// Cron Task Manager for PM Copilot
// Manages scheduled task execution with persistence and recovery
// Includes Rust-layer scheduler that directly executes tasks via Sidecar
//
// Key responsibilities:
// - Task lifecycle management (create, start, pause, stop, complete)
// - Interval-based scheduling with overlap prevention
// - Session activation/deactivation coordination with SidecarManager
// - Persistence to ~/.pm-copilot/cron_tasks.json with auto-recovery on startup

use chrono::{DateTime, Utc};
use cron::Schedule as CronExprSchedule;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tokio::time::Duration;
use uuid::Uuid;

use crate::{ulog_error, ulog_info, ulog_warn};
use crate::sidecar::{
    execute_cron_task, CronExecutePayload, ManagedSidecarManager, ProviderEnv,
    SidecarOwner, ensure_session_sidecar, release_session_sidecar,
};

/// Normalize a path for comparison (removes trailing slashes)
/// This ensures consistent path matching regardless of how paths are formatted
fn normalize_path(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string() // Keep original if it's root path
    } else {
        trimmed.to_string()
    }
}

/// Parse a cron expression and compute the next fire time as a wall-clock UTC timestamp.
/// Accepts standard 5-field cron expressions (min hour dom month dow) and
/// converts to the 7-field format required by the `cron` crate (sec min hour dom month dow year).
fn next_cron_fire_time(expr: &str, tz: Option<&str>) -> Result<DateTime<Utc>, String> {
    // Normalize: 5-field → 7-field by prepending "0 " (seconds) and appending " *" (year)
    let expr7 = {
        let fields: Vec<&str> = expr.trim().split_whitespace().collect();
        match fields.len() {
            5 => format!("0 {} *", expr.trim()),
            6 => format!("0 {}", expr.trim()),  // already has year
            7 => expr.trim().to_string(),         // already full 7-field
            _ => return Err(format!("Invalid cron expression '{}': expected 5-7 fields, got {}", expr, fields.len())),
        }
    };

    let schedule = CronExprSchedule::from_str(&expr7)
        .map_err(|e| format!("Failed to parse cron expression '{}' (normalized: '{}'): {}", expr, expr7, e))?;

    // Resolve timezone
    let now = if let Some(tz_str) = tz {
        let tz: chrono_tz::Tz = tz_str.parse()
            .map_err(|_| format!("Invalid timezone '{}' for cron expression", tz_str))?;
        Utc::now().with_timezone(&tz)
    } else {
        // Default to UTC — use a fixed-offset representation
        Utc::now().with_timezone(&chrono_tz::UTC)
    };

    let next = schedule.after(&now).next()
        .ok_or_else(|| format!("No upcoming fire time for cron expression '{}'", expr))?;

    Ok(next.with_timezone(&Utc))
}

/// Wall-clock aware sleep that survives system suspend/hibernate.
///
/// Unlike `tokio::time::sleep(duration)` which uses monotonic time (pauses during
/// system sleep on macOS), this function polls `Utc::now()` (wall clock) every
/// POLL_INTERVAL seconds, correctly detecting that the scheduled time has passed
/// even after the system wakes from sleep.
///
/// Returns `true` if target time was reached, `false` if shutdown was requested.
async fn sleep_until_wallclock(
    target: DateTime<Utc>,
    shutdown: &RwLock<bool>,
    task_id: &str,
) -> bool {
    const POLL_SECS: u64 = 30;
    loop {
        let now = Utc::now();
        if now >= target {
            return true;
        }
        // Check shutdown flag
        if *shutdown.read().await {
            log::info!("[CronTask] Task {} wallclock sleep interrupted by shutdown", task_id);
            return false;
        }
        // Sleep for min(remaining, POLL_SECS) — short sleeps survive system suspend
        let remaining_secs = (target - now).num_seconds().max(0) as u64;
        let sleep_secs = remaining_secs.min(POLL_SECS).max(1);
        tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
    }
}

/// Atomic file save helper - writes to temp file first, then renames
/// This prevents data corruption if the process crashes mid-write
async fn atomic_save_tasks(
    storage_path: &PathBuf,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
) -> Result<(), String> {
    // Read tasks under lock
    let tasks_snapshot = {
        let tasks_guard = tasks.read().await;
        tasks_guard.values().cloned().collect::<Vec<_>>()
    };
    // Lock released here

    let store = CronTaskStore { tasks: tasks_snapshot };

    let content = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("Failed to serialize cron tasks: {}", e))?;

    // Ensure directory exists
    if let Some(parent) = storage_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron tasks directory: {}", e))?;
    }

    // Write to temp file first, then rename (atomic on most filesystems)
    let temp_path = storage_path.with_extension("tmp");
    fs::write(&temp_path, &content)
        .map_err(|e| format!("Failed to write cron tasks temp file: {}", e))?;

    fs::rename(&temp_path, storage_path)
        .map_err(|e| format!("Failed to rename cron tasks file: {}", e))?;

    log::debug!("[CronTask] Atomically saved {} tasks to disk", store.tasks.len());
    Ok(())
}

/// Run mode for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RunMode {
    /// Keep session context between executions
    SingleSession,
    /// Create new session for each execution (no memory)
    NewSession,
}

/// Task status (simplified: only Running and Stopped)
/// Stopped includes: manual stop, end conditions met, AI exit
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Task is running and will execute at intervals
    Running,
    /// Task was stopped (includes: manual stop, end conditions met, AI exit)
    Stopped,
}

/// End conditions for a cron task
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EndConditions {
    /// Task will stop after this time (ISO timestamp)
    pub deadline: Option<DateTime<Utc>>,
    /// Task will stop after this many executions
    pub max_executions: Option<u32>,
    /// Allow AI to exit the task via ExitCronTask tool
    pub ai_can_exit: bool,
}

/// Provider environment for task execution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderEnv {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_tokens_param_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_format: Option<String>,
}

/// Delivery target for IM Bot cron task results
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronDelivery {
    pub bot_id: String,
    pub chat_id: String,
    pub platform: String,
}

/// Flexible schedule types for cron tasks (v0.1.21)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CronSchedule {
    /// One-shot: execute at a specific time, then stop
    At { at: String },
    /// Recurring interval in minutes, with optional delayed start
    Every { minutes: u32, #[serde(default, skip_serializing_if = "Option::is_none")] start_at: Option<String> },
    /// Cron expression with optional timezone
    Cron { expr: String, tz: Option<String> },
    /// Ralph Loop: completion-triggered re-execution (no time-based scheduling)
    /// AI finishes → 3s buffer → execute again. Exponential backoff on failure.
    Loop,
}

/// A scheduled cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTask {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    pub status: TaskStatus,
    #[serde(default)]
    pub execution_count: u32,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_executed_at: Option<DateTime<Utc>>,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    /// Tab ID associated with this task (for frontend reference)
    #[serde(default)]
    pub tab_id: Option<String>,
    /// Exit reason (set when AI calls ExitCronTask)
    #[serde(default)]
    pub exit_reason: Option<String>,
    /// Permission mode for execution (auto, plan, fullAgency, custom)
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Model to use for execution
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider environment (API key, base URL)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    /// Last error message (if any)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    // ===== IM Bot cron fields (v0.1.21) =====
    /// Source IM Bot ID that created this task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    /// Where to deliver execution results
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    /// Flexible schedule (overrides interval_minutes when present)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    /// Human-readable name for the task
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Computed next execution time (enriched at read time, not persisted)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_execution_at: Option<String>,
    /// Internal SDK session ID where conversation data is stored.
    /// Differs from `session_id` (Sidecar session key) — this tracks the actual
    /// SDK session UUID for frontend to load conversation history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub internal_session_id: Option<String>,
    /// Last activity timestamp — updated on create, start, stop, execute.
    /// Used by frontend to sort tasks by most recent activity.
    #[serde(default = "chrono::Utc::now")]
    pub updated_at: DateTime<Utc>,
}

/// Configuration for creating a new cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskConfig {
    pub workspace_path: String,
    pub session_id: String,
    pub prompt: String,
    pub interval_minutes: u32,
    #[serde(default)]
    pub end_conditions: EndConditions,
    #[serde(default)]
    pub run_mode: RunMode,
    #[serde(default = "default_true")]
    pub notify_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<TaskProviderEnv>,
    // ===== IM Bot cron fields (v0.1.21) =====
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<CronDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<CronSchedule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_permission_mode() -> String {
    "auto".to_string()
}

impl Default for RunMode {
    fn default() -> Self {
        Self::SingleSession
    }
}

/// Persistent storage for cron tasks
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CronTaskStore {
    #[serde(default)]
    tasks: Vec<CronTask>,
}

// ============ Cron Run Records (execution history) ============

const MAX_RUN_RECORDS: usize = 500;

/// A single execution record for a cron task
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRunRecord {
    pub ts: i64,                    // Unix timestamp (ms)
    pub ok: bool,                   // Whether execution succeeded
    pub duration_ms: u64,           // Execution duration
    pub content: Option<String>,    // AI output text (delivery content)
    pub error: Option<String>,      // Error message on failure
}

/// Sanitize task_id to prevent path traversal (remove path separators and dots sequences)
fn sanitize_task_id(task_id: &str) -> String {
    task_id
        .replace(['/', '\\', '\0'], "")
        .replace("..", "")
}

/// Get the JSONL file path for a task's run records
fn run_record_path(task_id: &str) -> PathBuf {
    let safe_id = sanitize_task_id(task_id);
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".pm-copilot")
        .join("cron_runs")
        .join(format!("{}.jsonl", safe_id))
}

