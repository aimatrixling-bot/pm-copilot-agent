// Sidecar process management module
// Handles spawning, monitoring, and shutting down multiple Bun backend server instances
// Supports per-Tab isolation with independent Sidecar processes

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::sync::Once;
use std::thread;
use std::time::Duration;

use crate::{ulog_info, ulog_warn, ulog_error, ulog_debug};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::proxy_config;

// Ensure file descriptor limit is increased only once (unix only)
#[cfg(unix)]
static RLIMIT_INIT: Once = Once::new();

/// Increase file descriptor limit to prevent "low max file descriptors" error from Bun
/// This is especially important on macOS where the default soft limit is often 2560
#[cfg(unix)]
fn ensure_high_file_descriptor_limit() {
    RLIMIT_INIT.call_once(|| {
        use libc::{getrlimit, setrlimit, rlimit, RLIMIT_NOFILE};

        unsafe {
            let mut rlim = rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };

            // Get current limits
            if getrlimit(RLIMIT_NOFILE, &mut rlim) == 0 {
                let old_soft = rlim.rlim_cur;
                let hard_limit = rlim.rlim_max;

                // Only increase if current soft limit is below a reasonable threshold
                // Target: at least 65536, or hard limit if lower
                let target = std::cmp::min(65536, hard_limit);

                if old_soft < target {
                    rlim.rlim_cur = target;

                    if setrlimit(RLIMIT_NOFILE, &rlim) == 0 {
                        ulog_info!(
                            "[sidecar] Increased file descriptor limit: {} -> {} (hard limit: {})",
                            old_soft, target, hard_limit
                        );
                    } else {
                        ulog_warn!(
                            "[sidecar] Failed to increase file descriptor limit (current: {}, target: {})",
                            old_soft, target
                        );
                    }
                } else {
                    ulog_info!(
                        "[sidecar] File descriptor limit already sufficient: {} (hard: {})",
                        old_soft, hard_limit
                    );
                }
            } else {
                ulog_warn!("[sidecar] Failed to get current file descriptor limit");
            }
        }
    });
}

#[cfg(not(unix))]
fn ensure_high_file_descriptor_limit() {
    // No-op on non-Unix systems
}

// Configuration constants
const BASE_PORT: u16 = 31415;
// Health check: 600 attempts × 500ms ≈ 5 min upper bound.
// In practice localhost TCP fails instantly (~1ms), so real wall-time ≈ 600 × 500ms = 5 min.
// The generous limit accommodates Windows Defender first-run scanning of bun.exe,
// which can hold the process for 20-30s before any code executes.
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 600;
const HEALTH_CHECK_DELAY_MS: u64 = 500;
const HEALTH_CHECK_TIMEOUT_MS: u64 = 100;
// HTTP health check for existing sidecar.
// 2000ms accommodates Windows systems under startup load (Defender, proxy, Plugin Bridge init).
// Previously 500ms which caused false "unhealthy" during busy startup windows.
const HTTP_HEALTH_CHECK_TIMEOUT_MS: u64 = 2000;
// Grace period after sidecar creation during which the health monitor skips checks.
// Prevents the monitor from killing a sidecar that's still completing its initial startup
// (TCP health check, Bun init, Plugin Bridge, etc.), especially on Windows with Defender.
const STARTUP_GRACE_SECS: u64 = 45;
#[cfg(unix)]
const GRACEFUL_SHUTDOWN_TIMEOUT_SECS: u64 = 5;
// Port range: 500 ports (31415-31914)
const PORT_RANGE: u16 = 500;
// Special identifier for global sidecar (used by Settings page)
pub const GLOBAL_SIDECAR_ID: &str = "__global__";
// Process identification marker (used to identify our sidecar processes)
// This marker is added to all sidecar commands for reliable process identification
const SIDECAR_MARKER: &str = "--pm-copilot-sidecar";

// Port file for CLI discovery — written when Global Sidecar starts,
// read by `cli.rs` to know which port to connect to.
const PORT_FILE_NAME: &str = "sidecar.port";

// ===== Crashed Bun Tracking =====
// When a bundled bun crashes with STATUS_ACCESS_VIOLATION (0xC0000005, typically AVX2
// incompatibility in VMs), mark it as crashed so subsequent attempts fall through to system bun.
static CRASHED_BUN_PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[allow(dead_code)] // Only called from #[cfg(windows)] blocks; harmless on other platforms
fn mark_bun_as_crashed(path: &std::path::Path) {
    let normalized = normalize_external_path(path.to_path_buf());
    // unwrap_or_else recovers from Mutex poisoning — the body is trivial (Vec::push),
    // so the data is still consistent even if a previous holder panicked.
    let mut paths = CRASHED_BUN_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    if !paths.iter().any(|p| p == &normalized) {
        paths.push(normalized.clone());
        ulog_warn!(
            "[sidecar] Marked bun as crashed (will try system fallback on next attempt): {:?}",
            normalized
        );
    }
}

fn is_bun_crashed(path: &std::path::Path) -> bool {
    let normalized = normalize_external_path(path.to_path_buf());
    let paths = CRASHED_BUN_PATHS.lock().unwrap_or_else(|e| e.into_inner());
    paths.iter().any(|x| x == &normalized)
}

/// On Windows, check if the process exited with STATUS_ACCESS_VIOLATION (0xC0000005)
/// and mark the bun binary as crashed for fallback to system bun.
#[cfg(target_os = "windows")]
fn maybe_mark_crashed_bun(status: &std::process::ExitStatus, bun_path: &std::path::Path) {
    let code = status.code().unwrap_or(0) as u32;
    if code == 0xc0000005 {
        mark_bun_as_crashed(bun_path);
    }
}

// ===== Port File for CLI Discovery =====

/// Write the Global Sidecar port to ~/.pm-copilot/sidecar.port so the CLI can discover it.
fn write_global_port_file(port: u16) {
    if let Some(home) = dirs::home_dir() {
        let port_file = home.join(".pm-copilot").join(PORT_FILE_NAME);
        if let Err(e) = std::fs::write(&port_file, port.to_string()) {
            ulog_warn!("[sidecar] Failed to write port file {:?}: {}", port_file, e);
        } else {
            ulog_info!("[sidecar] Wrote CLI port file: {:?} = {}", port_file, port);
        }
    }
}

/// Remove the port file (called on app exit / sidecar shutdown).
fn remove_global_port_file() {
    if let Some(home) = dirs::home_dir() {
        let port_file = home.join(".pm-copilot").join(PORT_FILE_NAME);
        let _ = std::fs::remove_file(&port_file);
    }
}

// ===== Proxy Configuration =====
// Default values (must match TypeScript PROXY_DEFAULTS in types.ts)
// Proxy configuration is now managed by the shared proxy_config module
// See src/proxy_config.rs for implementation details

/// Cleanup stale sidecar processes from previous app instances
/// This should be called on app startup before creating the SidecarManager
/// Cleans up:
/// 1. Bun sidecar processes (identified by SIDECAR_MARKER)
/// 2. SDK child processes (claude-agent-sdk/cli.js)
/// 3. MCP child processes (~/.pm-copilot/mcp/)
///
/// Note: This runs BEFORE logging is initialized, so we use eprintln! for debugging
pub fn cleanup_stale_sidecars() {
    // Use eprintln! because this runs before tauri_plugin_log is initialized
    eprintln!("[sidecar] Cleaning up stale sidecar processes...");

    // Remove stale port file from previous crashed instance
    remove_global_port_file();

    #[cfg(unix)]
    {
        // 1. Clean up bun sidecar processes (our main sidecar)
        let sidecar_count = kill_processes_by_pattern("sidecar", SIDECAR_MARKER, true);

        // 2. Clean up SDK child processes
        // These are spawned by SDK and don't have our marker
        // Pattern matches: bun .../claude-agent-sdk/cli.js
        let sdk_count = kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

        // 3. Clean up MCP child processes from our installation
        // Pattern matches: bun ~/.pm-copilot/mcp/.../cli.js
        // This is specific to our MCP installation path, won't affect other apps
        let mcp_count = kill_processes_by_pattern("MCP", ".pm-copilot/mcp/", true);

        // 4. Clean up MCP servers launched via bun x / npx (not under ~/.pm-copilot/mcp/)
        let mcp_ext1 = kill_processes_by_pattern("MCP-ext", "@playwright/mcp", true);
        let mcp_ext2 = kill_processes_by_pattern("MCP-ext", "@anthropic-ai/mcp", true);

        eprintln!(
            "[sidecar] Startup cleanup complete: {} sidecar, {} SDK, {} MCP, {} MCP-ext processes cleaned",
            sidecar_count, sdk_count, mcp_count, mcp_ext1 + mcp_ext2
        );
    }

    #[cfg(windows)]
    {
        // Windows: Clean up all related processes
        // 1. Clean up bun sidecar processes (our main sidecar)
        kill_windows_processes_by_pattern(SIDECAR_MARKER);

        // 2. Clean up SDK child processes
        kill_windows_processes_by_pattern("claude-agent-sdk");

        // 3. Clean up MCP child processes
        kill_windows_processes_by_pattern(".pm-copilot\\mcp\\");

        // 4. Clean up MCP servers launched via bun x / npx
        // npm package names use forward slashes even on Windows
        kill_windows_processes_by_pattern("@playwright/mcp");
        kill_windows_processes_by_pattern("@anthropic-ai/mcp");

        // 5. Clean up bundled Node.js processes (MCP servers started via bundled npx)
        kill_windows_processes_by_pattern("\\PM Copilot\\nodejs\\");

        // Verify cleanup completed (max 1 second wait)
        let start = std::time::Instant::now();
        let max_wait = Duration::from_secs(1);
        loop {
            if !has_windows_processes(SIDECAR_MARKER)
                && !has_windows_processes("claude-agent-sdk")
                && !has_windows_processes(".pm-copilot\\mcp\\")
                && !has_windows_processes("\\PM Copilot\\nodejs\\")
            {
                ulog_info!("[sidecar] Windows cleanup verified in {:?}", start.elapsed());
                break;
            }
            if start.elapsed() > max_wait {
                ulog_warn!("[sidecar] Windows cleanup timeout after 1s, some processes may remain");
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Find PIDs by command line pattern, excluding current process
/// Note: Uses "--" separator before pattern to handle patterns starting with "-"
/// (e.g., "--pm-copilot-sidecar" would otherwise be interpreted as a pgrep option)
#[cfg(unix)]
fn find_pids_by_pattern(pattern: &str) -> Vec<i32> {
    let current_pid = std::process::id() as i32;

    Command::new("pgrep")
        .args(["-f", "--", pattern])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<i32>().ok())
                // Exclude current process to avoid self-kill
                .filter(|&pid| pid != current_pid)
                .collect()
        })
        .unwrap_or_default()
}

/// Kill processes by pattern with optional SIGKILL fallback
/// - name: descriptive name for logging
/// - pattern: command line pattern to match
/// - force_kill: if true, use SIGKILL for processes that don't respond to SIGTERM
/// Returns: number of processes killed
///
/// Note: Uses eprintln! because this may run before tauri_plugin_log is initialized
#[cfg(unix)]
fn kill_processes_by_pattern(name: &str, pattern: &str, force_kill: bool) -> usize {
    let pids = find_pids_by_pattern(pattern);
    if pids.is_empty() {
        return 0;
    }

    eprintln!("[sidecar] Found {} {} processes, sending SIGTERM...", pids.len(), name);

    // First try SIGTERM for graceful shutdown
    for pid in &pids {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }

    if !force_kill {
        return pids.len(); // Assume all killed (can't verify without waiting)
    }

    // Wait briefly for graceful shutdown
    thread::sleep(Duration::from_millis(300));

    // Check if any processes survived, use SIGKILL if needed
    let remaining = find_pids_by_pattern(pattern);
    if !remaining.is_empty() {
        eprintln!(
            "[sidecar] {} {} processes didn't respond to SIGTERM, using SIGKILL...",
            remaining.len(), name
        );
        for pid in &remaining {
            unsafe {
                libc::kill(*pid, libc::SIGKILL);
            }
        }
    }

    let final_remaining = find_pids_by_pattern(pattern);
    let killed_count = pids.len() - final_remaining.len();
    eprintln!("[sidecar] {} cleanup complete, killed {}/{} processes", name, killed_count, pids.len());
    killed_count
}



// ============= Session-Centric Sidecar Architecture =============
// Sidecar is a service process for Sessions, not for Tabs or CronTasks.
// Multiple owners (Tabs, CronTasks) can share a Session's Sidecar.

/// Owner of a Sidecar - can be a Tab, CronTask, or BackgroundCompletion
/// When all owners release, the Sidecar is stopped.
#[derive(Debug, Clone, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum SidecarOwner {
    /// Tab ID that owns part of this Sidecar
    Tab(String),
    /// Cron Task ID that owns part of this Sidecar
    CronTask(String),
    /// Background completion owner - keeps Sidecar alive while AI finishes responding
    /// String is the session ID for identification
    BackgroundCompletion(String),
    /// Agent owner - keeps Sidecar alive for IM/Agent message processing
    /// String is the session_key (e.g. "agent:{agentId}:{channel}:{type}:{id}")
    Agent(String),
}

/// Explicit three-state lifecycle for a SessionSidecar.
///
/// Replaces the previous `healthy: bool` which conflated Starting (process alive,
/// not yet healthy) with Dead (process exited), causing race conditions where
/// health monitors would kill Starting sidecars.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarState {
    /// Process spawned, `wait_for_health` in progress — do not kill.
    Starting,
    /// TCP health check passed (`wait_for_health`), ready to serve requests.
    Healthy,
    /// Process exited or health check permanently failed.
    Dead,
}

/// Session-centric Sidecar instance
/// Each Session has at most one Sidecar, shared by multiple owners.
pub struct SessionSidecar {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Session ID this Sidecar serves
    pub session_id: String,
    /// Workspace path for this session
    /// Reserved for future use (e.g., workspace-aware operations)
    #[allow(dead_code)]
    pub workspace_path: PathBuf,
    /// Lifecycle state: Starting → Healthy → Dead
    pub state: SidecarState,
    /// Set of owners (Tabs and CronTasks) that are using this Sidecar
    pub owners: HashSet<SidecarOwner>,
    /// Creation timestamp
    /// Reserved for future use (e.g., TTL-based cleanup)
    #[allow(dead_code)]
    pub created_at: std::time::Instant,
}

