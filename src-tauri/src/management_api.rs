// Internal Management API for Bun Sidecar → Rust IPC
// Provides HTTP endpoints on localhost for cron task management
// Only accessible from 127.0.0.1 (Bun Sidecar processes)

use axum::{
    extract::{DefaultBodyLimit, Query},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tokio::net::TcpListener;

use crate::cron_task::{
    self, CronDelivery, CronSchedule, CronTask, CronTaskConfig, TaskProviderEnv,
};
use crate::im::{self, ManagedImBots, ManagedAgents};
use crate::im::adapter::ImStreamAdapter;
use crate::im::bridge;
use crate::im::types::MediaType;

/// Global management API port (set once at startup)
static MANAGEMENT_PORT: OnceLock<u16> = OnceLock::new();

/// Global IM bots state (set once at startup for wake endpoint)
static IM_BOTS_STATE: OnceLock<ManagedImBots> = OnceLock::new();

/// Global Agent state (set once at startup)
static AGENT_STATE: OnceLock<ManagedAgents> = OnceLock::new();

/// Get the management API port (returns 0 if not started)
pub fn get_management_port() -> u16 {
    MANAGEMENT_PORT.get().copied().unwrap_or(0)
}

/// Set the IM bots state for the management API (called once at startup)
pub fn set_im_bots_state(bots: ManagedImBots) {
    let _ = IM_BOTS_STATE.set(bots);
}

/// Set the Agent state for the management API (called once at startup)
pub fn set_agent_state(agents: ManagedAgents) {
    let _ = AGENT_STATE.set(agents);
}

fn get_im_bots() -> Option<&'static ManagedImBots> {
    IM_BOTS_STATE.get()
}

fn get_agents() -> Option<&'static ManagedAgents> {
    AGENT_STATE.get()
}

/// Global Sidecar manager state (set once at startup)
static SIDECAR_STATE: OnceLock<crate::sidecar::ManagedSidecarManager> = OnceLock::new();

/// Set the SidecarManager state for the management API (called once at startup)
pub fn set_sidecar_state(state: crate::sidecar::ManagedSidecarManager) {
    let _ = SIDECAR_STATE.set(state);
}

#[allow(dead_code)]
fn get_sidecar_state() -> Option<&'static crate::sidecar::ManagedSidecarManager> {
    SIDECAR_STATE.get()
}

/// Start the internal management API server on a random port
/// Returns the port number for injection into Sidecar env vars
pub async fn start_management_api() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind management API: {}", e))?;

    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get management API address: {}", e))?
        .port();

    MANAGEMENT_PORT
        .set(port)
        .map_err(|_| "Management API already started".to_string())?;

    let app = Router::new()
        .route("/api/cron/create", post(create_cron_handler))
        .route("/api/cron/list", get(list_cron_handler))
        .route("/api/cron/update", post(update_cron_handler))
        .route("/api/cron/delete", post(delete_cron_handler))
        .route("/api/cron/run", post(run_cron_handler))
        .route("/api/cron/runs", get(runs_cron_handler))
        .route("/api/cron/status", get(status_cron_handler))
        .route("/api/im/channels", get(list_im_channels_handler))
        .route("/api/im/wake", post(wake_bot_handler))
        .route("/api/im/send-media", post(send_media_handler))
        .route("/api/im-bridge/message", post(handle_bridge_message))
        .route("/api/cron/stop", post(stop_cron_handler))
        .route("/api/plugin/list", get(list_plugins_handler))
        .route("/api/plugin/install", post(install_plugin_handler))
        .route("/api/plugin/uninstall", post(uninstall_plugin_handler))
        .route("/api/agent/runtime-status", get(agent_runtime_status_handler))
        // Bridge messages carry base64-encoded media attachments (images/files).
        // Default axum 2MB limit is too small — raise to 50MB for this API.
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024));

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            log::error!("[management-api] Server error: {}", e);
        }
    });

    log::info!(
        "[management-api] Started on http://127.0.0.1:{}",
        port
    );
    Ok(port)
}