/// Append a run record to ~/.pm-copilot/cron_runs/<taskId>.jsonl
/// Truncates to MAX_RUN_RECORDS if exceeded.
pub fn record_cron_run(task_id: &str, record: &CronRunRecord) -> Result<(), String> {
    let path = run_record_path(task_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cron_runs dir: {}", e))?;
    }

    let line = serde_json::to_string(record)
        .map_err(|e| format!("Failed to serialize run record: {}", e))?
        + "\n";

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("Failed to open run record file: {}", e))?;

    file.write_all(line.as_bytes())
        .map_err(|e| format!("Failed to write run record: {}", e))?;

    // Truncate if over limit
    truncate_run_file_if_needed(&path, MAX_RUN_RECORDS);
    Ok(())
}

/// Read the most recent `limit` run records (returned in chronological order)
pub fn read_cron_runs(task_id: &str, limit: usize) -> Vec<CronRunRecord> {
    let path = run_record_path(task_id);
    if !path.exists() {
        return vec![];
    }

    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let capped = limit.min(100);
    let records: Vec<CronRunRecord> = content
        .lines()
        .rev()
        .take(capped)
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    // Reverse back to chronological order
    records.into_iter().rev().collect()
}

/// Truncate a JSONL file to keep only the last `max` lines
fn truncate_run_file_if_needed(path: &PathBuf, max: usize) {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= max {
        return;
    }

    // Keep only the last `max` lines
    let kept: Vec<&str> = lines[lines.len() - max..].to_vec();
    let new_content = kept.join("\n") + "\n";
    let _ = fs::write(path, new_content);
}

/// Event payload for cron task execution trigger
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskTriggerPayload {
    pub task_id: String,
    pub prompt: String,
    pub is_first_execution: bool,
    pub ai_can_exit: bool,
    pub workspace_path: String,
    pub session_id: String,
    pub run_mode: RunMode,
    pub notify_enabled: bool,
    pub tab_id: Option<String>,
}

// ============ Recovery Event Types (方案 A: Rust 统一恢复) ============

/// Event payload for a single task recovery success
/// Emitted as "cron:task-recovered" for each successfully recovered task
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskRecoveredPayload {
    pub task_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub port: u16,
    pub status: String,
    pub execution_count: u32,
    pub interval_minutes: u32,
}

/// Event payload for task status changes
/// Emitted as "cron:task-status-changed" when task status changes
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronTaskStatusChangedPayload {
    pub task_id: String,
    pub session_id: String,
    pub old_status: String,
    pub new_status: String,
    pub reason: Option<String>,
}

/// Event payload for recovery summary
/// Emitted as "cron:recovery-summary" after all recovery attempts complete
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoverySummaryPayload {
    pub total_tasks: u32,
    pub recovered_count: u32,
    pub failed_count: u32,
    pub failed_tasks: Vec<CronRecoveryFailedTask>,
}

/// Info about a single failed recovery
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRecoveryFailedTask {
    pub task_id: String,
    pub workspace_path: String,
    pub error: String,
}

/// Compute the next execution time for a cron task (enrichment helper)
/// Returns an ISO 8601 string or None if the task is stopped or cannot be computed
fn compute_next_execution(task: &CronTask) -> Option<String> {
    if task.status != TaskStatus::Running {
        return None;
    }

    match &task.schedule {
        Some(CronSchedule::At { at }) => {
            // One-shot: the target time itself
            Some(at.clone())
        }
        Some(CronSchedule::Every { minutes, start_at }) => {
            // If start_at is set and in the future, use it as next execution
            if let Some(ref sa) = start_at {
                if let Ok(parsed) = DateTime::parse_from_rfc3339(sa) {
                    let target = parsed.with_timezone(&Utc);
                    if target > Utc::now() && task.execution_count == 0 {
                        return Some(target.to_rfc3339());
                    }
                }
            }
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(*minutes as i64);
            Some(next.to_rfc3339())
        }
        Some(CronSchedule::Cron { expr, tz }) => {
            match next_cron_fire_time(expr, tz.as_deref()) {
                Ok(next) => Some(next.to_rfc3339()),
                Err(_) => None,
            }
        }
        Some(CronSchedule::Loop) => {
            // Ralph Loop: no scheduled time, triggered by completion
            None
        }
        None => {
            // Legacy: use interval_minutes
            let base = task.last_executed_at.unwrap_or(task.created_at);
            let next = base + chrono::Duration::minutes(task.interval_minutes as i64);
            Some(next.to_rfc3339())
        }
    }
}

/// Enrich a CronTask with computed next_execution_at
fn enrich_task(mut task: CronTask) -> CronTask {
    task.next_execution_at = compute_next_execution(&task);
    task
}

/// Manager for cron tasks
pub struct CronTaskManager {
    pub(crate) tasks: Arc<RwLock<HashMap<String, CronTask>>>,
    storage_path: PathBuf,
    /// Flag to stop all scheduler loops
    shutdown: Arc<RwLock<bool>>,
    /// Track which tasks are currently executing (for overlap prevention)
    executing_tasks: Arc<RwLock<HashSet<String>>>,
    /// Track which tasks have active schedulers (prevents duplicate scheduler spawns)
    active_schedulers: Arc<RwLock<HashSet<String>>>,
    /// Tauri app handle for emitting events (set after initialization)
    app_handle: Arc<RwLock<Option<AppHandle>>>,
}

impl CronTaskManager {
    /// Create a new CronTaskManager with persistence at ~/.pm-copilot/cron_tasks.json
    pub fn new() -> Self {
        let storage_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".pm-copilot")
            .join("cron_tasks.json");

        // Load persisted tasks synchronously before creating the manager
        // This avoids the need for block_on with async locks
        let initial_tasks = Self::load_tasks_from_file(&storage_path);

        let task_count = initial_tasks.len();
        let manager = Self {
            tasks: Arc::new(RwLock::new(initial_tasks)),
            storage_path,
            shutdown: Arc::new(RwLock::new(false)),
            executing_tasks: Arc::new(RwLock::new(HashSet::new())),
            active_schedulers: Arc::new(RwLock::new(HashSet::new())),
            app_handle: Arc::new(RwLock::new(None)),
        };

        if task_count > 0 {
            ulog_info!("[CronTask] Loaded {} tasks from disk", task_count);
        }