impl SessionSidecar {
    /// Is this sidecar healthy and ready to accept requests?
    pub fn is_reusable(&self) -> bool {
        matches!(self.state, SidecarState::Healthy)
    }

    /// Is this sidecar still starting up? (process alive, `wait_for_health` in progress)
    pub fn is_starting(&self) -> bool {
        matches!(self.state, SidecarState::Starting)
    }

    /// Is this sidecar dead?
    /// Also auto-detects process exit and transitions Starting/Healthy → Dead.
    pub fn is_dead(&mut self) -> bool {
        if self.state == SidecarState::Dead {
            return true;
        }
        // Check if the process actually exited while we thought it was alive
        match self.process.try_wait() {
            Ok(Some(_)) => {
                self.state = SidecarState::Dead;
                true
            }
            Ok(None) => false, // Still running
            Err(_) => {
                self.state = SidecarState::Dead;
                true
            }
        }
    }

    /// Check if this Sidecar has any owners
    /// Reserved for future use (e.g., lifecycle management)
    #[allow(dead_code)]
    pub fn has_owners(&self) -> bool {
        !self.owners.is_empty()
    }

    /// Add an owner to this Sidecar
    pub fn add_owner(&mut self, owner: SidecarOwner) {
        self.owners.insert(owner);
    }

    /// Remove an owner from this Sidecar
    /// Returns true if this was the last owner (Sidecar should be stopped)
    pub fn remove_owner(&mut self, owner: &SidecarOwner) -> bool {
        self.owners.remove(owner);
        self.owners.is_empty()
    }
}

/// Ensure Sidecar process is killed when SessionSidecar is dropped
impl Drop for SessionSidecar {
    fn drop(&mut self) {
        ulog_info!(
            "[sidecar] Drop: killing SessionSidecar for session {} on port {} (state: {:?})",
            self.session_id, self.port, self.state
        );
        let _ = kill_process(&mut self.process);
    }
}

/// Single Sidecar instance (legacy - used only for Global Sidecar).
/// Still uses `healthy: bool` since the Global Sidecar is a singleton
/// without the multi-owner race conditions that motivated `SidecarState`.
pub struct SidecarInstance {
    /// The child process handle
    pub process: Child,
    /// Port this instance is running on
    pub port: u16,
    /// Agent directory (None for global sidecar)
    pub agent_dir: Option<PathBuf>,
    /// Whether the sidecar passed initial health check
    pub healthy: bool,
    /// Whether this is a global sidecar (uses temp directory)
    pub is_global: bool,
    /// When this instance was created — used by health monitor to apply startup grace period.
    /// During the grace window the monitor skips health checks, preventing false "unhealthy"
    /// verdicts while the sidecar is still initialising (TCP check, Bun startup, Plugin Bridge…).
    pub created_at: std::time::Instant,
}

impl SidecarInstance {
    /// Check if the sidecar process is still running
    /// This actively checks the process rather than just relying on the healthy flag
    pub fn is_running(&mut self) -> bool {
        if !self.healthy {
            return false;
        }
        
        // Try to check if process has exited
        match self.process.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                self.healthy = false;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                self.healthy = false;
                false
            }
        }
    }
}

/// Ensure Bun process is killed when SidecarInstance is dropped
impl Drop for SidecarInstance {
    fn drop(&mut self) {
        ulog_info!("[sidecar] Drop: killing process on port {}", self.port);
        let _ = kill_process(&mut self.process);
        
        // Clean up temp directory for global sidecar
        if self.is_global {
            if let Some(ref dir) = self.agent_dir {
                ulog_info!("[sidecar] Cleaning up temp directory: {:?}", dir);
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

/// Session activation record
/// Tracks which Sidecar is currently "activating" a Session
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionActivation {
    /// Session ID being activated
    pub session_id: String,
    /// Tab ID that owns this activation (None for headless cron tasks)
    pub tab_id: Option<String>,
    /// Cron task ID if activated by cron task
    pub task_id: Option<String>,
    /// Port of the Sidecar handling this session
    pub port: u16,
    /// Workspace path
    pub workspace_path: String,
    /// Whether this is a cron task activation
    pub is_cron_task: bool,
}

/// Sidecar info for external queries
/// Reserved for future use (e.g., admin UI, debugging endpoints)
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub workspace_path: String,
    pub is_healthy: bool,
}

/// Multi-instance Sidecar Manager
/// Manages multiple Sidecar processes with Session singleton support
///
/// Architecture (v0.1.11 - Session-Centric):
/// - Sessions own Sidecars (1:1 relationship between Session and Sidecar)
/// - Multiple owners (Tabs, CronTasks) can share a Session's Sidecar
/// - Sidecar only stops when all owners release
///
/// Legacy support (v0.1.10):
/// - instances: per-Tab Sidecar instances (for backward compatibility)
/// - cron_task_instances: dedicated cron task Sidecars (for backward compatibility)
pub struct SidecarManager {
    // ===== New Session-Centric Storage (v0.1.11) =====
    /// Session ID -> SessionSidecar (primary storage for Session-centric model)
    sidecars: HashMap<String, SessionSidecar>,

    // ===== Legacy Storage (kept for backward compatibility) =====
    /// Tab ID -> Sidecar Instance (legacy, used for Global Sidecar)
    instances: HashMap<String, SidecarInstance>,
    /// Session ID -> Session Activation (tracks which session is active for Session singleton)
    session_activations: HashMap<String, SessionActivation>,
    /// Port counter for allocation (starts from BASE_PORT)
    port_counter: AtomicU16,
    /// Session ID -> generation counter. Incremented each time a sidecar is created
    /// for a session. Used to detect replacements during lock-gap HTTP health checks.
    sidecar_generations: HashMap<String, u64>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            sidecars: HashMap::new(),
            instances: HashMap::new(),
            session_activations: HashMap::new(),
            port_counter: AtomicU16::new(BASE_PORT),
            sidecar_generations: HashMap::new(),
        }
    }

    /// Increment and return the generation counter for a session.
    fn next_generation(&mut self, session_id: &str) -> u64 {
        let gen = self.sidecar_generations.entry(session_id.to_string()).or_insert(0);
        *gen += 1;
        *gen
    }

    /// Get the current generation counter for a session (0 if never created).
    fn current_generation(&self, session_id: &str) -> u64 {
        self.sidecar_generations.get(session_id).copied().unwrap_or(0)
    }

    /// Get the next available port with max attempts to prevent infinite loop
    pub fn allocate_port(&self) -> Result<u16, String> {
        const MAX_ATTEMPTS: u32 = 200;
        
        for _ in 0..MAX_ATTEMPTS {
            let port = self.port_counter.fetch_add(1, Ordering::SeqCst);
            
            // Reset counter if we've gone past the range
            if port > BASE_PORT + PORT_RANGE {
                self.port_counter.store(BASE_PORT, Ordering::SeqCst);
            }
            
            if is_port_available(port) {
                return Ok(port);
            }
        }
        
        Err(format!("No available port found after {} attempts", MAX_ATTEMPTS))
    }

    /// Check if a Tab has a running instance
    #[allow(dead_code)]
    pub fn has_instance(&self, tab_id: &str) -> bool {
        self.instances.contains_key(tab_id)
    }

    /// Get instance status for a Tab
    pub fn get_instance(&self, tab_id: &str) -> Option<&SidecarInstance> {
        self.instances.get(tab_id)
    }

    /// Get mutable instance reference
    pub fn get_instance_mut(&mut self, tab_id: &str) -> Option<&mut SidecarInstance> {
        self.instances.get_mut(tab_id)
    }

    /// Insert a new instance
    pub fn insert_instance(&mut self, tab_id: String, instance: SidecarInstance) {
        self.instances.insert(tab_id, instance);
    }

    /// Remove and return an instance (will be dropped, killing the process)
    pub fn remove_instance(&mut self, tab_id: &str) -> Option<SidecarInstance> {
        self.instances.remove(tab_id)
    }

    /// Get all Tab IDs
    #[allow(dead_code)]
    pub fn tab_ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }

    /// Iterate over all instances (tab_id, instance)
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn iter_instances(&self) -> impl Iterator<Item = (&String, &SidecarInstance)> {
        self.instances.iter()
    }

    /// Get all unique ports of running Sidecars (session-centric + legacy global).
    /// Used for broadcasting config changes (e.g. proxy hot-reload) to all Sidecars.
    pub fn get_all_active_ports(&mut self) -> Vec<u16> {
        let mut ports = Vec::new();
        // Session-centric sidecars (Tab/CronTask/BackgroundCompletion)
        for sc in self.sidecars.values_mut() {
            if !sc.is_dead() {
                ports.push(sc.port);
            }
        }
        // Legacy instances (Global Sidecar)
        for inst in self.instances.values_mut() {
            if inst.is_running() {
                ports.push(inst.port);
            }
        }
        ports.sort();
        ports.dedup();
        ports
    }

    /// Stop all instances (session sidecars and global sidecar)
    pub fn stop_all(&mut self) {
        ulog_info!(
            "[sidecar] Stopping all instances (sessions: {}, global: {})",
            self.sidecars.len(),
            self.instances.len()
        );
        self.sidecars.clear(); // Session-centric Sidecars (Drop kills processes)
        self.instances.clear(); // Global Sidecar (Drop kills process)
        self.session_activations.clear();
        self.sidecar_generations.clear();
        // Remove port file so CLI knows the sidecar is down
        remove_global_port_file();
    }

    // ============= Session Activation Methods =============

    /// Get session activation by session ID
    pub fn get_session_activation(&self, session_id: &str) -> Option<&SessionActivation> {
        self.session_activations.get(session_id)
    }

    /// Activate a session (associate it with a Sidecar)
    pub fn activate_session(
        &mut self,
        session_id: String,
        tab_id: Option<String>,
        task_id: Option<String>,
        port: u16,
        workspace_path: String,
        is_cron_task: bool,
    ) {
        ulog_info!(
            "[sidecar] Activating session {} on port {}, tab: {:?}, task: {:?}, cron: {}",
            session_id, port, tab_id, task_id, is_cron_task
        );
        self.session_activations.insert(
            session_id.clone(),
            SessionActivation {
                session_id,
                tab_id,
                task_id,
                port,
                workspace_path,
                is_cron_task,
            },
        );
    }

    /// Deactivate a session
    pub fn deactivate_session(&mut self, session_id: &str) -> Option<SessionActivation> {
        ulog_info!("[sidecar] Deactivating session {}", session_id);
        self.session_activations.remove(session_id)
    }

    /// Update session activation's tab_id (e.g., when a Tab connects to headless Sidecar)
    pub fn update_session_tab(&mut self, session_id: &str, tab_id: Option<String>) {
        if let Some(activation) = self.session_activations.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Updating session {} tab: {:?} -> {:?}",
                session_id, activation.tab_id, tab_id
            );
            activation.tab_id = tab_id;
            // If a tab connects, it's no longer a pure cron task session
            if activation.tab_id.is_some() {
                activation.is_cron_task = false;
            }
        }
    }

    /// Get all active sessions for a workspace
    /// Reserved for future use (e.g., debugging, admin UI)
    #[allow(dead_code)]
    pub fn get_workspace_sessions(&self, workspace_path: &str) -> Vec<&SessionActivation> {
        self.session_activations
            .values()
            .filter(|a| a.workspace_path == workspace_path)
            .collect()
    }

    // ============= Session-Centric Sidecar API (v0.1.11) =============

    /// Get the port for a Session's Sidecar
    pub fn get_session_port(&self, session_id: &str) -> Option<u16> {
        self.sidecars.get(session_id).map(|s| s.port)
    }

    /// Check if a Session has an active Sidecar (Starting or Healthy)
    /// Reserved for future use (e.g., debugging, health checks)
    #[allow(dead_code)]
    pub fn has_session_sidecar(&mut self, session_id: &str) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            !sidecar.is_dead()
        } else {
            false
        }
    }

    /// Get SessionSidecar reference by session ID
    /// Reserved for future use (e.g., debugging, introspection)
    #[allow(dead_code)]
    pub fn get_session_sidecar(&self, session_id: &str) -> Option<&SessionSidecar> {
        self.sidecars.get(session_id)
    }

    /// Get mutable SessionSidecar reference by session ID
    /// Reserved for future use (e.g., advanced owner management)
    #[allow(dead_code)]
    pub fn get_session_sidecar_mut(&mut self, session_id: &str) -> Option<&mut SessionSidecar> {
        self.sidecars.get_mut(session_id)
    }

    /// Get session IDs that have a BackgroundCompletion owner
    /// Used by Task Center to show [后台] tags on sessions
    pub fn get_background_session_ids(&self) -> Vec<String> {
        self.sidecars.iter()
            .filter(|(_, sc)| sc.owners.iter().any(|o| matches!(o, SidecarOwner::BackgroundCompletion(_))))
            .map(|(sid, _)| sid.clone())
            .collect()
    }

    /// Insert a sidecar and auto-increment its generation counter.
    /// This ensures every creation is tracked for lock-gap race detection.
    fn insert_sidecar(&mut self, session_id: &str, sidecar: SessionSidecar) {
        self.next_generation(session_id);
        self.sidecars.insert(session_id.to_string(), sidecar);
    }

    /// Remove a sidecar. Does NOT clear the generation counter — it must remain
    /// queryable across lock gaps (e.g. during HTTP health check windows).
    fn remove_sidecar(&mut self, session_id: &str) -> Option<SessionSidecar> {
        self.sidecars.remove(session_id)
    }

    /// Clear the generation counter for a session.
    /// Call only when the session is permanently done (last owner released).
    fn clear_generation(&mut self, session_id: &str) {
        self.sidecar_generations.remove(session_id);
    }

    /// Add an owner to a Session's Sidecar
    /// Returns true if owner was added, false if session doesn't exist
    /// Reserved for future use (e.g., explicit owner management)
    #[allow(dead_code)]
    pub fn add_session_owner(&mut self, session_id: &str, owner: SidecarOwner) -> bool {
        if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Adding owner {:?} to session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.add_owner(owner);
            true
        } else {
            false
        }
    }

    /// Remove an owner from a Session's Sidecar
    /// If this was the last owner, the Sidecar is removed (and killed via Drop)
    /// Returns (was_removed, sidecar_was_stopped)
    pub fn remove_session_owner(&mut self, session_id: &str, owner: &SidecarOwner) -> (bool, bool) {
        let should_stop = if let Some(sidecar) = self.sidecars.get_mut(session_id) {
            ulog_info!(
                "[sidecar] Removing owner {:?} from session {} (port {})",
                owner, session_id, sidecar.port
            );
            sidecar.remove_owner(owner) // Returns true if this was the last owner
        } else {
            return (false, false);
        };

        if should_stop {
            ulog_info!(
                "[sidecar] Last owner removed from session {}, stopping Sidecar",
                session_id
            );
            self.remove_sidecar(session_id);
            (true, true)
        } else {
            (true, false)
        }
    }

    /// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
    /// This updates the key in both sidecars and session_activations HashMaps
    /// without stopping the Sidecar.
    ///
    /// Returns true if the upgrade was successful.
    pub fn upgrade_session_id(&mut self, old_session_id: &str, new_session_id: &str) -> bool {
        ulog_info!(
            "[sidecar] Upgrading session ID: {} -> {}",
            old_session_id, new_session_id
        );

        let mut upgraded = false;

        // 1. Upgrade in sidecars HashMap
        // NOTE: Direct HashMap access (not insert_sidecar/remove_sidecar) because this is
        // a key rename, not a creation. Generation is migrated separately in step 2.
        if let Some(mut sidecar) = self.sidecars.remove(old_session_id) {
            // Update the session_id field in the sidecar itself
            sidecar.session_id = new_session_id.to_string();
            self.sidecars.insert(new_session_id.to_string(), sidecar);
            ulog_info!(
                "[sidecar] Upgraded sidecars HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        // 2. Migrate generation counter
        if let Some(gen) = self.sidecar_generations.remove(old_session_id) {
            self.sidecar_generations.insert(new_session_id.to_string(), gen);
        }

        // 3. Upgrade in session_activations HashMap
        if let Some(mut activation) = self.session_activations.remove(old_session_id) {
            // Update the session_id field in the activation itself
            activation.session_id = new_session_id.to_string();
            self.session_activations.insert(new_session_id.to_string(), activation);
            ulog_info!(
                "[sidecar] Upgraded session_activations HashMap: {} -> {}",
                old_session_id, new_session_id
            );
            upgraded = true;
        }

        if !upgraded {
            ulog_debug!(
                "[sidecar] No entries found for session {} to upgrade",
                old_session_id
            );
        }

        upgraded
    }

    /// Check if a session's Sidecar has persistent background owners (CronTask or Agent)
    /// that will keep it alive after a Tab releases its ownership.
    pub fn session_has_persistent_owners(&self, session_id: &str) -> bool {
        self.sidecars
            .get(session_id)
            .map(|s| s.owners.iter().any(|o| matches!(o, SidecarOwner::CronTask(_) | SidecarOwner::Agent(_))))
            .unwrap_or(false)
    }

}

impl Default for SidecarManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure all processes are killed when manager is dropped
impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// Thread-safe managed state wrapper
pub type ManagedSidecarManager = Arc<Mutex<SidecarManager>>;

/// Create a new managed sidecar manager
pub fn create_sidecar_manager() -> ManagedSidecarManager {
    Arc::new(Mutex::new(SidecarManager::new()))
}

// ============= Legacy compatibility types =============
// These are kept for backward compatibility during migration
// 
// TODO(PRD 0.1.0): Remove legacy API after confirming all frontend code
// uses the new multi-instance API (startTabSidecar, stopTabSidecar, etc.)
// 
// Legacy functions to remove:
// - start_sidecar, stop_sidecar, get_sidecar_status
// - restart_sidecar, ensure_sidecar_running, check_process_alive
// - cmd_start_sidecar, cmd_stop_sidecar, cmd_get_sidecar_status
// - cmd_get_server_url, cmd_restart_sidecar, cmd_ensure_sidecar_running
// - cmd_check_sidecar_alive

/// Legacy sidecar status (still used by existing commands)
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub port: u16,
    pub agent_dir: String,
}