// ===== Request / Response types =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateCronRequest {
    name: Option<String>,
    schedule: Option<CronSchedule>,
    message: String,
    session_target: Option<String>, // "new_session" | "single_session"
    source_bot_id: Option<String>,
    delivery: Option<CronDelivery>,
    workspace_path: String,
    model: Option<String>,
    permission_mode: Option<String>,
    provider_env: Option<TaskProviderEnv>,
    /// Fallback interval if no schedule provided
    interval_minutes: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct CreateCronResponse {
    task_id: String,
    status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListCronQuery {
    source_bot_id: Option<String>,
    workspace_path: Option<String>,
}

// ListCronResponse removed — list_cron_handler now returns serde_json::Value
// with explicit { "ok": true, "tasks": [...] } for Admin API forwarding compatibility.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronTaskSummary {
    id: String,
    name: Option<String>,
    prompt: String,
    status: String,
    schedule: Option<CronSchedule>,
    interval_minutes: u32,
    execution_count: u32,
    last_executed_at: Option<String>,
    created_at: String,
}

impl From<CronTask> for CronTaskSummary {
    fn from(t: CronTask) -> Self {
        Self {
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            status: serde_json::to_value(&t.status)
                .and_then(|v| Ok(v.as_str().unwrap_or("unknown").to_string()))
                .unwrap_or_else(|_| "unknown".to_string()),
            schedule: t.schedule,
            interval_minutes: t.interval_minutes,
            execution_count: t.execution_count,
            last_executed_at: t.last_executed_at.map(|dt| dt.to_rfc3339()),
            created_at: t.created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateCronRequest {
    task_id: String,
    patch: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdRequest {
    task_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ===== Handlers =====

async fn create_cron_handler(
    Json(req): Json<CreateCronRequest>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let is_loop = matches!(&req.schedule, Some(CronSchedule::Loop));
    let run_mode = if is_loop {
        cron_task::RunMode::SingleSession // Loop always uses single_session
    } else {
        match req.session_target.as_deref() {
            Some("single_session") => cron_task::RunMode::SingleSession,
            _ => cron_task::RunMode::NewSession,
        }
    };

    let interval_minutes = match &req.schedule {
        Some(CronSchedule::Every { minutes, .. }) => *minutes,
        Some(CronSchedule::At { .. }) => 60, // placeholder, not used for one-shot
        Some(CronSchedule::Cron { .. }) => 60, // placeholder, calculated by cron expression
        Some(CronSchedule::Loop) => 0, // not used, Loop is completion-triggered
        None => req.interval_minutes.unwrap_or(30),
    };

    let session_id = uuid::Uuid::new_v4().to_string();

    let config = CronTaskConfig {
        workspace_path: req.workspace_path,
        session_id,
        prompt: req.message,
        interval_minutes: interval_minutes.max(5),
        end_conditions: Default::default(),
        run_mode,
        notify_enabled: true,
        tab_id: None,
        permission_mode: req.permission_mode.unwrap_or_else(|| "auto".to_string()),
        model: req.model,
        provider_env: req.provider_env,
        source_bot_id: req.source_bot_id,
        delivery: req.delivery,
        schedule: req.schedule,
        name: req.name,
    };

    match manager.create_task(config).await {
        Ok(task) => {
            // Auto-start the task
            let task_id = task.id.clone();
            if let Err(e) = manager.start_task(&task_id).await {
                log::warn!("[management-api] Created task {} but failed to start: {}", task_id, e);
            } else if let Err(e) = manager.start_task_scheduler(&task_id).await {
                log::warn!("[management-api] Started task {} but failed to start scheduler: {}", task_id, e);
            }

            // Fetch enriched task to get computed nextExecutionAt
            let next_exec = manager.get_task(&task_id).await
                .and_then(|t| t.next_execution_at);

            Json(serde_json::json!({
                "ok": true,
                "taskId": task.id,
                "status": "running",
                "nextExecutionAt": next_exec
            }))
        }
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": e
        })),
    }
}

async fn list_cron_handler(
    Query(query): Query<ListCronQuery>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();

    let tasks = if let Some(bot_id) = &query.source_bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &query.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };

    let summaries: Vec<CronTaskSummary> = tasks.into_iter().map(CronTaskSummary::from).collect();
    Json(serde_json::json!({ "ok": true, "tasks": summaries }))
}

async fn update_cron_handler(
    Json(req): Json<UpdateCronRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    match manager.update_task_fields(&req.task_id, req.patch).await {
        Ok(_) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn delete_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Stop first if running
    let _ = manager.stop_task(&req.task_id, Some("Deleted via management API".to_string())).await;

    match manager.delete_task(&req.task_id).await {
        Ok(()) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse {
            ok: false,
            error: Some(e),
        }),
    }
}

async fn run_cron_handler(
    Json(req): Json<TaskIdRequest>,
) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();