        manager
    }

    /// Load tasks from file synchronously (used during initialization)
    /// Returns empty HashMap on any error (logged as warning)
    /// Uses per-task fallback: if whole-store parse fails, tries parsing tasks individually
    fn load_tasks_from_file(storage_path: &PathBuf) -> HashMap<String, CronTask> {
        if !storage_path.exists() {
            return HashMap::new();
        }

        let content = match fs::read_to_string(storage_path) {
            Ok(c) => c,
            Err(e) => {
                ulog_warn!("[CronTask] Failed to read cron tasks file: {}", e);
                return HashMap::new();
            }
        };

        // Try whole-store deserialization first (fast path)
        match serde_json::from_str::<CronTaskStore>(&content) {
            Ok(store) => {
                return store.tasks.into_iter().map(|t| (t.id.clone(), t)).collect();
            }
            Err(e) => {
                ulog_warn!("[CronTask] Whole-store parse failed ({}), trying per-task fallback", e);
            }
        }

        // Fallback: parse as raw JSON value, then deserialize tasks individually
        let raw: serde_json::Value = match serde_json::from_str(&content) {
            Ok(v) => v,
            Err(e) => {
                ulog_warn!("[CronTask] Failed to parse cron tasks as JSON at all: {}", e);
                return HashMap::new();
            }
        };

        let tasks_array = match raw.get("tasks").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => {
                ulog_warn!("[CronTask] No 'tasks' array found in cron_tasks.json");
                return HashMap::new();
            }
        };

        let mut result = HashMap::new();
        let mut skipped = 0u32;
        for (i, task_val) in tasks_array.iter().enumerate() {
            match serde_json::from_value::<CronTask>(task_val.clone()) {
                Ok(task) => {
                    result.insert(task.id.clone(), task);
                }
                Err(e) => {
                    let task_id = task_val.get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    ulog_warn!(
                        "[CronTask] Skipping corrupted task[{}] id={}: {}",
                        i, task_id, e
                    );
                    skipped += 1;
                }
            }
        }

        if skipped > 0 {
            ulog_warn!(
                "[CronTask] Per-task fallback: loaded {} tasks, skipped {} corrupted",
                result.len(), skipped
            );
        }

        result
    }

    /// Set the Tauri app handle for emitting events
    /// Must be called during app setup before starting any tasks
    pub async fn set_app_handle(&self, handle: AppHandle) {
        let mut app_handle = self.app_handle.write().await;
        *app_handle = Some(handle);
        ulog_info!("[CronTask] App handle set");
    }

    /// Start the scheduler for a task
    /// This spawns a background tokio task that directly executes via Sidecar at intervals
    pub async fn start_task_scheduler(&self, task_id: &str) -> Result<(), String> {
        let task = self.get_task(task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status != TaskStatus::Running {
            return Err(format!("Task {} is not in running status", task_id));
        }

        // Check if scheduler is already running for this task
        {
            let active = self.active_schedulers.read().await;
            if active.contains(task_id) {
                log::info!("[CronTask] Scheduler already running for task {}, skipping", task_id);
                return Ok(());
            }
        }

        // Mark scheduler as active
        {
            let mut active = self.active_schedulers.write().await;
            active.insert(task_id.to_string());
        }

        let tasks = Arc::clone(&self.tasks);
        let shutdown = Arc::clone(&self.shutdown);
        let executing_tasks = Arc::clone(&self.executing_tasks);
        let active_schedulers = Arc::clone(&self.active_schedulers);
        let app_handle = Arc::clone(&self.app_handle);
        let storage_path = self.storage_path.clone();
        let task_id_owned = task_id.to_string();
        let schedule = task.schedule.clone();
        let interval_mins = match &schedule {
            Some(CronSchedule::Every { minutes, .. }) => *minutes,
            _ => task.interval_minutes,
        };
        let last_executed = task.last_executed_at;
        let execution_count = task.execution_count;

        // Spawn the scheduler loop
        tokio::spawn(async move {
            log::info!("[CronTask] Scheduler started for task {} (interval: {} min, executions: {})", task_id_owned, interval_mins, execution_count);

            // Wait for app_handle to be available (with timeout)
            // This handles the race condition where scheduler starts before initialize_cron_manager completes
            let mut app_handle_ready = false;
            for i in 0..50 {  // 5 seconds max wait (50 * 100ms)
                let handle_opt = app_handle.read().await;
                if handle_opt.is_some() {
                    app_handle_ready = true;
                    break;
                }
                drop(handle_opt);
                if i == 0 {
                    log::warn!("[CronTask] App handle not ready for task {}, waiting...", task_id_owned);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }

            if !app_handle_ready {
                log::error!("[CronTask] App handle not available after 5 seconds, aborting scheduler for task {}", task_id_owned);
                // Clean up: remove from active schedulers
                {
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                }
                return;
            }

            // Emit scheduler started event to frontend
            {
                let handle_opt = app_handle.read().await;
                if let Some(ref handle) = *handle_opt {
                    let _ = handle.emit("cron:scheduler-started", serde_json::json!({
                        "taskId": task_id_owned,
                        "intervalMinutes": interval_mins,
                        "executionCount": execution_count
                    }));
                }
            }

            // Calculate initial wait time
            // For CronSchedule::At — calculate delay until target time, then one-shot
            // For CronSchedule::Cron — compute next fire time from cron expression
            let is_one_shot = matches!(&schedule, Some(CronSchedule::At { .. }));
            let is_cron_expr = matches!(&schedule, Some(CronSchedule::Cron { .. }));
            let is_loop = matches!(&schedule, Some(CronSchedule::Loop));
            let cron_expr_info = match &schedule {
                Some(CronSchedule::Cron { expr, tz }) => Some((expr.clone(), tz.clone())),
                _ => None,
            };
            let interval_secs = interval_mins.max(5) as i64 * 60;
            // Compute initial target as a wall-clock time (not a Duration).
            // This is critical: we use sleep_until_wallclock() which polls Utc::now()
            // instead of tokio::time::sleep() which uses monotonic time that pauses
            // during system sleep/suspend.
            let initial_target: Option<DateTime<Utc>> = if is_loop {
                // Ralph Loop: execute immediately (2s startup delay)
                log::info!("[CronTask] Task {} Ralph Loop mode, executing in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(CronSchedule::At { ref at }) = schedule {
                // One-shot: target is the specified time
                match DateTime::parse_from_rfc3339(at).or_else(|_| DateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S")) {
                    Ok(target) => {
                        let target_utc = target.with_timezone(&Utc);
                        let now = Utc::now();
                        if target_utc > now {
                            log::info!("[CronTask] Task {} scheduled at {}, waiting {} seconds", task_id_owned, at, (target_utc - now).num_seconds());
                            Some(target_utc)
                        } else {
                            log::info!("[CronTask] Task {} target time {} already passed, executing immediately", task_id_owned, at);
                            Some(now + chrono::Duration::seconds(2))
                        }
                    }
                    Err(e) => {
                        log::warn!("[CronTask] Task {} invalid 'at' time '{}': {}, executing in 2s", task_id_owned, at, e);
                        Some(Utc::now() + chrono::Duration::seconds(2))
                    }
                }
            } else if let Some(CronSchedule::Cron { ref expr, ref tz }) = schedule {
                // Cron expression: compute next fire time from wall clock
                match next_cron_fire_time(expr, tz.as_deref()) {
                    Ok(target) => {
                        log::info!("[CronTask] Task {} cron expr '{}' (tz={:?}), next fire at {} (in {} seconds)",
                            task_id_owned, expr, tz, target, (target - Utc::now()).num_seconds());
                        Some(target)
                    }
                    Err(e) => {
                        log::error!("[CronTask] Task {} invalid cron config: {}, stopping scheduler", task_id_owned, e);
                        {
                            let mut active = active_schedulers.write().await;
                            active.remove(&task_id_owned);
                        }
                        return;
                    }
                }
            } else if let Some(CronSchedule::Every { start_at: Some(ref sa), .. }) = schedule {
                // Every with start_at: wait until the specified start time for first execution
                if execution_count == 0 {
                    match DateTime::parse_from_rfc3339(sa) {
                        Ok(target) => {
                            let target_utc = target.with_timezone(&Utc);
                            let now = Utc::now();
                            if target_utc > now {
                                ulog_info!("[CronTask] Task {} delayed start at {}, waiting {} seconds", task_id_owned, sa, (target_utc - now).num_seconds());
                                Some(target_utc)
                            } else {
                                ulog_info!("[CronTask] Task {} start time {} already passed, executing in 2 seconds", task_id_owned, sa);
                                Some(now + chrono::Duration::seconds(2))
                            }
                        }
                        Err(_) => {
                            ulog_warn!("[CronTask] Task {} invalid start_at '{}', starting in 2 seconds", task_id_owned, sa);
                            Some(Utc::now() + chrono::Duration::seconds(2))
                        }
                    }
                } else if let Some(last_exec) = last_executed {
                    let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                    Some(next_exec)
                } else {
                    Some(Utc::now() + chrono::Duration::seconds(2))
                }
            } else if execution_count == 0 {
                log::info!("[CronTask] Task {} first execution, starting in 2 seconds", task_id_owned);
                Some(Utc::now() + chrono::Duration::seconds(2))
            } else if let Some(last_exec) = last_executed {
                let next_exec = last_exec + chrono::Duration::seconds(interval_secs);
                let now = Utc::now();
                if next_exec > now {
                    log::info!("[CronTask] Task {} next execution at {} (in {} seconds, based on lastExecutedAt)",
                        task_id_owned, next_exec, (next_exec - now).num_seconds());
                    Some(next_exec)
                } else {
                    log::info!("[CronTask] Task {} is past due, executing in 5 seconds", task_id_owned);
                    Some(now + chrono::Duration::seconds(5))
                }
            } else {
                log::info!("[CronTask] Task {} no lastExecutedAt but count={}, waiting full interval", task_id_owned, execution_count);
                Some(Utc::now() + chrono::Duration::seconds(interval_secs))
            };

            // Ralph Loop: track consecutive failures for exponential backoff
            let mut loop_consecutive_failures: u32 = 0;

            // Wait for initial period using wall-clock polling (survives system sleep)
            if let Some(target) = initial_target {
                if !sleep_until_wallclock(target, &shutdown, &task_id_owned).await {
                    // Shutdown requested during wait
                    let mut active = active_schedulers.write().await;
                    active.remove(&task_id_owned);
                    return;
                }
            }

            loop {

                // Check shutdown flag
                {
                    let shutdown_flag = shutdown.read().await;
                    if *shutdown_flag {
                        log::info!("[CronTask] Scheduler shutdown for task {}", task_id_owned);
                        break;
                    }
                }

                // Check task status
                let task_opt = {
                    let tasks_guard = tasks.read().await;
                    tasks_guard.get(&task_id_owned).cloned()
                };

                let task = match task_opt {
                    Some(t) => t,
                    None => {
                        log::info!("[CronTask] Task {} no longer exists, stopping scheduler", task_id_owned);
                        break;
                    }
                };

                // Only execute if task is still running
                if task.status != TaskStatus::Running {
                    log::info!("[CronTask] Task {} status changed to {:?}, stopping scheduler", task_id_owned, task.status);
                    break;
                }

                // Check end conditions before execution
                let should_complete = check_end_conditions_static(&task);
                if should_complete {
                    log::info!("[CronTask] Task {} reached end condition, completing", task_id_owned);
                    // Complete task and deactivate session
                    if let Some(ref handle) = *app_handle.read().await {
                        stop_task_internal(handle, &tasks, &task_id_owned, None).await;
                    }
                    break;
                }

                // Check if task is currently executing (overlap prevention)
                {
                    let executing = executing_tasks.read().await;
                    if executing.contains(&task_id_owned) {
                        log::warn!("[CronTask] Task {} is still executing, skipping this interval", task_id_owned);
                        // Short wait before checking again
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        continue;
                    }
                }

                // Get app handle for execution
                let handle_opt = {
                    let handle_guard = app_handle.read().await;
                    handle_guard.clone()
                };

                let Some(handle) = handle_opt else {
                    log::error!("[CronTask] No app handle available for task {}, will retry next interval", task_id_owned);
                    // Short wait before retrying (prevents tight loop)
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    continue;
                };

                // Mark task as executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.insert(task_id_owned.clone());
                }

                let is_first = task.execution_count == 0;
                log::info!("[CronTask] Executing task {} (execution #{})", task_id_owned, task.execution_count + 1);

                // Emit execution starting event to frontend
                let _ = handle.emit("cron:execution-starting", serde_json::json!({
                    "taskId": task_id_owned,
                    "executionNumber": task.execution_count + 1,
                    "isFirstExecution": is_first
                }));

                log::info!("[CronTask] About to call execute_task_directly for task {}", task_id_owned);

                // Emit debug event for frontend visibility
                let _ = handle.emit("cron:debug", serde_json::json!({
                    "taskId": task_id_owned,
                    "message": "About to call execute_task_directly"
                }));

                // Execute directly via Sidecar with timeout to prevent indefinite hanging
                let exec_start = std::time::Instant::now();
                let execution_result = tokio::time::timeout(
                    Duration::from_secs(3600), // 60 minutes timeout
                    execute_task_directly(&handle, &task, is_first)
                ).await;

                let execution_result = match execution_result {
                    Ok(result) => result,
                    Err(_) => {
                        log::error!("[CronTask] Task {} execution timed out after 60 minutes", task_id_owned);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": "Execution timed out after 60 minutes",
                            "error": true
                        }));
                        Err("Execution timed out".to_string())
                    }
                };
                let duration_ms = exec_start.elapsed().as_millis() as u64;

                // Record execution history to JSONL
                // Cap content at 2000 chars to prevent JSONL bloat (500 records * large output)
                const MAX_CONTENT_LEN: usize = 2000;
                match &execution_result {
                    Ok((success, _, output_text, _)) => {
                        let run_record = CronRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: *success,
                            duration_ms,
                            content: output_text.as_ref().map(|t| {
                                if t.len() > MAX_CONTENT_LEN {
                                    // Find a valid UTF-8 boundary near the limit
                                    let end = t.char_indices()
                                        .take_while(|(i, _)| *i < MAX_CONTENT_LEN)
                                        .last()
                                        .map(|(i, c)| i + c.len_utf8())
                                        .unwrap_or(MAX_CONTENT_LEN.min(t.len()));
                                    format!("{}...", &t[..end])
                                } else {
                                    t.clone()
                                }
                            }),
                            error: None,
                        };
                        if let Err(e) = record_cron_run(&task_id_owned, &run_record) {
                            log::warn!("[CronTask] Failed to record run: {}", e);
                        }
                    }
                    Err(ref e) => {
                        let run_record = CronRunRecord {
                            ts: Utc::now().timestamp_millis(),
                            ok: false,
                            duration_ms,
                            content: None,
                            error: Some(e.clone()),
                        };
                        let _ = record_cron_run(&task_id_owned, &run_record);
                    }
                }

                // Log the actual execution outcome (not just is_ok which only means "no Rust error")
                match &execution_result {
                    Ok((success, _, _, _)) => {
                        log::info!("[CronTask] execute_task_directly completed for task {}: task_success={}", task_id_owned, success);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_directly completed: task_success={}", success)
                        }));
                    }
                    Err(ref e) => {
                        log::warn!("[CronTask] execute_task_directly failed for task {}: {}", task_id_owned, e);
                        let _ = handle.emit("cron:debug", serde_json::json!({
                            "taskId": task_id_owned,
                            "message": format!("execute_task_directly failed: {}", e),
                            "error": true
                        }));
                    }
                }

                // Mark task as no longer executing
                {
                    let mut executing = executing_tasks.write().await;
                    executing.remove(&task_id_owned);
                }

                // Handle execution result
                match execution_result {
                    Ok((success, ai_exit_reason, output_text, internal_sid)) => {
                        // Update execution count, last_executed_at, and internal_session_id
                        let updated_execution_count;
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                let now = Utc::now();
                                t.execution_count += 1;
                                t.last_executed_at = Some(now);
                                t.updated_at = now;
                                t.last_error = None;
                                // Track the internal SDK session ID for frontend session loading
                                if internal_sid.is_some() {
                                    t.internal_session_id = internal_sid.clone();
                                }
                                updated_execution_count = t.execution_count;
                            } else {
                                updated_execution_count = task.execution_count + 1;
                            }
                        }

                        // Ralph Loop: reset failure counter on success, increment on logical failure
                        if is_loop {
                            if success {
                                loop_consecutive_failures = 0;
                            } else {
                                loop_consecutive_failures += 1;
                                if loop_consecutive_failures >= 10 {
                                    log::error!("[CronTask] Task {} Ralph Loop: 10 consecutive failures (logical), stopping", task_id_owned);
                                    stop_task_internal(&handle, &tasks, &task_id_owned,
                                        Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                    break;
                                }
                                let backoff_secs = match loop_consecutive_failures {
                                    1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                                };
                                log::warn!("[CronTask] Task {} Ralph Loop: logical failure #{}, backoff {}s",
                                    task_id_owned, loop_consecutive_failures, backoff_secs);
                            }
                        }

                        // Emit execution-complete for ALL success paths
                        // (one-shot, AI exit, end condition, and normal continue)
                        // Must happen before any break so frontend always gets the update
                        log::info!("[CronTask] Emitting cron:execution-complete for task {} with executionCount={}", task_id_owned, updated_execution_count);
                        let _ = handle.emit("cron:execution-complete", serde_json::json!({
                            "taskId": task_id_owned,
                            "success": success,
                            "executionCount": updated_execution_count,
                            "internalSessionId": internal_sid
                        }));

                        // Deliver results to IM Bot + wake heartbeat (v0.1.21)
                        // Use actual AI output when available, fallback to generic summary
                        if let Some(ref delivery) = task.delivery {
                            let content = output_text.unwrap_or_else(|| {
                                if success {
                                    format!("Cron task '{}' completed successfully.", task.name.as_deref().unwrap_or(&task_id_owned))
                                } else {
                                    format!("Cron task '{}' completed with issues.", task.name.as_deref().unwrap_or(&task_id_owned))
                                }
                            });
                            deliver_cron_result_to_bot(&handle, delivery, &task_id_owned, &content).await;
                        }

                        // Check if AI requested exit
                        if let Some(reason) = ai_exit_reason {
                            log::info!("[CronTask] Task {} AI requested exit: {}", task_id_owned, reason);
                            stop_task_internal(&handle, &tasks, &task_id_owned, Some(reason)).await;
                            break;
                        }

                        // One-shot tasks (CronSchedule::At) auto-delete after first execution
                        if is_one_shot {
                            log::info!("[CronTask] Task {} is one-shot (schedule::at), auto-deleting after execution", task_id_owned);
                            stop_task_internal(&handle, &tasks, &task_id_owned, Some("One-shot task completed".to_string())).await;
                            // Remove from persistence (CT-08: one-shot tasks auto-delete)
                            {
                                let mut tasks_guard = tasks.write().await;
                                tasks_guard.remove(&task_id_owned);
                            }
                            let manager = get_cron_task_manager();
                            if let Err(e) = manager.save_to_disk().await {
                                log::warn!("[CronTask] Failed to save after one-shot deletion: {}", e);
                            }
                            break;
                        }

                        // Check end conditions after execution
                        let should_stop = {
                            let tasks_guard = tasks.read().await;
                            tasks_guard.get(&task_id_owned)
                                .map(|t| check_end_conditions_static(t))
                                .unwrap_or(false)
                        };
                        if should_stop {
                            log::info!("[CronTask] Task {} reached end condition after execution", task_id_owned);
                            stop_task_internal(&handle, &tasks, &task_id_owned, None).await;
                            break;
                        }
                    }
                    Err(e) => {
                        log::error!("[CronTask] Task {} execution failed: {}", task_id_owned, e);
                        // Update last_error
                        {
                            let mut tasks_guard = tasks.write().await;
                            if let Some(t) = tasks_guard.get_mut(&task_id_owned) {
                                t.last_error = Some(e.clone());
                            }
                        }
                        // Emit error event for frontend
                        let _ = handle.emit("cron:execution-error", serde_json::json!({
                            "taskId": task_id_owned,
                            "error": e
                        }));

                        // Ralph Loop: exponential backoff on failure (3→10→30→60→120→300s, max 10 consecutive)
                        if is_loop {
                            loop_consecutive_failures += 1;
                            if loop_consecutive_failures >= 10 {
                                log::error!("[CronTask] Task {} Ralph Loop: 10 consecutive failures, stopping", task_id_owned);
                                stop_task_internal(&handle, &tasks, &task_id_owned,
                                    Some("Ralph Loop: 10 consecutive failures".to_string())).await;
                                break;
                            }
                            let backoff_secs = match loop_consecutive_failures {
                                1 => 3, 2 => 10, 3 => 30, 4 => 60, 5 => 120, _ => 300,
                            };
                            log::warn!("[CronTask] Task {} Ralph Loop: failure #{}, backoff {}s",
                                task_id_owned, loop_consecutive_failures, backoff_secs);
                            let backoff_target = Utc::now() + chrono::Duration::seconds(backoff_secs as i64);
                            if !sleep_until_wallclock(backoff_target, &shutdown, &task_id_owned).await {
                                log::info!("[CronTask] Task {} shutdown during Loop backoff", task_id_owned);
                                break;
                            }
                        }
                        // Continue to next interval (don't break on error)
                    }
                }

                // Save updated state atomically (temp file + rename)
                if let Err(e) = atomic_save_tasks(&storage_path, &tasks).await {
                    log::warn!("[CronTask] Failed to save task state: {}", e);
                }

                // Ralph Loop: skip time-based scheduling, re-execute after 3s buffer
                if is_loop {
                    log::info!("[CronTask] Task {} Ralph Loop: next execution in 3 seconds", task_id_owned);
                    let buffer_target = Utc::now() + chrono::Duration::seconds(3);
                    if !sleep_until_wallclock(buffer_target, &shutdown, &task_id_owned).await {
                        log::info!("[CronTask] Task {} shutdown during Loop buffer", task_id_owned);
                        break;
                    }
                    continue;
                }

                // Wait for the next execution time using wall-clock polling.
                // This survives system sleep/suspend — after wake, the poll detects
                // that wall-clock time has passed and fires within ≤30 seconds.
                let next_target = if is_cron_expr {
                    if let Some((ref expr, ref tz)) = cron_expr_info {
                        match next_cron_fire_time(expr, tz.as_deref()) {
                            Ok(target) => {
                                log::info!("[CronTask] Task {} cron next fire at {} (in {} seconds)",
                                    task_id_owned, target, (target - Utc::now()).num_seconds());
                                target
                            }
                            Err(e) => {
                                log::error!("[CronTask] Task {} cron schedule error: {}, stopping", task_id_owned, e);
                                break;
                            }
                        }
                    } else {
                        break; // Should not happen — cron_expr_info is always Some for is_cron_expr
                    }
                } else {
                    // Fixed interval: next = now + interval
                    let target = Utc::now() + chrono::Duration::seconds(interval_secs);
                    log::info!("[CronTask] Task {} next execution at {} (in {} minutes)",
                        task_id_owned, target, interval_mins);
                    target
                };
                if !sleep_until_wallclock(next_target, &shutdown, &task_id_owned).await {
                    log::info!("[CronTask] Task {} shutdown during wait", task_id_owned);
                    break;
                }
            }

            // Clean up: remove from active schedulers
            {
                let mut active = active_schedulers.write().await;
                active.remove(&task_id_owned);
            }
            log::info!("[CronTask] Scheduler loop exited for task {}", task_id_owned);
        });

        Ok(())
    }

    /// Mark a task as currently executing (called when execution starts)
    pub async fn mark_task_executing(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.insert(task_id.to_string());
        log::debug!("[CronTask] Task {} marked as executing", task_id);
    }

    /// Mark a task as no longer executing (called when execution completes)
    pub async fn mark_task_complete(&self, task_id: &str) {
        let mut executing = self.executing_tasks.write().await;
        executing.remove(task_id);
        log::debug!("[CronTask] Task {} marked as complete", task_id);
    }

    /// Check if a task is currently executing
    pub async fn is_task_executing(&self, task_id: &str) -> bool {
        let executing = self.executing_tasks.read().await;
        executing.contains(task_id)
    }

    /// Save tasks to disk using atomic writes (temp file + rename)
    pub(crate) async fn save_to_disk(&self) -> Result<(), String> {
        atomic_save_tasks(&self.storage_path, &self.tasks).await
    }

    /// Create a new cron task (does not start it)
    pub async fn create_task(&self, config: CronTaskConfig) -> Result<CronTask, String> {
        // Validate minimum interval (5 minutes, matches frontend MIN_CRON_INTERVAL)
        if config.interval_minutes < 5 {
            return Err("Interval must be at least 5 minutes".to_string());
        }

        let task = CronTask {
            id: format!("cron_{}", Uuid::new_v4().to_string().replace("-", "")[..12].to_string()),
            workspace_path: config.workspace_path,
            session_id: config.session_id,
            prompt: config.prompt,
            interval_minutes: config.interval_minutes,
            end_conditions: config.end_conditions,
            run_mode: config.run_mode,
            status: TaskStatus::Stopped, // Start stopped, caller must explicitly start
            execution_count: 0,
            created_at: Utc::now(),
            last_executed_at: None,
            notify_enabled: config.notify_enabled,
            tab_id: config.tab_id,
            exit_reason: None,
            permission_mode: config.permission_mode,
            model: config.model,
            provider_env: config.provider_env,
            last_error: None,
            source_bot_id: config.source_bot_id,
            delivery: config.delivery,
            schedule: config.schedule,
            name: config.name,
            next_execution_at: None, // Enriched at read time
            internal_session_id: None, // Set after first execution
            updated_at: Utc::now(),
        };

        let mut tasks = self.tasks.write().await;
        tasks.insert(task.id.clone(), task.clone());
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Created task: {}", task.id);

        Ok(task)
    }

    /// Get a task by ID (enriched with next_execution_at)
    pub async fn get_task(&self, task_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.get(task_id).cloned().map(enrich_task)
    }

    /// Get all tasks (enriched with next_execution_at)
    pub async fn get_all_tasks(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks.values().cloned().map(enrich_task).collect()
    }

    /// Get tasks for a specific workspace (enriched with next_execution_at)
    /// Uses normalized path comparison to handle trailing slashes and other inconsistencies
    pub async fn get_tasks_for_workspace(&self, workspace_path: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        let normalized_query = normalize_path(workspace_path);
        let result: Vec<CronTask> = tasks
            .values()
            .filter(|t| normalize_path(&t.workspace_path) == normalized_query)
            .cloned()
            .map(enrich_task)
            .collect();

        log::debug!(
            "[CronTask] get_tasks_for_workspace: query='{}' (normalized='{}'), found {} tasks",
            workspace_path, normalized_query, result.len()
        );

        result
    }

    /// Get active task for a specific session (running only, enriched)
    pub async fn get_active_task_for_session(&self, session_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.session_id == session_id && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Get active task for a specific tab (running only, enriched)
    pub async fn get_active_task_for_tab(&self, tab_id: &str) -> Option<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .find(|t| t.tab_id.as_deref() == Some(tab_id) && t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
    }

    /// Get tasks created by a specific IM Bot (v0.1.21, enriched)
    pub async fn get_tasks_for_bot(&self, bot_id: &str) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.source_bot_id.as_deref() == Some(bot_id))
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task fields (partial update, for management API)
    pub async fn update_task_fields(&self, task_id: &str, patch: serde_json::Value) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        // Apply allowed patches
        if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
            task.name = Some(name.to_string());
        }
        // Accept both "prompt" and "message" (Bun normalizes, but defend in depth)
        if let Some(prompt) = patch.get("prompt").and_then(|v| v.as_str())
            .or_else(|| patch.get("message").and_then(|v| v.as_str()))
        {
            task.prompt = prompt.to_string();
        }
        if let Some(interval) = patch.get("intervalMinutes").and_then(|v| v.as_u64()) {
            task.interval_minutes = interval.max(5) as u32;
        }
        if let Some(schedule_val) = patch.get("schedule") {
            if schedule_val.is_null() {
                task.schedule = None;
            } else if let Ok(s) = serde_json::from_value::<CronSchedule>(schedule_val.clone()) {
                task.schedule = Some(s);
            }
        }

        task.updated_at = Utc::now();
        let updated = task.clone();
        drop(tasks);
        self.save_to_disk().await?;
        log::info!("[CronTask] Updated task fields: {}", task_id);
        Ok(updated)
    }

    /// Start a task (begin scheduling)
    /// Can start a task in Stopped status (e.g., after creation or after previous stop)
    pub async fn start_task(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if task.status == TaskStatus::Running {
            return Err("Task is already running".to_string());
        }

        task.status = TaskStatus::Running;
        task.updated_at = Utc::now();
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;
        log::info!("[CronTask] Started task: {}", task_id);

        Ok(task_clone)
    }

    /// Stop a task (with optional exit reason)
    /// Also deactivates the associated session and unregisters the CronTask user
    /// exit_reason can be set when AI calls ExitCronTask tool or end conditions are met
    pub async fn stop_task(&self, task_id: &str, exit_reason: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        task.status = TaskStatus::Stopped;
        task.exit_reason = exit_reason.clone();
        task.updated_at = Utc::now();
        let task_clone = task.clone();
        drop(tasks);

        // Release CronTask's ownership of the Session Sidecar
        // If Tab still owns it, Sidecar continues running
        self.stop_cron_task_sidecar_internal(&session_id, task_id).await;

        // Deactivate session via app handle
        self.deactivate_session_internal(&session_id).await;

        self.save_to_disk().await?;

        // Emit stopped event for frontend listeners (e.g., RecentTasks badge refresh)
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            let _ = handle.emit("cron:task-stopped", serde_json::json!({
                "taskId": task_id,
                "exitReason": exit_reason
            }));
        }

        log::info!("[CronTask] Stopped task: {} (CronTask released from session {})", task_id, session_id);

        Ok(task_clone)
    }

    /// Internal helper to deactivate a session via SidecarManager
    async fn deactivate_session_internal(&self, session_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                match sidecar_state.lock() {
                    Ok(mut manager) => {
                        manager.deactivate_session(session_id);
                        log::debug!("[CronTask] Deactivated session: {}", session_id);
                    }
                    Err(e) => {
                        log::error!("[CronTask] Cannot deactivate session {}: lock poisoned: {}", session_id, e);
                    }
                }
            } else {
                log::warn!("[CronTask] Cannot deactivate session {}: SidecarManager state not found", session_id);
            }
        } else {
            log::warn!("[CronTask] Cannot deactivate session {}: app handle not available", session_id);
        }
    }

    /// Internal helper to release CronTask's ownership of the Session Sidecar
    /// With Session-centric Sidecar (Owner model), this only releases the CronTask owner.
    /// If Tab still owns the Sidecar, it continues running.
    async fn stop_cron_task_sidecar_internal(&self, session_id: &str, task_id: &str) {
        let handle_opt = self.app_handle.read().await;
        if let Some(ref handle) = *handle_opt {
            if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
                let owner = SidecarOwner::CronTask(task_id.to_string());
                match release_session_sidecar(&sidecar_state, session_id, &owner) {
                    Ok(stopped) => {
                        if stopped {
                            log::info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar stopped (was last owner)",
                                task_id, session_id
                            );
                        } else {
                            log::info!(
                                "[CronTask] Released CronTask {} from session {}, Sidecar continues (Tab still owns it)",
                                task_id, session_id
                            );
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "[CronTask] Failed to release CronTask {} from session {}: {}",
                            task_id, session_id, e
                        );
                    }
                }
            } else {
                log::warn!("[CronTask] Cannot release CronTask {}: SidecarManager state not found", task_id);
            }
        } else {
            log::warn!("[CronTask] Cannot release CronTask {}: app handle not available", task_id);
        }
    }

    /// Delete a task
    /// Also releases CronTask's Sidecar ownership and deactivates session if task was running
    pub async fn delete_task(&self, task_id: &str) -> Result<(), String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.remove(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let session_id = task.session_id.clone();
        let was_running = task.status == TaskStatus::Running;
        drop(tasks);

        // Release CronTask's Sidecar ownership and deactivate session if task was running
        if was_running {
            self.stop_cron_task_sidecar_internal(&session_id, task_id).await;
            self.deactivate_session_internal(&session_id).await;
        }

        self.save_to_disk().await?;
        log::info!("[CronTask] Deleted task: {} (was_running: {}, CronTask released)", task_id, was_running);

        Ok(())
    }

    /// Record task execution
    pub async fn record_execution(&self, task_id: &str) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        let now = Utc::now();
        task.execution_count += 1;
        task.last_executed_at = Some(now);
        task.updated_at = now;

        // Check end conditions
        let should_stop = self.check_end_conditions(task);
        if should_stop {
            task.status = TaskStatus::Stopped;
        }

        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Check if task should end based on conditions
    fn check_end_conditions(&self, task: &CronTask) -> bool {
        // Check deadline
        if let Some(deadline) = task.end_conditions.deadline {
            if Utc::now() >= deadline {
                log::info!("[CronTask] Task {} reached deadline", task.id);
                return true;
            }
        }

        // Check max executions
        if let Some(max) = task.end_conditions.max_executions {
            if task.execution_count >= max {
                log::info!("[CronTask] Task {} reached max executions ({})", task.id, max);
                return true;
            }
        }

        false
    }

    /// Get tasks that need to be recovered (running status on app restart, enriched)
    pub async fn get_tasks_to_recover(&self) -> Vec<CronTask> {
        let tasks = self.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.status == TaskStatus::Running)
            .cloned()
            .map(enrich_task)
            .collect()
    }

    /// Update task's tab association
    pub async fn update_task_tab(&self, task_id: &str, tab_id: Option<String>) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        task.tab_id = tab_id;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Update task's session ID (called when session is created after task creation)
    pub async fn update_task_session(&self, task_id: &str, session_id: String) -> Result<CronTask, String> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        log::info!("[CronTask] Updating task {} sessionId: {:?} -> {}", task_id, task.session_id, session_id);
        task.session_id = session_id;
        let task_clone = task.clone();
        drop(tasks);

        self.save_to_disk().await?;

        Ok(task_clone)
    }

    /// Shutdown the manager (stop all scheduler loops)
    pub async fn shutdown(&self) {
        let mut shutdown = self.shutdown.write().await;
        *shutdown = true;
        log::info!("[CronTask] Manager shutdown initiated");
    }

    /// Check if shutdown has been requested
    pub async fn is_shutdown(&self) -> bool {
        let shutdown = self.shutdown.read().await;
        *shutdown
    }
}