/// Legacy managed sidecar type alias
pub type ManagedSidecar = ManagedSidecarManager;

/// Legacy function: create_sidecar_state -> create_sidecar_manager
pub fn create_sidecar_state() -> ManagedSidecar {
    create_sidecar_manager()
}

/// Legacy SidecarConfig with required agent_dir
#[derive(Debug, Clone)]
pub struct LegacySidecarConfig {
    #[allow(dead_code)]
    pub port: u16,
    pub agent_dir: PathBuf,
    #[allow(dead_code)]
    pub initial_prompt: Option<String>,
}

// ============= Core Functions =============

/// Kill a child process (non-blocking)
///
/// - Unix: sends SIGTERM, then spawns a background thread to wait for graceful
///   shutdown and escalate to SIGKILL if the process doesn't exit in time.
/// - Windows: uses `taskkill /T /F` to immediately kill the entire process tree
///   (including SDK subprocess and MCP servers). No background wait needed.
///
/// Returns immediately, making it suitable for use in Drop implementations.
fn kill_process(child: &mut Child) -> std::io::Result<()> {
    let pid = child.id();

    #[cfg(unix)]
    {
        // Kill the entire process group (negative PID) so SDK CLI + MCP servers are also signaled
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // taskkill /T kills the entire process tree (including SDK subprocess and MCP servers)
        // taskkill /F forces termination
        let result = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        match result {
            Ok(output) => {
                if !output.status.success() {
                    // taskkill failed (process may have already exited), fallback to child.kill()
                    let _ = child.kill();
                }
            }
            Err(_) => {
                // taskkill command not available, fallback
                let _ = child.kill();
            }
        }
    }

    // Spawn a background thread to wait for graceful shutdown
    // This ensures we don't block the caller (important for UI responsiveness)
    // The thread will force kill if the process doesn't exit within timeout
    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            // taskkill /T /F already synchronously terminated the process tree,
            // no need for background polling on Windows
            let _ = pid; // suppress unused variable
            return;
        }

        #[cfg(unix)]
        {
            let timeout = Duration::from_secs(GRACEFUL_SHUTDOWN_TIMEOUT_SECS);
            let start = std::time::Instant::now();

            loop {
                // Use waitpid with WNOHANG to check without blocking
                let mut status: i32 = 0;
                let result = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };

                if result > 0 {
                    // Direct child exited; give group members a brief grace period then SIGKILL the group
                    ulog_debug!("[sidecar] Process {} exited gracefully, cleaning up process group", pid);
                    std::thread::sleep(Duration::from_millis(500));
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                    return;
                } else if result < 0 {
                    // Error (process might already be gone)
                    ulog_debug!("[sidecar] Process {} already gone or error", pid);
                    return;
                }
                // result == 0 means process still running

                if start.elapsed() > timeout {
                    ulog_warn!("[sidecar] Process {} didn't exit after SIGTERM, force killing process group", pid);
                    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                    return;
                }

                thread::sleep(Duration::from_millis(50));
            }
        }
    });

    Ok(())
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Normalize a path for use with external processes.
///
/// On Windows, Tauri's `resource_dir()` and Rust's `current_exe()` / `canonicalize()`
/// return paths with the `\\?\` extended-length prefix. Most external tools (Bun, Node,
/// npm) cannot handle this prefix — they silently hang or fail.
///
/// This function strips the prefix on Windows; on other platforms it's a no-op.
pub(crate) fn normalize_external_path(path: PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let s = path.to_string_lossy();
        if let Some(stripped) = s.strip_prefix("\\\\?\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// Diagnose why bun executable was not found and return a user-friendly error message.
fn diagnose_bun_not_found<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    let mut details = Vec::new();

    // Check resource_dir
    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            details.push(format!("resource_dir: {:?}", resource_dir));
            #[cfg(target_os = "windows")]
            {
                let expected = resource_dir.join("bun-x86_64-pc-windows-msvc.exe");
                if !expected.exists() {
                    if let Some(parent) = resource_dir.parent() {
                        let parent_bun = parent.join("bun-x86_64-pc-windows-msvc.exe");
                        if !parent_bun.exists() {
                            details.push("bun binary not found in install directory — may have been quarantined by antivirus".to_string());
                        }
                    }
                }
            }
        }
        Err(e) => {
            details.push(format!("resource_dir() failed: {}", e));
        }
    }

    // Check exe location
    #[cfg(target_os = "windows")]
    if let Ok(exe_path) = std::env::current_exe() {
        details.push(format!("current_exe: {:?}", exe_path));
    }

    let diag = details.join("; ");
    let msg = format!(
        "Bun runtime not found. {} | \
         Possible causes: (1) Antivirus quarantined bun.exe — check Windows Security > Protection History. \
         (2) Installation is corrupted — try reinstalling. \
         Workaround: install Bun manually from https://bun.sh",
        diag
    );
    ulog_error!("[sidecar] {}", msg);
    msg
}

/// Diagnose why bun process exited immediately and return a user-friendly error message.
fn diagnose_immediate_exit(status: &std::process::ExitStatus, bun_path: &std::path::Path) -> String {
    let status_str = format!("{:?}", status);

    #[cfg(target_os = "windows")]
    {
        // On Windows, ExitStatus wraps the process exit code.
        // 0xc0000135 (STATUS_DLL_NOT_FOUND) = missing DLL (e.g., VCRUNTIME140.dll)
        // 0xc0000142 (STATUS_DLL_INIT_FAILED) = DLL initialization failed
        let code = status.code().unwrap_or(0) as u32;
        let hint = match code {
            0xc0000135 => {
                "Missing system DLL (likely VCRUNTIME140.dll). \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000142 => {
                "DLL initialization failed. \
                 Please install Visual C++ Redistributable: \
                 https://aka.ms/vs/17/release/vc_redist.x64.exe"
            }
            0xc0000005 => {
                "STATUS_ACCESS_VIOLATION — bundled bun.exe may require AVX2 instructions \
                 (unsupported in many virtual machines and older CPUs). \
                 Install bun globally via: powershell -c \"irm bun.sh/install.ps1 | iex\" \
                 (or: npm install -g bun). Both auto-select a compatible baseline build. \
                 The app will fall back to the system-installed bun on the next attempt."
            }
            0xc0000022 => {
                "Access denied — antivirus may be blocking bun.exe. \
                 Check Windows Security > Protection History, or add the install directory to exclusions."
            }
            1 => {
                "Bun exited with code 1. Check if Git for Windows is installed \
                 (required by Claude Agent SDK): https://git-scm.com/downloads/win"
            }
            _ => "",
        };

        let msg = if hint.is_empty() {
            format!(
                "Bun process exited immediately (status: {}, code: 0x{:08x}). bun_path: {:?}",
                status_str, code, bun_path
            )
        } else {
            format!(
                "Bun process exited immediately (status: {}, code: 0x{:08x}). {} | bun_path: {:?}",
                status_str, code, hint, bun_path
            )
        };
        ulog_error!("[sidecar] {}", msg);
        return msg;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let msg = format!(
            "Bun process exited immediately with status: {}. bun_path: {:?}",
            status_str, bun_path
        );
        ulog_error!("[sidecar] {}", msg);
        msg
    }
}

/// Helper: check if bun exists at the given directory with platform-specific names
#[cfg(target_os = "windows")]
fn check_bun_in_dir(dir: &std::path::Path, label: &str) -> Option<PathBuf> {
    let win_bun = dir.join("bun-x86_64-pc-windows-msvc.exe");
    let win_bun_simple = dir.join("bun.exe");

    // If ANY bun in this directory is marked as crashed, skip ALL candidates.
    // Both filenames likely point to the same binary, so trying the sibling would just crash again.
    let any_crashed = (win_bun.exists() && is_bun_crashed(&win_bun))
        || (win_bun_simple.exists() && is_bun_crashed(&win_bun_simple));
    if any_crashed {
        ulog_warn!("[sidecar] Skipping all bun candidates from {} (crashed): {:?}", label, dir);
        return None;
    }

    if win_bun.exists() {
        ulog_info!("[sidecar] Using bundled bun from {} (platform): {:?}", label, win_bun);
        return Some(win_bun);
    }
    if win_bun_simple.exists() {
        ulog_info!("[sidecar] Using bundled bun from {} (simple): {:?}", label, win_bun_simple);
        return Some(win_bun_simple);
    }
    None
}

/// Find the bun executable path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
fn find_bun_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_bun_executable_inner(app_handle).map(normalize_external_path)
}

/// Public wrapper for find_bun_executable (used by im::bridge module).
pub fn find_bun_executable_pub<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_bun_executable(app_handle)
}