    // Check task exists
    let task = match manager.get_task(&req.task_id).await {
        Some(t) => t,
        None => {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Task not found: {}", req.task_id)),
            });
        }
    };

    // If task is stopped, start it first
    if task.status == cron_task::TaskStatus::Stopped {
        if let Err(e) = manager.start_task(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start task: {}", e)),
            });
        }
        if let Err(e) = manager.start_task_scheduler(&req.task_id).await {
            return Json(ApiResponse {
                ok: false,
                error: Some(format!("Failed to start scheduler: {}", e)),
            });
        }
    }

    Json(ApiResponse { ok: true, error: None })
}

// ===== Runs / Status / Wake handlers =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunsQuery {
    task_id: String,
    limit: Option<usize>,
}

async fn runs_cron_handler(
    Query(params): Query<RunsQuery>,
) -> Json<serde_json::Value> {
    let limit = params.limit.unwrap_or(20);
    let runs = cron_task::read_cron_runs(&params.task_id, limit);
    Json(serde_json::json!({ "ok": true, "runs": runs }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusQuery {
    bot_id: Option<String>,
    workspace_path: Option<String>,
}

async fn status_cron_handler(
    Query(params): Query<StatusQuery>,
) -> Json<serde_json::Value> {
    let manager = cron_task::get_cron_task_manager();
    let tasks = if let Some(bot_id) = &params.bot_id {
        manager.get_tasks_for_bot(bot_id).await
    } else if let Some(workspace) = &params.workspace_path {
        manager.get_tasks_for_workspace(workspace).await
    } else {
        manager.get_all_tasks().await
    };

    let total = tasks.len();
    let running = tasks.iter().filter(|t| t.status == cron_task::TaskStatus::Running).count();
    let last_executed = tasks.iter().filter_map(|t| t.last_executed_at).max();
    let next_execution = tasks.iter().filter_map(|t| t.next_execution_at.clone()).min();

    Json(serde_json::json!({
        "ok": true,
        "totalTasks": total,
        "runningTasks": running,
        "lastExecutedAt": last_executed,
        "nextExecutionAt": next_execution,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WakeRequest {
    bot_id: String,
    text: Option<String>,
}

/// Look up a bot instance by ID — checks ManagedAgents first (primary path), then
/// falls back to ManagedImBots (legacy compatibility, usually empty after migration).
/// Returns (router Arc, heartbeat wake_tx) with locks already dropped.
async fn find_bot_refs(bot_id: &str) -> Option<(
    std::sync::Arc<tokio::sync::Mutex<im::router::SessionRouter>>,
    Option<tokio::sync::mpsc::Sender<im::types::WakeReason>>,
)> {
    // Check agent channels first (primary path after v0.1.41 migration)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some((
                    std::sync::Arc::clone(&ch_inst.bot_instance.router),
                    ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                ));
            }
        }
    }
    // Legacy fallback: ManagedImBots (for backward compatibility — usually empty)
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some((
                std::sync::Arc::clone(&instance.router),
                instance.heartbeat_wake_tx.clone(),
            ));
        }
    }
    None
}

/// Look up a bot's adapter by ID — checks ManagedAgents first, then legacy ManagedImBots.
async fn find_bot_adapter(bot_id: &str) -> Option<std::sync::Arc<im::AnyAdapter>> {
    // Check agent channels first (primary path)
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            if let Some(ch_inst) = agent.channels.get(bot_id) {
                return Some(std::sync::Arc::clone(&ch_inst.bot_instance.adapter));
            }
        }
    }
    // Legacy fallback
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        if let Some(instance) = bots_guard.get(bot_id) {
            return Some(std::sync::Arc::clone(&instance.adapter));
        }
    }
    None
}