// ============ Helper Functions ============

/// Check if task should end based on conditions (static version for use in scheduler)
fn check_end_conditions_static(task: &CronTask) -> bool {
    // Check deadline
    if let Some(deadline) = task.end_conditions.deadline {
        if Utc::now() >= deadline {
            log::info!("[CronTask] Task {} reached deadline", task.id);
            return true;
        }
    }

    // Check max executions
    if let Some(max) = task.end_conditions.max_executions {
        if task.execution_count >= max {
            log::info!("[CronTask] Task {} reached max executions ({})", task.id, max);
            return true;
        }
    }

    false
}

/// Execute a task directly via Sidecar (without going through frontend)
/// Returns (success, ai_exit_reason, output_text, internal_session_id) tuple
async fn execute_task_directly(
    handle: &AppHandle,
    task: &CronTask,
    is_first_execution: bool,
) -> Result<(bool, Option<String>, Option<String>, Option<String>), String> {
    log::info!("[CronTask] execute_task_directly starting for task {}", task.id);

    // Emit debug event: entering function
    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": "execute_task_directly: entering function"
    }));

    // Get SidecarManager state
    let sidecar_state = match handle.try_state::<ManagedSidecarManager>() {
        Some(state) => {
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": "execute_task_directly: got SidecarManager state"
            }));
            state
        }
        None => {
            log::error!("[CronTask] SidecarManager state not available for task {}", task.id);
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": "execute_task_directly: SidecarManager state NOT available",
                "error": true
            }));
            return Err("SidecarManager state not available".to_string());
        }
    };

    log::info!("[CronTask] Got SidecarManager state for task {}", task.id);

    // Convert run_mode enum to string for payload
    let run_mode_str = match task.run_mode {
        RunMode::SingleSession => "single_session",
        RunMode::NewSession => "new_session",
    };

    // Build execution payload
    // execution_number is 1-based (first execution = 1)
    let execution_number = task.execution_count + 1;
    let payload = CronExecutePayload {
        task_id: task.id.clone(),
        prompt: task.prompt.clone(),
        session_id: Some(task.session_id.clone()),
        is_first_execution: Some(is_first_execution),
        ai_can_exit: Some(task.end_conditions.ai_can_exit),
        permission_mode: Some(task.permission_mode.clone()),
        model: task.model.clone(),
        provider_env: task.provider_env.as_ref().map(|env| ProviderEnv {
            base_url: env.base_url.clone(),
            api_key: env.api_key.clone(),
            api_protocol: env.api_protocol.clone(),
            max_output_tokens: env.max_output_tokens,
            max_output_tokens_param_name: env.max_output_tokens_param_name.clone(),
            upstream_format: env.upstream_format.clone(),
        }),
        run_mode: Some(run_mode_str.to_string()),
        interval_minutes: Some(task.interval_minutes),
        execution_number: Some(execution_number),
    };

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: calling execute_cron_task, workspace={}", task.workspace_path)
    }));

    log::info!("[CronTask] Built payload for task {}, calling execute_cron_task with workspace: {}", task.id, task.workspace_path);

    // Execute via Sidecar
    let result = execute_cron_task(handle, &sidecar_state, &task.workspace_path, payload).await
        .map_err(|e| {
            log::error!("[CronTask] execute_cron_task failed for task {}: {}", task.id, e);
            let _ = handle.emit("cron:debug", serde_json::json!({
                "taskId": task.id,
                "message": format!("execute_task_directly: execute_cron_task FAILED: {}", e),
                "error": true
            }));
            e
        })?;

    let _ = handle.emit("cron:debug", serde_json::json!({
        "taskId": task.id,
        "message": format!("execute_task_directly: execute_cron_task completed, task_success={}", result.success)
    }));

    log::info!("[CronTask] execute_cron_task completed for task {}, task_success={}", task.id, result.success);

    // Send notification if enabled
    if task.notify_enabled {
        send_task_notification(handle, task, &result);
    }

    let ai_exit_reason = if result.ai_requested_exit == Some(true) {
        result.exit_reason
    } else {
        None
    };

    Ok((result.success, ai_exit_reason, result.output_text, result.session_id))
}