fn find_bun_executable_inner<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // First, try to find bundled bun via resource_dir
    match app_handle.path().resource_dir() {
        Ok(resource_dir) => {
            ulog_info!("[sidecar] resource_dir resolved to: {:?}", resource_dir);

            #[cfg(target_os = "macos")]
            {
                if let Some(contents_dir) = resource_dir.parent() {
                    // externalBin places binaries in MacOS/ with platform suffix
                    #[cfg(target_arch = "aarch64")]
                    let macos_bun = contents_dir.join("MacOS").join("bun-aarch64-apple-darwin");
                    #[cfg(target_arch = "x86_64")]
                    let macos_bun = contents_dir.join("MacOS").join("bun-x86_64-apple-darwin");

                    if macos_bun.exists() {
                        ulog_info!("Using bundled bun from MacOS: {:?}", macos_bun);
                        return Some(macos_bun);
                    }

                    // Also check without suffix (for backward compatibility)
                    let macos_bun_simple = contents_dir.join("MacOS").join("bun");
                    if macos_bun_simple.exists() {
                        ulog_info!("Using bundled bun from MacOS (simple): {:?}", macos_bun_simple);
                        return Some(macos_bun_simple);
                    }
                }
            }

            #[cfg(target_os = "windows")]
            {
                // Windows NSIS: bun.exe is in the same directory as the main executable.
                // resource_dir() may return either $INSTDIR or $INSTDIR\resources depending
                // on the Tauri version and Windows config. Check both resource_dir itself
                // and its parent to handle both cases.
                if let Some(found) = check_bun_in_dir(&resource_dir, "resource_dir") {
                    return Some(found);
                }
                if let Some(parent) = resource_dir.parent() {
                    if let Some(found) = check_bun_in_dir(parent, "resource_dir parent") {
                        return Some(found);
                    }
                }
            }

            // Check in resource_dir/binaries/ for development mode
            #[cfg(target_os = "windows")]
            let bundled_bun = resource_dir.join("binaries").join("bun.exe");
            #[cfg(not(target_os = "windows"))]
            let bundled_bun = resource_dir.join("binaries").join("bun");

            if bundled_bun.exists() {
                if is_bun_crashed(&bundled_bun) {
                    ulog_warn!("Skipping crashed bundled bun: {:?}", bundled_bun);
                } else {
                    ulog_info!("Using bundled bun: {:?}", bundled_bun);
                    return Some(bundled_bun);
                }
            }

            #[cfg(target_os = "macos")]
            {
                #[cfg(target_arch = "aarch64")]
                let platform_bun = resource_dir.join("binaries").join("bun-aarch64-apple-darwin");
                #[cfg(target_arch = "x86_64")]
                let platform_bun = resource_dir.join("binaries").join("bun-x86_64-apple-darwin");

                if platform_bun.exists() {
                    ulog_info!("Using bundled platform bun: {:?}", platform_bun);
                    return Some(platform_bun);
                }
            }

            #[cfg(target_os = "windows")]
            {
                let platform_bun = resource_dir.join("binaries").join("bun-x86_64-pc-windows-msvc.exe");
                if platform_bun.exists() {
                    if is_bun_crashed(&platform_bun) {
                        ulog_warn!("Skipping crashed bundled platform bun: {:?}", platform_bun);
                    } else {
                        ulog_info!("Using bundled platform bun: {:?}", platform_bun);
                        return Some(platform_bun);
                    }
                }
            }
        }
        Err(e) => {
            ulog_warn!("[sidecar] resource_dir() failed: {}, will try exe-relative fallback", e);
        }
    }

    // Fallback: find bun relative to the current executable (most reliable on Windows)
    #[cfg(target_os = "windows")]
    {
        match std::env::current_exe() {
            Ok(exe_path) => {
                ulog_info!("[sidecar] current_exe: {:?}", exe_path);
                if let Some(exe_dir) = exe_path.parent() {
                    if let Some(found) = check_bun_in_dir(exe_dir, "exe_dir") {
                        return Some(found);
                    }
                }
            }
            Err(e) => {
                ulog_warn!("[sidecar] current_exe() failed: {}", e);
            }
        }
    }

    // Fallback: system locations
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            format!(
                "{}\\.bun\\bin\\bun.exe",
                std::env::var("USERPROFILE").unwrap_or_default()
            ),
            format!(
                "{}\\bun\\bin\\bun.exe",
                std::env::var("LOCALAPPDATA").unwrap_or_default()
            ),
            format!(
                "{}\\bun\\bun.exe",
                std::env::var("PROGRAMFILES").unwrap_or_default()
            ),
        ];

        for candidate in &candidates {
            let path = PathBuf::from(candidate);
            if path.exists() {
                ulog_info!("Using system bun: {:?}", path);
                return Some(path);
            }
        }

        // Try to find bun in PATH (augmented with common system dirs)
        if let Some(path) = crate::system_binary::find("bun.exe")
            .or_else(|| crate::system_binary::find("bun"))
        {
            ulog_info!("Using bun from PATH: {:?}", path);
            return Some(path);
        }

        ulog_error!("[sidecar] Bun executable not found in any location. Checked: resource_dir, exe_dir, system locations, PATH");
        return None;
    }

    #[cfg(not(target_os = "windows"))]
    {
        // Try well-known paths first, then fall back to augmented PATH search.
        // system_binary::find already includes /opt/homebrew/bin etc., but checking
        // explicit paths is faster and covers ~/.bun/bin which isn't in the standard list.
        let home = std::env::var("HOME").unwrap_or_default();
        let explicit_paths = [
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ];
        for candidate in explicit_paths {
            let path = PathBuf::from(candidate);
            if path.exists() {
                ulog_info!("Using system bun: {:?}", path);
                return Some(path);
            }
        }
        // ~/.bun/bin/bun (user-local install)
        let user_bun = PathBuf::from(format!("{}/.bun/bin/bun", home));
        if user_bun.exists() {
            ulog_info!("Using system bun: {:?}", user_bun);
            return Some(user_bun);
        }

        crate::system_binary::find("bun")
    }
}

/// Find the server script path.
/// Returns a normalized path safe for `Command::new()` (no `\\?\` prefix on Windows).
fn find_server_script<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    find_server_script_inner(app_handle).map(normalize_external_path)
}

fn find_server_script_inner<R: Runtime>(_app_handle: &AppHandle<R>) -> Option<PathBuf> {
    // 1. First check for bundled server-dist.js (Production)
    // Modified: Only check bundled script in Release mode, so Dev mode uses source
    #[cfg(debug_assertions)]
    ulog_info!("[sidecar] Debug mode detected, SKIPPING bundled script check (forcing source usage)");

    #[cfg(not(debug_assertions))]
    {
        match _app_handle.path().resource_dir() {
            Ok(resource_dir) => {
                let bundled_script = resource_dir.join("server-dist.js");
                if bundled_script.exists() {
                    ulog_info!("Using bundled server script (bundled): {:?}", bundled_script);
                    return Some(bundled_script);
                }

                // Legacy check: Check for server/index.ts (Development / Legacy)
                let legacy_script = resource_dir.join("server").join("index.ts");
                if legacy_script.exists() {
                    ulog_info!("Using bundled server script (legacy): {:?}", legacy_script);
                    return Some(legacy_script);
                }
            }
            Err(e) => {
                ulog_warn!("[sidecar] resource_dir() failed for script search: {}", e);
            }
        }

        // Fallback: find server-dist.js relative to current executable
        #[cfg(target_os = "windows")]
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let script = exe_dir.join("server-dist.js");
                if script.exists() {
                    ulog_info!("[sidecar] Using server script from exe_dir: {:?}", script);
                    return Some(script);
                }
            }
        }
    }

    if cfg!(debug_assertions) {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("src").join("server").join("index.ts"));

        if let Some(ref path) = dev_path {
            if path.exists() {
                ulog_info!("Using development server script: {:?}", path);
                return dev_path;
            }
        }

        if let Ok(cwd) = std::env::current_dir() {
            let cwd_path = cwd.join("src").join("server").join("index.ts");
            if cwd_path.exists() {
                ulog_info!("Using cwd server script: {:?}", cwd_path);
                return Some(cwd_path);
            }
        }
    }

    ulog_error!("[sidecar] Server script not found in any location");
    None
}

/// Wait for a new sidecar to become healthy using TCP-level check.
/// For initial startup, TCP check is sufficient and more reliable because:
/// - Bun starts listening on TCP port before HTTP handler is fully ready
/// - TCP check has been proven stable in production
/// Note: For REUSING an existing sidecar, use check_sidecar_http_health() instead
///
/// `alive_check`: optional closure that returns `true` if the sidecar process is still alive.
/// Checked every 20 iterations (~10s) to detect early crashes (e.g., AVX2 0xC0000005 on Windows
/// VMs where Windows Defender delays the crash by 20-30s, bypassing the 50ms early exit check).
fn wait_for_health(port: u16, alive_check: Option<Box<dyn Fn() -> bool>>) -> Result<(), String> {
    let delay = Duration::from_millis(HEALTH_CHECK_DELAY_MS);

    for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
        // Every 20 attempts (~10s), check if process is still alive.
        // This catches crashes that happen after the 50ms early exit check
        // (e.g., Windows Defender scans bun.exe for 20-30s before it executes and crashes).
        if attempt % 20 == 0 {
            if let Some(ref check) = alive_check {
                if !check() {
                    return Err(format!(
                        "Sidecar process exited during health check on port {} (detected at attempt {})",
                        port, attempt
                    ));
                }
            }
        }

        match std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(HEALTH_CHECK_TIMEOUT_MS),
        ) {
            Ok(_) => {
                ulog_info!("[sidecar] TCP health check passed after {} attempts on port {}", attempt, port);
                return Ok(());
            }
            Err(_) => {
                if attempt < HEALTH_CHECK_MAX_ATTEMPTS {
                    thread::sleep(delay);
                }
            }
        }
    }

    Err(format!(
        "Sidecar failed TCP health check after {} attempts on port {}",
        HEALTH_CHECK_MAX_ATTEMPTS, port
    ))
}

/// Quick HTTP health check for existing sidecar (non-blocking style with short timeout)
/// Returns true if the sidecar HTTP server is responsive
fn check_sidecar_http_health(port: u16) -> bool {
    let health_url = format!("http://127.0.0.1:{}/health", port);

    // Short timeout for quick check - sidecar should respond immediately if healthy
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_millis(HTTP_HEALTH_CHECK_TIMEOUT_MS))
        .build() {
        Ok(c) => c,
        Err(_) => return false,
    };

    match client.get(&health_url).send() {
        Ok(response) => response.status().is_success(),
        Err(e) => {
            ulog_warn!("[sidecar] HTTP health check failed on port {}: {}", port, e);
            false
        }
    }
}

// ============= Tab-based Multi-instance Commands =============

/// Start a Sidecar for a specific Tab
/// Each Tab gets its own dedicated Sidecar (1:1 relationship)
pub fn start_tab_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    tab_id: &str,
    agent_dir: Option<PathBuf>,
) -> Result<u16, String> {
    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Check if already running for this tab
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            ulog_info!("[sidecar] Tab {} already has running instance on port {}", tab_id, instance.port);
            return Ok(instance.port);
        }
    }

    // Remove stale instance if exists
    manager_guard.remove_instance(tab_id);

    // Find executables
    let bun_path = find_bun_executable(app_handle)
        .ok_or_else(|| diagnose_bun_not_found(app_handle))?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting for tab {} on port {}, agent_dir: {:?}",
        tab_id, port, agent_dir
    );

    // Build command - 直接用 bun <script> 而非 bun run <script>（更稳定）
    // Add SIDECAR_MARKER for reliable process identification and cleanup
    let mut cmd = crate::process_cmd::new(&bun_path);
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER);

    // Determine if this is a global sidecar and handle agent directory
    let is_global = agent_dir.is_none();
    if is_global {
        cmd.arg("--no-pre-warm");
    }
    let effective_agent_dir = if let Some(ref dir) = agent_dir {
        cmd.arg("--agent-dir").arg(dir);
        Some(dir.clone())
    } else {
        // Global sidecar: use temp directory
        let temp_dir = std::env::temp_dir().join(format!("pm-copilot-global-{}", std::process::id()));
        ulog_info!("[sidecar] Creating temp agent directory: {:?}", temp_dir);

        // Create directory and fail early if unable to create
        std::fs::create_dir_all(&temp_dir).map_err(|e| {
            let err = format!(
                "[sidecar] Failed to create temp directory {:?}: {}. \
                 Check permissions on TEMP directory ({}). \
                 This directory is required for Global Sidecar to store runtime data.",
                temp_dir, e, std::env::temp_dir().display()
            );
            ulog_error!("{}", err);
            err
        })?;

        cmd.arg("--agent-dir").arg(&temp_dir);
        Some(temp_dir)
    };

    // Set working directory to script's parent directory
    // This is crucial for bun to find relative imports
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
        ulog_info!("[sidecar] Working directory set to: {:?}", script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("PM_COPILOT_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Inject runtime type for Agent Runtime selection (v0.1.59)
    // Session sidecars resolve runtime from agent config; global sidecar always uses builtin.
    // This env var is read by the Bun sidecar to decide which runtime to use.
    if !is_global {
        if let Some(ref dir) = agent_dir {
            if let Some(runtime) = resolve_agent_runtime_from_config(dir) {
                cmd.env("PM_COPILOT_RUNTIME", &runtime);
            }
        }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW already applied by process_cmd::new()

    // Unix: Make child a process group leader so kill(-PGID) kills the entire tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 关键诊断日志：打印当前可执行文件路径，确认运行的是正确版本
    ulog_info!("[sidecar] current_exe = {:?}", std::env::current_exe().ok());

    ulog_info!(
        "[sidecar] Spawning: bun={:?}, script={:?}, port={}, is_global={}",
        bun_path, script_path, port, is_global
    );

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        ulog_error!("[sidecar] Failed to spawn: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    ulog_info!("[sidecar] Process spawned with pid: {:?}", child.id());

    // 启动线程捕获 stdout → 写入统一日志（确保 Bun 输出在 unified log 可见）
    if let Some(stdout) = child.stdout.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][{}] {}", tab_id_clone, line);
                }
            }
        });
    }

    // 启动线程捕获 stderr → 写入统一日志
    if let Some(stderr) = child.stderr.take() {
        let tab_id_clone = tab_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                // startupBeacon 故意通过 stderr 输出 startup 进度，降级为 INFO 避免日志噪音
                if line.contains("[startup]") {
                    ulog_info!("[bun-err][{}] {}", tab_id_clone, line);
                } else {
                    ulog_error!("[bun-err][{}] {}", tab_id_clone, line);
                }
            }
        });
    }

    // Brief wait to let stdout/stderr threads capture initial output
    // Reduced from 500ms to 50ms for faster startup
    thread::sleep(Duration::from_millis(50));
    if let Ok(Some(status)) = child.try_wait() {
        // Process exited immediately, wait a bit for stderr thread to capture output
        thread::sleep(Duration::from_millis(100));
        ulog_error!("[sidecar] Process exited immediately with status: {:?}", status);
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_bun(&status, &bun_path);
        let diag = diagnose_immediate_exit(&status, &bun_path);
        return Err(diag);
    }

    // Create instance (not yet healthy)
    let instance = SidecarInstance {
        process: child,
        port,
        agent_dir: effective_agent_dir,
        healthy: false,
        is_global,
        created_at: std::time::Instant::now(),
    };

    manager_guard.insert_instance(tab_id.to_string(), instance);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure — detects process death during health check.
    // Critical for Windows VMs where Defender delays bun.exe execution by 20-30s,
    // causing the crash to happen well after the 50ms early exit check above.
    //
    // Also detects instance replacement: if the health monitor restarts the sidecar
    // while we're waiting, the old port is dead and a new instance sits at a different
    // port under the same tab_id. Checking `instance.port == expected_port` prevents
    // this closure from silently accepting the replacement and looping forever on a
    // dead port.
    let liveness_manager = manager.clone();
    let liveness_tab_id = tab_id.to_string();
    let expected_port = port;
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(instance) = guard.get_instance_mut(&liveness_tab_id) {
                // Reject if the instance was replaced (different port = different process)
                if instance.port != expected_port {
                    return false;
                }
                matches!(instance.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            // Mark as healthy
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                instance.healthy = true;
            }
            Ok(port)
        }
        Err(e) => {
            // Health check failed — diagnostics go to unified log directly
            ulog_error!("[sidecar] Health check failed: {}", e);
            let mut diag = e.clone();

            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
                match instance.process.try_wait() {
                    Ok(Some(status)) => {
                        #[cfg(target_os = "windows")]
                        maybe_mark_crashed_bun(&status, &bun_path);
                        let detail = format!(" | process exited: {:?}", status);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                    Ok(None) => {
                        let detail = " | process alive but not listening. \
                            Possible causes: antivirus slow-scanning bun.exe, or port conflict";
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(detail);
                    }
                    Err(wait_err) => {
                        let detail = format!(" | try_wait error: {}", wait_err);
                        ulog_error!("[sidecar]{}", detail);
                        diag.push_str(&detail);
                    }
                }

                // Note: stderr is already captured by the drain thread → ulog_error!
                // No need to .take() here (it was already taken at spawn time)
            }

            // Remove the failed instance
            manager_guard.remove_instance(tab_id);

            Err(diag)
        }
    }
}