/// Snapshot of channel metadata extracted under lock, resolved after lock is dropped.
struct ChannelSnapshot {
    bot_id: String,
    platform_str: String,
    name: String,
    agent_name: Option<String>,
    health: std::sync::Arc<im::health::HealthManager>,
}

/// GET /api/im/channels — List all configured IM channels for cron delivery target discovery.
/// Returns channel botId, platform, name, parent agent name, and runtime status.
/// Uses snapshot-then-await pattern to avoid holding ManagedAgents/ManagedImBots lock across awaits.
async fn list_im_channels_handler() -> Json<serde_json::Value> {
    let mut snapshots: Vec<ChannelSnapshot> = Vec::new();

    // Snapshot from ManagedAgents (primary path after v0.1.41) — lock dropped before await
    if let Some(agents) = get_agents() {
        let agents_guard = agents.lock().await;
        for agent in agents_guard.values() {
            for (ch_id, ch_inst) in &agent.channels {
                let platform_str = serde_json::to_value(&ch_inst.bot_instance.platform)
                    .and_then(|v| serde_json::from_value::<String>(v))
                    .unwrap_or_else(|_| "unknown".to_string());
                let name = ch_inst.bot_instance.config.name.clone()
                    .unwrap_or_else(|| ch_id.clone());
                snapshots.push(ChannelSnapshot {
                    bot_id: ch_id.clone(),
                    platform_str,
                    name,
                    agent_name: Some(agent.config.name.clone()),
                    health: std::sync::Arc::clone(&ch_inst.bot_instance.health),
                });
            }
        }
    } // agents_guard dropped here

    // Snapshot from legacy ManagedImBots — lock dropped before await
    if let Some(bots) = get_im_bots() {
        let bots_guard = bots.lock().await;
        for (bot_id, instance) in bots_guard.iter() {
            // Skip if already collected from agent channels
            if snapshots.iter().any(|s| s.bot_id == *bot_id) {
                continue;
            }
            let platform_str = serde_json::to_value(&instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            let name = instance.config.name.clone()
                .unwrap_or_else(|| bot_id.clone());
            snapshots.push(ChannelSnapshot {
                bot_id: bot_id.clone(),
                platform_str,
                name,
                agent_name: None,
                health: std::sync::Arc::clone(&instance.health),
            });
        }
    } // bots_guard dropped here

    // Now resolve health states without holding any lock
    let mut channels = Vec::with_capacity(snapshots.len());
    for snap in snapshots {
        let health_state = snap.health.get_state().await;
        let status_str = serde_json::to_value(&health_state.status)
            .and_then(|v| serde_json::from_value::<String>(v))
            .unwrap_or_else(|_| "unknown".to_string());
        channels.push(serde_json::json!({
            "botId": snap.bot_id,
            "platform": snap.platform_str,
            "name": snap.name,
            "agentName": snap.agent_name,
            "status": status_str,
        }));
    }

    Json(serde_json::json!({ "ok": true, "channels": channels }))
}

async fn wake_bot_handler(
    Json(payload): Json<WakeRequest>,
) -> Json<serde_json::Value> {
    let (router, wake_tx) = match find_bot_refs(&payload.bot_id).await {
        Some(refs) => refs,
        None => return Json(serde_json::json!({ "ok": false, "error": "Bot not found" })),
    };

    // Step 1: If text provided, try to POST system event to Bot Sidecar
    if let Some(ref text) = payload.text {
        let port = {
            let router_guard = router.lock().await;
            router_guard.find_any_active_session().map(|(p, _, _)| p)
        };

        if let Some(port) = port {
            let client = crate::local_http::builder().build().unwrap_or_default();
            let body = serde_json::json!({
                "event": "manual_wake",
                "content": text,
            });
            let _ = client
                .post(format!("http://127.0.0.1:{}/api/im/system-event", port))
                .json(&body)
                .send()
                .await;
        }
    }

    // Step 2: Send WakeReason::Manual to heartbeat runner
    if let Some(ref wake_tx) = wake_tx {
        match wake_tx.send(im::types::WakeReason::Manual).await {
            Ok(_) => Json(serde_json::json!({ "ok": true })),
            Err(e) => Json(serde_json::json!({ "ok": false, "error": format!("Wake failed: {}", e) })),
        }
    } else {
        Json(serde_json::json!({ "ok": false, "error": "Heartbeat not configured for this bot" }))
    }
}

// ===== Send Media handler =====

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct SendMediaRequest {
    bot_id: String,
    chat_id: String,
    platform: String,
    file_path: String,
    caption: Option<String>,
}

async fn send_media_handler(
    Json(req): Json<SendMediaRequest>,
) -> Json<serde_json::Value> {
    // Get adapter from the bot instance (checks legacy IM bots, then agent channels)
    let adapter: std::sync::Arc<im::AnyAdapter> = match find_bot_adapter(&req.bot_id).await {
        Some(a) => a,
        None => return Json(serde_json::json!({
            "ok": false, "error": format!("Bot not found: {}", req.bot_id)
        })),
    };

    // Read the file
    let path = std::path::Path::new(&req.file_path);
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let data = match tokio::fs::read(&req.file_path).await {
        Ok(d) => d,
        Err(e) => return Json(serde_json::json!({
            "ok": false, "error": format!("File not found or unreadable: {}", e)
        })),
    };

    let data_len = data.len() as u64;
    let media_type = MediaType::from_extension(ext);

    match media_type {
        MediaType::Image => {
            let size_limit: u64 = 10 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Image too large: {:.1} MB (max 10 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            log::info!("[send-media] Sending image: {} ({} bytes) to {}", filename, data_len, req.chat_id);
            match adapter.send_photo(&req.chat_id, data, &filename, req.caption.as_deref()).await {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send photo: {}", e)
                })),
            }
        }
        MediaType::File => {
            let size_limit: u64 = 50 * 1024 * 1024;
            if data_len > size_limit {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("File too large: {:.1} MB (max 50 MB)", data_len as f64 / (1024.0 * 1024.0))
                }));
            }
            let mime = match ext.to_lowercase().as_str() {
                "pdf" => "application/pdf",
                "doc" | "docx" => "application/msword",
                "xls" | "xlsx" => "application/vnd.ms-excel",
                "ppt" | "pptx" => "application/vnd.ms-powerpoint",
                "mp4" => "video/mp4",
                "mp3" => "audio/mpeg",
                "zip" => "application/zip",
                "csv" => "text/csv",
                "json" => "application/json",
                "xml" => "application/xml",
                "html" => "text/html",
                "txt" => "text/plain",
                _ => "application/octet-stream",
            };
            log::info!("[send-media] Sending file: {} ({} bytes, {}) to {}", filename, data_len, mime, req.chat_id);
            match adapter.send_file(&req.chat_id, data, &filename, mime, req.caption.as_deref()).await {
                Ok(_) => Json(serde_json::json!({
                    "ok": true, "fileName": filename, "fileSize": data_len
                })),
                Err(e) => Json(serde_json::json!({
                    "ok": false, "error": format!("Failed to send file: {}", e)
                })),
            }
        }
        MediaType::NonMedia => {
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Unsupported file type: .{} — only images, documents, media, and archives can be sent", ext)
            }))
        }
    }
}