/// Stop a task, unregister CronTask user, and deactivate its session (internal helper)
/// Used by scheduler when end conditions are met or AI requests exit
/// With Session-centric Sidecar (Owner model), this releases CronTask's ownership.
async fn stop_task_internal(
    handle: &AppHandle,
    tasks: &Arc<RwLock<HashMap<String, CronTask>>>,
    task_id: &str,
    exit_reason: Option<String>,
) {
    // Get session ID before updating status
    let session_id = {
        let tasks_guard = tasks.read().await;
        tasks_guard.get(task_id).map(|t| t.session_id.clone())
    };

    let Some(session_id) = session_id else {
        log::warn!("[CronTask] Task {} not found in stop_task_internal", task_id);
        return;
    };

    // Release CronTask's ownership of the Session Sidecar
    if let Some(sidecar_state) = handle.try_state::<ManagedSidecarManager>() {
        let owner = SidecarOwner::CronTask(task_id.to_string());
        match release_session_sidecar(&sidecar_state, &session_id, &owner) {
            Ok(stopped) => {
                if stopped {
                    log::info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar stopped",
                        task_id, session_id
                    );
                } else {
                    log::info!(
                        "[CronTask] Released CronTask {} from session {}, Sidecar continues",
                        task_id, session_id
                    );
                }
            }
            Err(e) => {
                log::error!(
                    "[CronTask] Failed to release CronTask {} from session {}: {}",
                    task_id, session_id, e
                );
            }
        }

        // Deactivate session (for legacy session tracking)
        if let Ok(mut manager) = sidecar_state.lock() {
            manager.deactivate_session(&session_id);
            log::info!("[CronTask] Deactivated session {} for stopped task {}", session_id, task_id);
        }
    }

    // Update task status
    {
        let mut tasks_guard = tasks.write().await;
        if let Some(task) = tasks_guard.get_mut(task_id) {
            task.status = TaskStatus::Stopped;
            task.exit_reason = exit_reason.clone();
        }
    }

    // Save to disk
    if let Some(parent) = dirs::home_dir() {
        let storage_path = parent.join(".pm-copilot").join("cron_tasks.json");
        let tasks_guard = tasks.read().await;
        let store = CronTaskStore {
            tasks: tasks_guard.values().cloned().collect(),
        };
        if let Ok(content) = serde_json::to_string_pretty(&store) {
            let _ = fs::write(&storage_path, content);
        }
    }

    // Emit stopped event
    let _ = handle.emit("cron:task-stopped", serde_json::json!({
        "taskId": task_id,
        "exitReason": exit_reason
    }));

    log::info!("[CronTask] Task {} stopped", task_id);
}