/// Stop a Sidecar for a specific Tab
/// Each Tab has its own Sidecar, so stopping is straightforward
pub fn stop_tab_sidecar(manager: &ManagedSidecarManager, tab_id: &str) -> Result<(), String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if let Some(instance) = manager_guard.remove_instance(tab_id) {
        ulog_info!("[sidecar] Stopped instance for tab {} on port {}", tab_id, instance.port);
        // Instance is dropped here, killing the process
    } else {
        ulog_debug!("[sidecar] No instance found for tab {}", tab_id);
    }

    Ok(())
}

/// Get the server URL for a specific Tab
/// This function checks multiple sources:
/// 1. Direct Tab sidecar instances (Global Sidecar)
/// 2. Session-centric sidecars via session_activations
/// 3. Legacy instances for backward compatibility
pub fn get_tab_server_url(manager: &ManagedSidecarManager, tab_id: &str) -> Result<String, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        if instance.is_running() {
            return Ok(format!("http://127.0.0.1:{}", instance.port));
        }
    }

    // Priority 2: Check session_activations to find the Session-centric sidecar
    let activation_session = manager_guard.session_activations.values()
        .find(|a| a.tab_id.as_deref() == Some(tab_id))
        .map(|a| (a.session_id.clone(), a.port));

    if let Some((session_id, port)) = activation_session {
        // Verify the sidecar is still healthy in Session-centric storage
        let is_healthy = manager_guard.sidecars.get_mut(&session_id)
            .map(|s| s.is_reusable())
            .unwrap_or(false)
            || manager_guard.instances.values_mut()
                .any(|i| i.port == port && i.is_running());

        if is_healthy {
            ulog_info!(
                "[sidecar] Tab {} using session {} sidecar on port {} (via session_activation)",
                tab_id, session_id, port
            );
            return Ok(format!("http://127.0.0.1:{}", port));
        }
    }

    Err(format!("No running sidecar for tab {}", tab_id))
}

/// Get status for a Tab's sidecar
/// This function checks multiple sources (same as get_tab_server_url)
pub fn get_tab_sidecar_status(manager: &ManagedSidecarManager, tab_id: &str) -> Result<SidecarStatus, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    // Priority 1: Check direct Tab sidecar instances (Global Sidecar)
    if let Some(instance) = manager_guard.get_instance_mut(tab_id) {
        return Ok(SidecarStatus {
            running: instance.is_running(),
            port: instance.port,
            agent_dir: instance.agent_dir.as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
        });
    }

    // Priority 2: Check session_activations for Session-centric sidecar
    let activation_info = manager_guard.session_activations.values()
        .find(|a| a.tab_id.as_deref() == Some(tab_id))
        .map(|a| (a.session_id.clone(), a.port, a.workspace_path.clone()));

    if let Some((session_id, port, workspace_path)) = activation_info {
        // Check if the sidecar is healthy in Session-centric storage
        let is_running = manager_guard.sidecars.get_mut(&session_id)
            .map(|s| s.is_reusable())
            .unwrap_or(false)
            || manager_guard.instances.values_mut()
                .any(|i| i.port == port && i.is_running());

        return Ok(SidecarStatus {
            running: is_running,
            port,
            agent_dir: workspace_path,
        });
    }

    // No sidecar found
    Ok(SidecarStatus {
        running: false,
        port: 0,
        agent_dir: String::new(),
    })
}

/// Start the global sidecar (for Settings page)
pub fn start_global_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
) -> Result<u16, String> {
    let port = start_tab_sidecar(app_handle, manager, GLOBAL_SIDECAR_ID, None)?;
    // Write port file so the CLI can discover the running sidecar
    write_global_port_file(port);
    Ok(port)
}

/// Check Global Sidecar status.
/// Returns:
/// - None: sidecar was never started (no instance in manager) → skip
/// - Some((port, true, created_at)):  process alive → do HTTP health check (if past grace)
/// - Some((port, false, created_at)): process dead → needs restart immediately
fn check_global_sidecar_status(manager: &ManagedSidecarManager) -> Option<(u16, bool, std::time::Instant)> {
    let mut guard = manager.lock().ok()?;
    let instance = guard.get_instance_mut(GLOBAL_SIDECAR_ID)?;
    let created_at = instance.created_at;
    Some((instance.port, instance.is_running(), created_at))
}

/// Background health monitor for the Global Sidecar.
/// Periodically checks if the Global Sidecar is alive and auto-restarts it when it dies.
/// Emits `global-sidecar:restarted` Tauri event with the new URL on successful restart.
pub async fn monitor_global_sidecar(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;
    use crate::logger;

    const CHECK_INTERVAL_SECS: u64 = 15;
    const MAX_RESTART_FAILURES: u32 = 5;
    const MAX_BACKOFF_SECS: u64 = 300; // 5 minutes

    let mut consecutive_restart_failures: u32 = 0;
    let mut is_first_check = true;

    logger::info(&app_handle, "[sidecar] Global sidecar health monitor started".to_string());

    loop {
        // First iteration: short delay (let Global Sidecar start up)
        // Subsequent iterations: normal interval or backoff on restart failures
        if is_first_check {
            is_first_check = false;
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        } else if consecutive_restart_failures > 0 {
            // Exponential backoff: 30s, 60s, 120s, 240s, 300s, 300s, ...
            let backoff = std::cmp::min(
                CHECK_INTERVAL_SECS.saturating_mul(2u64.saturating_pow(consecutive_restart_failures)),
                MAX_BACKOFF_SECS,
            );
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        } else {
            tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        }

        if shutdown.load(Relaxed) {
            logger::info(&app_handle, "[sidecar] Global sidecar monitor stopping (app shutdown)".to_string());
            break;
        }

        // Check process status (cheap, no HTTP)
        let (port, process_alive, created_at) = match check_global_sidecar_status(&manager) {
            Some(status) => status,
            None => continue, // Not started yet — skip
        };

        // Startup grace period: skip health checks for recently-created instances.
        // During startup the sidecar may be busy with TCP check, Bun init, Plugin Bridge
        // loading, etc. — an aggressive health check during this window false-fires and
        // triggers an unnecessary restart that cascades into frontend timeout (#58).
        let age = created_at.elapsed();
        if age < Duration::from_secs(STARTUP_GRACE_SECS) {
            if !process_alive {
                // Process died during startup — still worth restarting, but log clearly
                ulog_warn!(
                    "[sidecar] Global sidecar on port {} died during startup (age {:?}), restarting",
                    port, age
                );
                // Fall through to restart below
            } else {
                continue; // Within grace period and process alive — skip check
            }
        }

        let needs_restart = if process_alive {
            // Process alive → verify with HTTP health check (blocking)
            let is_healthy = tokio::task::spawn_blocking(move || {
                check_sidecar_http_health(port)
            })
            .await
            .unwrap_or(false);
            !is_healthy
        } else {
            // Process already dead → definitely needs restart
            true
        };

        if !needs_restart || shutdown.load(Relaxed) {
            // Healthy — reset failure counter
            consecutive_restart_failures = 0;
            continue;
        }

        ulog_warn!("[sidecar] Global sidecar on port {} is unhealthy, auto-restarting...", port);

        // Mark the existing instance as unhealthy so start_global_sidecar() won't
        // short-circuit with "already running". Without this, a hung process (alive
        // but not responding to HTTP) would never be replaced — is_running() checks
        // the healthy flag first, and start_tab_sidecar returns the old port.
        {
            if let Ok(mut guard) = manager.lock() {
                if let Some(instance) = guard.get_instance_mut(GLOBAL_SIDECAR_ID) {
                    instance.healthy = false;
                }
            }
        }

        let app_clone = app_handle.clone();
        let mgr_clone = manager.clone();
        match tokio::task::spawn_blocking(move || {
            start_global_sidecar(&app_clone, &mgr_clone)
        })
        .await
        {
            Ok(Ok(new_port)) => {
                consecutive_restart_failures = 0;
                let new_url = format!("http://127.0.0.1:{}", new_port);
                logger::info(
                    &app_handle,
                    format!("[sidecar] Global sidecar auto-restarted on port {} ({})", new_port, new_url),
                );
                let _ = app_handle.emit("global-sidecar:restarted", &new_url);
            }
            Ok(Err(e)) => {
                consecutive_restart_failures += 1;
                if consecutive_restart_failures >= MAX_RESTART_FAILURES {
                    ulog_error!("[sidecar] Failed to auto-restart global sidecar ({} consecutive failures, backing off): {}", consecutive_restart_failures, e);
                } else {
                    ulog_error!("[sidecar] Failed to auto-restart global sidecar (attempt {}): {}", consecutive_restart_failures, e);
                }
            }
            Err(e) => {
                consecutive_restart_failures += 1;
                ulog_error!("[sidecar] spawn_blocking failed during global sidecar restart: {}", e);
            }
        }
    }
}

/// Monitor all session sidecars and auto-restart dead ones that still have owners.
/// Mirrors the `monitor_global_sidecar()` pattern with backoff tracking.
pub async fn monitor_session_sidecars(
    app_handle: AppHandle,
    manager: ManagedSidecarManager,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 15;
    const MAX_RESTART_FAILURES: u32 = 5;

    // Initial delay: let app fully start before monitoring
    tokio::time::sleep(Duration::from_secs(20)).await;
    ulog_info!("[sidecar] Session sidecar health monitor started");

    // Recovery queue: preserves workspace + owners across failed restarts.
    // When ensure_session_sidecar fails, the dead entry is gone from sidecars
    // but we keep it here so the next cycle can retry.
    struct RecoveryEntry {
        workspace: std::path::PathBuf,
        owners: Vec<SidecarOwner>,
        failures: u32,
    }
    let mut recovery: HashMap<String, RecoveryEntry> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }

        // Phase 1: Scan sidecars for newly dead sessions, merge into recovery queue
        {
            let mut guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => continue,
            };
            for (sid, sc) in guard.sidecars.iter_mut() {
                if sc.is_dead() && !sc.owners.is_empty() && !recovery.contains_key(sid) {
                    recovery.insert(sid.clone(), RecoveryEntry {
                        workspace: sc.workspace_path.clone(),
                        owners: sc.owners.iter().cloned().collect(),
                        failures: 0,
                    });
                }
            }
        }

        // Remove entries that recovered on their own (now healthy in sidecars)
        recovery.retain(|sid, _| {
            manager
                .lock()
                .map(|mut g| {
                    g.sidecars
                        .get_mut(sid)
                        .map(|sc| sc.is_dead())
                        .unwrap_or(true) // not in sidecars → keep in recovery
                })
                .unwrap_or(true)
        });

        if recovery.is_empty() {
            continue;
        }

        // Phase 2: Attempt restart for each entry in recovery queue
        let session_ids: Vec<String> = recovery.keys().cloned().collect();
        for session_id in session_ids {
            if shutdown.load(Relaxed) {
                break;
            }

            let entry = recovery.get(&session_id).unwrap();
            if entry.failures >= MAX_RESTART_FAILURES {
                continue;
            }

            // Remove dead entry from sidecars if still present (re-verify under lock)
            {
                let mut guard = match manager.lock() {
                    Ok(g) => g,
                    Err(_) => continue,
                };
                if let Some(sc) = guard.sidecars.get_mut(&session_id) {
                    if !sc.is_dead() {
                        // Recovered on its own — remove from recovery
                        recovery.remove(&session_id);
                        continue;
                    }
                }
                guard.remove_sidecar(&session_id);
            }

            let first_owner = entry.owners[0].clone();
            let workspace = entry.workspace.clone();
            let owners_snapshot = entry.owners.clone();
            let mgr = manager.clone();
            let app = app_handle.clone();
            let sid = session_id.clone();

            match tokio::task::spawn_blocking(move || {
                ensure_session_sidecar(&app, &mgr, &sid, &workspace, first_owner)
            })
            .await
            {
                Ok(Ok(result)) => {
                    if owners_snapshot.len() > 1 {
                        if let Ok(mut guard) = manager.lock() {
                            if let Some(sc) = guard.sidecars.get_mut(&session_id) {
                                for owner in owners_snapshot.iter().skip(1) {
                                    sc.add_owner(owner.clone());
                                }
                            }
                        }
                    }
                    recovery.remove(&session_id);
                    ulog_info!(
                        "[sidecar] Session {} auto-restarted on port {}",
                        session_id,
                        result.port
                    );
                    let _ = app_handle.emit(
                        "session-sidecar:restarted",
                        serde_json::json!({
                            "sessionId": session_id,
                            "port": result.port,
                        }),
                    );
                }
                Ok(Err(e)) => {
                    if let Some(entry) = recovery.get_mut(&session_id) {
                        entry.failures += 1;
                    }
                    ulog_error!(
                        "[sidecar] Failed to auto-restart session {}: {}",
                        session_id,
                        e
                    );
                }
                Err(e) => {
                    if let Some(entry) = recovery.get_mut(&session_id) {
                        entry.failures += 1;
                    }
                    ulog_error!(
                        "[sidecar] spawn_blocking failed for session {}: {}",
                        session_id,
                        e
                    );
                }
            }
        }
    }
}

// ============= Session-Centric Sidecar API (v0.1.11) =============

/// Result returned from ensure_session_sidecar
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnsureSidecarResult {
    pub port: u16,
    pub is_new: bool,
}