// ===== Cron Stop handler =====

async fn stop_cron_handler(Json(req): Json<TaskIdRequest>) -> Json<ApiResponse> {
    let manager = cron_task::get_cron_task_manager();
    match manager.stop_task(&req.task_id, Some("Stopped via admin CLI".to_string())).await {
        Ok(_) => Json(ApiResponse { ok: true, error: None }),
        Err(e) => Json(ApiResponse { ok: false, error: Some(e) }),
    }
}

// ===== Plugin Management handlers =====

async fn list_plugins_handler() -> Json<serde_json::Value> {
    match bridge::list_openclaw_plugins().await {
        Ok(plugins) => Json(serde_json::json!({ "ok": true, "plugins": plugins })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallPluginRequest {
    npm_spec: String,
}

async fn install_plugin_handler(Json(req): Json<InstallPluginRequest>) -> Json<serde_json::Value> {
    // install_openclaw_plugin requires AppHandle, but Management API doesn't have it.
    // Use the global app handle from logger module.
    let app_handle = match crate::logger::get_app_handle() {
        Some(h) => h,
        None => return Json(serde_json::json!({ "ok": false, "error": "App not initialized" })),
    };
    match bridge::install_openclaw_plugin(app_handle, &req.npm_spec).await {
        Ok(metadata) => Json(serde_json::json!({ "ok": true, "plugin": metadata })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UninstallPluginRequest {
    plugin_id: String,
}

async fn uninstall_plugin_handler(Json(req): Json<UninstallPluginRequest>) -> Json<serde_json::Value> {
    match bridge::uninstall_openclaw_plugin(&req.plugin_id).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

// ===== Agent Runtime Status handler =====

async fn agent_runtime_status_handler() -> Json<serde_json::Value> {
    let agents = match get_agents() {
        Some(a) => a,
        None => return Json(serde_json::json!({ "ok": true, "agents": {} })),
    };

    let agents_guard = agents.lock().await;

    // Snapshot data under lock, then drop lock before awaiting health states
    struct AgentSnapshot {
        agent_id: String,
        agent_name: String,
        enabled: bool,
        channels: Vec<ChannelRuntimeSnapshot>,
    }
    struct ChannelRuntimeSnapshot {
        channel_id: String,
        platform_str: String,
        health: std::sync::Arc<im::health::HealthManager>,
    }

    let mut snapshots: Vec<AgentSnapshot> = Vec::new();
    for (agent_id, agent) in agents_guard.iter() {
        let mut ch_snapshots = Vec::new();
        for (ch_id, ch) in &agent.channels {
            let platform_str = serde_json::to_value(&ch.bot_instance.platform)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            ch_snapshots.push(ChannelRuntimeSnapshot {
                channel_id: ch_id.clone(),
                platform_str,
                health: std::sync::Arc::clone(&ch.bot_instance.health),
            });
        }
        snapshots.push(AgentSnapshot {
            agent_id: agent_id.clone(),
            agent_name: agent.config.name.clone(),
            enabled: agent.config.enabled,
            channels: ch_snapshots,
        });
    }
    drop(agents_guard);

    // Now resolve health states without holding the lock
    let mut result = serde_json::Map::new();
    for snap in snapshots {
        let mut channels = Vec::new();
        for ch in &snap.channels {
            let health_state = ch.health.get_state().await;
            let status_str = serde_json::to_value(&health_state.status)
                .and_then(|v| serde_json::from_value::<String>(v))
                .unwrap_or_else(|_| "unknown".to_string());
            channels.push(serde_json::json!({
                "channelId": ch.channel_id,
                "channelType": ch.platform_str,
                "status": status_str,
                "uptimeSeconds": health_state.uptime_seconds,
                "lastMessageAt": health_state.last_message_at,
                "errorMessage": health_state.error_message,
                "activeSessions": health_state.active_sessions.len(),
                "restartCount": health_state.restart_count,
            }));
        }
        result.insert(snap.agent_id.clone(), serde_json::json!({
            "agentId": snap.agent_id,
            "agentName": snap.agent_name,
            "enabled": snap.enabled,
            "channels": channels,
        }));
    }

    Json(serde_json::json!({ "ok": true, "agents": result }))
}

// ===== Bridge Message handler (OpenClaw Channel Plugin → Rust) =====

/// Media attachment from Plugin Bridge (base64-encoded).
/// Classified by the Bridge shim based on MIME type:
///   - "image" → ImAttachmentType::Image (Claude Vision API)
///   - "file"  → ImAttachmentType::File (save to workspace + @path reference)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeAttachment {
    file_name: String,
    mime_type: String,
    /// base64-encoded file content
    data: String,
    /// "image" | "file"
    attachment_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeMessagePayload {
    bot_id: String,
    plugin_id: String,
    sender_id: String,
    sender_name: Option<String>,
    text: String,
    chat_type: String,       // "direct" | "group"
    chat_id: String,
    message_id: Option<String>,
    #[allow(dead_code)]
    group_id: Option<String>,
    is_mention: Option<bool>,
    /// Human-readable group name from plugin (e.g. GroupSubject in OpenClaw Feishu)
    #[serde(default)]
    group_name: Option<String>,
    /// Thread ID for threaded replies (MessageThreadId in OpenClaw)
    #[serde(default)]
    #[allow(dead_code)]
    thread_id: Option<String>,
    /// Quoted reply text content (ReplyToBody in OpenClaw)
    #[serde(default)]
    reply_to_body: Option<String>,
    /// Group-level custom system prompt from plugin config
    #[serde(default)]
    group_system_prompt: Option<String>,
    /// Media attachments from OpenClaw plugin (images, files, voice, video)
    #[serde(default)]
    attachments: Vec<BridgeAttachment>,
}

async fn handle_bridge_message(
    Json(payload): Json<BridgeMessagePayload>,
) -> (axum::http::StatusCode, Json<serde_json::Value>) {
    use crate::im::bridge;
    use crate::im::types::{ImAttachment, ImAttachmentType, ImMessage, ImPlatform, ImSourceType};

    // Validate plugin_id: reject empty, path separators, and colons.
    // Note: built-in platform names ("feishu" etc.) are allowed because OpenClaw plugins
    // may legitimately use them as channel IDs (e.g. official Feishu plugin = "feishu").
    // Bridge routing uses botId (UUID), not pluginId, so there's no collision.
    let plugin_id = payload.plugin_id.trim().to_string();
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains(':')
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Invalid plugin_id: '{}'", plugin_id)
            })),
        );
    }

    let sender = match bridge::get_bridge_sender(&payload.bot_id).await {
        Some(tx) => tx,
        None => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": format!("No bridge sender registered for bot_id={}", payload.bot_id)
                })),
            );
        }
    };

    let source_type = if payload.chat_type == "group" {
        ImSourceType::Group
    } else {
        ImSourceType::Private
    };
    // Default: private=true (directed at bot), group=false (only if explicitly flagged)
    let is_mention = payload.is_mention.unwrap_or(source_type == ImSourceType::Private);

    // Decode base64 media attachments from Bridge
    let mut im_attachments: Vec<ImAttachment> = Vec::new();
    for att in &payload.attachments {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(&att.data) {
            Ok(data) => {
                let attachment_type = if att.attachment_type == "image" {
                    ImAttachmentType::Image
                } else {
                    ImAttachmentType::File
                };
                crate::ulog_info!(
                    "[im-bridge] Decoded {} attachment: {} ({}, {} bytes)",
                    att.attachment_type,
                    att.file_name,
                    att.mime_type,
                    data.len()
                );
                im_attachments.push(ImAttachment {
                    file_name: att.file_name.clone(),
                    mime_type: att.mime_type.clone(),
                    data,
                    attachment_type,
                });
            }
            Err(e) => {
                crate::ulog_error!(
                    "[im-bridge] Failed to decode base64 for {}: {}",
                    att.file_name,
                    e
                );
            }
        }
    }

    let msg = ImMessage {
        chat_id: payload.chat_id,
        message_id: payload.message_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        text: payload.text,
        sender_id: payload.sender_id,
        sender_name: payload.sender_name,
        source_type,
        platform: ImPlatform::OpenClaw(plugin_id),
        timestamp: chrono::Utc::now(),
        attachments: im_attachments,
        media_group_id: None,
        is_mention,
        reply_to_bot: false,
        hint_group_name: payload.group_name,
        reply_to_body: payload.reply_to_body,
        group_system_prompt: payload.group_system_prompt,
    };

    match sender.send(msg).await {
        Ok(_) => (
            axum::http::StatusCode::OK,
            Json(serde_json::json!({ "ok": true })),
        ),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("Failed to send message to processing loop: {}", e)
            })),
        ),
    }
}