/// Send system notification for task execution
fn send_task_notification(
    handle: &AppHandle,
    task: &CronTask,
    result: &crate::sidecar::CronExecuteResponse,
) {
    let title = if result.success {
        "定时任务执行完成".to_string()
    } else {
        "定时任务执行失败".to_string()
    };

    let body = if let Some(ref reason) = result.exit_reason {
        format!("AI 主动结束: {}", reason)
    } else if let Some(ref error) = result.error {
        format!("错误: {}", error)
    } else {
        format!("任务 #{} 已完成", task.execution_count + 1)
    };

    // Use tauri notification plugin — include tab_id for frontend navigation
    let _ = handle.emit("notification:show", serde_json::json!({
        "title": title,
        "body": body,
        "tabId": task.tab_id
    }));
}

/// Global singleton instance
static CRON_TASK_MANAGER: std::sync::OnceLock<CronTaskManager> = std::sync::OnceLock::new();

/// Get the global CronTaskManager instance
pub fn get_cron_task_manager() -> &'static CronTaskManager {
    CRON_TASK_MANAGER.get_or_init(CronTaskManager::new)
}

// ============ Tauri Commands ============

/// Create a new cron task
#[tauri::command]
pub async fn cmd_create_cron_task(config: CronTaskConfig) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.create_task(config).await
}