/// Ensure a Session has a Sidecar running, adding the specified owner.
/// If the Session already has a healthy Sidecar, just adds the owner.
/// If no Sidecar exists, creates a new one with the owner.
///
/// Returns (port, is_new) where is_new is true if a new Sidecar was started.
///
/// # WARNING: Blocking Function
/// This function uses `reqwest::blocking::Client` internally (via `check_sidecar_http_health`)
/// which uses `block_on()`. Calling this function from within an async context (tokio runtime)
/// will cause a deadlock or panic.
///
/// When calling from async code, wrap in `tokio::task::spawn_blocking`:
/// ```ignore
/// let result = tokio::task::spawn_blocking(move || {
///     ensure_session_sidecar(&app_handle, &manager, &session_id, workspace_path, owner)
/// })
/// .await
/// .map_err(|e| format!("spawn_blocking failed: {}", e))?;
/// ```
pub fn ensure_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
) -> Result<EnsureSidecarResult, String> {
    ulog_info!("[sidecar] ensure_session_sidecar called for session: {}, owner: {:?}", session_id, owner);

    // Ensure file descriptor limit is high enough for Bun
    ensure_high_file_descriptor_limit();

    ulog_debug!("[sidecar] Acquiring manager lock...");
    let mut manager_guard = manager.lock().map_err(|e| {
        ulog_error!("[sidecar] Failed to acquire manager lock: {}", e);
        e.to_string()
    })?;
    ulog_debug!("[sidecar] Manager lock acquired");

    // Check if Session already has a healthy Sidecar
    // We use a two-phase approach to avoid holding the lock during HTTP check:
    // Phase 1: Check if sidecar exists and get its port (with lock)
    // Phase 2: Do HTTP health check (without lock)
    // Phase 3: Re-acquire lock and finalize decision

    let existing_sidecar_info: Option<u16> = {
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_dead() {
                // Process exited, clean up
                ulog_info!(
                    "[sidecar] Session {} has dead Sidecar process, removing",
                    session_id
                );
                manager_guard.remove_sidecar(session_id);
                None
            } else if sidecar.is_reusable() {
                // Healthy — needs HTTP verification outside the lock
                Some(sidecar.port)
            } else {
                // Starting — another thread is doing wait_for_health, just join
                ulog_info!(
                    "[sidecar] Session {} Sidecar still starting on port {}, adding owner {:?}",
                    session_id, sidecar.port, owner
                );
                sidecar.add_owner(owner);
                return Ok(EnsureSidecarResult { port: sidecar.port, is_new: false });
            }
        } else {
            None
        }
    };

    // If we found a running sidecar, verify HTTP health (with lock released).
    // CRITICAL: The lock is dropped during the 2s HTTP check. Another thread (health monitor)
    // can replace the sidecar during this window. We use a generation counter to detect this
    // and avoid accidentally killing the healthy replacement.
    if let Some(port) = existing_sidecar_info {
        let pre_gen = manager_guard.current_generation(session_id);
        drop(manager_guard);

        // Verify HTTP server is actually responsive (not just process alive)
        let http_healthy = check_sidecar_http_health(port);

        // Re-acquire lock after HTTP check
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        let post_gen = manager_guard.current_generation(session_id);

        if post_gen != pre_gen {
            // Generation changed: another thread replaced the sidecar during our HTTP check.
            // Reuse the replacement if it's alive (Healthy or Starting).
            ulog_info!(
                "[sidecar] Session {} generation changed ({} → {}) during HTTP check on port {}, checking replacement",
                session_id, pre_gen, post_gen, port
            );
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if !sidecar.is_dead() {
                    // Replacement alive (Healthy or Starting) — reuse
                    ulog_info!(
                        "[sidecar] Session {} replacement on port {} is {:?}, adding owner and returning",
                        session_id, sidecar.port, sidecar.state
                    );
                    sidecar.add_owner(owner);
                    return Ok(EnsureSidecarResult {
                        port: sidecar.port,
                        is_new: false,
                    });
                }
            }
            // Replacement sidecar process also dead — fall through to create
        } else if http_healthy {
            // Same generation, HTTP healthy — try to reuse
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port && sidecar.is_reusable() {
                    ulog_info!(
                        "[sidecar] Session {} Sidecar HTTP healthy on port {}, adding owner {:?}",
                        session_id, port, owner
                    );
                    sidecar.add_owner(owner);
                    return Ok(EnsureSidecarResult {
                        port,
                        is_new: false,
                    });
                }
            }
            // Sidecar gone but generation unchanged (removed without replacement)
            ulog_info!(
                "[sidecar] Session {} Sidecar removed during HTTP check, will create new",
                session_id
            );
        } else {
            // Same generation, HTTP unhealthy — safe to remove (no one replaced it)
            ulog_warn!(
                "[sidecar] Session {} Sidecar process alive but HTTP unresponsive on port {}, removing",
                session_id, port
            );
            manager_guard.remove_sidecar(session_id);
        }

        return create_new_session_sidecar(
            app_handle, manager, session_id, workspace_path, owner, manager_guard
        );
    }

    // No existing sidecar found, create a new one with the original guard
    create_new_session_sidecar(
        app_handle, manager, session_id, workspace_path, owner, manager_guard
    )
}

/// Helper function to create a new session sidecar
/// Extracted to avoid code duplication and handle the mutex guard properly
fn create_new_session_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    workspace_path: &std::path::Path,
    owner: SidecarOwner,
    mut manager_guard: std::sync::MutexGuard<'_, SidecarManager>,
) -> Result<EnsureSidecarResult, String> {

    // Guard against double-creation: if another thread already created a sidecar for this
    // session (e.g., health monitor raced with frontend), reuse it instead of spawning another.
    if let Some(existing) = manager_guard.sidecars.get_mut(session_id) {
        if !existing.is_dead() {
            ulog_info!(
                "[sidecar] Session {} already has a {:?} sidecar on port {} (created by another thread), reusing",
                session_id, existing.state, existing.port
            );
            existing.add_owner(owner);
            return Ok(EnsureSidecarResult {
                port: existing.port,
                is_new: false,
            });
        }
        // Exists but process dead — remove before creating fresh
        manager_guard.remove_sidecar(session_id);
    }

    // Need to start a new Sidecar
    // First, find executables
    let bun_path = find_bun_executable(app_handle)
        .ok_or_else(|| diagnose_bun_not_found(app_handle))?;
    let script_path = find_server_script(app_handle)
        .ok_or_else(|| "Server script not found".to_string())?;

    // Allocate port
    let port = manager_guard.allocate_port()?;

    ulog_info!(
        "[sidecar] Starting SessionSidecar for session {} on port {}, owner: {:?}",
        session_id, port, owner
    );

    // Build command
    let mut cmd = crate::process_cmd::new(&bun_path);
    cmd.arg(&script_path)
        .arg("--port")
        .arg(port.to_string())
        .arg(SIDECAR_MARKER)
        .arg("--agent-dir")
        .arg(workspace_path);

    // Pass session_id to Bun for real sessions (not pending-xxx)
    // so Bun uses the same UUID as Rust/SDK, enabling resume on crash recovery
    if !session_id.starts_with("pending-") {
        cmd.arg("--session-id").arg(session_id);
    }

    // Set working directory to script's parent directory
    if let Some(script_dir) = script_path.parent() {
        cmd.current_dir(script_dir);
    }

    // Apply proxy policy: user proxy / inherit system / protect localhost (pit-of-success)
    proxy_config::apply_to_subprocess(&mut cmd);

    // Inject management API port for Bun→Rust IPC (v0.1.21)
    let mgmt_port = crate::management_api::get_management_port();
    if mgmt_port > 0 {
        cmd.env("PM_COPILOT_MANAGEMENT_PORT", mgmt_port.to_string());
    }

    // Inject runtime type for Agent Runtime selection (v0.1.59)
    if let Some(runtime) = resolve_agent_runtime_from_config(workspace_path) {
        cmd.env("PM_COPILOT_RUNTIME", &runtime);
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());

    // Windows: CREATE_NO_WINDOW already applied by process_cmd::new()

    // Unix: Make child a process group leader so kill(-PGID) kills the entire tree
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Spawn
    let mut child = cmd.spawn().map_err(|e| {
        ulog_error!("[sidecar] Failed to spawn SessionSidecar: {}", e);
        format!("Failed to spawn sidecar: {}", e)
    })?;

    // Capture stdout/stderr → 写入统一日志
    let session_id_clone = session_id.to_string();
    if let Some(stdout) = child.stdout.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut bun_logger_active = false;
            for line in reader.lines().flatten() {
                // Once Bun's unified logger is initialized, ALL console.log output is
                // written directly to the unified log file by Bun's logger interceptor.
                // Capturing stdout after this point causes 100% duplication ([BUN] + [bun-out]).
                // Only pre-logger startup lines need to go through bun-out.
                if !bun_logger_active {
                    if line.contains("[Logger] Unified logging initialized") {
                        bun_logger_active = true;
                    }
                    ulog_info!("[bun-out][session:{}] {}", session_id_for_log, line);
                }
                // After logger init: silently drop stdout (Bun logger handles it)
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let session_id_for_log = session_id_clone.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                if line.contains("[startup]") {
                    ulog_info!("[bun-err][session:{}] {}", session_id_for_log, line);
                } else {
                    ulog_error!("[bun-err][session:{}] {}", session_id_for_log, line);
                }
            }
        });
    }

    // Brief wait to check if process exits immediately
    thread::sleep(Duration::from_millis(50));
    if let Ok(Some(status)) = child.try_wait() {
        thread::sleep(Duration::from_millis(100));
        ulog_error!("[sidecar] SessionSidecar exited immediately with status: {:?}", status);
        #[cfg(target_os = "windows")]
        maybe_mark_crashed_bun(&status, &bun_path);
        let diag = diagnose_immediate_exit(&status, &bun_path);
        return Err(diag);
    }

    // Create SessionSidecar with owner
    let mut owners = HashSet::new();
    owners.insert(owner.clone());
    let sidecar = SessionSidecar {
        process: child,
        port,
        session_id: session_id.to_string(),
        workspace_path: workspace_path.to_path_buf(),
        state: SidecarState::Starting,
        owners,
        created_at: std::time::Instant::now(),
    };

    manager_guard.insert_sidecar(session_id, sidecar);

    // Drop lock before waiting for health
    drop(manager_guard);

    // Build liveness check closure for session sidecar
    let liveness_manager = manager.clone();
    let liveness_session_id = session_id.to_string();
    let alive_check: Box<dyn Fn() -> bool> = Box::new(move || {
        if let Ok(mut guard) = liveness_manager.lock() {
            if let Some(sidecar) = guard.sidecars.get_mut(&liveness_session_id) {
                matches!(sidecar.process.try_wait(), Ok(None))
            } else {
                false
            }
        } else {
            true // can't acquire lock, assume alive
        }
    });

    // Wait for health
    match wait_for_health(port, Some(alive_check)) {
        Ok(()) => {
            // Mark as healthy — verify port to avoid mutating a replacement sidecar
            // that was created by another thread (e.g., health monitor) during the wait.
            let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
            if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                if sidecar.port == port {
                    sidecar.state = SidecarState::Healthy;
                } else {
                    ulog_warn!(
                        "[sidecar] Session {} sidecar replaced during wait_for_health (expected port {}, found {}), skipping Healthy transition",
                        session_id, port, sidecar.port
                    );
                }
            }
            ulog_info!(
                "[sidecar] SessionSidecar for session {} is healthy on port {}",
                session_id, port
            );
            Ok(EnsureSidecarResult {
                port,
                is_new: true,
            })
        }
        Err(e) => {
            ulog_error!("[sidecar] SessionSidecar health check failed: {}", e);
            let mut manager_guard = manager.lock().map_err(|_| e.clone())?;
            // Verify port before acting — another thread may have replaced the sidecar
            let port_matches = manager_guard.sidecars.get(session_id)
                .map(|s| s.port == port)
                .unwrap_or(false);
            if port_matches {
                // Check exit status and mark crashed bun for fallback
                #[cfg(target_os = "windows")]
                if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
                    if let Ok(Some(status)) = sidecar.process.try_wait() {
                        maybe_mark_crashed_bun(&status, &bun_path);
                    }
                }
                // Remove the failed sidecar (ours, not a replacement)
                manager_guard.remove_sidecar(session_id);
            } else {
                ulog_warn!(
                    "[sidecar] Session {} sidecar replaced during wait_for_health (port {}), skipping removal",
                    session_id, port
                );
            }
            Err(e)
        }
    }
}

/// Release an owner from a Session's Sidecar.
/// If this was the last owner, the Sidecar is stopped.
///
/// Returns true if the Sidecar was stopped (no more owners).
pub fn release_session_sidecar(
    manager: &ManagedSidecarManager,
    session_id: &str,
    owner: &SidecarOwner,
) -> Result<bool, String> {
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    let (removed, stopped) = manager_guard.remove_session_owner(session_id, owner);

    if removed {
        if stopped {
            // Clean up generation counter when sidecar is permanently removed
            manager_guard.clear_generation(session_id);
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar stopped (last owner)",
                owner, session_id
            );
        } else {
            ulog_info!(
                "[sidecar] Released owner {:?} from session {}, Sidecar continues running",
                owner, session_id
            );
        }
        Ok(stopped)
    } else {
        ulog_debug!(
            "[sidecar] Session {} has no Sidecar to release owner {:?} from",
            session_id, owner
        );
        Ok(false)
    }
}

/// Get the port for a Session's Sidecar
pub fn get_session_sidecar_port(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<Option<u16>, String> {
    let manager_guard = manager.lock().map_err(|e| e.to_string())?;
    Ok(manager_guard.get_session_port(session_id))
}

// ============= Session-Centric Tauri Commands =============

/// Ensure a Session has a Sidecar running, adding the specified owner
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_ensure_session_sidecar(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    workspacePath: String,
    ownerType: String,
    ownerId: String,
) -> Result<EnsureSidecarResult, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    let workspace_path = PathBuf::from(&workspacePath);
    ensure_session_sidecar(&app_handle, &state, &sessionId, &workspace_path, owner)
}

/// Release an owner from a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_release_session_sidecar(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    ownerType: String,
    ownerId: String,
) -> Result<bool, String> {
    let owner = match ownerType.as_str() {
        "tab" => SidecarOwner::Tab(ownerId),
        "cron_task" => SidecarOwner::CronTask(ownerId),
        "background_completion" => SidecarOwner::BackgroundCompletion(ownerId),
        "im_bot" | "agent" => SidecarOwner::Agent(ownerId),
        _ => return Err(format!("Invalid owner type: {}", ownerType)),
    };

    release_session_sidecar(&state, &sessionId, &owner)
}