/// Start a cron task
/// The cron task Sidecar will be started on-demand when the first execution runs
#[tauri::command]
pub async fn cmd_start_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    let task = manager.start_task(&task_id).await?;

    log::info!(
        "[CronTask] Started cron task {} for workspace {}",
        task.id, task.workspace_path
    );

    // Emit event so frontend task list refreshes immediately
    let _ = app_handle.emit("cron:task-started", serde_json::json!({
        "taskId": task.id,
    }));

    Ok(task)
}

/// Stop a cron task (with optional exit reason)
/// exit_reason can be set when AI calls ExitCronTask or end conditions are met
#[tauri::command]
pub async fn cmd_stop_cron_task(task_id: String, exit_reason: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.stop_task(&task_id, exit_reason).await
}

/// Delete a cron task
#[tauri::command]
pub async fn cmd_delete_cron_task(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.delete_task(&task_id).await?;
    let _ = app_handle.emit("cron:task-deleted", serde_json::json!({ "taskId": task_id }));
    Ok(())
}

/// Get a cron task by ID
#[tauri::command]
pub async fn cmd_get_cron_task(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))
}

/// Get all cron tasks
#[tauri::command]
pub async fn cmd_get_cron_tasks() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_all_tasks().await)
}

/// Get cron tasks for a workspace
#[tauri::command]
pub async fn cmd_get_workspace_cron_tasks(workspace_path: String) -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_for_workspace(&workspace_path).await)
}

/// Get active cron task for a session (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_session_cron_task(sessionId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_session(&sessionId).await)
}

/// Get active cron task for a tab (running only)
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_get_tab_cron_task(tabId: String) -> Result<Option<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_active_task_for_tab(&tabId).await)
}

/// Record task execution (called by Sidecar after execution completes)
#[tauri::command]
pub async fn cmd_record_cron_execution(task_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.record_execution(&task_id).await
}

/// Update task's tab association
#[tauri::command]
pub async fn cmd_update_cron_task_tab(task_id: String, tab_id: Option<String>) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_tab(&task_id, tab_id).await
}

/// Update task's session ID (called when session is created after task creation)
#[tauri::command]
pub async fn cmd_update_cron_task_session(task_id: String, session_id: String) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();
    manager.update_task_session(&task_id, session_id).await
}

/// Get tasks that need recovery (tasks that were running before app restart)
#[tauri::command]
pub async fn cmd_get_tasks_to_recover() -> Result<Vec<CronTask>, String> {
    let manager = get_cron_task_manager();
    Ok(manager.get_tasks_to_recover().await)
}

/// Start the scheduler for a task
/// This function is called both for initial task start and for recovery after app restart.
/// With Session-centric Sidecar (Owner model), this ensures CronTask is added as owner.
#[tauri::command]
pub async fn cmd_start_cron_scheduler(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<(), String> {
    log::info!("[CronTask] cmd_start_cron_scheduler called for task: {}", task_id);

    let manager = get_cron_task_manager();
    log::debug!("[CronTask] Got manager, getting task...");

    // Get task info for session activation
    let task = manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found: {}", task_id))?;
    log::debug!("[CronTask] Got task: {}, session_id: {}", task_id, task.session_id);

    // Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    if let Some(sidecar_state) = app_handle.try_state::<ManagedSidecarManager>() {
        log::debug!("[CronTask] Got sidecar state, ensuring session sidecar...");

        // Clone data for spawn_blocking (requires 'static lifetime)
        let app_handle_clone = app_handle.clone();
        let sidecar_state_clone = sidecar_state.inner().clone();
        let session_id = task.session_id.clone();
        let workspace_path = task.workspace_path.clone();
        let owner = SidecarOwner::CronTask(task_id.clone());
        let task_id_for_log = task_id.clone();
        let tab_id = task.tab_id.clone();

        log::info!("[CronTask] Calling ensure_session_sidecar for session: {}", session_id);

        // Run blocking sidecar operations in a dedicated thread pool
        let result = tokio::task::spawn_blocking(move || {
            let workspace = std::path::Path::new(&workspace_path);
            ensure_session_sidecar(&app_handle_clone, &sidecar_state_clone, &session_id, workspace, owner)
        })
        .await
        .map_err(|e| format!("spawn_blocking failed: {}", e))?;

        match result {
            Ok(result) => {
                log::info!(
                    "[CronTask] Ensured Sidecar for session {} (port={}, is_new={})",
                    task.session_id, result.port, result.is_new
                );

                // Activate session (for legacy session tracking)
                if let Ok(mut sidecar_manager) = sidecar_state.lock() {
                    sidecar_manager.activate_session(
                        task.session_id.clone(),
                        tab_id,
                        Some(task_id_for_log),
                        result.port,
                        task.workspace_path.clone(),
                        true, // is_cron_task = true
                    );
                }
            }
            Err(e) => {
                log::error!(
                    "[CronTask] Failed to ensure Sidecar for task {}: {}",
                    task_id, e
                );
                return Err(e);
            }
        }
    }

    // Start the scheduler loop
    manager.start_task_scheduler(&task_id).await
}

/// Mark a task as currently executing (called when execution starts)
#[tauri::command]
pub async fn cmd_mark_task_executing(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_executing(&task_id).await;
    Ok(())
}

/// Mark a task as no longer executing (called when execution completes)
#[tauri::command]
pub async fn cmd_mark_task_complete(task_id: String) -> Result<(), String> {
    let manager = get_cron_task_manager();
    manager.mark_task_complete(&task_id).await;
    Ok(())
}

/// Check if a task is currently executing
#[tauri::command]
pub async fn cmd_is_task_executing(task_id: String) -> Result<bool, String> {
    let manager = get_cron_task_manager();
    Ok(manager.is_task_executing(&task_id).await)
}

/// Get execution history (run records) for a cron task
#[tauri::command]
pub fn cmd_get_cron_runs(task_id: String, limit: Option<usize>) -> Result<Vec<CronRunRecord>, String> {
    Ok(read_cron_runs(&task_id, limit.unwrap_or(20)))
}

/// Update editable fields of a cron task (name, prompt, schedule, endConditions)
/// If the task is running, it will be stopped, updated, and restarted.
#[tauri::command]
pub async fn cmd_update_cron_task_fields(
    app_handle: tauri::AppHandle,
    task_id: String,
    name: Option<String>,
    prompt: Option<String>,
    schedule: Option<CronSchedule>,
    interval_minutes: Option<u32>,
    end_conditions: Option<EndConditions>,
    notify_enabled: Option<bool>,
    model: Option<String>,
    permission_mode: Option<String>,
    delivery: Option<CronDelivery>,
    clear_delivery: Option<bool>,
) -> Result<CronTask, String> {
    let manager = get_cron_task_manager();

    // Check if task was running — if so, stop first, update, then restart
    let was_running = {
        let task = manager.get_task(&task_id).await
            .ok_or_else(|| format!("Task not found: {}", task_id))?;
        task.status == TaskStatus::Running
    };

    if was_running {
        manager.stop_task(&task_id, None).await?;
        // Clear active_schedulers to prevent start_task_scheduler from short-circuiting
        // (stop_task sets status=Stopped but the old scheduler tokio task may not have
        // polled the status change and removed itself from the set yet)
        {
            let mut active = manager.active_schedulers.write().await;
            active.remove(&task_id);
        }
    }

    // Apply updates
    {
        let mut tasks = manager.tasks.write().await;
        let task = tasks.get_mut(&task_id)
            .ok_or_else(|| format!("Task not found: {}", task_id))?;

        if let Some(n) = name { task.name = Some(n); }
        if let Some(p) = prompt { task.prompt = p; }
        if let Some(s) = schedule {
            // Also update interval_minutes for legacy compatibility
            if let CronSchedule::Every { minutes, .. } = &s {
                task.interval_minutes = *minutes;
            }
            task.schedule = Some(s);
        }
        if let Some(im) = interval_minutes { task.interval_minutes = im; }
        if let Some(ec) = end_conditions { task.end_conditions = ec; }
        if let Some(ne) = notify_enabled { task.notify_enabled = ne; }
        if let Some(m) = model { task.model = Some(m); }
        if let Some(pm) = permission_mode { task.permission_mode = pm; }
        if let Some(d) = delivery { task.delivery = Some(d); }
        else if clear_delivery == Some(true) { task.delivery = None; }
        task.updated_at = Utc::now();
    }

    manager.save_to_disk().await?;

    if was_running {
        manager.start_task(&task_id).await?;
        manager.start_task_scheduler(&task_id).await?;
    }

    let _ = app_handle.emit("cron:task-updated", serde_json::json!({ "taskId": task_id }));

    manager.get_task(&task_id).await
        .ok_or_else(|| format!("Task not found after update: {}", task_id))
}