/// Get the port for a Session's Sidecar
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_port(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<Option<u16>, String> {
    get_session_sidecar_port(&state, &sessionId)
}

/// Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
/// This updates HashMap keys without stopping the Sidecar.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_upgrade_session_id(
    state: tauri::State<'_, ManagedSidecarManager>,
    oldSessionId: String,
    newSessionId: String,
) -> Result<bool, String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.upgrade_session_id(&oldSessionId, &newSessionId))
}

/// Check if a session's Sidecar has persistent background owners (CronTask or Agent)
/// Used by frontend to decide whether closing a tab needs confirmation.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_session_has_persistent_owners(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> bool {
    let manager = state.lock().unwrap_or_else(|e| e.into_inner());
    manager.session_has_persistent_owners(&sessionId)
}

// ============= Background Session Completion =============
// Keeps a Sidecar alive in the background while AI finishes responding,
// even after the Tab releases its ownership.

/// Background completion polling interval (2 seconds)
const BG_POLL_INTERVAL_SECS: u64 = 2;
/// Background completion safety timeout (60 minutes)
const BG_MAX_DURATION_SECS: u64 = 3600;

/// Result from start_background_completion
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCompletionResult {
    pub started: bool,
    pub session_id: String,
}

/// Check if a Sidecar's session is currently in "running" state
/// by calling GET /api/session-state
fn check_sidecar_session_state(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/session-state", port);
    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_secs(3))
        .build() {
        Ok(c) => c,
        Err(_) => return None,
    };

    match client.get(&url).send() {
        Ok(response) if response.status().is_success() => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct SessionStateResponse {
                session_state: String,
            }
            match response.json::<SessionStateResponse>() {
                Ok(state) => Some(state.session_state),
                Err(_) => None,
            }
        }
        _ => None,
    }
}

/// Start background completion for a session.
/// Adds a BackgroundCompletion owner and spawns a polling thread.
/// Returns { started: true } if AI is actively running, { started: false } if idle.
pub fn start_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<BackgroundCompletionResult, String> {
    let result_id = session_id.to_string();

    // Phase 1: Check if sidecar exists and get port (with lock)
    let port = {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            if sidecar.is_reusable() {
                Some(sidecar.port)
            } else {
                None
            }
        } else {
            None
        }
    };

    let port = match port {
        Some(p) => p,
        None => {
            ulog_debug!("[bg-completion] No running sidecar for session {}", session_id);
            return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
        }
    };

    // Phase 2: Check session state (without lock - HTTP call)
    let state = check_sidecar_session_state(port);
    let is_running = state.as_deref() == Some("running");

    if !is_running {
        ulog_info!("[bg-completion] Session {} is not running (state: {:?}), no background completion needed", session_id, state);
        return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
    }

    // Phase 3: Add BackgroundCompletion owner (with lock)
    {
        let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
        if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
            let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
            if sidecar.owners.contains(&bg_owner) {
                ulog_info!("[bg-completion] Session {} already has a BackgroundCompletion owner", session_id);
                return Ok(BackgroundCompletionResult { started: true, session_id: result_id });
            }
            sidecar.add_owner(bg_owner);
            ulog_info!("[bg-completion] Added BackgroundCompletion owner to session {} (port {})", session_id, port);
        } else {
            ulog_warn!("[bg-completion] Sidecar disappeared during state check for session {}", session_id);
            return Ok(BackgroundCompletionResult { started: false, session_id: result_id });
        }
    }

    // Phase 4: Spawn polling thread
    let manager_clone = Arc::clone(manager);
    let session_id_clone = session_id.to_string();
    let app_handle_clone = app_handle.clone();

    thread::spawn(move || {
        poll_background_completion(
            &app_handle_clone,
            &manager_clone,
            &session_id_clone,
            port,
        );
    });

    Ok(BackgroundCompletionResult { started: true, session_id: result_id })
}

/// Polling loop that runs in a background thread.
/// Checks session state every BG_POLL_INTERVAL_SECS until AI finishes,
/// then removes the BackgroundCompletion owner (which may stop the Sidecar).
fn poll_background_completion<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    session_id: &str,
    port: u16,
) {
    ulog_info!("[bg-completion] Starting polling for session {} on port {}", session_id, port);
    let start_time = std::time::Instant::now();
    let max_duration = Duration::from_secs(BG_MAX_DURATION_SECS);
    let poll_interval = Duration::from_secs(BG_POLL_INTERVAL_SECS);
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut consecutive_http_failures: u32 = 0;
    const MAX_HTTP_FAILURES: u32 = 3;

    loop {
        thread::sleep(poll_interval);

        // Safety timeout
        if start_time.elapsed() > max_duration {
            ulog_warn!("[bg-completion] Session {} hit safety timeout ({} min), stopping", session_id, BG_MAX_DURATION_SECS / 60);
            break;
        }

        // Check owner still exists + sidecar process still alive (single lock acquisition)
        {
            let mut manager_guard = match manager.lock() {
                Ok(g) => g,
                Err(_) => break,
            };
            match manager_guard.sidecars.get_mut(session_id) {
                Some(sidecar) => {
                    // Owner removed externally (e.g., user reconnected via cancelBackgroundCompletion)
                    if !sidecar.owners.contains(&bg_owner) {
                        ulog_info!("[bg-completion] BackgroundCompletion owner removed for session {} (user reconnected?), exiting poll", session_id);
                        return; // Don't remove owner - it's already gone
                    }
                    // Process died
                    if sidecar.is_dead() {
                        ulog_warn!("[bg-completion] Sidecar process died for session {}", session_id);
                        break;
                    }
                }
                None => {
                    ulog_info!("[bg-completion] Sidecar removed for session {}, exiting poll", session_id);
                    return; // Sidecar already gone, nothing to clean up
                }
            }
        }

        // Check session state via HTTP (lock released, no contention)
        match check_sidecar_session_state(port) {
            Some(ref state) if state == "running" => {
                consecutive_http_failures = 0;
                ulog_debug!("[bg-completion] Session {} still running, continuing poll", session_id);
                continue;
            }
            Some(ref state) => {
                ulog_info!("[bg-completion] Session {} finished (state: {})", session_id, state);
                break;
            }
            None => {
                consecutive_http_failures += 1;
                if consecutive_http_failures >= MAX_HTTP_FAILURES {
                    ulog_warn!(
                        "[bg-completion] Session {} HTTP unreachable {} consecutive times, giving up",
                        session_id, consecutive_http_failures
                    );
                    break;
                }
                ulog_warn!(
                    "[bg-completion] Session {} HTTP unreachable ({}/{}), retrying...",
                    session_id, consecutive_http_failures, MAX_HTTP_FAILURES
                );
                continue;
            }
        }
    }

    // Remove BackgroundCompletion owner
    let sidecar_stopped = match release_session_sidecar(manager, session_id, &bg_owner) {
        Ok(stopped) => stopped,
        Err(e) => {
            ulog_error!("[bg-completion] Failed to release owner for session {}: {}", session_id, e);
            false
        }
    };

    ulog_info!(
        "[bg-completion] Session {} background completion finished, sidecar_stopped: {}",
        session_id, sidecar_stopped
    );

    // Emit Tauri event to notify frontend
    let _ = app_handle.emit("session:background-complete", serde_json::json!({
        "sessionId": session_id,
        "sidecarStopped": sidecar_stopped,
    }));
}

/// Cancel background completion for a session (e.g., when user reconnects).
/// Simply removes the BackgroundCompletion owner; the polling thread will detect this and exit.
pub fn cancel_background_completion(
    manager: &ManagedSidecarManager,
    session_id: &str,
) -> Result<bool, String> {
    let bg_owner = SidecarOwner::BackgroundCompletion(session_id.to_string());
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;

    if let Some(sidecar) = manager_guard.sidecars.get_mut(session_id) {
        if sidecar.owners.contains(&bg_owner) {
            sidecar.owners.remove(&bg_owner);
            ulog_info!("[bg-completion] Cancelled background completion for session {}", session_id);
            Ok(true)
        } else {
            ulog_debug!("[bg-completion] No BackgroundCompletion owner to cancel for session {}", session_id);
            Ok(false)
        }
    } else {
        ulog_debug!("[bg-completion] No sidecar found to cancel background completion for session {}", session_id);
        Ok(false)
    }
}

/// Start background completion for a session
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_start_background_completion(
    app_handle: AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<BackgroundCompletionResult, String> {
    start_background_completion(&app_handle, &state, &sessionId)
}

/// Cancel background completion for a session (when user reconnects)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_cancel_background_completion(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<bool, String> {
    cancel_background_completion(&state, &sessionId)
}

/// Get session IDs that have active background completions
#[tauri::command]
pub fn cmd_get_background_sessions(
    state: tauri::State<'_, ManagedSidecarManager>,
) -> Result<Vec<String>, String> {
    let manager = state.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_background_session_ids())
}

/// Stop all sidecar instances and clean up child processes
/// This should be called when the app is closing
pub fn stop_all_sidecars(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Stopping all sidecars and cleaning up child processes...");

    // 1. Stop all managed sidecar instances (kills bun sidecars via Drop)
    let mut manager_guard = manager.lock().map_err(|e| e.to_string())?;
    manager_guard.stop_all();
    drop(manager_guard);

    // 2. Clean up any orphaned child processes (SDK and MCP)
    // This is necessary because SDK spawns child processes that don't die
    // when the parent bun sidecar is killed
    cleanup_child_processes();

    Ok(())
}

/// Shutdown for update — block until all child processes are fully terminated.
/// Unlike stop_all_sidecars (which is non-blocking), this function waits for
/// all bun/SDK/MCP processes to exit, preventing NSIS installer file-lock errors on Windows.
pub fn shutdown_for_update(manager: &ManagedSidecarManager) -> Result<(), String> {
    ulog_info!("[sidecar] Shutdown for update: stopping all processes...");

    // 1. Stop all sidecar instances (via Drop → kill_process → taskkill /T /F)
    stop_all_sidecars(manager)?;

    // 2. Actively kill orphan processes that may survive sidecar tree-kill
    //    (e.g., node.exe from bundled npx — cmd.exe intermediate layers break process tree)
    #[cfg(windows)]
    {
        cleanup_child_processes();
    }

    // 3. Wait for all related processes to truly exit
    #[cfg(windows)]
    {
        let max_wait = Duration::from_secs(5);
        let start = std::time::Instant::now();
        loop {
            let has_sidecar = has_windows_processes(SIDECAR_MARKER);
            let has_sdk = has_windows_processes("claude-agent-sdk");
            let has_mcp = has_windows_processes(".pm-copilot\\mcp\\");
            let has_node = has_windows_processes("\\PM Copilot\\nodejs\\");

            if !has_sidecar && !has_sdk && !has_mcp && !has_node {
                ulog_info!("[sidecar] All processes terminated in {:?}", start.elapsed());
                break;
            }

            if start.elapsed() > max_wait {
                ulog_warn!("[sidecar] Update shutdown timeout, force killing remaining...");
                kill_windows_processes_by_pattern(SIDECAR_MARKER);
                kill_windows_processes_by_pattern("claude-agent-sdk");
                kill_windows_processes_by_pattern(".pm-copilot\\mcp\\");
                kill_windows_processes_by_pattern("\\PM Copilot\\nodejs\\");
                // Brief wait to confirm termination
                thread::sleep(Duration::from_secs(1));
                break;
            }

            thread::sleep(Duration::from_millis(100));
        }
    }

    // Unix: SIGKILL is reliable, just allow a brief settling period
    #[cfg(unix)]
    {
        thread::sleep(Duration::from_millis(500));
    }

    ulog_info!("[sidecar] Shutdown for update complete");
    Ok(())
}

/// Clean up SDK and MCP child processes
/// Called on app shutdown to ensure no orphaned processes remain
#[cfg(unix)]
fn cleanup_child_processes() {
    // Clean up SDK child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("SDK", "claude-agent-sdk/cli.js", true);

    // Clean up MCP child processes (with SIGKILL fallback for app shutdown)
    kill_processes_by_pattern("MCP", ".pm-copilot/mcp/", true);

    // Clean up MCP servers launched via bun x / npx (not under ~/.pm-copilot/mcp/)
    kill_processes_by_pattern("MCP-ext", "@playwright/mcp", true);
    kill_processes_by_pattern("MCP-ext", "@anthropic-ai/mcp", true);
}

#[cfg(windows)]
fn cleanup_child_processes() {
    // Windows: Clean up SDK and MCP child processes using wmic + taskkill
    ulog_info!("[sidecar] Cleaning up child processes on Windows...");

    // Clean up SDK child processes
    kill_windows_processes_by_pattern("claude-agent-sdk");

    // Clean up MCP child processes
    kill_windows_processes_by_pattern(".pm-copilot\\mcp\\");

    // Clean up MCP servers launched via bun x / npx (not under ~/.pm-copilot/mcp/)
    kill_windows_processes_by_pattern("@playwright\\mcp");
    kill_windows_processes_by_pattern("@anthropic-ai\\mcp");

    // Clean up bundled Node.js processes (MCP servers started via bundled npx)
    // These may survive tree-kill when npx.cmd creates intermediate cmd.exe layers
    kill_windows_processes_by_pattern("\\PM Copilot\\nodejs\\");
}

#[cfg(windows)]
fn kill_windows_processes_by_pattern(pattern: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Use PowerShell Get-CimInstance (wmic is deprecated in Windows 10/11)
    // Fallback to wmic for older systems
    let ps_command = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | Select-Object -ExpandProperty ProcessId",
        pattern.replace("'", "''")  // Escape single quotes for PowerShell
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_command])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let pids: Vec<u32> = match output {
        Ok(ref o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect()
        }
        _ => {
            // Fallback to wmic for older Windows versions
            ulog_info!("[sidecar] PowerShell failed, falling back to wmic");
            Command::new("wmic")
                .args(["process", "where", &format!("commandline like '%{}%'", pattern), "get", "processid"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()
                .map(|o| {
                    String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .skip(1)
                        .filter_map(|s| s.trim().parse::<u32>().ok())
                        .collect()
                })
                .unwrap_or_default()
        }
    };

    if pids.is_empty() {
        return;
    }

    let mut killed = 0;
    for pid in &pids {
        let mut cmd = Command::new("taskkill");
        // /T = kill process tree (children too), /F = force
        cmd.args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW);
        if cmd.output().is_ok() {
            killed += 1;
        }
    }

    if killed > 0 {
        ulog_info!("[sidecar] Killed {} processes (tree) matching '{}'", killed, pattern);
    }
}