/// Deliver cron task completion result to IM Bot (v0.1.21)
/// 1. POST system event to the Bot's Sidecar for heartbeat to pick up
/// 2. Wake the Bot's heartbeat runner
async fn deliver_cron_result_to_bot(
    handle: &AppHandle,
    delivery: &CronDelivery,
    task_id: &str,
    summary: &str,
) {
    ulog_info!(
        "[CronTask] Delivering result for task {} to bot {} (platform: {})",
        task_id, delivery.bot_id, delivery.platform
    );

    // 1. Find the Bot's sidecar port and POST system event
    // First check ManagedAgents (v0.1.41), then fall back to ManagedImBots (legacy)
    let im_state: tauri::State<'_, crate::im::ManagedImBots> = match handle.try_state() {
        Some(s) => s,
        None => {
            ulog_warn!("[CronTask] Cannot deliver result: IM state not available");
            return;
        }
    };

    // Extract Arc refs from instance, then drop guard early to avoid
    // holding the lock during potentially slow ensure_sidecar (~2s).
    let (router, current_model, current_provider_env, mcp_servers_json, wake_tx) = {
        // Try Agent state first (v0.1.41)
        let agent_refs = if let Some(agent_state) = handle.try_state::<crate::im::ManagedAgents>() {
            let agents_guard = agent_state.lock().await;
            let mut found = None;
            for (_agent_id, agent) in agents_guard.iter() {
                if let Some(ch) = agent.channels.get(&delivery.bot_id) {
                    found = Some((
                        std::sync::Arc::clone(&ch.bot_instance.router),
                        std::sync::Arc::clone(&ch.bot_instance.current_model),
                        std::sync::Arc::clone(&ch.bot_instance.current_provider_env),
                        std::sync::Arc::clone(&ch.bot_instance.mcp_servers_json),
                        ch.bot_instance.heartbeat_wake_tx.clone(),
                    ));
                    break;
                }
            }
            found
        } else {
            None
        };

        if let Some(refs) = agent_refs {
            refs
        } else {
            // Fall back to legacy ManagedImBots
            let im_guard = im_state.lock().await;
            let instance = match im_guard.get(&delivery.bot_id) {
                Some(i) => i,
                None => {
                    ulog_warn!(
                        "[CronTask] Cannot deliver result: Bot {} not found or not running. \
                         Task result stored in execution history only. \
                         User needs to start the channel in Agent settings.",
                        delivery.bot_id
                    );
                    return;
                }
            };
            (
                std::sync::Arc::clone(&instance.router),
                std::sync::Arc::clone(&instance.current_model),
                std::sync::Arc::clone(&instance.current_provider_env),
                std::sync::Arc::clone(&instance.mcp_servers_json),
                instance.heartbeat_wake_tx.clone(),
            )
        }
    }; // guards dropped here

    let sidecar_manager = match handle.try_state::<ManagedSidecarManager>() {
        Some(s) => s,
        None => {
            ulog_warn!("[CronTask] Cannot deliver result: SidecarManager state not available");
            return;
        }
    };

    // 1. Ensure sidecar is running and POST system event.
    // Same ensure_sidecar pattern as heartbeat — if sidecar was idle-collected, wake it up
    // so the system event is stored in-process memory before heartbeat drains it.
    let session_key = {
        let router_guard = router.lock().await;
        router_guard.find_any_peer_session().map(|(key, _, _)| key)
    };

    if let Some(session_key) = session_key {
        let (port, is_new_sidecar) = {
            let mut router_guard = router.lock().await;
            match router_guard.ensure_sidecar(&session_key, handle, &sidecar_manager).await {
                Ok(result) => result,
                Err(e) => {
                    ulog_warn!("[CronTask] Failed to ensure sidecar for bot {}: {}", delivery.bot_id, e);
                    // Still try to wake heartbeat below
                    (0, false)
                }
            }
        };

        // Sync AI config for newly created sidecar
        if is_new_sidecar && port > 0 {
            let model = current_model.read().await.clone();
            let penv = current_provider_env.read().await.clone();
            let mcp = mcp_servers_json.read().await.clone();
            router.lock().await
                .sync_ai_config(port, model.as_deref(), mcp.as_deref(), penv.as_ref())
                .await;
            ulog_info!("[CronTask] Woke up sidecar for bot {} on port {}", delivery.bot_id, port);
        }

        if port > 0 {
            let client = crate::local_http::builder().build().unwrap_or_default();
            let url = format!("http://127.0.0.1:{}/api/im/system-event", port);
            let body = serde_json::json!({
                "event": "cron_complete",
                "content": summary,
                "taskId": task_id,
            });
            match client.post(&url).json(&body).send().await {
                Ok(_) => ulog_info!("[CronTask] Delivered system event to bot {} sidecar", delivery.bot_id),
                Err(e) => ulog_warn!("[CronTask] Failed to deliver system event: {}", e),
            }
        }
    }

    // 2. Wake the heartbeat runner
    if let Some(ref wake_tx) = wake_tx {
        let reason = crate::im::types::WakeReason::CronComplete {
            task_id: task_id.to_string(),
            summary: summary.to_string(),
        };
        if let Err(e) = wake_tx.send(reason).await {
            ulog_warn!("[CronTask] Failed to wake heartbeat: {}", e);
        } else {
            ulog_info!("[CronTask] Heartbeat wake sent for bot {}", delivery.bot_id);
        }
    }
}

/// Initialize cron task manager with app handle (called during app setup)
/// Now includes unified recovery logic (方案 A: Rust 统一恢复)
/// Emits "cron:manager-ready" event when initialization is complete
/// Emits "cron:task-recovered" for each recovered task
/// Emits "cron:recovery-summary" after all recovery attempts complete
pub async fn initialize_cron_manager(handle: AppHandle) {
    let manager = get_cron_task_manager();
    manager.set_app_handle(handle.clone()).await;
    ulog_info!("[CronTask] Manager initialized with app handle");

    // Recover running tasks (方案 A: Rust 层统一恢复)
    recover_running_tasks(&handle).await;

    // Emit event to notify frontend that cron manager is ready
    // Frontend no longer needs to call recoverCronTasks
    let _ = handle.emit("cron:manager-ready", serde_json::json!({}));
    ulog_info!("[CronTask] Emitted cron:manager-ready event");
}

/// Recover all tasks that were running before app restart (方案 A: Rust 统一恢复)
/// This function:
/// 1. Gets all tasks with status=Running
/// 2. For each task: starts Sidecar, activates session, starts scheduler
/// 3. Emits cron:task-recovered for each success
/// 4. Emits cron:recovery-summary when done
async fn recover_running_tasks(handle: &AppHandle) {
    let manager = get_cron_task_manager();
    let tasks_to_recover = manager.get_tasks_to_recover().await;

    if tasks_to_recover.is_empty() {
        ulog_info!("[CronTask] No tasks to recover");
        // Emit empty summary
        let _ = handle.emit("cron:recovery-summary", CronRecoverySummaryPayload {
            total_tasks: 0,
            recovered_count: 0,
            failed_count: 0,
            failed_tasks: vec![],
        });
        return;
    }

    ulog_info!("[CronTask] Recovering {} task(s)...", tasks_to_recover.len());

    let mut recovered_count = 0u32;
    let mut failed_tasks: Vec<CronRecoveryFailedTask> = vec![];

    for task in &tasks_to_recover {
        match try_recover_single_task(handle, task).await {
            Ok(port) => {
                recovered_count += 1;
                ulog_info!("[CronTask] Recovered task {} on port {}", task.id, port);

                // Emit task-recovered event for frontend
                let _ = handle.emit("cron:task-recovered", CronTaskRecoveredPayload {
                    task_id: task.id.clone(),
                    session_id: task.session_id.clone(),
                    workspace_path: task.workspace_path.clone(),
                    port,
                    status: "running".to_string(),
                    execution_count: task.execution_count,
                    interval_minutes: task.interval_minutes,
                });
            }
            Err(e) => {
                ulog_error!("[CronTask] Failed to recover task {}: {}", task.id, e);
                failed_tasks.push(CronRecoveryFailedTask {
                    task_id: task.id.clone(),
                    workspace_path: task.workspace_path.clone(),
                    error: e,
                });
            }
        }
    }

    let total = tasks_to_recover.len() as u32;
    let failed_count = failed_tasks.len() as u32;

    ulog_info!(
        "[CronTask] Recovery complete: {}/{} tasks recovered, {} failed",
        recovered_count, total, failed_count
    );

    // Emit recovery summary
    let _ = handle.emit("cron:recovery-summary", CronRecoverySummaryPayload {
        total_tasks: total,
        recovered_count,
        failed_count,
        failed_tasks,
    });
}

/// Try to recover a single task
/// Returns the Sidecar port on success
async fn try_recover_single_task(handle: &AppHandle, task: &CronTask) -> Result<u16, String> {
    ulog_info!(
        "[CronTask] Recovering task {} for workspace {}",
        task.id, task.workspace_path
    );

    // Step 1: Ensure Session has a Sidecar with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let sidecar_state = handle.try_state::<ManagedSidecarManager>()
        .ok_or_else(|| "SidecarManager state not available".to_string())?;

    // Clone data for spawn_blocking (requires 'static lifetime)
    let handle_clone = handle.clone();
    let sidecar_state_clone = sidecar_state.inner().clone();
    let session_id = task.session_id.clone();
    let workspace_path = task.workspace_path.clone();
    let task_id = task.id.clone();
    let tab_id = task.tab_id.clone();
    let owner = SidecarOwner::CronTask(task_id.clone());

    // Run blocking sidecar operations in a dedicated thread pool
    let result = tokio::task::spawn_blocking(move || {
        let workspace = std::path::Path::new(&workspace_path);
        ensure_session_sidecar(&handle_clone, &sidecar_state_clone, &session_id, workspace, owner)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    ulog_info!(
        "[CronTask] Session {} Sidecar ensured: port={}, is_new={}",
        task.session_id, result.port, result.is_new
    );

    // Step 2: Activate session (for legacy session tracking)
    {
        let mut manager = sidecar_state.lock()
            .map_err(|e| format!("Failed to lock SidecarManager: {}", e))?;

        manager.activate_session(
            task.session_id.clone(),
            tab_id,
            Some(task_id),
            result.port,
            task.workspace_path.clone(),
            true, // is_cron_task = true
        );
        ulog_info!("[CronTask] Session {} activated for task {}", task.session_id, task.id);
    }

    // Step 3: Start scheduler
    let cron_manager = get_cron_task_manager();
    cron_manager.start_task_scheduler(&task.id).await?;
    ulog_info!("[CronTask] Scheduler started for task {}", task.id);

    Ok(result.port)
}