/// Check if any Windows processes exist matching the pattern
#[cfg(windows)]
fn has_windows_processes(pattern: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let ps_command = format!(
        "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*{}*' }} | Select-Object -ExpandProperty ProcessId",
        pattern.replace("'", "''")
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", &ps_command])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            !String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect::<Vec<_>>()
                .is_empty()
        }
        _ => false,
    }
}

#[cfg(not(any(unix, windows)))]
fn cleanup_child_processes() {
    // No-op on other platforms
}

// ============= Legacy Compatibility Functions =============
// These wrap the new multi-instance API to support existing code

/// Legacy: Start sidecar (uses "__legacy__" as tab ID)
pub fn start_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
    config: LegacySidecarConfig,
) -> Result<u16, String> {
    // Use legacy tab ID
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Stop any existing legacy instance
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    // Start new instance
    start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(config.agent_dir))
}

/// Legacy: Stop sidecar
pub fn stop_sidecar(state: &ManagedSidecar) -> Result<(), String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    stop_tab_sidecar(state, LEGACY_TAB_ID)
}

/// Legacy: Get sidecar status
pub fn get_sidecar_status(state: &ManagedSidecar) -> Result<SidecarStatus, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    get_tab_sidecar_status(state, LEGACY_TAB_ID)
}

/// Legacy: Check if process is alive
pub fn check_process_alive(state: &ManagedSidecar) -> Result<bool, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
    
    if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
        Ok(instance.is_running())
    } else {
        Ok(false)
    }
}

/// Legacy: Restart sidecar
pub fn restart_sidecar<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";
    
    // Get current config
    let agent_dir = {
        let manager_guard = state.lock().map_err(|e| e.to_string())?;
        manager_guard.get_instance(LEGACY_TAB_ID)
            .and_then(|i| i.agent_dir.clone())
    };
    
    // Stop and restart
    let _ = stop_tab_sidecar(state, LEGACY_TAB_ID);
    
    if let Some(dir) = agent_dir {
        start_tab_sidecar(app_handle, state, LEGACY_TAB_ID, Some(dir))
    } else {
        Err("No previous agent_dir to restart with".to_string())
    }
}

/// Legacy: Ensure sidecar is running
pub fn ensure_sidecar_running<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &ManagedSidecar,
) -> Result<u16, String> {
    const LEGACY_TAB_ID: &str = "__legacy__";

    // Check if already running
    {
        let mut manager_guard = state.lock().map_err(|e| e.to_string())?;
        if let Some(instance) = manager_guard.get_instance_mut(LEGACY_TAB_ID) {
            if instance.is_running() {
                return Ok(instance.port);
            }
        }
    }

    // Need to restart
    restart_sidecar(app_handle, state)
}

// ============= Session Activation Tauri Commands =============

/// Get session activation status
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_get_session_activation(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Option<SessionActivation> {
    let manager = state.lock().ok()?;
    manager.get_session_activation(&sessionId).cloned()
}

/// Activate a session (associate with Sidecar)
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_activate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
    taskId: Option<String>,
    port: u16,
    workspacePath: String,
    isCronTask: bool,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.activate_session(sessionId, tabId, taskId, port, workspacePath, isCronTask);
    Ok(())
}

/// Deactivate a session
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_deactivate_session(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.deactivate_session(&sessionId);
    Ok(())
}

/// Update session's tab association
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_update_session_tab(
    state: tauri::State<'_, ManagedSidecarManager>,
    sessionId: String,
    tabId: Option<String>,
) -> Result<(), String> {
    let mut manager = state.lock().map_err(|e| e.to_string())?;
    manager.update_session_tab(&sessionId, tabId);
    Ok(())
}

/// Cron task execution payload - sent to Sidecar's /cron/execute-sync endpoint
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecutePayload {
    pub task_id: String,
    pub prompt: String,
    /// Session ID for activation tracking (prevents Sidecar from being killed during cron execution)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_first_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_can_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_env: Option<ProviderEnv>,
    /// Run mode: "single_session" (keep context) or "new_session" (fresh each time)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_mode: Option<String>,
    /// Task execution interval in minutes (for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<u32>,
    /// Current execution number (1-based, for System Prompt context)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_number: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderEnv {
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

/// Cron task execution response from Sidecar
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronExecuteResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_requested_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
    /// Internal SDK session ID where conversation data is stored
    /// (may differ from the Sidecar session key used for process management)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Execute a cron task synchronously via Sidecar HTTP API
/// This function ensures a Sidecar is running for the session and calls its /cron/execute-sync endpoint
pub async fn execute_cron_task<R: Runtime>(
    app_handle: &AppHandle<R>,
    manager: &ManagedSidecarManager,
    workspace_path: &str,
    payload: CronExecutePayload,
) -> Result<CronExecuteResponse, String> {
    ulog_info!(
        "[sidecar] execute_cron_task called for task {} in workspace {}",
        payload.task_id, workspace_path
    );

    // Require session_id for Session-centric Sidecar
    let session_id = payload.session_id.clone().ok_or_else(|| {
        let err = format!("[sidecar] execute_cron_task requires session_id for task {}", payload.task_id);
        ulog_error!("{}", err);
        err
    })?;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: about to call ensure_session_sidecar"
    }));

    // Ensure Sidecar is running for this session with CronTask as owner
    // IMPORTANT: Use spawn_blocking because ensure_session_sidecar uses reqwest::blocking::Client
    // which cannot be called from within a tokio async runtime (causes deadlock)
    let app_handle_clone = app_handle.clone();
    let manager_clone = manager.clone();
    let session_id_clone = session_id.clone();
    let workspace_clone = workspace_path.to_string();
    let task_id_clone = payload.task_id.clone();
    let owner = SidecarOwner::CronTask(task_id_clone.clone());

    let result = tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(&workspace_clone);
        ensure_session_sidecar(&app_handle_clone, &manager_clone, &session_id_clone, &workspace, owner)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))?
    .map_err(|e| {
        ulog_error!("[sidecar] ensure_session_sidecar failed for task {}: {}", payload.task_id, e);
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": format!("execute_cron_task: ensure_session_sidecar FAILED: {}", e),
            "error": true
        }));
        e
    })?;

    let port = result.port;

    // Emit debug event
    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: sidecar ready on port {}, isNew={}", port, result.is_new)
    }));

    ulog_info!(
        "[sidecar] Cron sidecar ready for task {} on port {} (isNew={})",
        payload.task_id, port, result.is_new
    );

    // Also record in session_activations for Session singleton tracking
    {
        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: recording session activation"
        }));

        let mut manager_guard = manager.lock().map_err(|e| {
            let _ = app_handle.emit("cron:debug", serde_json::json!({
                "taskId": payload.task_id,
                "message": format!("execute_cron_task: mutex lock FAILED: {}", e),
                "error": true
            }));
            e.to_string()
        })?;

        manager_guard.activate_session(
            session_id.clone(),
            None,  // No tab_id for cron tasks
            Some(payload.task_id.clone()),  // Store task_id for Tab connection
            port,
            workspace_path.to_string(),
            true,  // is_cron_task = true
        );

        let _ = app_handle.emit("cron:debug", serde_json::json!({
            "taskId": payload.task_id,
            "message": "execute_cron_task: session activation recorded"
        }));

        ulog_info!(
            "[sidecar] Cron task {} activated session {} as cron (port {})",
            payload.task_id, session_id, port
        );
    }

    let url = format!("http://127.0.0.1:{}/cron/execute-sync", port);

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": format!("execute_cron_task: about to send HTTP request to {}", url)
    }));

    ulog_info!(
        "[sidecar] Executing cron task {} via {}",
        payload.task_id, url
    );

    // Create HTTP client with generous timeout (cron tasks can take long)
    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(3660)) // 61 minutes (slightly more than cron task's 60 min timeout)
        .tcp_nodelay(true)
        .build()
        .map_err(|e| format!("[sidecar] Failed to create HTTP client: {}", e))?;

    let _ = app_handle.emit("cron:debug", serde_json::json!({
        "taskId": payload.task_id,
        "message": "execute_cron_task: HTTP client created, sending request..."
    }));

    // Send request to Sidecar
    let response = client
        .post(&url)
        .json(&payload)
        .send()
        .await;

    // Deactivate session after execution (regardless of success/failure)
    // Note: We keep the session activated between cron executions to protect Sidecar.
    // Only deactivate if the task is being stopped or completed.
    // For now, we keep it activated - the cron scheduler should deactivate when task stops.

    let response = response.map_err(|e| format!("[sidecar] HTTP request failed: {}", e))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("[sidecar] Failed to read response body: {}", e))?;

    ulog_info!(
        "[sidecar] Cron task {} response: status={}, body={}",
        payload.task_id, status, body.chars().take(500).collect::<String>()
    );

    // Parse response
    let result: CronExecuteResponse = serde_json::from_str(&body)
        .map_err(|e| format!("[sidecar] Failed to parse response JSON: {} (body: {})", e, body))?;

    ulog_info!(
        "[sidecar] Cron task {} parsed response: success={}, error={:?}, ai_requested_exit={:?}",
        payload.task_id, result.success, result.error, result.ai_requested_exit
    );

    Ok(result)
}

/// Tauri command to execute a cron task synchronously
/// This is called by the cron scheduler in Rust
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_execute_cron_task(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, ManagedSidecarManager>,
    workspacePath: String,
    taskId: String,
    sessionId: Option<String>,
    prompt: String,
    isFirstExecution: Option<bool>,
    aiCanExit: Option<bool>,
    permissionMode: Option<String>,
    model: Option<String>,
    providerEnv: Option<ProviderEnv>,
    runMode: Option<String>,
    intervalMinutes: Option<u32>,
    executionNumber: Option<u32>,
) -> Result<CronExecuteResponse, String> {
    let payload = CronExecutePayload {
        task_id: taskId.clone(),
        prompt,
        session_id: sessionId,
        is_first_execution: isFirstExecution,
        ai_can_exit: aiCanExit,
        permission_mode: permissionMode,
        model,
        provider_env: providerEnv,
        run_mode: runMode,
        interval_minutes: intervalMinutes,
        execution_number: executionNumber,
    };

    execute_cron_task(&app_handle, &state, &workspacePath, payload).await
}

// ============= Proxy Hot-Reload =============

/// Build the proxy payload from disk config for broadcasting to Sidecars.
fn build_proxy_payload() -> serde_json::Value {
    match proxy_config::read_proxy_settings() {
        Some(s) => match proxy_config::get_proxy_url(&s) {
            Ok(_) => serde_json::json!({
                "enabled": true,
                "protocol": s.protocol.unwrap_or_else(|| "http".into()),
                "host": s.host.unwrap_or_else(|| "127.0.0.1".into()),
                "port": s.port.unwrap_or(7890),
            }),
            Err(_) => serde_json::json!({ "enabled": false }),
        },
        None => serde_json::json!({ "enabled": false }),
    }
}

/// POST proxy config to a single Sidecar.
async fn post_proxy(client: &reqwest::Client, port: u16, payload: &serde_json::Value) -> bool {
    let url = format!("http://127.0.0.1:{}/api/proxy/set", port);
    match client.post(&url).json(payload).send().await {
        Ok(r) if r.status().is_success() => {
            ulog_info!("[proxy-propagate] Updated sidecar on port {}", port);
            true
        }
        Ok(r) => {
            ulog_warn!("[proxy-propagate] Port {} returned {}", port, r.status());
            false
        }
        Err(e) => {
            ulog_warn!("[proxy-propagate] Port {} unreachable: {}", port, e);
            false
        }
    }
}

/// Propagate proxy settings from disk config to all running Sidecars.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_propagate_proxy(
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    imState: tauri::State<'_, crate::im::ManagedImBots>,
) -> Result<serde_json::Value, String> {
    let payload = build_proxy_payload();

    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut ok = 0u32;
    let mut fail = 0u32;

    // 1. Tab + Global Sidecars
    let ports = sidecarManager
        .lock()
        .map_err(|e| e.to_string())?
        .get_all_active_ports();
    for port in &ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    // 2. IM Bot Sidecars — collect ports under lock, then release before network I/O
    let im_ports: Vec<u16> = {
        let im_guard = imState.lock().await;
        let mut collected = Vec::new();
        for (_bot_id, instance) in im_guard.iter() {
            let router = instance.router.lock().await;
            for port in router.active_sidecar_ports() {
                if !ports.contains(&port) {
                    collected.push(port);
                }
            }
        }
        collected.sort();
        collected.dedup();
        collected
    }; // Both im_guard and router locks released here

    for port in &im_ports {
        if post_proxy(&client, *port, &payload).await {
            ok += 1;
        } else {
            fail += 1;
        }
    }

    ulog_info!(
        "[proxy-propagate] Done: {} updated, {} failed",
        ok,
        fail
    );
    Ok(serde_json::json!({ "updated": ok, "failed": fail }))
}

// ─── Agent Runtime resolution (v0.1.59) ───

/// Look up the `runtime` field from the agent config in ~/.pm-copilot/config.json
/// matching the given workspace path. Returns None for "builtin" (the default).
fn resolve_agent_runtime_from_config(workspace_path: &std::path::Path) -> Option<String> {
    let config_path = dirs::home_dir()?.join(".pm-copilot").join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(&content).ok()?;

    // Gate: multi-agent runtime feature must be explicitly enabled (developer mode)
    // When off, all sidecars start as builtin regardless of agent config
    if !cfg.get("multiAgentRuntime").and_then(|v| v.as_bool()).unwrap_or(false) {
        return None;
    }

    let workspace_str = workspace_path.to_string_lossy();
    let agents = cfg.get("agents")?.as_array()?;
    for agent in agents {
        let agent_path = agent.get("workspacePath")?.as_str()?;
        if agent_path == workspace_str.as_ref() {
            if let Some(runtime) = agent.get("runtime").and_then(|v| v.as_str()) {
                if runtime != "builtin" {
                    return Some(runtime.to_string());
                }
            }
            return None;
        }
    }
    None
}
