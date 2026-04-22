// IM Bot integration module
// Manages the Telegram Bot lifecycle, routing IM messages to AI Sidecars.

pub mod adapter;
pub mod bridge;
pub mod buffer;
pub mod dingtalk;
pub mod feishu;
pub mod group_history;
pub mod health;
pub mod heartbeat;
pub mod memory_update;
pub mod router;
pub mod telegram;
pub mod types;
mod util;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::StreamExt;
use reqwest::Client;
use serde_json::json;
use tauri::{AppHandle, Emitter, Runtime};
use crate::{ulog_info, ulog_warn, ulog_error, ulog_debug};
use tokio::sync::{watch, Mutex, RwLock, Semaphore};
use tokio::task::JoinSet;

use tokio::sync::mpsc;

use crate::sidecar::ManagedSidecarManager;

/// Approval callback from IM platform (button click or text command)
pub struct ApprovalCallback {
    pub request_id: String,
    pub decision: String,  // "allow_once" | "always_allow" | "deny"
    #[allow(dead_code)]
    pub user_id: String,
}

/// Pending approval waiting for user response
struct PendingApproval {
    sidecar_port: u16,
    chat_id: String,
    card_message_id: String,
    created_at: Instant,
}

type PendingApprovals = Arc<Mutex<HashMap<String, PendingApproval>>>;

/// Per-peer locks: serializes requests (IM chat + heartbeat) to the same Sidecar.
/// Required because /api/im/chat uses a single imStreamCallback; concurrent
/// requests would conflict. Shared between processing loop and heartbeat runner.
pub(crate) type PeerLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

use bridge::BridgeAdapter;
use buffer::MessageBuffer;
use dingtalk::DingtalkAdapter;
use feishu::FeishuAdapter;
use health::HealthManager;
use router::{
    create_sidecar_stream_client, RouteError, SessionRouter, GLOBAL_CONCURRENCY,
};
use telegram::TelegramAdapter;
use group_history::{GroupHistoryBuffer, GroupHistoryEntry};
use types::{BotConfigPatch, GroupActivation, GroupEvent, GroupPermission, GroupPermissionStatus, ImAttachmentType, ImBotStatus, ImConfig, ImConversation, ImMessage, ImPlatform, ImSourceType, ImStatus};

/// Platform-agnostic adapter enum — avoids dyn dispatch overhead.
pub(crate) enum AnyAdapter {
    Telegram(Arc<TelegramAdapter>),
    Feishu(Arc<FeishuAdapter>),
    Dingtalk(Arc<DingtalkAdapter>),
    Bridge(Arc<BridgeAdapter>),
}

impl adapter::ImAdapter for AnyAdapter {
    async fn verify_connection(&self) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => a.verify_connection().await,
            Self::Feishu(a) => a.verify_connection().await,
            Self::Dingtalk(a) => a.verify_connection().await,
            Self::Bridge(a) => a.verify_connection().await,
        }
    }
    async fn register_commands(&self) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.register_commands().await,
            Self::Feishu(a) => a.register_commands().await,
            Self::Dingtalk(a) => a.register_commands().await,
            Self::Bridge(a) => a.register_commands().await,
        }
    }
    async fn listen_loop(&self, shutdown_rx: tokio::sync::watch::Receiver<bool>) {
        match self {
            Self::Telegram(a) => a.listen_loop(shutdown_rx).await,
            Self::Feishu(a) => a.listen_loop(shutdown_rx).await,
            Self::Dingtalk(a) => a.listen_loop(shutdown_rx).await,
            Self::Bridge(a) => a.listen_loop(shutdown_rx).await,
        }
    }
    async fn send_message(&self, chat_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Feishu(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Dingtalk(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
            Self::Bridge(a) => adapter::ImAdapter::send_message(a.as_ref(), chat_id, text).await,
        }
    }
    async fn ack_received(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
            Self::Dingtalk(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
            Self::Bridge(a) => adapter::ImAdapter::ack_received(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn ack_processing(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
            Self::Dingtalk(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
            Self::Bridge(a) => adapter::ImAdapter::ack_processing(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn ack_clear(&self, chat_id: &str, message_id: &str) {
        match self {
            Self::Telegram(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
            Self::Dingtalk(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
            Self::Bridge(a) => adapter::ImAdapter::ack_clear(a.as_ref(), chat_id, message_id).await,
        }
    }
    async fn send_typing(&self, chat_id: &str) {
        match self {
            Self::Telegram(a) => a.send_typing(chat_id).await,
            Self::Feishu(a) => a.send_typing(chat_id).await,
            Self::Dingtalk(a) => a.send_typing(chat_id).await,
            Self::Bridge(a) => a.send_typing(chat_id).await,
        }
    }
}

impl adapter::ImStreamAdapter for AnyAdapter {
    async fn send_message_returning_id(&self, chat_id: &str, text: &str) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Feishu(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Dingtalk(a) => a.send_message_returning_id(chat_id, text).await,
            Self::Bridge(a) => a.send_message_returning_id(chat_id, text).await,
        }
    }
    async fn edit_message(&self, chat_id: &str, message_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
            Self::Feishu(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
            Self::Dingtalk(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
            Self::Bridge(a) => adapter::ImStreamAdapter::edit_message(a.as_ref(), chat_id, message_id, text).await,
        }
    }
    async fn delete_message(&self, chat_id: &str, message_id: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
            Self::Feishu(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
            Self::Dingtalk(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
            Self::Bridge(a) => adapter::ImStreamAdapter::delete_message(a.as_ref(), chat_id, message_id).await,
        }
    }
    fn max_message_length(&self) -> usize {
        match self {
            Self::Telegram(a) => a.max_message_length(),
            Self::Feishu(a) => a.max_message_length(),
            Self::Dingtalk(a) => a.max_message_length(),
            Self::Bridge(a) => a.max_message_length(),
        }
    }
    async fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_approval_card(chat_id, request_id, tool_name, tool_input).await.map_err(|e| e.to_string()),
            Self::Feishu(a) => a.send_approval_card(chat_id, request_id, tool_name, tool_input).await,
            Self::Dingtalk(a) => adapter::ImStreamAdapter::send_approval_card(a.as_ref(), chat_id, request_id, tool_name, tool_input).await,
            Self::Bridge(a) => a.send_approval_card(chat_id, request_id, tool_name, tool_input).await,
        }
    }
    async fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.update_approval_status(chat_id, message_id, status).await.map_err(|e| e.to_string()),
            Self::Feishu(a) => a.update_approval_status(message_id, status).await,
            Self::Dingtalk(a) => adapter::ImStreamAdapter::update_approval_status(a.as_ref(), chat_id, message_id, status).await,
            Self::Bridge(a) => adapter::ImStreamAdapter::update_approval_status(a.as_ref(), chat_id, message_id, status).await,
        }
    }
    async fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Feishu(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Dingtalk(a) => a.send_photo(chat_id, data, filename, caption).await,
            Self::Bridge(a) => a.send_photo(chat_id, data, filename, caption).await,
        }
    }
    async fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> adapter::AdapterResult<Option<String>> {
        match self {
            Self::Telegram(a) => a.send_file(chat_id, data, filename, mime_type, caption).await,
            Self::Feishu(a) => a.send_file(chat_id, data, filename, mime_type, caption).await,
            Self::Dingtalk(a) => a.send_file(chat_id, data, filename, mime_type, caption).await,
            Self::Bridge(a) => a.send_file(chat_id, data, filename, mime_type, caption).await,
        }
    }
    async fn finalize_message(&self, chat_id: &str, message_id: &str, text: &str) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Feishu(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Dingtalk(a) => a.finalize_message(chat_id, message_id, text).await,
            Self::Bridge(a) => a.finalize_message(chat_id, message_id, text).await,
        }
    }
    fn use_draft_streaming(&self) -> bool {
        match self {
            Self::Telegram(a) => a.use_draft_streaming(),
            Self::Feishu(a) => a.use_draft_streaming(),
            Self::Dingtalk(a) => a.use_draft_streaming(),
            Self::Bridge(a) => a.use_draft_streaming(),
        }
    }
    fn preferred_throttle_ms(&self) -> u64 {
        match self {
            Self::Telegram(a) => a.preferred_throttle_ms(),
            Self::Feishu(a) => a.preferred_throttle_ms(),
            Self::Dingtalk(a) => a.preferred_throttle_ms(),
            Self::Bridge(a) => a.preferred_throttle_ms(),
        }
    }
    fn supports_edit(&self) -> bool {
        match self {
            Self::Telegram(a) => a.supports_edit(),
            Self::Feishu(a) => a.supports_edit(),
            Self::Dingtalk(a) => a.supports_edit(),
            Self::Bridge(a) => a.supports_edit(),
        }
    }
    fn bridge_context(&self) -> Option<(u16, String, Vec<String>)> {
        match self {
            Self::Telegram(a) => a.bridge_context(),
            Self::Feishu(a) => a.bridge_context(),
            Self::Dingtalk(a) => a.bridge_context(),
            Self::Bridge(a) => a.bridge_context(),
        }
    }
    fn supports_streaming(&self) -> bool {
        match self {
            Self::Telegram(a) => a.supports_streaming(),
            Self::Feishu(a) => a.supports_streaming(),
            Self::Dingtalk(a) => a.supports_streaming(),
            Self::Bridge(a) => a.supports_streaming(),
        }
    }
    async fn start_stream(&self, chat_id: &str, initial_text: &str) -> adapter::AdapterResult<String> {
        match self {
            Self::Telegram(a) => a.start_stream(chat_id, initial_text).await,
            Self::Feishu(a) => a.start_stream(chat_id, initial_text).await,
            Self::Dingtalk(a) => a.start_stream(chat_id, initial_text).await,
            Self::Bridge(a) => a.start_stream(chat_id, initial_text).await,
        }
    }
    async fn stream_chunk(
        &self,
        chat_id: &str,
        stream_id: &str,
        text: &str,
        sequence: u32,
        is_thinking: bool,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking).await,
            Self::Feishu(a) => a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking).await,
            Self::Dingtalk(a) => a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking).await,
            Self::Bridge(a) => a.stream_chunk(chat_id, stream_id, text, sequence, is_thinking).await,
        }
    }
    async fn finalize_stream(
        &self,
        chat_id: &str,
        stream_id: &str,
        final_text: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Feishu(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Dingtalk(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
            Self::Bridge(a) => a.finalize_stream(chat_id, stream_id, final_text).await,
        }
    }
    async fn abort_stream(
        &self,
        chat_id: &str,
        stream_id: &str,
    ) -> adapter::AdapterResult<()> {
        match self {
            Self::Telegram(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Feishu(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Dingtalk(a) => a.abort_stream(chat_id, stream_id).await,
            Self::Bridge(a) => a.abort_stream(chat_id, stream_id).await,
        }
    }
}

/// Managed state for the IM Bot subsystem (multi-bot: bot_id → instance)
pub type ManagedImBots = Arc<Mutex<HashMap<String, ImBotInstance>>>;

/// Running IM Bot instance
pub struct ImBotInstance {
    #[allow(dead_code)]
    pub(crate) bot_id: String,
    #[allow(dead_code)]
    pub(crate) platform: ImPlatform,
    shutdown_tx: watch::Sender<bool>,
    pub(crate) health: Arc<HealthManager>,
    pub(crate) router: Arc<Mutex<SessionRouter>>,
    buffer: Arc<Mutex<MessageBuffer>>,
    started_at: Instant,
    /// JoinHandle for the message processing loop (awaited during graceful shutdown)
    process_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the platform listen loop (long-poll / WebSocket)
    poll_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the approval callback handler
    approval_handle: tokio::task::JoinHandle<()>,
    /// JoinHandle for the health persist loop
    health_handle: tokio::task::JoinHandle<()>,
    /// Random bind code for QR code binding flow
    bind_code: String,
    #[allow(dead_code)]
    pub(crate) config: ImConfig,
    // ===== Heartbeat (v0.1.21) =====
    /// Heartbeat runner background task handle
    heartbeat_handle: Option<tokio::task::JoinHandle<()>>,
    /// Channel to send wake signals to heartbeat runner
    pub heartbeat_wake_tx: Option<mpsc::Sender<types::WakeReason>>,
    /// Shared heartbeat config (for hot updates)
    heartbeat_config: Option<Arc<tokio::sync::RwLock<types::HeartbeatConfig>>>,
    /// Platform adapter (retained for graceful shutdown — e.g. dedup flush)
    pub(crate) adapter: Arc<AnyAdapter>,
    /// Bridge process handle (OpenClaw plugins only)
    bridge_process: Option<tokio::sync::Mutex<bridge::BridgeProcess>>,
    // ===== Hot-reloadable config =====
    pub(crate) current_model: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) current_provider_env: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub(crate) permission_mode: Arc<tokio::sync::RwLock<String>>,
    pub(crate) mcp_servers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    pub(crate) allowed_users: Arc<tokio::sync::RwLock<Vec<String>>>,
    // ===== Group Chat (v0.1.28) =====
    pub(crate) group_permissions: Arc<tokio::sync::RwLock<Vec<GroupPermission>>>,
    pub(crate) group_activation: Arc<tokio::sync::RwLock<GroupActivation>>,
    pub(crate) group_tools_deny: Arc<tokio::sync::RwLock<Vec<String>>>,
    pub(crate) group_history: Arc<Mutex<GroupHistoryBuffer>>,
    // ===== Agent link (v0.1.41) =====
    /// Set after the bot is moved into an AgentInstance; the processing loop sees updates via Arc.
    pub(crate) agent_link: SharedAgentLink,
}

// ===== Agent Architecture (v0.1.41) =====

use types::{AgentConfigRust, AgentConfigPatch, AgentStatus, ChannelConfigRust, ChannelStatus, LastActiveChannel};

/// Info linking an ImBotInstance back to its parent Agent (set after moving into AgentInstance).
/// The processing loop holds a clone of this Arc; writing to it after spawn is visible to the task.
#[derive(Clone)]
pub(crate) struct AgentChannelLink {
    pub channel_id: String,
    pub agent_id: String,
    /// Shared with `AgentInstance.last_active_channel` — the processing loop writes here.
    pub last_active_channel: Arc<RwLock<Option<LastActiveChannel>>>,
}

/// Shared, write-after-spawn link — the processing loop reads this via Arc.
pub(crate) type SharedAgentLink = Arc<RwLock<Option<AgentChannelLink>>>;

/// Running Channel instance within an Agent
pub struct ChannelInstance {
    pub channel_id: String,
    /// The underlying ImBotInstance that does the actual work
    /// (reuses existing infrastructure — adapter, router, buffer, health, etc.)
    pub bot_instance: ImBotInstance,
}

/// Running Agent instance (holds multiple ChannelInstances)
pub struct AgentInstance {
    pub agent_id: String,
    pub config: AgentConfigRust,
    pub channels: HashMap<String, ChannelInstance>,
    pub last_active_channel: Arc<tokio::sync::RwLock<Option<LastActiveChannel>>>,
    // Agent-level heartbeat (shared across channels)
    pub heartbeat_handle: Option<tokio::task::JoinHandle<()>>,
    pub heartbeat_wake_tx: Option<mpsc::Sender<types::WakeReason>>,
    pub heartbeat_config: Option<Arc<tokio::sync::RwLock<types::HeartbeatConfig>>>,
    // Agent-level hot-reloadable AI config (shared defaults)
    pub current_model: Arc<tokio::sync::RwLock<Option<String>>>,
    pub current_provider_env: Arc<tokio::sync::RwLock<Option<serde_json::Value>>>,
    pub permission_mode: Arc<tokio::sync::RwLock<String>>,
    pub mcp_servers_json: Arc<tokio::sync::RwLock<Option<String>>>,
    // Memory auto-update (v0.1.43)
    pub memory_update_config: Option<Arc<tokio::sync::RwLock<Option<types::MemoryAutoUpdateConfig>>>>,
    pub memory_update_running: Option<Arc<std::sync::atomic::AtomicBool>>,
}

/// Managed state for the Agent subsystem (agent_id → instance)
pub type ManagedAgents = Arc<Mutex<HashMap<String, AgentInstance>>>;

/// Create the managed Agent state (called during app setup)
pub fn create_agent_state() -> ManagedAgents {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Signal all running agents to shut down (sync, for use in app exit handlers).
pub fn signal_all_agents_shutdown(agent_state: &ManagedAgents) {
    if let Ok(agents) = agent_state.try_lock() {
        for (agent_id, instance) in agents.iter() {
            log::info!("[agent] Signaling shutdown for agent {}", agent_id);
            for (channel_id, ch) in &instance.channels {
                log::info!("[agent] Shutting down channel {} of agent {}", channel_id, agent_id);
                let _ = ch.bot_instance.shutdown_tx.send(true);
                ch.bot_instance.poll_handle.abort();
                ch.bot_instance.process_handle.abort();
                ch.bot_instance.approval_handle.abort();
                ch.bot_instance.health_handle.abort();
                if let Some(ref h) = ch.bot_instance.heartbeat_handle {
                    h.abort();
                }
            }
            if let Some(ref h) = instance.heartbeat_handle {
                h.abort();
            }
        }
    } else {
        log::warn!("[agent] Could not acquire lock for shutdown signal, agents may linger");
    }
}

/// Create the managed IM Bot state (called during app setup)
pub fn create_im_bot_state() -> ManagedImBots {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Signal all running IM bots to shut down (sync, for use in app exit handlers).
/// Best-effort: uses try_lock to avoid blocking if mutex is held.
pub fn signal_all_bots_shutdown(im_state: &ManagedImBots) {
    if let Ok(bots) = im_state.try_lock() {
        for (bot_id, instance) in bots.iter() {
            log::info!("[im] Signaling shutdown for bot {}", bot_id);
            let _ = instance.shutdown_tx.send(true);
            instance.poll_handle.abort();
            instance.process_handle.abort();
            instance.approval_handle.abort();
            instance.health_handle.abort();
            if let Some(ref h) = instance.heartbeat_handle {
                h.abort();
            }
        }
    } else {
        log::warn!("[im] Could not acquire lock for shutdown signal, IM bots may linger");
    }
}

/// Shutdown a single bot instance (extracted from stop_im_bot for reuse by agent commands).
/// Does NOT lock any global state — caller is responsible for removing the instance first.
async fn shutdown_bot_instance(
    instance: ImBotInstance,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: &str,
) -> Result<(), String> {
    ulog_info!("[im] Stopping bot instance {}...", bot_id);

    // Signal shutdown to all loops
    let _ = instance.shutdown_tx.send(true);

    // Abort poll_handle to cancel in-flight long-poll HTTP request immediately
    instance.poll_handle.abort();

    // Wait for in-flight messages to finish (graceful: up to 10s)
    match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        instance.process_handle,
    )
    .await
    {
        Ok(_) => ulog_info!("[im] Processing loop exited gracefully"),
        Err(_) => ulog_warn!("[im] Processing loop did not exit within 10s, proceeding with shutdown"),
    }

    // Wait for auxiliary tasks
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.approval_handle).await;
    if let Some(hb) = instance.heartbeat_handle {
        // abort() the heartbeat task to ensure prompt shutdown.
        // Heartbeat may be blocked in create_sidecar_blocking (Phase 2, up to 5 min)
        // or in the heartbeat HTTP call itself. abort() cancels at the next .await point.
        hb.abort();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), hb).await;
    }
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), instance.health_handle).await;

    // Persist remaining buffered messages to disk
    if let Err(e) = instance.buffer.lock().await.save_to_disk() {
        ulog_warn!("[im] Failed to persist buffer on shutdown: {}", e);
    }

    // Flush dedup cache to disk (Feishu only)
    if let AnyAdapter::Feishu(ref feishu) = *instance.adapter {
        feishu.flush_dedup_cache().await;
    }

    // Kill bridge process and unregister sender (OpenClaw only)
    if let Some(bp_mutex) = instance.bridge_process {
        let mut bp = bp_mutex.lock().await;
        bp.kill().await;
        bridge::unregister_bridge_sender(bot_id).await;
    }

    // Persist active sessions in health state before releasing Sidecars
    instance
        .health
        .set_active_sessions(instance.router.lock().await.active_sessions())
        .await;

    // Release all Sidecar sessions
    instance
        .router
        .lock()
        .await
        .release_all(sidecar_manager);

    // Final health state: mark as Stopped and persist
    instance.health.set_status(ImStatus::Stopped).await;
    let _ = instance.health.persist().await;

    ulog_info!("[im] Bot instance {} stopped", bot_id);
    Ok(())
}

/// Create a bot instance without locking or inserting into any global container.
/// Core logic extracted from start_im_bot for reuse by agent channel commands.
/// `agent_id` controls:
///   - Router session key format (TD-2: `agent:` prefix vs legacy `im:`)
///   - Health file path (TD-3: `agents/{id}/channels/` vs `im_bots/`)
async fn create_bot_instance<R: Runtime>(
    app_handle: &AppHandle<R>,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
    agent_id: Option<String>,
) -> Result<(ImBotInstance, ImBotStatus), String> {
    ulog_info!(
        "[im] Starting IM Bot {} (configured workspace: {:?})",
        bot_id,
        config.default_workspace_path,
    );

    // Migrate legacy files to per-bot paths on first start
    health::migrate_legacy_files(&bot_id);

    // TD-3: Migrate bot data to agent path if this is an agent channel
    if let Some(ref aid) = agent_id {
        health::migrate_bot_data_to_agent(&bot_id, aid);
    }

    // Determine default workspace (filter empty strings from frontend)
    // Fallback chain: configured path → bundled mino → home dir
    let default_workspace = config
        .default_workspace_path
        .as_ref()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            // Try bundled mino workspace first
            dirs::home_dir()
                .map(|h| h.join(".pm-copilot").join("projects").join("mino"))
                .filter(|p| p.exists())
                .unwrap_or_else(|| {
                    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
                })
        });

    ulog_info!("[im] Resolved workspace: {}", default_workspace.display());
    let default_workspace_str = default_workspace.to_string_lossy().to_string();

    // Initialize components (TD-3: agent channels use agent-scoped paths)
    let health_path = match &agent_id {
        Some(aid) => health::agent_channel_health_path(aid, &bot_id),
        None => health::bot_health_path(&bot_id),
    };
    let health = Arc::new(HealthManager::new(health_path));
    health.set_status(ImStatus::Connecting).await;

    let buffer_path = match &agent_id {
        Some(aid) => health::agent_channel_buffer_path(aid, &bot_id),
        None => health::bot_buffer_path(&bot_id),
    };
    let buffer = Arc::new(Mutex::new(MessageBuffer::load_from_disk(&buffer_path)));

    // TD-2: Agent channels use new_for_agent() for agent-scoped session keys
    let router = {
        let mut r = match &agent_id {
            Some(aid) => SessionRouter::new_for_agent(default_workspace, aid.clone()),
            None => SessionRouter::new(default_workspace),
        };
        // Restore peer→session mapping from previous run's im_state.json
        let prev_sessions = health.get_state().await.active_sessions;
        r.restore_sessions(&prev_sessions);
        Arc::new(Mutex::new(r))
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Shared mutable whitelist — updated when a user binds via QR code
    let allowed_users = Arc::new(tokio::sync::RwLock::new(config.allowed_users.clone()));

    // Shared mutable model — updated by /model command from Telegram
    let current_model = Arc::new(tokio::sync::RwLock::new(config.model.clone()));

    // Generate bind code for QR code binding flow
    let bind_code = format!("BIND_{}", &uuid::Uuid::new_v4().to_string()[..8]);

    // Create approval channel for permission request callbacks
    let (approval_tx, mut approval_rx) = mpsc::channel::<ApprovalCallback>(32);
    let pending_approvals: PendingApprovals = Arc::new(Mutex::new(HashMap::new()));

    // Create group event channel for bot added/removed from groups
    let (group_event_tx, mut group_event_rx) = mpsc::channel::<GroupEvent>(32);

    // Initialize group chat state from config (loaded from disk)
    let initial_activation = match config.group_activation.as_deref() {
        Some("always") => GroupActivation::Always,
        _ => GroupActivation::Mention,
    };
    let group_permissions: Arc<tokio::sync::RwLock<Vec<GroupPermission>>> = Arc::new(
        tokio::sync::RwLock::new(config.group_permissions.clone()),
    );
    let group_activation: Arc<tokio::sync::RwLock<GroupActivation>> = Arc::new(
        tokio::sync::RwLock::new(initial_activation),
    );
    let group_tools_deny: Arc<tokio::sync::RwLock<Vec<String>>> = Arc::new(
        tokio::sync::RwLock::new(config.group_tools_deny.clone()),
    );
    let group_history: Arc<Mutex<GroupHistoryBuffer>> = Arc::new(
        Mutex::new(GroupHistoryBuffer::new()),
    );

    // Create platform adapter (implements ImAdapter + ImStreamAdapter traits)
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel(256);
    let msg_tx_for_reinjection = msg_tx.clone(); // For media group merge re-injection
    let mut bridge_process_handle: Option<bridge::BridgeProcess> = None;
    let adapter: Arc<AnyAdapter> = match config.platform {
        ImPlatform::Telegram => Arc::new(AnyAdapter::Telegram(Arc::new(TelegramAdapter::new(
            &config,
            msg_tx.clone(),
            Arc::clone(&allowed_users),
            approval_tx.clone(),
            group_event_tx.clone(),
        )))),
        ImPlatform::Feishu => {
            let dedup_path = Some(match &agent_id {
                Some(aid) => health::agent_channel_dedup_path(aid, &bot_id),
                None => health::bot_dedup_path(&bot_id),
            });
            Arc::new(AnyAdapter::Feishu(Arc::new(FeishuAdapter::new(
                &config,
                msg_tx.clone(),
                Arc::clone(&allowed_users),
                approval_tx.clone(),
                dedup_path,
                group_event_tx.clone(),
            ))))
        }
        ImPlatform::Dingtalk => {
            let dedup_path = Some(match &agent_id {
                Some(aid) => health::agent_channel_dedup_path(aid, &bot_id),
                None => health::bot_dedup_path(&bot_id),
            });
            Arc::new(AnyAdapter::Dingtalk(Arc::new(DingtalkAdapter::new(
                &config,
                msg_tx.clone(),
                Arc::clone(&allowed_users),
                approval_tx.clone(),
                dedup_path,
                group_event_tx.clone(),
            ))))
        }
        ImPlatform::OpenClaw(ref channel_id) => {
            // Allocate port for bridge process
            let bridge_port = {
                let manager = sidecar_manager.lock().unwrap();
                manager.allocate_port()?
            };

            let rust_port = crate::management_api::get_management_port();
            let plugin_id = config.openclaw_plugin_id.as_deref()
                .unwrap_or(channel_id);

            let plugin_dir = dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".pm-copilot")
                .join("openclaw-plugins")
                .join(plugin_id);

            let bp = bridge::spawn_plugin_bridge(
                app_handle,
                &plugin_dir.to_string_lossy(),
                bridge_port,
                rust_port,
                &bot_id,
                config.openclaw_plugin_config.as_ref(),
            )
            .await?;

            // Register bridge sender for inbound message routing
            bridge::register_bridge_sender(&bot_id, &channel_id, msg_tx.clone()).await;

            let mut bridge_adapter = BridgeAdapter::new(
                channel_id.clone(),
                bp.port,
            );
            bridge_adapter.sync_capabilities().await;
            // Override with user-configured tool groups (if set in channel config).
            // Auto-merge: any new groups from the plugin that aren't in the user's
            // list get appended so they're available during this channel session.
            // The merge runs on every channel startup (idempotent, not persisted to disk).
            if let Some(ref groups) = config.openclaw_enabled_tool_groups {
                if !groups.is_empty() {
                    let plugin_groups = bridge_adapter.all_tool_groups();
                    let mut merged = groups.clone();
                    let mut new_count = 0usize;
                    for g in plugin_groups {
                        if !merged.contains(g) {
                            merged.push(g.clone());
                            new_count += 1;
                        }
                    }
                    if new_count > 0 {
                        ulog_info!("[im] Auto-merged {} new tool group(s) from plugin into enabled list", new_count);
                    }
                    bridge_adapter.set_enabled_tool_groups(merged);
                }
            }
            let adapter = Arc::new(AnyAdapter::Bridge(Arc::new(bridge_adapter)));
            bridge_process_handle = Some(bp);
            adapter
        }
    };

    // Verify bot connection via ImAdapter + ImStreamAdapter traits
    use adapter::ImAdapter;
    use adapter::ImStreamAdapter;
    match adapter.verify_connection().await {
        Ok(display_name) => {
            ulog_info!("[im] Bot verified: {}", display_name);
            // Store bot display name. Telegram returns "@username", Feishu returns plain name.
            let username = display_name.strip_prefix('@')
                .map(|s| s.to_string())
                .unwrap_or(display_name);
            health.set_bot_username(Some(username)).await;
            health.set_status(ImStatus::Online).await;
            health.set_error(None).await;
            // Emit appropriate event based on whether this is an agent channel or legacy bot
            if agent_id.is_some() {
                let _ = app_handle.emit("agent:status-changed", json!({ "event": "online" }));
            } else {
                let _ = app_handle.emit("im:status-changed", json!({ "event": "online" }));
            }
        }
        Err(e) => {
            let err_msg = format!("Bot connection verification failed: {}", e);
            ulog_error!("[im] {}", err_msg);
            // Clean up bridge process if it was spawned (OpenClaw only)
            if let Some(mut bp) = bridge_process_handle.take() {
                bp.kill_sync();
                bridge::unregister_bridge_sender(&bot_id).await;
            }
            health.set_status(ImStatus::Error).await;
            health.set_error(Some(err_msg.clone())).await;
            let _ = health.persist().await;
            return Err(err_msg);
        }
    }

    // Register platform commands via ImAdapter trait
    if let Err(e) = adapter.register_commands().await {
        ulog_warn!("[im] Failed to register bot commands: {}", e);
    }

    // Start health persist loop
    let health_handle = health.start_persist_loop(shutdown_rx.clone());

    // Start platform listen loop (long-poll for Telegram, health watchdog for Bridge)
    let adapter_clone = Arc::clone(&adapter);
    let poll_shutdown_rx = shutdown_rx.clone();
    let poll_handle = tokio::spawn(async move {
        adapter_clone.listen_loop(poll_shutdown_rx).await;
    });

    // Watch for unexpected listen_loop exit (e.g., Bridge health check failures).
    // If listen_loop ends but shutdown was not signalled, mark bot as error.
    {
        let health_for_watcher = health.clone();
        let mut watcher_shutdown_rx = shutdown_rx.clone();
        let poll_handle_watcher = poll_handle.abort_handle();
        let bot_id_for_watcher = bot_id.clone();
        let shutdown_tx_for_watcher = shutdown_tx.clone();
        tokio::spawn(async move {
            // Wait until either shutdown is signalled or the poll task finishes
            loop {
                tokio::select! {
                    _ = watcher_shutdown_rx.changed() => {
                        if *watcher_shutdown_rx.borrow() { return; } // Normal shutdown
                    }
                    _ = async { while !poll_handle_watcher.is_finished() { tokio::time::sleep(Duration::from_secs(2)).await; } } => {
                        // poll_handle finished without shutdown signal — bridge/adapter died
                        ulog_error!("[im] Listen loop for bot {} exited unexpectedly, marking as error", bot_id_for_watcher);
                        health_for_watcher.set_status(ImStatus::Error).await;
                        health_for_watcher.set_error(Some("Platform connection lost (listen loop exited)".to_string())).await;
                        // Signal shutdown so the processing loop also stops cleanly
                        let _ = shutdown_tx_for_watcher.send(true);
                        return;
                    }
                }
            }
        });
    }

    // Start approval callback handler
    let pending_approvals_for_handler = Arc::clone(&pending_approvals);
    let adapter_for_approval = Arc::clone(&adapter);
    let approval_client = crate::local_http::json_client(std::time::Duration::from_secs(30));
    let mut approval_shutdown_rx = shutdown_rx.clone();
    let approval_handle = tokio::spawn(async move {
        loop {
            let cb = tokio::select! {
                msg = approval_rx.recv() => match msg {
                    Some(cb) => cb,
                    None => break, // Channel closed
                },
                _ = approval_shutdown_rx.changed() => {
                    if *approval_shutdown_rx.borrow() { break; }
                    continue;
                }
            };

            let pending = pending_approvals_for_handler.lock().await.remove(&cb.request_id);
            if let Some(p) = pending {
                // POST decision to Sidecar
                let url = format!("http://127.0.0.1:{}/api/im/permission-response", p.sidecar_port);
                let result = approval_client
                    .post(&url)
                    .json(&json!({
                        "requestId": cb.request_id,
                        "decision": cb.decision,
                    }))
                    .send()
                    .await;
                match result {
                    Ok(resp) if resp.status().is_success() => {
                        ulog_info!("[im] Approval forwarded: rid={}, decision={}", &cb.request_id[..cb.request_id.len().min(16)], cb.decision);
                    }
                    Ok(resp) => {
                        ulog_error!("[im] Approval forward failed: HTTP {}", resp.status());
                    }
                    Err(e) => {
                        ulog_error!("[im] Approval forward error: {}", e);
                    }
                }
                // Update card to show result (skip if card send had failed)
                if !p.card_message_id.is_empty() {
                    let status_text = if cb.decision == "deny" { "denied" } else { "approved" };
                    let _ = adapter_for_approval.update_approval_status(
                        &p.chat_id,
                        &p.card_message_id,
                        status_text,
                    ).await;
                }
            } else {
                ulog_warn!("[im] Approval callback for unknown request_id: {}", &cb.request_id[..cb.request_id.len().min(16)]);
            }
        }
        ulog_info!("[im] Approval handler exited");
    });

    // Per-peer locks: shared between the processing loop and heartbeat runner.
    // Both must acquire the lock for a session_key before calling Sidecar HTTP APIs,
    // because /api/im/chat uses a single imStreamCallback — concurrent requests would conflict.
    let peer_locks: PeerLocks = Arc::new(Mutex::new(HashMap::new()));

    // Start message processing loop
    //
    // Concurrency model:
    //   Commands are handled inline (fast, no I/O to Sidecar).
    //   Regular messages are spawned as per-message tasks via JoinSet.
    //
    //   Lock ordering (per task):
    //     1. Per-peer lock — serializes requests to the same Sidecar (required because
    //        /api/im/chat uses a single imStreamCallback; concurrent requests would conflict).
    //        Heartbeat runner also acquires this lock to prevent callback conflicts.
    //     2. Global semaphore — limits total concurrent Sidecar I/O across all peers.
    //        Acquired AFTER the peer lock so queued same-peer tasks don't hold permits
    //        while waiting, which would starve other peers.
    //     3. Router lock — held briefly for data ops (ensure_sidecar, record_response),
    //        never during the HTTP POST itself.
    let router_clone = Arc::clone(&router);
    let buffer_clone = Arc::clone(&buffer);
    let health_clone = Arc::clone(&health);
    let adapter_for_reply = Arc::clone(&adapter);
    let app_clone = app_handle.clone();
    let manager_clone = Arc::clone(sidecar_manager);
    let permission_mode = Arc::new(tokio::sync::RwLock::new(config.permission_mode.clone()));
    // Parse provider env from config (for per-message forwarding to Sidecar)
    // Wrapped in RwLock so /provider command can update it at runtime
    let provider_env: Option<serde_json::Value> = config
        .provider_env_json
        .as_ref()
        .and_then(|json_str| serde_json::from_str(json_str).ok());
    let current_provider_env = Arc::new(tokio::sync::RwLock::new(provider_env));
    // MCP servers JSON — hot-reloadable
    let mcp_servers_json = Arc::new(tokio::sync::RwLock::new(config.mcp_servers_json.clone()));
    let bot_name_for_loop = config.name.clone();
    let bind_code_for_loop = bind_code.clone();
    let bot_id_for_loop = bot_id.clone();
    let allowed_users_for_loop = Arc::clone(&allowed_users);
    let current_model_for_loop = Arc::clone(&current_model);
    let current_provider_env_for_loop = Arc::clone(&current_provider_env);
    let permission_mode_for_loop = Arc::clone(&permission_mode);
    let mcp_servers_json_for_loop = Arc::clone(&mcp_servers_json);
    let pending_approvals_for_loop = Arc::clone(&pending_approvals);
    let approval_tx_for_loop = approval_tx.clone();
    let group_permissions_for_loop = Arc::clone(&group_permissions);
    let group_activation_for_loop = Arc::clone(&group_activation);
    let group_tools_deny_for_loop = Arc::clone(&group_tools_deny);
    let group_history_for_loop = Arc::clone(&group_history);
    let group_event_tx_for_loop = group_event_tx.clone();
    let mut process_shutdown_rx = shutdown_rx.clone();

    // Concurrency primitives (live outside the router for lock-free access)
    let global_semaphore = Arc::new(Semaphore::new(GLOBAL_CONCURRENCY));
    // peer_locks is created in start_im_bot() and shared with heartbeat runner;
    // the Arc is cloned here for the processing loop.
    let peer_locks_for_loop = Arc::clone(&peer_locks);
    let stream_client = create_sidecar_stream_client();
    let platform_for_loop = config.platform.clone();
    // Agent link — starts as None; set after bot is moved into AgentInstance.
    // The processing loop holds a clone of this Arc and checks it after each message.
    let agent_link: SharedAgentLink = Arc::new(RwLock::new(None));
    let agent_link_for_loop = Arc::clone(&agent_link);

    let process_handle = tokio::spawn(async move {
        let mut in_flight: JoinSet<()> = JoinSet::new();

        // Media group buffering (Telegram albums)
        struct MediaGroupEntry {
            messages: Vec<ImMessage>,
            first_received: Instant,
        }
        let mut media_groups: HashMap<String, MediaGroupEntry> = HashMap::new();
        const MEDIA_GROUP_TIMEOUT: Duration = Duration::from_millis(500);
        const MEDIA_GROUP_CHECK_INTERVAL: Duration = Duration::from_millis(100);

        /// Merge buffered media group messages into one combined message
        fn merge_media_group(mut messages: Vec<ImMessage>) -> ImMessage {
            messages.sort_by_key(|m| m.message_id.parse::<i64>().unwrap_or(0));
            let mut base = messages.remove(0);
            // Use first non-empty text as caption
            if base.text.is_empty() {
                if let Some(msg_with_text) = messages.iter().find(|m| !m.text.is_empty()) {
                    base.text = msg_with_text.text.clone();
                }
            }
            // Merge all attachments
            for msg in messages {
                base.attachments.extend(msg.attachments);
            }
            base.media_group_id = None; // Already merged
            base
        }

        /// Process attachments: save File types to workspace, encode Image types to base64.
        /// This is async to use non-blocking file I/O.
        async fn process_attachments(
            msg: &mut ImMessage,
            workspace_path: &std::path::Path,
        ) -> Vec<serde_json::Value> {
            /// Maximum image size for base64 encoding (10 MB)
            const MAX_IMAGE_ENCODE_SIZE: usize = 10 * 1024 * 1024;

            let mut file_refs: Vec<String> = Vec::new();
            let mut image_payloads: Vec<serde_json::Value> = Vec::new();

            for attachment in &msg.attachments {
                match attachment.attachment_type {
                    ImAttachmentType::File => {
                        let target_dir = workspace_path.join("pm_copilot_files");
                        if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
                            ulog_error!("[im] Failed to create pm_copilot_files dir: {}", e);
                            continue;
                        }
                        let target_path = target_dir.join(&attachment.file_name);
                        let final_path = auto_rename_path(&target_path);
                        if let Err(e) = tokio::fs::write(&final_path, &attachment.data).await {
                            ulog_error!("[im] Failed to save file: {}", e);
                            continue;
                        }
                        let relative = format!(
                            "pm_copilot_files/{}",
                            final_path.file_name().unwrap().to_string_lossy()
                        );
                        file_refs.push(format!("@{}", relative));
                        ulog_info!(
                            "[im] Saved file attachment: {} ({} bytes)",
                            relative,
                            attachment.data.len()
                        );
                    }
                    ImAttachmentType::Image => {
                        if attachment.data.len() > MAX_IMAGE_ENCODE_SIZE {
                            ulog_warn!(
                                "[im] Image too large for base64 encoding: {} ({} bytes, max {})",
                                attachment.file_name,
                                attachment.data.len(),
                                MAX_IMAGE_ENCODE_SIZE
                            );
                            continue;
                        }
                        use base64::Engine;
                        let b64 =
                            base64::engine::general_purpose::STANDARD.encode(&attachment.data);
                        image_payloads.push(json!({
                            "name": attachment.file_name,
                            "mimeType": attachment.mime_type,
                            "data": b64,
                        }));
                        ulog_info!(
                            "[im] Encoded image attachment: {} ({} bytes)",
                            attachment.file_name,
                            attachment.data.len()
                        );
                    }
                }
            }

            // Append @path references to message text
            if !file_refs.is_empty() {
                let refs_text = file_refs.join(" ");
                if msg.text.is_empty() {
                    msg.text = refs_text;
                } else {
                    msg.text = format!("{}\n{}", msg.text, refs_text);
                }
            }

            image_payloads
        }

        loop {
            // Determine flush timeout for media groups
            let flush_timeout = if media_groups.is_empty() {
                Duration::from_secs(3600)
            } else {
                MEDIA_GROUP_CHECK_INTERVAL
            };

            tokio::select! {
                Some(msg) = msg_rx.recv() => {
                    // Buffer media group messages
                    if let Some(ref group_id) = msg.media_group_id {
                        media_groups
                            .entry(group_id.clone())
                            .or_insert_with(|| MediaGroupEntry {
                                messages: Vec::new(),
                                first_received: Instant::now(),
                            })
                            .messages
                            .push(msg);
                        continue;
                    }
                    let session_key = {
                        let r = router_clone.lock().await;
                        r.session_key(&msg)
                    };
                    let chat_id = msg.chat_id.clone();
                    let message_id = msg.message_id.clone();
                    let text = msg.text.trim().to_string();

                    // ── Bot command dispatch (inline — fast, no Sidecar I/O) ──

                    // QR code binding: /start BIND_xxxx
                    // Bind code handling: Telegram uses "/start BIND_xxx", Feishu uses plain "BIND_xxx"
                    let is_telegram_bind = text.starts_with("/start BIND_");
                    let is_feishu_bind = text.starts_with("BIND_") && msg.platform == ImPlatform::Feishu;
                    let is_dingtalk_bind = text.starts_with("BIND_") && msg.platform == ImPlatform::Dingtalk;
                    let is_openclaw_bind = text.starts_with("BIND_") && matches!(msg.platform, ImPlatform::OpenClaw(_));
                    if is_telegram_bind || is_feishu_bind || is_dingtalk_bind || is_openclaw_bind {
                        // If sender is already bound, silently ignore stale BIND_ messages
                        // (Feishu may re-deliver old messages after bot restart clears dedup cache)
                        let already_bound = {
                            let users = allowed_users_for_loop.read().await;
                            users.contains(&msg.sender_id)
                        };
                        if already_bound {
                            ulog_debug!("[im] Ignoring stale BIND message from already-bound user {}", msg.sender_id);
                            continue;
                        }

                        let code = if is_telegram_bind {
                            text.strip_prefix("/start ").unwrap_or("")
                        } else {
                            text.as_str()
                        };
                        if code == bind_code_for_loop {
                            // Valid bind — add user to whitelist
                            let user_id_str = msg.sender_id.clone();
                            let display = msg.sender_name.clone().unwrap_or_else(|| user_id_str.clone());

                            {
                                let mut users = allowed_users_for_loop.write().await;
                                if !users.contains(&user_id_str) {
                                    users.push(user_id_str.clone());
                                    ulog_info!("[im] User bound via QR: {} ({})", display, user_id_str);
                                }
                            }

                            // Persist to config.json directly (doesn't rely on frontend being mounted)
                            {
                                let bid = bot_id_for_loop.clone();
                                let new_users = allowed_users_for_loop.read().await.clone();
                                tokio::task::spawn_blocking(move || {
                                    let patch = BotConfigPatch {
                                        allowed_users: Some(new_users),
                                        ..Default::default()
                                    };
                                    if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                        ulog_warn!("[im] Failed to persist bound user: {}", e);
                                    }
                                });
                            }

                            let reply = format!("✅ 绑定成功！你好 {}，现在可以直接和我聊天了。", display);
                            if let Err(e) = adapter_for_reply.send_message(&chat_id, &reply).await {
                                ulog_warn!("[im-cmd] send_message (bind success) failed: {}", e);
                            }

                            // Emit Tauri events so frontend can update UI
                            let _ = app_clone.emit(
                                "im:user-bound",
                                serde_json::json!({
                                    "botId": bot_id_for_loop,
                                    "userId": user_id_str,
                                    "username": msg.sender_name,
                                }),
                            );
                            let _ = app_clone.emit(
                                "im:bot-config-changed",
                                serde_json::json!({ "botId": bot_id_for_loop }),
                            );
                        } else {
                            if let Err(e) = adapter_for_reply.send_message(
                                &chat_id,
                                "❌ 绑定码无效或已过期，请在 PM Copilot 设置中重新获取二维码。",
                            ).await {
                                ulog_warn!("[im-cmd] send_message (bind invalid) failed: {}", e);
                            }
                        }
                        continue;
                    }

                    // Handle plain /start (first-time interaction, not a bind)
                    if text == "/start" {
                        if let Err(e) = adapter_for_reply.send_message(
                            &chat_id,
                            "👋 你好！我是 PM Copilot Bot。\n\n\
                             可用命令：\n\
                             /help — 查看所有命令\n\
                             /new — 开始新对话\n\
                             /workspace <路径> — 切换工作区\n\
                             /model — 查看或切换 AI 模型\n\
                             /provider — 查看或切换 AI 供应商\n\
                             /mode — 切换权限模式\n\
                             /status — 查看状态\n\n\
                             直接发消息即可开始对话。",
                        ).await {
                            ulog_warn!("[im-cmd] send_message (/start) failed: {}", e);
                        }
                        continue;
                    }

                    if text == "/help" {
                        let mut help = String::from(
                            "📖 可用命令\n\n\
                             /new — 开始新对话（清空当前上下文）\n\
                             /workspace — 查看当前工作区\n\
                             /workspace <路径> — 切换工作区目录\n\
                             /model — 查看当前供应商的可用模型\n\
                             /model <序号或模型ID> — 切换模型\n\
                             /provider — 查看可用 AI 供应商\n\
                             /provider <序号或ID> — 切换供应商\n\
                             /mode — 查看当前权限模式\n\
                             /mode <模式> — 切换模式（plan / auto / full）\n\
                             /status — 查看会话状态\n\
                             /help — 显示本帮助",
                        );
                        // Append plugin commands if available (translate English descriptions to Chinese)
                        if let AnyAdapter::Bridge(ref bridge) = *adapter_for_reply {
                            let cmds = bridge.get_commands();
                            if !cmds.is_empty() {
                                help.push_str("\n\n📦 插件命令\n");
                                for (name, desc) in cmds {
                                    let cn_desc = translate_plugin_command_desc(name, desc);
                                    help.push_str(&format!("/{} — {}\n", name, cn_desc));
                                }
                            }
                        }
                        help.push_str("\n\n💬 直接发送文字即可与 AI 对话。\n🔒 工具审批：收到权限请求时，回复「允许」「始终允许」或「拒绝」。");
                        if let Err(e) = adapter_for_reply.send_message(&chat_id, &help).await {
                            ulog_warn!("[im-cmd] send_message (/help) failed: {}", e);
                        }
                        continue;
                    }

                    if text == "/new" {
                        // Group auth check: only allowedUsers can /new in groups
                        if msg.source_type == ImSourceType::Group {
                            let is_allowed = allowed_users_for_loop.read().await.contains(&msg.sender_id);
                            if !is_allowed {
                                continue; // Silently skip unauthorized /new
                            }
                        }
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        // Clear pending group history so the fresh session doesn't get stale context
                        group_history_for_loop.lock().await.clear(&session_key);
                        let result = router_clone
                            .lock()
                            .await
                            .reset_session(&session_key, &app_clone, &manager_clone)
                            .await;
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        match result {
                            Ok(new_id) => {
                                let reply = format!("✅ 已创建新对话 ({})", &new_id[..8.min(new_id.len())]);
                                if let Err(e) = adapter_for_reply.send_message(&chat_id, &reply).await {
                                    ulog_warn!("[im-cmd] send_message (/new success) failed: {}", e);
                                }
                            }
                            Err(e) => {
                                if let Err(e2) = adapter_for_reply.send_message(&chat_id, &format!("❌ 创建失败: {}", e)).await {
                                    ulog_warn!("[im-cmd] send_message (/new error) failed: {}", e2);
                                }
                            }
                        }
                        continue;
                    }

                    // Private-only commands: silently skip in group chats (v0.1.28)
                    // Note: /start and /help are already handled above (before this point),
                    // so they don't need to be listed here.
                    if msg.source_type == ImSourceType::Group
                        && (text.starts_with("/workspace")
                            || text.starts_with("/model")
                            || text.starts_with("/provider")
                            || text.starts_with("/mode")
                            || text == "/status")
                    {
                        continue;
                    }

                    if text.starts_with("/workspace") {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let path_arg = text.strip_prefix("/workspace").unwrap_or("").trim();
                        let reply = if path_arg.is_empty() {
                            // Show current workspace
                            let router = router_clone.lock().await;
                            let sessions = router.active_sessions();
                            let current = sessions.iter().find(|s| s.session_key == session_key);
                            match current {
                                Some(s) => format!("📁 当前工作区: {}", s.workspace_path),
                                None => "📁 尚未绑定工作区（发送消息后自动绑定默认工作区）".to_string(),
                            }
                        } else {
                            // Switch workspace
                            match router_clone
                                .lock()
                                .await
                                .switch_workspace(&session_key, path_arg, &app_clone, &manager_clone)
                                .await
                            {
                                Ok(_) => format!("✅ 已切换工作区: {}\n⚠️ 仅对当前对话生效，重启后恢复默认工作区", path_arg),
                                Err(e) => format!("❌ 切换失败: {}", e),
                            }
                        };
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        if let Err(e) = adapter_for_reply.send_message(&chat_id, &reply).await {
                            ulog_warn!("[im-cmd] send_message (/workspace) failed: {}", e);
                        }
                        continue;
                    }

                    if text == "/status" {
                        adapter_for_reply.ack_processing(&chat_id, &message_id).await;
                        let router = router_clone.lock().await;
                        let sessions = router.active_sessions();
                        let current = sessions.iter().find(|s| s.session_key == session_key);
                        let reply = match current {
                            Some(s) => format!(
                                "📊 Session 状态\n\n工作区: {}\n消息数: {}\n会话: {}",
                                s.workspace_path, s.message_count, &session_key
                            ),
                            None => format!(
                                "📊 Session 状态\n\n当前无活跃 Session\n会话键: {}",
                                session_key
                            ),
                        };
                        adapter_for_reply.ack_clear(&chat_id, &message_id).await;
                        if let Err(e) = adapter_for_reply.send_message(&chat_id, &reply).await {
                            ulog_warn!("[im-cmd] send_message (/status) failed: {}", e);
                        }
                        continue;
                    }

                    // /model — show or switch AI model (dynamic list from current provider)
                    if text.starts_with("/model") {
                        let arg = text.strip_prefix("/model").unwrap_or("").trim().to_string();

                        // Find current provider's models from availableProvidersJson (lazy-read from disk)
                        let models: Vec<serde_json::Value> = {
                            let providers: Vec<serde_json::Value> = {
                                let ap = tokio::task::spawn_blocking(read_available_providers_from_disk)
                                    .await.ok().flatten();
                                ap.as_ref()
                                    .and_then(|json| serde_json::from_str(json).ok())
                                    .unwrap_or_default()
                            };
                            let current_env = current_provider_env_for_loop.read().await;
                            let current_provider = if current_env.is_none() {
                                // Subscription (Anthropic) — find provider whose id contains "sub"
                                providers.iter().find(|p| {
                                    p["id"].as_str().map(|s| s.contains("sub")).unwrap_or(false)
                                }).cloned()
                            } else {
                                // Match by baseUrl
                                let base_url = current_env.as_ref()
                                    .and_then(|v| v["baseUrl"].as_str());
                                providers.iter()
                                    .find(|p| p["baseUrl"].as_str() == base_url)
                                    .cloned()
                            };
                            current_provider
                                .and_then(|p| p["models"].as_array().cloned())
                                .unwrap_or_default()
                        };

                        if arg.is_empty() {
                            let current = current_model_for_loop.read().await;
                            let display = current.as_deref().unwrap_or("(默认)");

                            if models.is_empty() {
                                // Fallback: no models info available
                                let help = format!(
                                    "📊 当前模型: {}\n\n提示: 可直接输入模型 ID 切换\n用法: /model <模型ID>",
                                    display,
                                );
                                if let Err(e) = adapter_for_reply.send_message(&chat_id, &help).await {
                                    ulog_warn!("[im-cmd] send_message (/model help) failed: {}", e);
                                }
                            } else {
                                let mut menu = format!("📊 当前模型: {}\n\n可用模型:\n", display);
                                for (i, m) in models.iter().enumerate() {
                                    let model_id = m["model"].as_str().unwrap_or("?");
                                    let model_name = m["modelName"].as_str().unwrap_or(model_id);
                                    menu.push_str(&format!("{}. {} ({})\n", i + 1, model_name, model_id));
                                }
                                menu.push_str("\n用法: /model <序号或模型ID>");
                                if let Err(e) = adapter_for_reply.send_message(&chat_id, &menu).await {
                                    ulog_warn!("[im-cmd] send_message (/model list) failed: {}", e);
                                }
                            }
                        } else {
                            // Resolve target model: by index (1-based) or by model ID
                            let model_id = if let Ok(idx) = arg.parse::<usize>() {
                                if idx == 0 {
                                    None // invalid: 1-based index
                                } else {
                                    models.get(idx - 1)
                                        .and_then(|m| m["model"].as_str())
                                        .map(|s| s.to_string())
                                }
                            } else {
                                Some(arg) // accept any string as model ID
                            };

                            match model_id {
                                Some(id) => {
                                    // Update shared model state
                                    {
                                        let mut model_guard = current_model_for_loop.write().await;
                                        *model_guard = Some(id.clone());
                                    }
                                    // If peer has an active Sidecar, log it
                                    let router = router_clone.lock().await;
                                    let sessions = router.active_sessions();
                                    if let Some(s) = sessions.iter().find(|s| s.session_key == session_key) {
                                        drop(router);
                                        ulog_info!("[im] /model: set to {} (session={})", id, s.session_key);
                                    }
                                    if let Err(e) = adapter_for_reply.send_message(
                                        &chat_id,
                                        &format!("✅ 模型已切换为: {}", id),
                                    ).await {
                                        ulog_warn!("[im-cmd] send_message (/model switch) failed: {}", e);
                                    }

                                    // Persist to config.json + notify frontend
                                    let bid = bot_id_for_loop.clone();
                                    let model_str = id.clone();
                                    tokio::task::spawn_blocking(move || {
                                        let patch = BotConfigPatch {
                                            model: Some(model_str),
                                            ..Default::default()
                                        };
                                        if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                            ulog_warn!("[im] /model persist failed: {}", e);
                                        }
                                    });
                                    let _ = app_clone.emit("im:bot-config-changed", json!({
                                        "botId": bot_id_for_loop,
                                    }));
                                }
                                None => {
                                    if let Err(e) = adapter_for_reply.send_message(
                                        &chat_id,
                                        "❌ 无效的序号，请使用 /model 查看可用列表",
                                    ).await {
                                        ulog_warn!("[im-cmd] send_message (/model invalid) failed: {}", e);
                                    }
                                }
                            }
                        }
                        continue;
                    }

                    // /provider — show or switch AI provider
                    if text.starts_with("/provider") {
                        let arg = text.strip_prefix("/provider").unwrap_or("").trim().to_string();

                        // Parse available providers from config (lazy-read from disk)
                        let providers: Vec<serde_json::Value> = {
                            let ap = tokio::task::spawn_blocking(read_available_providers_from_disk)
                                .await.ok().flatten();
                            ap.as_ref()
                                .and_then(|json| serde_json::from_str(json).ok())
                                .unwrap_or_default()
                        };

                        if arg.is_empty() {
                            // Show current provider + available list
                            let current_env = current_provider_env_for_loop.read().await;
                            let current_name = if current_env.is_none() {
                                "Anthropic (订阅) [默认]".to_string()
                            } else {
                                // Find name by matching baseUrl
                                let base_url = current_env.as_ref()
                                    .and_then(|v| v["baseUrl"].as_str());
                                providers.iter()
                                    .find(|p| p["baseUrl"].as_str() == base_url)
                                    .and_then(|p| p["name"].as_str())
                                    .unwrap_or("自定义")
                                    .to_string()
                            };

                            let mut menu = format!("📡 当前供应商: {}\n\n可用供应商:\n", current_name);
                            for (i, p) in providers.iter().enumerate() {
                                let name = p["name"].as_str().unwrap_or("?");
                                let id = p["id"].as_str().unwrap_or("?");
                                menu.push_str(&format!("{}. {} ({})\n", i + 1, name, id));
                            }
                            menu.push_str("\n用法: /provider <序号或ID>");

                            if let Err(e) = adapter_for_reply.send_message(&chat_id, &menu).await {
                                ulog_warn!("[im-cmd] send_message (/provider list) failed: {}", e);
                            }
                        } else {
                            // Switch provider by index (1-based) or ID
                            let target = if let Ok(idx) = arg.parse::<usize>() {
                                providers.get(idx.saturating_sub(1)).cloned()
                            } else {
                                providers.iter()
                                    .find(|p| p["id"].as_str().map(|s| s == arg).unwrap_or(false))
                                    .cloned()
                            };

                            match target {
                                Some(provider) => {
                                    let name = provider["name"].as_str().unwrap_or("?");
                                    let primary_model = provider["primaryModel"].as_str().unwrap_or("");
                                    let provider_id = provider["id"].as_str().unwrap_or("");

                                    // Subscription provider → clear provider env
                                    let (penv_json, pid_str): (Option<String>, Option<String>) = if provider_id.contains("sub") {
                                        *current_provider_env_for_loop.write().await = None;
                                        (Some(String::new()), Some(String::new())) // empty = clear
                                    } else {
                                        // Build new provider env from stored info (include apiProtocol)
                                        let new_env = serde_json::json!({
                                            "baseUrl": provider["baseUrl"],
                                            "apiKey": provider["apiKey"],
                                            "authType": provider["authType"],
                                            "apiProtocol": provider["apiProtocol"],
                                        });
                                        let env_str = new_env.to_string();
                                        *current_provider_env_for_loop.write().await = Some(new_env);
                                        (Some(env_str), Some(provider_id.to_string()))
                                    };

                                    // Also switch model to the provider's primary model
                                    let model_for_persist = if !primary_model.is_empty() {
                                        *current_model_for_loop.write().await = Some(primary_model.to_string());
                                        Some(primary_model.to_string())
                                    } else {
                                        None
                                    };

                                    if let Err(e) = adapter_for_reply.send_message(
                                        &chat_id,
                                        &format!("✅ 已切换供应商: {}\n模型: {}", name, primary_model),
                                    ).await {
                                        ulog_warn!("[im-cmd] send_message (/provider switch) failed: {}", e);
                                    }

                                    // Persist to config.json + notify frontend
                                    let bid = bot_id_for_loop.clone();
                                    tokio::task::spawn_blocking(move || {
                                        let patch = BotConfigPatch {
                                            model: model_for_persist,
                                            provider_env_json: penv_json,
                                            provider_id: pid_str,
                                            ..Default::default()
                                        };
                                        if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                            ulog_warn!("[im] /provider persist failed: {}", e);
                                        }
                                    });
                                    let _ = app_clone.emit("im:bot-config-changed", json!({
                                        "botId": bot_id_for_loop,
                                    }));
                                }
                                None => {
                                    if let Err(e) = adapter_for_reply.send_message(
                                        &chat_id,
                                        "❌ 未找到该供应商，请使用 /provider 查看可用列表",
                                    ).await {
                                        ulog_warn!("[im-cmd] send_message (/provider not found) failed: {}", e);
                                    }
                                }
                            }
                        }
                        continue;
                    }

                    // /mode — show or switch permission mode
                    if text.starts_with("/mode") {
                        let arg = text.strip_prefix("/mode").unwrap_or("").trim().to_lowercase();
                        let current = permission_mode_for_loop.read().await.clone();

                        if arg.is_empty() {
                            let display = match current.as_str() {
                                "plan" => "🛡 计划模式 (plan) — AI 执行操作前需要审批",
                                "auto" => "⚡ 自动模式 (auto) — 安全操作自动执行，敏感操作需审批",
                                "fullAgency" => "🚀 全自主模式 (fullAgency) — 所有操作自动执行",
                                _ => "❓ 未知模式",
                            };
                            if let Err(e) = adapter_for_reply.send_message(
                                &chat_id,
                                &format!(
                                    "🔐 当前权限模式\n\n{}\n\n\
                                     可选模式：\n\
                                     • plan — 计划模式（最安全）\n\
                                     • auto — 自动模式（推荐）\n\
                                     • full — 全自主模式\n\n\
                                     用法: /mode <模式>",
                                    display,
                                ),
                            ).await {
                                ulog_warn!("[im-cmd] send_message (/mode display) failed: {}", e);
                            }
                        } else {
                            let new_mode = match arg.as_str() {
                                "plan" => "plan",
                                "auto" => "auto",
                                "full" | "fullagency" => "fullAgency",
                                _ => {
                                    if let Err(e) = adapter_for_reply.send_message(
                                        &chat_id,
                                        "❌ 无效模式，可选: plan / auto / full",
                                    ).await {
                                        ulog_warn!("[im-cmd] send_message (/mode invalid) failed: {}", e);
                                    }
                                    continue;
                                }
                            };
                            *permission_mode_for_loop.write().await = new_mode.to_string();

                            let display = match new_mode {
                                "plan" => "🛡 计划模式 — AI 执行操作前需要审批",
                                "auto" => "⚡ 自动模式 — 安全操作自动执行",
                                "fullAgency" => "🚀 全自主模式 — 所有操作自动执行",
                                _ => unreachable!(),
                            };
                            ulog_info!("[im] /mode: switched to {} (session={})", new_mode, session_key);
                            if let Err(e) = adapter_for_reply.send_message(
                                &chat_id,
                                &format!("✅ 权限模式已切换\n\n{}", display),
                            ).await {
                                ulog_warn!("[im-cmd] send_message (/mode switch) failed: {}", e);
                            }

                            // Persist to config.json + notify frontend
                            let bid = bot_id_for_loop.clone();
                            let mode_str = new_mode.to_string();
                            tokio::task::spawn_blocking(move || {
                                let patch = BotConfigPatch {
                                    permission_mode: Some(mode_str),
                                    ..Default::default()
                                };
                                if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                    ulog_warn!("[im] /mode persist failed: {}", e);
                                }
                            });
                            let _ = app_clone.emit("im:bot-config-changed", json!({
                                "botId": bot_id_for_loop,
                            }));
                        }
                        continue;
                    }

                    // ── Text-based approval commands (fallback for platforms without card callbacks) ──
                    let approval_decision = match text.as_str() {
                        "允许" | "同意" | "approve" => Some("allow_once"),
                        "始终允许" | "始终同意" | "always approve" => Some("always_allow"),
                        "拒绝" | "deny" => Some("deny"),
                        _ => None,
                    };
                    if let Some(decision) = approval_decision {
                        // Find the most recent pending approval for this chat
                        let pending_rid = {
                            let guard = pending_approvals_for_loop.lock().await;
                            guard.iter()
                                .find(|(_, p)| p.chat_id == chat_id)
                                .map(|(rid, _)| rid.clone())
                        };
                        if let Some(request_id) = pending_rid {
                            ulog_info!("[im] Text approval command: decision={}, rid={}", decision, &request_id[..request_id.len().min(16)]);
                            let _ = approval_tx_for_loop.send(ApprovalCallback {
                                request_id,
                                decision: decision.to_string(),
                                user_id: msg.sender_id.clone(),
                            }).await;
                            continue;
                        }
                        // No pending approval — fall through to regular message handling
                    }

                    // ── Access control ──────────
                    // All platforms (including Bridge/OpenClaw) go through the Rust
                    // whitelist. Bridge plugins use dmPolicy=open at the plugin level;
                    // actual access control is enforced here via BIND_xxx + allowedUsers.
                    let is_bridge_platform = matches!(msg.platform, ImPlatform::OpenClaw(_));

                    // Private message whitelist check for Bridge platforms
                    // (Bridge plugins use dmPolicy=open, access control is at Rust layer)
                    if msg.source_type == ImSourceType::Private && is_bridge_platform {
                        let is_allowed = {
                            let users = allowed_users_for_loop.read().await;
                            users.is_empty() || users.contains(&msg.sender_id)
                        };
                        if !is_allowed {
                            ulog_info!("[im] Bridge private message from {} blocked (not in allowedUsers)", msg.sender_id);
                            continue;
                        }
                    }

                    if msg.source_type == ImSourceType::Group {
                        // Bridge group auto-discovery: when a Bridge plugin delivers a group
                        // message for an unknown group, auto-create a Pending permission entry.
                        // Native adapters discover groups via platform events (my_chat_member etc.),
                        // but Bridge/OpenClaw plugins have no equivalent lifecycle event.
                        if is_bridge_platform {
                            // Match by group_id OR group_name (handles chatId format migration:
                            // old records have group_id=ou_xxx, new format uses oc_xxx)
                            let known = group_permissions_for_loop.read().await
                                .iter().any(|g| g.group_id == msg.chat_id || g.group_name == msg.chat_id);
                            if !known {
                                ulog_info!("[im] Bridge group auto-discovery: {} ({})", msg.chat_id, msg.hint_group_name.as_deref().unwrap_or("?"));
                                // try_send (not send().await) — sender and receiver share the same
                                // select! loop; .await could deadlock if the channel is full.
                                let _ = group_event_tx_for_loop.try_send(GroupEvent::BotAdded {
                                    chat_id: msg.chat_id.clone(),
                                    chat_title: msg.hint_group_name.clone()
                                        .unwrap_or_else(|| msg.chat_id.clone()),
                                    platform: msg.platform.clone(),
                                    added_by_name: msg.sender_name.clone(),
                                });
                            }
                        }

                        // Check if sender is a whitelisted user OR group is approved
                        let is_allowed_user = {
                            let users = allowed_users_for_loop.read().await;
                            users.contains(&msg.sender_id)
                        };
                        let group_approved = {
                            let perms = group_permissions_for_loop.read().await;
                            perms.iter().any(|g| g.group_id == msg.chat_id && g.status == GroupPermissionStatus::Approved)
                        };

                        if !is_allowed_user && !group_approved {
                            // Buffer history even for unapproved groups so AI has context
                            // when the group is eventually approved or an allowedUser @triggers.
                            group_history_for_loop.lock().await.push(
                                &session_key,
                                GroupHistoryEntry {
                                    sender_name: msg.sender_name.clone().unwrap_or_else(|| msg.sender_id.clone()),
                                    text: msg.text.clone(),
                                    timestamp: chrono::Local::now(),
                                },
                            );
                            continue;
                        }

                        // Trigger check: in Mention mode, non-triggered messages go to history buffer
                        // Exception: plugin slash commands bypass mention gate (like built-in /help /model)
                        let is_plugin_command = is_bridge_platform && matches!(
                            adapter_for_reply.as_ref(),
                            AnyAdapter::Bridge(bridge) if bridge.match_command(&text).is_some()
                        );
                        let activation = group_activation_for_loop.read().await.clone();
                        if activation == GroupActivation::Mention && !msg.is_mention && !is_plugin_command {
                            group_history_for_loop.lock().await.push(
                                &session_key,
                                GroupHistoryEntry {
                                    sender_name: msg.sender_name.clone().unwrap_or_else(|| msg.sender_id.clone()),
                                    text: msg.text.clone(),
                                    timestamp: chrono::Local::now(),
                                },
                            );
                            continue;
                        }
                    }

                    // ── Regular message → spawn concurrent task ──────────
                    ulog_info!(
                        "[im] Routing message from {} to Sidecar (session_key={}, {} chars)",
                        msg.sender_name.as_deref().unwrap_or("?"),
                        session_key,
                        text.len(),
                    );

                    // Bridge plugin commands: check if text matches a registered command
                    // Must be checked AFTER standard commands (/help, /model, etc.)
                    if is_bridge_platform {
                        if let AnyAdapter::Bridge(ref bridge) = *adapter_for_reply {
                            if let Some((cmd_name, cmd_args)) = bridge.match_command(&text) {
                                ulog_info!("[im] Plugin command /{} from {} (args: {:?})", cmd_name, msg.sender_id, cmd_args);
                                let bridge_clone = adapter_for_reply.clone();
                                let chat_id_clone = chat_id.clone();
                                let sender_id = msg.sender_id.clone();
                                tokio::spawn(async move {
                                    if let AnyAdapter::Bridge(ref b) = *bridge_clone {
                                        match b.execute_command(&cmd_name, &cmd_args, &sender_id, &chat_id_clone).await {
                                            Ok(result) => {
                                                let _ = bridge_clone.send_message(&chat_id_clone, &result).await;
                                            }
                                            Err(e) => {
                                                let _ = bridge_clone.send_message(&chat_id_clone, &format!("❌ 命令执行失败: {}", e)).await;
                                            }
                                        }
                                    }
                                });
                                continue;
                            }
                        }
                    }

                    // Clone shared state for the spawned task
                    let task_router = Arc::clone(&router_clone);
                    let task_adapter = Arc::clone(&adapter_for_reply);
                    let task_app = app_clone.clone();
                    let task_manager = Arc::clone(&manager_clone);
                    let task_buffer = Arc::clone(&buffer_clone);
                    let task_health = Arc::clone(&health_clone);
                    let task_perm = permission_mode_for_loop.read().await.clone();
                    let task_provider_env = Arc::clone(&current_provider_env_for_loop);
                    let task_model = Arc::clone(&current_model_for_loop);
                    let task_mcp_json = mcp_servers_json_for_loop.read().await.clone();
                    let task_stream_client = stream_client.clone();
                    let task_sem = Arc::clone(&global_semaphore);
                    let task_locks = Arc::clone(&peer_locks_for_loop);
                    let task_pending_approvals = Arc::clone(&pending_approvals_for_loop);
                    let task_bot_id = bot_id_for_loop.clone();
                    let task_bot_name = bot_name_for_loop.clone();
                    let task_group_history = Arc::clone(&group_history_for_loop);
                    let task_group_activation = Arc::clone(&group_activation_for_loop);
                    let task_group_tools_deny = Arc::clone(&group_tools_deny_for_loop);
                    let task_group_permissions = Arc::clone(&group_permissions_for_loop);
                    let task_agent_link = Arc::clone(&agent_link_for_loop);
                    let task_allowed_users = Arc::clone(&allowed_users_for_loop);

                    in_flight.spawn(async move {
                        // 1. Acquire per-peer lock FIRST (serialize requests to same Sidecar).
                        let peer_lock = {
                            let mut locks = task_locks.lock().await;
                            locks
                                .entry(session_key.clone())
                                .or_insert_with(|| Arc::new(Mutex::new(())))
                                .clone()
                        };
                        let _peer_guard = peer_lock.lock().await;

                        // 2. Acquire global semaphore (rate limit across all peers)
                        let _permit = match task_sem.clone().acquire_owned().await {
                            Ok(p) => p,
                            Err(_) => {
                                ulog_error!("[im] Semaphore closed");
                                return;
                            }
                        };

                        // 3. ACK + typing indicator
                        task_adapter.ack_processing(&chat_id, &message_id).await;
                        task_adapter.send_typing(&chat_id).await;

                        // 4. Ensure Sidecar is running (brief router lock)
                        let (port, is_new_sidecar) = match task_router
                            .lock()
                            .await
                            .ensure_sidecar(&session_key, &task_app, &task_manager)
                            .await
                        {
                            Ok(result) => result,
                            Err(e) => {
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                let _ = task_adapter
                                    .send_message(&chat_id, &format!("⚠️ {}", e))
                                    .await;
                                return;
                            }
                        };

                        // 4b. Sync AI config to newly created Sidecar
                        if is_new_sidecar {
                            let model = task_model.read().await.clone();
                            let penv = task_provider_env.read().await.clone();
                            task_router
                                .lock()
                                .await
                                .sync_ai_config(
                                    port,
                                    model.as_deref(),
                                    task_mcp_json.as_deref(),
                                    penv.as_ref(),
                                )
                                .await;
                        }

                        // 4c. Process attachments (File → save to workspace, Image → base64)
                        let mut msg = msg; // make mutable for attachment processing
                        let workspace_path = {
                            let router = task_router.lock().await;
                            router
                                .peer_session_workspace(&session_key)
                                .unwrap_or_else(|| router.default_workspace().clone())
                        };
                        let image_payloads = if !msg.attachments.is_empty() {
                            process_attachments(&mut msg, &workspace_path).await
                        } else {
                            Vec::new()
                        };

                        // 4d. Group context injection (v0.1.28)
                        let group_ctx = if msg.source_type == ImSourceType::Group {
                            // Drain pending history
                            let history = task_group_history.lock().await.drain(&session_key);
                            let pending_history = GroupHistoryBuffer::format_as_context(&history);
                            // Check if this is the first turn for this group session
                            let (is_first_turn, message_count) = {
                                let router = task_router.lock().await;
                                let ps = router.get_peer_session(&session_key);
                                (ps.map_or(true, |p| p.message_count == 0),
                                 ps.map_or(0, |p| p.message_count))
                            };
                            let activation = task_group_activation.read().await.clone();
                            let tools_deny = task_group_tools_deny.read().await.clone();
                            // Get group name: 1) group_permissions config, 2) Bridge hint, 3) chat_id fallback
                            let group_name = {
                                let perms = task_group_permissions.read().await;
                                perms.iter()
                                    .find(|g| g.group_id == msg.chat_id)
                                    .map(|g| g.group_name.clone())
                                    .or_else(|| msg.hint_group_name.clone())
                                    .unwrap_or_else(|| msg.chat_id.clone())
                            };
                            Some(GroupStreamContext {
                                group_name,
                                platform: msg.platform.clone(),
                                activation,
                                is_first_turn,
                                pending_history,
                                tools_deny,
                                is_mention: msg.is_mention,
                                message_count,
                            })
                        } else {
                            None
                        };

                        // 5. SSE stream: route message + stream response to Telegram
                        //    Spawn keepalive to prevent idle collection during long agentic tasks.
                        //    stream_to_im() can run 30+ min for multi-tool-use turns, during which
                        //    heartbeat can't touch last_active (blocked by peer lock).
                        let keepalive = tokio::spawn({
                            let router = Arc::clone(&task_router);
                            let key = session_key.clone();
                            async move {
                                let mut tick = tokio::time::interval(
                                    std::time::Duration::from_secs(300),
                                );
                                tick.tick().await; // skip immediate first tick
                                loop {
                                    tick.tick().await;
                                    router.lock().await.touch_session_activity(&key);
                                }
                            }
                        });

                        let penv = task_provider_env.read().await.clone();
                        let task_model_val = task_model.read().await.clone();
                        let images = if image_payloads.is_empty() {
                            None
                        } else {
                            Some(&image_payloads)
                        };
                        let allowed_snapshot = task_allowed_users.read().await.clone();
                        let session_id = match stream_to_im(
                            &task_stream_client,
                            port,
                            &msg,
                            task_adapter.as_ref(),
                            &chat_id,
                            &task_perm,
                            penv.as_ref(),
                            task_model_val.as_deref(),
                            images,
                            &task_pending_approvals,
                            Some(&task_bot_id),
                            task_bot_name.as_deref(),
                            group_ctx.as_ref(),
                            Some(&allowed_snapshot),
                        )
                        .await
                        {
                            Ok(sid) => {
                                ulog_info!(
                                    "[im] Stream complete for {} (session={})",
                                    session_key,
                                    sid.as_deref().unwrap_or("?"),
                                );
                                // Finalize AI Card for DingTalk (isFinalize: true)
                                if let AnyAdapter::Dingtalk(ref dt) = *task_adapter {
                                    dt.post_stream_cleanup(&chat_id).await;
                                }
                                sid
                            }
                            Err(e) => {
                                ulog_error!("[im] Stream error for {}: {}", session_key, e);
                                // Clean up any active AI Card on error (prevent zombie cards)
                                if let AnyAdapter::Dingtalk(ref dt) = *task_adapter {
                                    dt.post_stream_cleanup(&chat_id).await;
                                }
                                if e.should_buffer() {
                                    task_buffer.lock().await.push(&msg);
                                }
                                // Format user-friendly error: SSE errors from Bun are already
                                // localized via localizeImError, extract the inner message
                                // instead of wrapping with "处理消息时出错" again.
                                // RouteError::Response displays as "Sidecar returned {status}: {body}"
                                let e_str = format!("{}", e);
                                let user_msg = if e_str.starts_with("Sidecar returned ") {
                                    // Extract body after "Sidecar returned NNN: "
                                    let inner = e_str.splitn(2, ": ").nth(1).unwrap_or(&e_str);
                                    format!("⚠️ {}", inner)
                                } else {
                                    format!("⚠️ {}", e)
                                };
                                let _ = task_adapter
                                    .send_message(&chat_id, &user_msg)
                                    .await;
                                task_adapter.ack_clear(&chat_id, &message_id).await;
                                keepalive.abort();
                                return;
                            }
                        };

                        // 6. Clear ACK reaction
                        task_adapter.ack_clear(&chat_id, &message_id).await;

                        // 7. Update session state
                        {
                            let mut router = task_router.lock().await;
                            router.record_response(&session_key, session_id.as_deref());
                            // If Bun sidecar created a new session (e.g. provider switch),
                            // upgrade the Rust-side session_id + Sidecar Manager key
                            if let Some(new_sid) = session_id.as_deref() {
                                router.upgrade_peer_session_id(
                                    &session_key, new_sid, &task_manager,
                                );
                            }
                        }

                        // Update health
                        task_health
                            .set_last_message_at(chrono::Utc::now().to_rfc3339())
                            .await;
                        task_health
                            .set_active_sessions(
                                task_router.lock().await.active_sessions(),
                            )
                            .await;
                        // Emit appropriate event based on agent_link
                        {
                            let link_guard = task_agent_link.read().await;
                            if link_guard.is_some() {
                                let _ = task_app.emit("agent:status-changed", json!({ "event": "sessions_updated" }));
                            } else {
                                let _ = task_app.emit("im:status-changed", json!({ "event": "sessions_updated" }));
                            }
                        }

                        // 7b. Update agent lastActiveChannel (if this bot belongs to an agent)
                        {
                            let link_guard = task_agent_link.read().await;
                            if let Some(ref link) = *link_guard {
                                let now_str = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
                                let new_lac = LastActiveChannel {
                                    channel_id: link.channel_id.clone(),
                                    session_key: session_key.clone(),
                                    last_active_at: now_str,
                                };
                                *link.last_active_channel.write().await = Some(new_lac);
                                ulog_debug!(
                                    "[agent] Updated lastActiveChannel: agent={}, channel={}, session={}",
                                    link.agent_id, link.channel_id, session_key
                                );
                            }
                        }

                        // 8. Buffer replay (same session only — per-peer lock is held)
                        let mut replayed = 0u32;
                        loop {
                            let maybe = task_buffer.lock().await.pop_for_session(&session_key);
                            match maybe {
                                Some(buffered) => {
                                    let buf_chat_id = buffered.chat_id.clone();
                                    let buf_msg = buffered.to_im_message();
                                    let buf_allowed = task_allowed_users.read().await.clone();
                                    match stream_to_im(
                                        &task_stream_client,
                                        port,
                                        &buf_msg,
                                        task_adapter.as_ref(),
                                        &buf_chat_id,
                                        &task_perm,
                                        penv.as_ref(),
                                        task_model_val.as_deref(),
                                        None, // buffered messages don't preserve attachments
                                        &task_pending_approvals,
                                        Some(&task_bot_id),
                                        task_bot_name.as_deref(),
                                        None, // buffered messages don't carry group context
                                        Some(&buf_allowed),
                                    )
                                    .await
                                    {
                                        Ok(buf_sid) => {
                                            // Finalize AI Card for DingTalk
                                            if let AnyAdapter::Dingtalk(ref dt) = *task_adapter {
                                                dt.post_stream_cleanup(&buf_chat_id).await;
                                            }
                                            let mut router = task_router.lock().await;
                                            router.record_response(
                                                &session_key,
                                                buf_sid.as_deref(),
                                            );
                                            if let Some(sid) = buf_sid.as_deref() {
                                                router.upgrade_peer_session_id(
                                                    &session_key, sid, &task_manager,
                                                );
                                            }
                                            drop(router);
                                            replayed += 1;
                                        }
                                        Err(e) => {
                                            // Clean up any active AI Card on error
                                            if let AnyAdapter::Dingtalk(ref dt) = *task_adapter {
                                                dt.post_stream_cleanup(&buf_chat_id).await;
                                            }
                                            if e.should_buffer() {
                                                task_buffer.lock().await.push(&buf_msg);
                                            }
                                            break;
                                        }
                                    }
                                }
                                None => break,
                            }
                        }
                        if replayed > 0 {
                            ulog_info!("[im] Replayed {} buffered messages", replayed);
                        }

                        // Update buffer count in health
                        task_health
                            .set_buffered_messages(task_buffer.lock().await.len())
                            .await;

                        // Stream + buffer replay done — stop keepalive
                        keepalive.abort();

                        // Cleanup: release guards, then remove stale peer_lock entry
                        drop(_permit);
                        drop(_peer_guard);
                        drop(peer_lock);
                        {
                            let mut locks = task_locks.lock().await;
                            if let Some(lock_arc) = locks.get(&session_key) {
                                if Arc::strong_count(lock_arc) == 1 {
                                    locks.remove(&session_key);
                                }
                            }
                        }
                    });
                }
                // Handle group lifecycle events (bot added/removed from groups)
                Some(event) = group_event_rx.recv() => {
                    match event {
                        GroupEvent::BotAdded { chat_id, chat_title, platform, added_by_name } => {
                            ulog_info!("[im] Group event: BotAdded to {} ({})", chat_title, chat_id);
                            // Create pending GroupPermission
                            let perm = GroupPermission {
                                group_id: chat_id.clone(),
                                group_name: chat_title.clone(),
                                platform: platform.clone(),
                                status: GroupPermissionStatus::Pending,
                                discovered_at: chrono::Utc::now().to_rfc3339(),
                                added_by: added_by_name.clone(),
                            };
                            {
                                let mut perms = group_permissions_for_loop.write().await;
                                // Dedup: skip if group already known (Approved or Pending).
                                // Also match by group_name to handle the chatId format migration
                                // (pre-fix: group_id=ou_xxx from ctx.From, post-fix: group_id=oc_xxx from ctx.To).
                                if let Some(existing) = perms.iter_mut().find(|g| g.group_id == chat_id || g.group_name == chat_id) {
                                    // If found by group_name (old format), update group_id to the correct value
                                    if existing.group_id != chat_id {
                                        ulog_info!("[im] Group {} migrating group_id: {} -> {}", chat_title, existing.group_id, chat_id);
                                        existing.group_id = chat_id.clone();
                                    } else {
                                        ulog_info!("[im] Group {} already known, skipping BotAdded", chat_id);
                                    }
                                    continue;
                                }
                                perms.push(perm.clone());
                            }
                            // Persist to config.json
                            let bid = bot_id_for_loop.clone();
                            let new_perms = group_permissions_for_loop.read().await.clone();
                            tokio::task::spawn_blocking(move || {
                                let patch = BotConfigPatch {
                                    group_permissions: Some(new_perms),
                                    ..Default::default()
                                };
                                if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                    ulog_warn!("[im] Failed to persist group permission: {}", e);
                                }
                            });
                            // Send prompt message to group
                            let bot_name = health_clone.get_state().await.bot_username
                                .unwrap_or_else(|| "AI 助手".to_string());
                            let prompt_msg = format!(
                                "👋 你好！我是 {}。\n群聊授权申请已发送至管理员，授权后即可使用。\n已绑定的用户可直接 @我 提问。",
                                bot_name,
                            );
                            if let Err(e) = adapter_for_reply.send_message(&chat_id, &prompt_msg).await {
                                ulog_warn!("[im-cmd] send_message (group auth prompt) failed: {}", e);
                            }
                            // Emit Tauri events
                            let _ = app_clone.emit("im:group-permission-changed", json!({
                                "botId": bot_id_for_loop,
                                "event": "added",
                                "groupName": chat_title,
                            }));
                            let _ = app_clone.emit("im:bot-config-changed", json!({
                                "botId": bot_id_for_loop,
                            }));
                        }
                        GroupEvent::BotRemoved { chat_id, platform: _ } => {
                            ulog_info!("[im] Group event: BotRemoved from {}", chat_id);
                            // Remove group permission record
                            {
                                let mut perms = group_permissions_for_loop.write().await;
                                perms.retain(|g| g.group_id != chat_id);
                            }
                            // Clean up group history
                            {
                                let session_key = format!("im:{}:group:{}", platform_for_loop, chat_id);
                                group_history_for_loop.lock().await.clear(&session_key);
                            }
                            // Persist
                            let bid = bot_id_for_loop.clone();
                            let new_perms = group_permissions_for_loop.read().await.clone();
                            tokio::task::spawn_blocking(move || {
                                let patch = BotConfigPatch {
                                    group_permissions: Some(new_perms),
                                    ..Default::default()
                                };
                                if let Err(e) = persist_bot_config_patch(&bid, &patch) {
                                    ulog_warn!("[im] Failed to persist group removal: {}", e);
                                }
                            });
                            let _ = app_clone.emit("im:group-permission-changed", json!({
                                "botId": bot_id_for_loop,
                                "event": "removed",
                            }));
                            let _ = app_clone.emit("im:bot-config-changed", json!({
                                "botId": bot_id_for_loop,
                            }));
                        }
                    }
                }
                // Drain completed tasks (handle panics)
                Some(result) = in_flight.join_next(), if !in_flight.is_empty() => {
                    if let Err(e) = result {
                        ulog_error!("[im] Message task panicked: {}", e);
                    }
                }
                // Flush expired media groups
                _ = tokio::time::sleep(flush_timeout) => {
                    let expired_keys: Vec<String> = media_groups
                        .iter()
                        .filter(|(_, entry)| entry.first_received.elapsed() >= MEDIA_GROUP_TIMEOUT)
                        .map(|(k, _)| k.clone())
                        .collect();

                    for group_id in expired_keys {
                        if let Some(entry) = media_groups.remove(&group_id) {
                            let merged = merge_media_group(entry.messages);
                            ulog_info!(
                                "[im] Flushed media group {} ({} attachments)",
                                group_id,
                                merged.attachments.len(),
                            );
                            // Re-inject merged message into the channel
                            if msg_tx_for_reinjection.send(merged).await.is_err() {
                                ulog_error!("[im] Failed to re-inject merged media group");
                            }
                        }
                    }
                }
                _ = process_shutdown_rx.changed() => {
                    if *process_shutdown_rx.borrow() {
                        ulog_info!(
                            "[im] Processing loop shutting down, waiting for {} in-flight task(s)",
                            in_flight.len(),
                        );
                        // Drain remaining in-flight tasks before exiting
                        while let Some(result) = in_flight.join_next().await {
                            if let Err(e) = result {
                                ulog_error!("[im] Task panicked during shutdown: {}", e);
                            }
                        }
                        break;
                    }
                }
            }
        }
    });

    // Start idle session collector
    let router_for_idle = Arc::clone(&router);
    let manager_for_idle = Arc::clone(sidecar_manager);
    let app_for_idle = app_handle.clone();
    let mut idle_shutdown_rx = shutdown_rx.clone();
    let agent_id_for_idle = agent_id.clone();

    let _idle_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    let collected = router_for_idle.lock().await.collect_idle_sessions(&manager_for_idle);
                    if collected > 0 {
                        // Notify UI — agent channels emit agent event, legacy emit im event
                        if agent_id_for_idle.is_some() {
                            let _ = app_for_idle.emit("agent:status-changed", json!({ "event": "sessions_collected" }));
                        } else {
                            let _ = app_for_idle.emit("im:status-changed", json!({ "event": "sessions_collected" }));
                        }
                    }
                }
                _ = idle_shutdown_rx.changed() => {
                    if *idle_shutdown_rx.borrow() {
                        break;
                    }
                }
            }
        }
    });

    let started_at = Instant::now();

    // Build status (include bind URL for QR code flow / bind code for text bind)
    let bot_username_for_url = health.get_state().await.bot_username.clone();
    let (bind_url, bind_code_for_status) = match config.platform {
        ImPlatform::Telegram => {
            let url = bot_username_for_url
                .as_ref()
                .map(|u| format!("https://t.me/{}?start={}", u, bind_code));
            (url, None)
        }
        ImPlatform::Feishu => (None, Some(bind_code.clone())),
        ImPlatform::Dingtalk => (None, Some(bind_code.clone())),
        ImPlatform::OpenClaw(_) => (None, Some(bind_code.clone())),
    };

    let status = ImBotStatus {
        bot_username: bot_username_for_url.clone(),
        status: ImStatus::Online,
        uptime_seconds: 0,
        last_message_at: None,
        active_sessions: Vec::new(),
        error_message: None,
        restart_count: 0,
        buffered_messages: buffer.lock().await.len(),
        bind_url,
        bind_code: bind_code_for_status,
    };

    // ===== Heartbeat Runner (v0.1.21) =====
    let (heartbeat_handle, heartbeat_wake_tx, heartbeat_config_arc) = {
        let hb_config = config.heartbeat_config.clone().unwrap_or_default();
        let hb_bot_label = bot_username_for_url.clone().unwrap_or_else(|| bot_id.to_string());
        let (runner, config_arc, _mau_config_arc, _mau_running_arc) = heartbeat::HeartbeatRunner::new(
            hb_config,
            hb_bot_label,
            Arc::clone(&current_model),
            Arc::clone(&current_provider_env),
            Arc::clone(&mcp_servers_json),
            None, // Memory auto-update: not used for per-channel heartbeat (Agent-level only)
        );
        let (wake_tx, wake_rx) = mpsc::channel::<types::WakeReason>(64);

        let hb_shutdown_rx = shutdown_rx.clone();
        let hb_router = Arc::clone(&router);
        let hb_sidecar = Arc::clone(sidecar_manager);
        let hb_adapter = Arc::clone(&adapter);
        let hb_app = app_handle.clone();
        let hb_peer_locks = Arc::clone(&peer_locks);
        let hb_agent_id = agent_id.clone().unwrap_or_else(|| bot_id.to_string());
        let hb_workspace = default_workspace_str.clone();
        let handle = tokio::spawn(async move {
            runner.run_loop(
                hb_shutdown_rx,
                wake_rx,
                hb_router,
                hb_sidecar,
                hb_adapter,
                hb_app,
                hb_peer_locks,
                hb_agent_id,
                hb_workspace,
            ).await;
        });

        ulog_info!("[im] Heartbeat runner spawned for bot {}", bot_id);
        (Some(handle), Some(wake_tx), Some(config_arc))
    };

    // Build instance (caller is responsible for inserting into the appropriate container)
    let instance_platform = config.platform.clone();
    let instance = ImBotInstance {
        bot_id,
        platform: instance_platform,
        shutdown_tx,
        health: Arc::clone(&health),
        router,
        buffer,
        started_at,
        process_handle,
        poll_handle,
        approval_handle,
        health_handle,
        bind_code,
        config,
        heartbeat_handle,
        heartbeat_wake_tx,
        heartbeat_config: heartbeat_config_arc,
        adapter: Arc::clone(&adapter),
        // Hot-reloadable config (Arc clones shared with processing loop)
        current_model,
        current_provider_env,
        permission_mode,
        mcp_servers_json,
        allowed_users,
        // Group Chat (v0.1.28)
        group_permissions,
        group_activation,
        group_tools_deny,
        group_history,
        // OpenClaw Bridge process
        bridge_process: bridge_process_handle.map(tokio::sync::Mutex::new),
        // Agent link (set after moving into AgentInstance)
        agent_link,
    };

    Ok((instance, status))
}

/// Start the IM Bot (thin wrapper over create_bot_instance for legacy callers).
pub async fn start_im_bot<R: Runtime>(
    app_handle: &AppHandle<R>,
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: String,
    config: ImConfig,
) -> Result<ImBotStatus, String> {
    // Gracefully stop existing instance for this bot_id if running
    let existing = {
        let mut im_guard = im_state.lock().await;
        im_guard.remove(&bot_id)
    };
    if let Some(instance) = existing {
        ulog_info!("[im] Stopping existing IM Bot {} before restart", bot_id);
        let _ = shutdown_bot_instance(instance, sidecar_manager, &bot_id).await;
    }

    let (instance, status) = create_bot_instance(app_handle, sidecar_manager, bot_id.clone(), config, None).await?;

    let mut im_guard = im_state.lock().await;
    im_guard.insert(bot_id, instance);

    Ok(status)
}

/// Stop the IM Bot (thin wrapper over shutdown_bot_instance).
pub async fn stop_im_bot(
    im_state: &ManagedImBots,
    sidecar_manager: &ManagedSidecarManager,
    bot_id: &str,
) -> Result<(), String> {
    let instance = {
        let mut im_guard = im_state.lock().await;
        im_guard.remove(bot_id)
    };

    if let Some(instance) = instance {
        shutdown_bot_instance(instance, sidecar_manager, bot_id).await
    } else {
        ulog_debug!("[im] IM Bot {} was not running", bot_id);
        Ok(())
    }
}

/// Get current IM Bot status for a specific bot
pub async fn get_im_bot_status(im_state: &ManagedImBots, bot_id: &str) -> ImBotStatus {
    let im_guard = im_state.lock().await;

    if let Some(instance) = im_guard.get(bot_id) {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status.bot_username.as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
            ImPlatform::Dingtalk => (None, Some(instance.bind_code.clone())),
            ImPlatform::OpenClaw(_) => (None, Some(instance.bind_code.clone())),
        };

        ImBotStatus {
            bot_username: status.bot_username,
            status: status.status,
            uptime_seconds: status.uptime_seconds,
            last_message_at: status.last_message_at,
            active_sessions: status.active_sessions,
            error_message: status.error_message,
            restart_count: status.restart_count,
            buffered_messages: status.buffered_messages,
            bind_url,
            bind_code: bind_code_opt,
        }
    } else {
        ImBotStatus::default()
    }
}

/// Get status of all running bots
pub async fn get_all_bots_status(im_state: &ManagedImBots) -> HashMap<String, ImBotStatus> {
    let im_guard = im_state.lock().await;
    let mut result = HashMap::new();

    for (bot_id, instance) in im_guard.iter() {
        let mut status = instance.health.get_state().await;
        status.uptime_seconds = instance.started_at.elapsed().as_secs();
        status.buffered_messages = instance.buffer.lock().await.len();
        status.active_sessions = instance.router.lock().await.active_sessions();

        let (bind_url, bind_code_opt) = match instance.platform {
            ImPlatform::Telegram => {
                let url = status.bot_username.as_ref()
                    .map(|u| format!("https://t.me/{}?start={}", u, instance.bind_code));
                (url, None)
            }
            ImPlatform::Feishu => (None, Some(instance.bind_code.clone())),
            ImPlatform::Dingtalk => (None, Some(instance.bind_code.clone())),
            ImPlatform::OpenClaw(_) => (None, Some(instance.bind_code.clone())),
        };

        result.insert(bot_id.clone(), ImBotStatus {
            bot_username: status.bot_username,
            status: status.status,
            uptime_seconds: status.uptime_seconds,
            last_message_at: status.last_message_at,
            active_sessions: status.active_sessions,
            error_message: status.error_message,
            restart_count: status.restart_count,
            buffered_messages: status.buffered_messages,
            bind_url,
            bind_code: bind_code_opt,
        });
    }

    result
}

// ===== SSE Stream → IM Draft ====

/// Consume Sidecar SSE stream, managing draft message lifecycle for any IM platform.
/// Group context passed to `stream_to_im` for group chat sessions (v0.1.28).
struct GroupStreamContext {
    group_name: String,
    platform: ImPlatform,
    activation: GroupActivation,
    is_first_turn: bool,
    pending_history: Option<String>,
    tools_deny: Vec<String>,
    is_mention: bool,
    message_count: u32,
}

/// Placeholder message sent when the AI's first response block is non-text (thinking/tool_use).
/// Gives users immediate feedback that the AI is processing their message.
const THINKING_PLACEHOLDER: &str = "思考中…";

/// Each text block → independent IM message (streamed draft edits).
/// Returns sessionId on success.
async fn stream_to_im<A: adapter::ImStreamAdapter>(
    client: &Client,
    port: u16,
    msg: &ImMessage,
    adapter: &A,
    chat_id: &str,
    permission_mode: &str,
    provider_env: Option<&serde_json::Value>,
    model: Option<&str>,
    images: Option<&Vec<serde_json::Value>>,
    pending_approvals: &PendingApprovals,
    bot_id: Option<&str>,
    bot_name: Option<&str>,
    group_context: Option<&GroupStreamContext>,
    allowed_users: Option<&[String]>,
) -> Result<Option<String>, RouteError> {
    // Build request body (same as original route_to_sidecar)
    let source_owned;
    let source: &str = match (&msg.platform, &msg.source_type) {
        (ImPlatform::Telegram, ImSourceType::Private) => "telegram_private",
        (ImPlatform::Telegram, ImSourceType::Group) => "telegram_group",
        (ImPlatform::Feishu, ImSourceType::Private) => "feishu_private",
        (ImPlatform::Feishu, ImSourceType::Group) => "feishu_group",
        (ImPlatform::Dingtalk, ImSourceType::Private) => "dingtalk_private",
        (ImPlatform::Dingtalk, ImSourceType::Group) => "dingtalk_group",
        (ImPlatform::OpenClaw(ref id), ImSourceType::Private) => {
            source_owned = format!("{}_private", id);
            &source_owned
        }
        (ImPlatform::OpenClaw(ref id), ImSourceType::Group) => {
            source_owned = format!("{}_group", id);
            &source_owned
        }
    };
    let mut body = json!({
        "message": msg.text,
        "source": source,
        "sourceId": msg.chat_id,
        "senderName": msg.sender_name,
        "permissionMode": permission_mode,
    });
    if let Some(env) = provider_env {
        body["providerEnv"] = env.clone();
    }
    if let Some(m) = model {
        body["model"] = json!(m);
    }
    if let Some(imgs) = images {
        if !imgs.is_empty() {
            body["images"] = json!(imgs);
        }
    }
    if let Some(bid) = bot_id {
        body["botId"] = json!(bid);
    }
    if let Some(bn) = bot_name {
        body["botName"] = json!(bn);
    }
    // Group context fields (v0.1.28)
    if let Some(gc) = group_context {
        body["sourceType"] = json!("group");
        body["groupName"] = json!(gc.group_name);
        body["groupPlatform"] = json!(match &gc.platform {
            ImPlatform::Telegram => "Telegram".to_string(),
            ImPlatform::Feishu => "飞书".to_string(),
            ImPlatform::Dingtalk => "钉钉".to_string(),
            ImPlatform::OpenClaw(id) => id.clone(),
        });
        body["groupActivation"] = json!(match gc.activation {
            GroupActivation::Mention => "mention",
            GroupActivation::Always => "always",
        });
        body["isFirstGroupTurn"] = json!(gc.is_first_turn);
        body["isMention"] = json!(gc.is_mention);
        body["messageCount"] = json!(gc.message_count);
        if let Some(ref history) = gc.pending_history {
            body["pendingHistory"] = json!(history);
        }
        if !gc.tools_deny.is_empty() {
            body["groupToolsDeny"] = json!(gc.tools_deny);
        }
    }
    // Quoted reply body (from Bridge plugins, e.g. threaded reply in Feishu)
    if let Some(ref rtb) = msg.reply_to_body {
        if !rtb.is_empty() {
            body["replyToBody"] = json!(rtb);
        }
    }
    // Group system prompt from Bridge plugin config
    if let Some(ref gsp) = msg.group_system_prompt {
        if !gsp.is_empty() {
            body["groupSystemPrompt"] = json!(gsp);
        }
    }
    // Bridge plugin context — pass bridge port + tool groups to sidecar
    if let Some((bridge_port, bridge_plugin_id, tool_groups)) = adapter.bridge_context() {
        body["bridgePort"] = json!(bridge_port);
        body["bridgePluginId"] = json!(bridge_plugin_id);
        body["bridgeEnabledToolGroups"] = json!(tool_groups);
        body["senderId"] = json!(msg.sender_id);
        // ownerOnly check: sender is owner only if explicitly in allowed_users.
        // Fail-closed: no whitelist or empty whitelist = no owner (ownerOnly tools blocked).
        let is_owner = match allowed_users {
            Some(users) if !users.is_empty() => users.contains(&msg.sender_id),
            _ => false,
        };
        body["senderIsOwner"] = json!(is_owner);
        ulog_info!("[im-stream] Bridge context: port={}, plugin={}, groups={:?}", bridge_port, bridge_plugin_id, tool_groups);
    } else {
        ulog_info!("[im-stream] No bridge context (non-Bridge adapter)");
    }
    let url = format!("http://127.0.0.1:{}/api/im/chat", port);
    ulog_info!("[im-stream] POST {} (SSE)", url);

    let response = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| RouteError::Unavailable(e.to_string()))?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let error_text = response.text().await.unwrap_or_default();
        return Err(RouteError::Response(status, error_text));
    }

    // === Streaming protocol branch ===
    // If the adapter supports the streaming protocol (e.g. CardKit), use
    // the dedicated streaming flow instead of the edit-based draft flow.
    if adapter.supports_streaming() {
        return stream_to_im_streaming(adapter, chat_id, response, pending_approvals, port).await;
    }

    // === SSE stream consumption + multi-draft management ===
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();

    // Current text block state (reset on each block-end)
    let mut block_text = String::new();
    let mut draft_id: Option<String> = None;
    let mut last_edit = Instant::now();
    let mut any_text_sent = false;

    // Response-level placeholder state:
    // - placeholder_id: message ID of "思考中…" sent when first block is non-text
    //   (kept for cleanup on error/silent/no-response; NOT adopted as draft)
    // - first_content_sent: true once user has seen any content (placeholder or real text)
    let mut placeholder_id: Option<String> = None;
    let mut first_content_sent = false;

    let mut session_id: Option<String> = None;

    while let Some(chunk_result) = byte_stream.next().await {
        let chunk = chunk_result
            .map_err(|e| RouteError::Unavailable(format!("SSE stream error: {}", e)))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find("\n\n") {
            let event_str: String = buffer.drain(..pos).collect();
            buffer.drain(..2); // consume the "\n\n" delimiter

            // Skip heartbeat comments
            if event_str.starts_with(':') {
                continue;
            }

            let data = extract_sse_data(&event_str);
            if data.is_empty() {
                continue;
            }

            let json_val: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            match json_val["type"].as_str().unwrap_or("") {
                "partial" => {
                    if let Some(text) = json_val["text"].as_str() {
                        block_text = text.to_string();

                        // First meaningful text in this block → create a new draft message.
                        // Skip whitespace-only blocks (API spacer blocks before thinking).
                        // Accumulate until sentence boundary or min length for meaningful first send.
                        //
                        // When !supports_edit (e.g., WeChat), skip draft creation and edit calls
                        // entirely. Text accumulates in block_text and finalize_block sends it
                        // once at block-end — no fragment, no wasted 501 roundtrips.
                        if adapter.supports_edit() && draft_id.is_none() && !block_text.trim().is_empty() && has_sentence_boundary(&block_text) {
                            // Send real content as a new draft message.
                            // Placeholder (if any) stays as a separate "思考中…" message.
                            let display = format_draft_text(&block_text, adapter.max_message_length());
                            match adapter.send_message_returning_id(chat_id, &display).await {
                                Ok(Some(id)) => {
                                    draft_id = Some(id);
                                    last_edit = Instant::now();
                                }
                                _ => {} // draft creation failed; block-end will send_message directly
                            }
                            first_content_sent = true;
                        }

                        // Throttled edit — re-evaluate interval dynamically so fallback
                        // from 300ms→1000ms takes effect mid-stream.
                        // Reset last_edit BEFORE await so cycle = max(throttle, edit_latency)
                        // instead of throttle + edit_latency (important for Bridge path).
                        if let Some(ref did) = draft_id {
                            let throttle = Duration::from_millis(adapter.preferred_throttle_ms());
                            if last_edit.elapsed() >= throttle {
                                last_edit = Instant::now();
                                let display = format_draft_text(&block_text, adapter.max_message_length());
                                if let Err(e) = adapter.edit_message(chat_id, did, &display).await {
                                    ulog_warn!("[im] Draft edit failed: {}", e);
                                }
                            }
                        }
                    }
                }
                "activity" => {
                    // Non-text block started (thinking, tool_use).
                    // If user hasn't seen any content yet, send a "thinking" placeholder
                    // as a NEW message (not adopted as draft later). This ensures
                    // immediate feedback even on platforms without edit support.
                    if !first_content_sent {
                        match adapter.send_message_returning_id(chat_id, THINKING_PLACEHOLDER).await {
                            Ok(Some(id)) => {
                                placeholder_id = Some(id);
                            }
                            Ok(None) => {
                                // Adapter skipped send (e.g. DingTalk non-card) → force via send_message
                                if let Err(e) = adapter.send_message(chat_id, THINKING_PLACEHOLDER).await {
                                    ulog_warn!("[im-stream] send_message (thinking placeholder) failed: {}", e);
                                }
                            }
                            Err(e) => {
                                ulog_warn!("[im-stream] send_message_returning_id (thinking placeholder) failed: {}", e);
                            }
                        }
                        first_content_sent = true;
                    }
                }
                "block-end" => {
                    let final_text = json_val["text"]
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| block_text.clone());
                    // Skip whitespace-only blocks (API spacer blocks emitted before thinking)
                    if final_text.trim().is_empty() {
                        // Delete orphaned draft if one was created
                        if let Some(ref did) = draft_id {
                            if let Err(e) = adapter.delete_message(chat_id, did).await {
                                ulog_warn!("[im-stream] delete_message (empty block draft) failed: {}", e);
                            }
                        }
                    } else {
                        finalize_block(adapter, chat_id, draft_id.clone(), &final_text).await;
                        any_text_sent = true;
                    }
                    // Reset current block state
                    block_text.clear();
                    draft_id = None;
                }
                "complete" => {
                    session_id = json_val["sessionId"].as_str().map(String::from);
                    let silent = json_val["silent"].as_bool().unwrap_or(false);

                    if silent {
                        // Group "always" mode: AI decided not to reply (NO_REPLY)
                        // Clean up draft/placeholder without sending anything
                        if let Some(ref did) = draft_id {
                            if let Err(e) = adapter.delete_message(chat_id, did).await {
                                ulog_warn!("[im-stream] delete_message (silent draft) failed: {}", e);
                            }
                        }
                        if let Some(ref pid) = placeholder_id {
                            if let Err(e) = adapter.delete_message(chat_id, pid).await {
                                ulog_warn!("[im-stream] delete_message (silent placeholder) failed: {}", e);
                            }
                        }
                        return Ok(session_id);
                    }

                    // Flush any remaining block text (skip whitespace-only)
                    if !block_text.trim().is_empty() {
                        finalize_block(adapter, chat_id, draft_id.clone(), &block_text).await;
                        any_text_sent = true;
                    } else if let Some(ref did) = draft_id {
                        if let Err(e) = adapter.delete_message(chat_id, did).await {
                            ulog_warn!("[im-stream] delete_message (complete empty draft) failed: {}", e);
                        }
                    }
                    if !any_text_sent {
                        // Edit placeholder in-place (avoids Feishu "recall" notification).
                        // Fall back to delete+send on platforms where edit is unsupported
                        // (e.g., DingTalk without AI Card).
                        if let Some(ref pid) = placeholder_id {
                            if adapter.edit_message(chat_id, pid, "(No response)").await.is_err() {
                                if let Err(e) = adapter.delete_message(chat_id, pid).await {
                                    ulog_warn!("[im-stream] delete_message (no-response placeholder) failed: {}", e);
                                }
                                if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                                    ulog_warn!("[im-stream] send_message (no response fallback) failed: {}", e);
                                }
                            }
                        } else {
                            if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                                ulog_warn!("[im-stream] send_message (no response) failed: {}", e);
                            }
                        }
                    }
                    return Ok(session_id);
                }
                "permission-request" => {
                    let request_id = json_val["requestId"].as_str().unwrap_or("").to_string();
                    let tool_name = json_val["toolName"].as_str().unwrap_or("unknown").to_string();
                    let tool_input = json_val["input"].as_str().unwrap_or("").to_string();

                    ulog_info!(
                        "[im-stream] Permission request: tool={}, rid={}",
                        tool_name,
                        &request_id[..request_id.len().min(16)]
                    );

                    // Send interactive approval card/keyboard
                    let card_msg_id = match adapter.send_approval_card(chat_id, &request_id, &tool_name, &tool_input).await {
                        Ok(Some(mid)) => mid,
                        Ok(None) => {
                            ulog_warn!("[im-stream] Approval card sent but no message ID returned");
                            String::new()
                        }
                        Err(e) => {
                            ulog_error!("[im-stream] Failed to send approval card: {}", e);
                            String::new()
                        }
                    };
                    // Always insert pending approval so text fallback ("允许"/"拒绝") works
                    {
                        let mut guard = pending_approvals.lock().await;
                        // Cleanup expired entries (Sidecar auto-denies after 10 min)
                        let now = Instant::now();
                        guard.retain(|_, p| now.duration_since(p.created_at) < Duration::from_secs(15 * 60));
                        guard.insert(request_id, PendingApproval {
                            sidecar_port: port,
                            chat_id: chat_id.to_string(),
                            card_message_id: card_msg_id,
                            created_at: now,
                        });
                    }
                    // SSE stream naturally pauses here — canUseTool Promise is blocking
                }
                "error" => {
                    let error = json_val["error"]
                        .as_str()
                        .unwrap_or("Unknown error");
                    // Delete current draft and placeholder if they exist
                    if let Some(ref did) = draft_id {
                        if let Err(e) = adapter.delete_message(chat_id, did).await {
                            ulog_warn!("[im-stream] delete_message (error draft) failed: {}", e);
                        }
                    }
                    if let Some(ref pid) = placeholder_id {
                        if let Err(e) = adapter.delete_message(chat_id, pid).await {
                            ulog_warn!("[im-stream] delete_message (error placeholder) failed: {}", e);
                        }
                    }
                    // Don't send_message here — outer handler will do it
                    return Err(RouteError::Response(500, error.to_string()));
                }
                _ => {} // Ignore unknown types
            }
        }
    }

    // Stream disconnected unexpectedly → flush any remaining text (skip whitespace-only)
    if !block_text.trim().is_empty() {
        finalize_block(adapter, chat_id, draft_id.clone(), &block_text).await;
        any_text_sent = true;
    } else if let Some(ref did) = draft_id {
        if let Err(e) = adapter.delete_message(chat_id, did).await {
            ulog_warn!("[im-stream] delete_message (disconnect draft) failed: {}", e);
        }
    }
    if !any_text_sent {
        // Edit placeholder in-place (avoids Feishu "recall" notification).
        // Fall back to delete+send on platforms where edit is unsupported.
        if let Some(ref pid) = placeholder_id {
            if adapter.edit_message(chat_id, pid, "(No response)").await.is_err() {
                if let Err(e) = adapter.delete_message(chat_id, pid).await {
                    ulog_warn!("[im-stream] delete_message (disconnect no-response placeholder) failed: {}", e);
                }
                if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                    ulog_warn!("[im-stream] send_message (disconnect no response fallback) failed: {}", e);
                }
            }
        } else {
            if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                ulog_warn!("[im-stream] send_message (disconnect no response) failed: {}", e);
            }
        }
    }
    Ok(session_id)
}

/// Streaming-protocol variant of `stream_to_im`.
///
/// Uses `adapter.start_stream()` / `stream_chunk()` / `finalize_stream()` /
/// `abort_stream()` instead of the edit-based draft message flow.
/// Called only when `adapter.supports_streaming()` returns true.
async fn stream_to_im_streaming<A: adapter::ImStreamAdapter>(
    adapter: &A,
    chat_id: &str,
    response: reqwest::Response,
    pending_approvals: &PendingApprovals,
    sidecar_port: u16,
) -> Result<Option<String>, RouteError> {
    let mut byte_stream = response.bytes_stream();
    let mut buffer = String::new();

    // Current stream state
    let mut stream_id: Option<String> = None;
    let mut block_text = String::new();
    let mut sequence: u32 = 0;
    let mut any_text_sent = false;
    let mut first_content_sent = false;
    // Placeholder message ID for cleanup on silent/error/no-response (mirrors stream_to_im)
    let mut placeholder_id: Option<String> = None;
    let mut session_id: Option<String> = None;

    while let Some(chunk_result) = byte_stream.next().await {
        let chunk = chunk_result
            .map_err(|e| RouteError::Unavailable(format!("SSE stream error: {}", e)))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find("\n\n") {
            let event_str: String = buffer.drain(..pos).collect();
            buffer.drain(..2); // consume "\n\n"

            if event_str.starts_with(':') {
                continue;
            }

            let data = extract_sse_data(&event_str);
            if data.is_empty() {
                continue;
            }

            let json_val: serde_json::Value = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };

            match json_val["type"].as_str().unwrap_or("") {
                "partial" => {
                    if let Some(text) = json_val["text"].as_str() {
                        block_text = text.to_string();

                        if stream_id.is_none() && !block_text.trim().is_empty() && has_sentence_boundary(&block_text) {
                            // First meaningful text → start the stream
                            match adapter.start_stream(chat_id, &block_text).await {
                                Ok(sid) if !sid.is_empty() => {
                                    stream_id = Some(sid);
                                    sequence = 1;
                                    any_text_sent = true;
                                    first_content_sent = true;
                                }
                                Ok(_) => {
                                    ulog_warn!("[im-stream] start_stream returned empty stream_id");
                                }
                                Err(e) => {
                                    ulog_warn!("[im-stream] start_stream failed: {}", e);
                                }
                            }
                        } else if let Some(ref sid) = stream_id {
                            // Subsequent chunk → push to stream
                            sequence += 1;
                            if let Err(e) = adapter.stream_chunk(chat_id, sid, &block_text, sequence, false).await {
                                ulog_warn!("[im-stream] stream_chunk failed: {}", e);
                            }
                        }
                    }
                }
                "activity" => {
                    // Non-text block (thinking, tool_use).
                    if let Some(ref sid) = stream_id {
                        // Stream already active → send thinking indicator within stream
                        sequence += 1;
                        if let Err(e) = adapter.stream_chunk(chat_id, sid, "", sequence, true).await {
                            ulog_warn!("[im-stream] stream_chunk (activity indicator) failed: {}", e);
                        }
                    } else if !first_content_sent {
                        // No stream yet and user hasn't seen any content →
                        // send placeholder as a standalone message for immediate feedback.
                        // Track ID for cleanup on silent/error/no-response.
                        match adapter.send_message_returning_id(chat_id, THINKING_PLACEHOLDER).await {
                            Ok(Some(id)) => {
                                placeholder_id = Some(id);
                            }
                            Ok(None) => {
                                if let Err(e) = adapter.send_message(chat_id, THINKING_PLACEHOLDER).await {
                                    ulog_warn!("[im-stream] send_message (streaming thinking placeholder) failed: {}", e);
                                }
                            }
                            Err(e) => {
                                ulog_warn!("[im-stream] send_message_returning_id (streaming thinking placeholder) failed: {}", e);
                            }
                        }
                        first_content_sent = true;
                    }
                }
                "block-end" => {
                    let final_text = json_val["text"]
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| block_text.clone());

                    if !final_text.trim().is_empty() {
                        if let Some(ref sid) = stream_id {
                            // Finalize the stream with final content
                            if let Err(e) = adapter.finalize_stream(chat_id, sid, &final_text).await {
                                ulog_warn!("[im-stream] finalize_stream failed: {}", e);
                            }
                            any_text_sent = true;
                        } else {
                            // No stream was started (very fast response) → send directly
                            if let Err(e) = adapter.send_message(chat_id, &final_text).await {
                                ulog_warn!("[im-stream] send_message (streaming block-end direct) failed: {}", e);
                            }
                            any_text_sent = true;
                        }
                    } else if let Some(ref sid) = stream_id {
                        // Whitespace-only block — abort the stream
                        if let Err(e) = adapter.abort_stream(chat_id, sid).await {
                            ulog_warn!("[im-stream] abort_stream (empty block) failed: {}", e);
                        }
                    }

                    // Reset for next block
                    block_text.clear();
                    stream_id = None;
                    sequence = 0;
                }
                "complete" => {
                    session_id = json_val["sessionId"].as_str().map(String::from);
                    let silent = json_val["silent"].as_bool().unwrap_or(false);

                    if silent {
                        // Group "always" mode: AI decided not to reply
                        if let Some(ref sid) = stream_id {
                            if let Err(e) = adapter.abort_stream(chat_id, sid).await {
                                ulog_warn!("[im-stream] abort_stream (silent) failed: {}", e);
                            }
                        }
                        if let Some(ref pid) = placeholder_id {
                            if let Err(e) = adapter.delete_message(chat_id, pid).await {
                                ulog_warn!("[im-stream] delete_message (streaming silent placeholder) failed: {}", e);
                            }
                        }
                        return Ok(session_id);
                    }

                    // Flush remaining block text
                    if !block_text.trim().is_empty() {
                        if let Some(ref sid) = stream_id {
                            if let Err(e) = adapter.finalize_stream(chat_id, sid, &block_text).await {
                                ulog_warn!("[im-stream] final finalize_stream failed: {}", e);
                            }
                            any_text_sent = true;
                        } else {
                            if let Err(e) = adapter.send_message(chat_id, &block_text).await {
                                ulog_warn!("[im-stream] send_message (streaming complete flush) failed: {}", e);
                            }
                            any_text_sent = true;
                        }
                    } else if let Some(ref sid) = stream_id {
                        if let Err(e) = adapter.abort_stream(chat_id, sid).await {
                            ulog_warn!("[im-stream] abort_stream (complete empty) failed: {}", e);
                        }
                    }

                    if !any_text_sent {
                        // Edit placeholder in-place if possible, otherwise delete + send
                        if let Some(ref pid) = placeholder_id {
                            if adapter.edit_message(chat_id, pid, "(No response)").await.is_err() {
                                let _ = adapter.delete_message(chat_id, pid).await;
                                if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                                    ulog_warn!("[im-stream] send_message (streaming no response fallback) failed: {}", e);
                                }
                            }
                        } else {
                            if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                                ulog_warn!("[im-stream] send_message (streaming no response) failed: {}", e);
                            }
                        }
                    }
                    return Ok(session_id);
                }
                "permission-request" => {
                    let request_id = json_val["requestId"].as_str().unwrap_or("").to_string();
                    let tool_name = json_val["toolName"].as_str().unwrap_or("unknown").to_string();
                    let tool_input = json_val["input"].as_str().unwrap_or("").to_string();

                    ulog_info!(
                        "[im-stream] Permission request (streaming): tool={}, rid={}",
                        tool_name,
                        &request_id[..request_id.len().min(16)]
                    );

                    let card_msg_id = match adapter.send_approval_card(chat_id, &request_id, &tool_name, &tool_input).await {
                        Ok(Some(mid)) => mid,
                        Ok(None) => String::new(),
                        Err(e) => {
                            ulog_error!("[im-stream] Failed to send approval card: {}", e);
                            String::new()
                        }
                    };
                    {
                        let mut guard = pending_approvals.lock().await;
                        let now = Instant::now();
                        guard.retain(|_, p| now.duration_since(p.created_at) < Duration::from_secs(15 * 60));
                        guard.insert(request_id, PendingApproval {
                            sidecar_port,
                            chat_id: chat_id.to_string(),
                            card_message_id: card_msg_id,
                            created_at: now,
                        });
                    }
                }
                "error" => {
                    let error = json_val["error"].as_str().unwrap_or("Unknown error");
                    // Abort any active stream
                    if let Some(ref sid) = stream_id {
                        if let Err(e) = adapter.abort_stream(chat_id, sid).await {
                            ulog_warn!("[im-stream] abort_stream (error) failed: {}", e);
                        }
                    }
                    if let Some(ref pid) = placeholder_id {
                        if let Err(e) = adapter.delete_message(chat_id, pid).await {
                            ulog_warn!("[im-stream] delete_message (streaming error placeholder) failed: {}", e);
                        }
                    }
                    return Err(RouteError::Response(500, error.to_string()));
                }
                _ => {}
            }
        }
    }

    // Stream disconnected unexpectedly
    if !block_text.trim().is_empty() {
        if let Some(ref sid) = stream_id {
            if let Err(e) = adapter.finalize_stream(chat_id, sid, &block_text).await {
                ulog_warn!("[im-stream] finalize_stream (disconnect) failed: {}", e);
            }
            any_text_sent = true;
        } else {
            if let Err(e) = adapter.send_message(chat_id, &block_text).await {
                ulog_warn!("[im-stream] send_message (streaming disconnect flush) failed: {}", e);
            }
            any_text_sent = true;
        }
    } else if let Some(ref sid) = stream_id {
        if let Err(e) = adapter.abort_stream(chat_id, sid).await {
            ulog_warn!("[im-stream] abort_stream (disconnect) failed: {}", e);
        }
    }
    if !any_text_sent {
        if let Some(ref pid) = placeholder_id {
            if adapter.edit_message(chat_id, pid, "(No response)").await.is_err() {
                let _ = adapter.delete_message(chat_id, pid).await;
                if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                    ulog_warn!("[im-stream] send_message (streaming disconnect no response fallback) failed: {}", e);
                }
            }
        } else {
            if let Err(e) = adapter.send_message(chat_id, "(No response)").await {
                ulog_warn!("[im-stream] send_message (streaming disconnect no response) failed: {}", e);
            }
        }
    }
    Ok(session_id)
}

/// Finalize a text block's draft message.
/// Uses adapter.max_message_length() to determine the platform's limit.
/// Detects draft mode from the draft_id string (`draft:xxx` prefix) rather than the adapter
/// trait method — this is safe even if `draft_fallback` flips mid-stream, because the decision
/// is based on the actual ID type of the current block, not global adapter state.
async fn finalize_block<A: adapter::ImStreamAdapter>(
    adapter: &A,
    chat_id: &str,
    draft_id: Option<String>,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    let is_draft_id = draft_id.as_ref().map_or(false, |id| id.starts_with("draft:"));
    if is_draft_id {
        // Draft mode: delete draft (no-op for draft: IDs) + send permanent message.
        // `sendMessageDraft` cannot be "committed" — only `sendMessage` creates a real message.
        if let Some(ref did) = draft_id {
            if let Err(e) = adapter.delete_message(chat_id, did).await {
                ulog_warn!("[im-stream] delete_message (draft finalize) failed: {}", e);
            }
        }
        if let Err(e) = adapter.send_message(chat_id, text).await {
            ulog_warn!("[im-stream] send_message (draft finalize) failed: {}", e);
        }
    } else {
        // Standard mode: edit-in-place or delete+send
        let max_len = adapter.max_message_length();
        if let Some(ref did) = draft_id {
            if text.len() <= max_len {
                if let Err(e) = adapter.finalize_message(chat_id, did, text).await {
                    ulog_warn!("[im] Finalize edit failed: {}, sending as new message", e);
                    if let Err(e2) = adapter.send_message(chat_id, text).await {
                        ulog_warn!("[im-stream] send_message (finalize fallback) failed: {}", e2);
                    }
                }
            } else {
                // Too long for edit: delete draft → send_message (auto-splits)
                if let Err(e) = adapter.delete_message(chat_id, did).await {
                    ulog_warn!("[im-stream] delete_message (too-long draft) failed: {}", e);
                }
                if let Err(e) = adapter.send_message(chat_id, text).await {
                    ulog_warn!("[im-stream] send_message (too-long split) failed: {}", e);
                }
            }
        } else {
            // No draft created (very fast response) → send directly
            if let Err(e) = adapter.send_message(chat_id, text).await {
                ulog_warn!("[im-stream] send_message (no-draft direct) failed: {}", e);
            }
        }
    }
}

/// Format draft display text (truncate if needed for platform limit).
/// `max_len` is the platform's message limit in bytes (e.g. 4096 for Telegram, 15000 for Feishu).
fn format_draft_text(text: &str, max_len: usize) -> String {
    // Reserve a small margin for the "..." truncation indicator
    let limit = max_len.saturating_sub(10);
    if text.len() > limit {
        // Find a char-boundary-safe truncation point
        let mut truncate_at = limit.min(text.len());
        while !text.is_char_boundary(truncate_at) && truncate_at > 0 {
            truncate_at -= 1;
        }
        format!("{}...", &text[..truncate_at])
    } else {
        text.to_string()
    }
}

/// Check if text has accumulated enough for a meaningful first send.
/// Triggers on sentence-ending punctuation or minimum length threshold.
/// Only affects first-send timing; subsequent edits use `preferred_throttle_ms`.
fn has_sentence_boundary(text: &str) -> bool {
    const MIN_FIRST_SEND_LEN: usize = 20;
    if text.chars().count() >= MIN_FIRST_SEND_LEN {
        return true;
    }
    let trimmed = text.trim_end();
    trimmed.ends_with('\n')
        || trimmed.ends_with('。')
        || trimmed.ends_with('，')
        || trimmed.ends_with('！')
        || trimmed.ends_with('？')
        || trimmed.ends_with('；')
        || trimmed.ends_with('：')
        || trimmed.ends_with(',')
        || trimmed.ends_with('.')
        || trimmed.ends_with('!')
        || trimmed.ends_with('?')
        || trimmed.ends_with(';')
        || trimmed.ends_with(':')
}

/// Translate plugin command descriptions to Chinese for /help display.
/// Falls back to the original English description if no translation is available.
fn translate_plugin_command_desc(name: &str, desc: &str) -> String {
    // Match by command name for known OpenClaw plugin commands
    match name {
        "feishu_diagnose" => "运行飞书插件诊断，检查配置、连接和权限".to_string(),
        "feishu_doctor" => "运行飞书插件诊断".to_string(),
        "feishu_auth" | "feishu auth" => "批量授权飞书用户权限".to_string(),
        "feishu" => "飞书插件命令（子命令：auth, doctor, start）".to_string(),
        _ => {
            if desc.is_empty() { "无描述".to_string() } else { desc.to_string() }
        }
    }
}

/// Extract `data:` payload from SSE event string.
fn extract_sse_data(event_str: &str) -> String {
    event_str
        .lines()
        .filter(|line| line.starts_with("data:"))
        .map(|line| {
            line.strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
                .unwrap_or("")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Generate a non-conflicting file path by appending _1, _2, etc.
fn auto_rename_path(path: &std::path::Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(path);
    for i in 1..100 {
        let new_name = format!("{}_{}{}", stem, i, ext);
        let new_path = parent.join(new_name);
        if !new_path.exists() {
            return new_path;
        }
    }
    path.to_path_buf()
}

// ===== Auto-start on app launch =====

/// Config shape from ~/.pm-copilot/config.json (only what we need)
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    /// Legacy single-bot config (for migration)
    im_bot_config: Option<PartialBotEntry>,
    /// Multi-bot configs (v0.1.19+)
    im_bot_configs: Option<Vec<PartialBotEntry>>,
    /// Agent configs (v0.1.41)
    #[serde(default)]
    agents: Vec<AgentConfigRust>,
    /// API keys keyed by provider ID (for migrating providerEnvJson)
    #[serde(default)]
    provider_api_keys: std::collections::HashMap<String, String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBotEntry {
    id: Option<String>,
    #[serde(flatten)]
    config: ImConfig,
}

/// Auto-start all enabled IM Bots.
/// Called from Tauri `setup` with a short delay to let the app initialize.
pub fn schedule_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize (Sidecar manager, etc.)
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let configs = read_im_configs_from_disk();
        if configs.is_empty() {
            return;
        }

        use tauri::Manager;
        let im_state = app_handle.state::<ManagedImBots>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for (bot_id, config) in configs {
            let has_credentials = match config.platform {
                ImPlatform::Telegram => !config.bot_token.is_empty(),
                ImPlatform::Feishu => {
                    config.feishu_app_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                        && config.feishu_app_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                }
                ImPlatform::Dingtalk => {
                    config.dingtalk_client_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                        && config.dingtalk_client_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                }
                ImPlatform::OpenClaw(_) => {
                    config.openclaw_plugin_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                }
            };
            if config.enabled && has_credentials {
                ulog_info!("[im] Auto-starting bot: {}", bot_id);
                match start_im_bot(&app_handle, &im_state, &sidecar_manager, bot_id.clone(), config).await {
                    Ok(_) => ulog_info!("[im] Auto-start succeeded for bot {}", bot_id),
                    Err(e) => ulog_warn!("[im] Auto-start failed for bot {}: {}", bot_id, e),
                }
            }
        }
    });
}

/// Read IM bot configs from ~/.pm-copilot/config.json
/// Returns (bot_id, config) pairs for all enabled bots.
///
/// Recovery chain (mirrors frontend safeLoadJson):
///   1. config.json — current version
///   2. config.json.bak — previous known-good version
///   3. config.json.tmp — in-progress write
fn read_im_configs_from_disk() -> Vec<(String, ImConfig)> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(".pm-copilot");
    let main_path = config_dir.join("config.json");

    // Try main → .bak → .tmp (same order as frontend safeLoadJson)
    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let app_config: PartialAppConfig = match serde_json::from_str(&content) {
            Ok(c) => c,
            Err(e) => {
                let label = ["main", "bak", "tmp"][i];
                ulog_warn!("[im] Config {} file corrupted, trying next: {}", label, e);
                continue;
            }
        };

        if i > 0 {
            ulog_warn!("[im] Recovered config from {} file", ["main", "bak", "tmp"][i]);
        }

        return parse_bot_entries(app_config);
    }

    Vec::new()
}

/// Extract (bot_id, config) pairs from parsed config.
/// Migrates missing `provider_env_json` from `provider_api_keys` + preset baseUrl map.
/// Skips bots whose IDs also appear as agent channel IDs (to prevent double auto-start).
fn parse_bot_entries(app_config: PartialAppConfig) -> Vec<(String, ImConfig)> {
    // Build set of channel IDs owned by agents — these will be started by schedule_agent_auto_start
    let agent_channel_ids: std::collections::HashSet<String> = app_config
        .agents
        .iter()
        .flat_map(|a| a.channels.iter().map(|ch| ch.id.clone()))
        .collect();

    let api_keys = app_config.provider_api_keys;
    let mut entries: Vec<(String, ImConfig)> = if let Some(bots) = app_config.im_bot_configs {
        bots.into_iter()
            .filter_map(|entry| {
                let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                if agent_channel_ids.contains(&id) {
                    ulog_debug!("[im] Skipping legacy bot {} (owned by agent)", id);
                    None
                } else {
                    Some((id, entry.config))
                }
            })
            .collect()
    } else if let Some(entry) = app_config.im_bot_config {
        let id = entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if agent_channel_ids.contains(&id) {
            Vec::new()
        } else {
            vec![(id, entry.config)]
        }
    } else {
        Vec::new()
    };

    // Migration: rebuild providerEnvJson for bots that have providerId but no providerEnvJson
    for (_id, config) in &mut entries {
        migrate_provider_env(config, &api_keys);
    }

    entries
}

/// Backward-compat migration: if a bot has `provider_id` set but `provider_env_json` is missing,
/// reconstruct it from `providerApiKeys` + preset provider baseUrl map.
/// This handles existing configs created before providerEnvJson persistence was added.
fn migrate_provider_env(
    config: &mut ImConfig,
    api_keys: &std::collections::HashMap<String, String>,
) {
    if config.provider_env_json.is_some() {
        return; // Already set
    }
    let provider_id = match &config.provider_id {
        Some(id) if !id.is_empty() && !id.contains("sub") => id.clone(),
        _ => return, // Subscription or no provider
    };
    let api_key = match api_keys.get(&provider_id) {
        Some(key) if !key.is_empty() => key,
        _ => return, // No API key available
    };
    let meta = match preset_provider_meta(&provider_id) {
        Some(m) => m,
        None => {
            ulog_warn!(
                "[im] Cannot migrate providerEnvJson for unknown provider '{}' — manual restart required",
                provider_id
            );
            return;
        }
    };
    let mut env = serde_json::json!({
        "baseUrl": meta.base_url,
        "apiKey": api_key,
        "authType": meta.auth_type,
    });
    if let Some(proto) = meta.api_protocol {
        env["apiProtocol"] = serde_json::json!(proto);
    }
    config.provider_env_json = Some(env.to_string());
    ulog_info!(
        "[im] Migrated providerEnvJson for provider '{}' from providerApiKeys",
        provider_id
    );
}

/// Backward-compat migration for Agent configs: rebuild missing `provider_env_json`
/// on both the agent level and each channel's overrides.
/// Uses the same preset baseUrl map as `migrate_provider_env`.
fn migrate_agent_provider_env(
    agent: &mut AgentConfigRust,
    api_keys: &std::collections::HashMap<String, String>,
) {
    // 1. Migrate agent-level providerEnvJson
    if agent.provider_env_json.is_none() {
        if let Some(ref pid) = agent.provider_id {
            if !pid.is_empty() && !pid.contains("sub") {
                if let Some(api_key) = api_keys.get(pid).filter(|k| !k.is_empty()) {
                    if let Some(meta) = preset_provider_meta(pid) {
                        let mut env = serde_json::json!({
                            "baseUrl": meta.base_url,
                            "apiKey": api_key,
                            "authType": meta.auth_type,
                        });
                        if let Some(proto) = meta.api_protocol {
                            env["apiProtocol"] = serde_json::json!(proto);
                        }
                        agent.provider_env_json = Some(env.to_string());
                        ulog_info!(
                            "[agent] Migrated agent-level providerEnvJson for provider '{}'",
                            pid
                        );
                    }
                }
            }
        }
    }

    // 2. Migrate each channel's overrides.providerEnvJson
    for ch in &mut agent.channels {
        if let Some(ref mut ov) = ch.overrides {
            if ov.provider_env_json.is_none() {
                if let Some(ref pid) = ov.provider_id {
                    if !pid.is_empty() && !pid.contains("sub") {
                        if let Some(api_key) = api_keys.get(pid).filter(|k| !k.is_empty()) {
                            if let Some(meta) = preset_provider_meta(pid) {
                                let mut env = serde_json::json!({
                                    "baseUrl": meta.base_url,
                                    "apiKey": api_key,
                                    "authType": meta.auth_type,
                                });
                                if let Some(proto) = meta.api_protocol {
                                    env["apiProtocol"] = serde_json::json!(proto);
                                }
                                ov.provider_env_json = Some(env.to_string());
                                ulog_info!(
                                    "[agent] Migrated channel override providerEnvJson for provider '{}'",
                                    pid
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

/// Preset provider metadata for migration: (baseUrl, authType, apiProtocol).
/// Must match PRESET_PROVIDERS in src/renderer/config/types.ts.
struct PresetProviderMeta {
    base_url: &'static str,
    auth_type: &'static str,
    api_protocol: Option<&'static str>, // None = anthropic (default), Some("openai") = OpenAI bridge
}

fn preset_provider_meta(provider_id: &str) -> Option<PresetProviderMeta> {
    match provider_id {
        "anthropic-api" => Some(PresetProviderMeta {
            base_url: "https://api.anthropic.com",
            auth_type: "both",
            api_protocol: None,
        }),
        "deepseek" => Some(PresetProviderMeta {
            base_url: "https://api.deepseek.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "moonshot" => Some(PresetProviderMeta {
            base_url: "https://api.moonshot.cn/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "zhipu" => Some(PresetProviderMeta {
            base_url: "https://open.bigmodel.cn/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "minimax" => Some(PresetProviderMeta {
            base_url: "https://api.minimaxi.com/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "google-gemini" => Some(PresetProviderMeta {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
            auth_type: "api_key",
            api_protocol: Some("openai"),
        }),
        "volcengine" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/coding",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "volcengine-api" => Some(PresetProviderMeta {
            base_url: "https://ark.cn-beijing.volces.com/api/compatible",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "siliconflow" => Some(PresetProviderMeta {
            base_url: "https://api.siliconflow.cn/",
            auth_type: "api_key",
            api_protocol: None,
        }),
        "zenmux" => Some(PresetProviderMeta {
            base_url: "https://zenmux.ai/api/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "aliyun-bailian-coding" => Some(PresetProviderMeta {
            base_url: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
            auth_type: "auth_token",
            api_protocol: None,
        }),
        "openrouter" => Some(PresetProviderMeta {
            base_url: "https://openrouter.ai/api",
            auth_type: "auth_token_clear_api_key",
            api_protocol: None,
        }),
        _ => None,
    }
}

// ===== Agent Config Disk Read/Write (v0.1.41) =====

/// Read Agent configs from disk. Falls back to reading imBotConfigs and converting.
fn read_agent_configs_from_disk() -> Vec<AgentConfigRust> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };
    let config_dir = home.join(".pm-copilot");
    let main_path = config_dir.join("config.json");

    let candidates = [
        main_path.clone(),
        config_dir.join("config.json.bak"),
        config_dir.join("config.json.tmp"),
    ];

    for (i, path) in candidates.iter().enumerate() {
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let app_config: PartialAppConfig = match serde_json::from_str(&content) {
            Ok(c) => c,
            Err(e) => {
                let label = ["main", "bak", "tmp"][i];
                ulog_warn!("[agent] Config {} file corrupted, trying next: {}", label, e);
                continue;
            }
        };

        if i > 0 {
            ulog_warn!("[agent] Recovered config from {} file", ["main", "bak", "tmp"][i]);
        }

        if !app_config.agents.is_empty() {
            let mut agents = app_config.agents;
            let api_keys = app_config.provider_api_keys;
            // Migration: rebuild providerEnvJson for agents/channels that have
            // providerId but no providerEnvJson (same as parse_bot_entries does for legacy bots)
            for agent in &mut agents {
                migrate_agent_provider_env(agent, &api_keys);
            }
            return agents;
        }

        // Fallback: if no agents[], try converting from imBotConfigs (migration)
        // This is handled by the TS frontend migration, but provide a Rust fallback too
        return Vec::new();
    }

    Vec::new()
}

/// Persist a partial patch to a single agent's entry in `~/.pm-copilot/config.json`.
#[allow(dead_code)] // Kept for potential future use; disk persistence now done by TypeScript service
fn persist_agent_config_patch(agent_id: &str, patch: &AgentConfigPatch) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[agent] Home dir not found")?;
    let config_path = home.join(".pm-copilot").join("config.json");
    let tmp_path = config_path.with_extension("json.tmp.rust");
    let bak_path = config_path.with_extension("json.bak");

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("[agent] Cannot read config.json: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("[agent] Cannot parse config.json: {}", e))?;

    let agents = config.get_mut("agents")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "[agent] No agents[] in config.json".to_string())?;
    let agent = agents.iter_mut()
        .find(|a| a.get("id").and_then(|v| v.as_str()) == Some(agent_id))
        .ok_or_else(|| format!("[agent] Agent {} not found in config.json", agent_id))?;

    // Apply patch fields
    macro_rules! apply_field {
        ($field:ident, $key:expr) => {
            if let Some(ref val) = patch.$field {
                agent[$key] = serde_json::json!(val);
            }
        };
    }
    apply_field!(name, "name");
    apply_field!(icon, "icon");
    apply_field!(enabled, "enabled");
    apply_field!(provider_id, "providerId");
    apply_field!(model, "model");
    apply_field!(provider_env_json, "providerEnvJson");
    apply_field!(permission_mode, "permissionMode");
    apply_field!(mcp_enabled_servers, "mcpEnabledServers");
    apply_field!(setup_completed, "setupCompleted");

    if let Some(ref channels) = patch.channels {
        agent["channels"] = serde_json::to_value(channels)
            .map_err(|e| format!("[agent] Failed to serialize channels: {}", e))?;
    }

    if let Some(ref hb_json) = patch.heartbeat_config_json {
        if !hb_json.is_empty() && hb_json != "null" {
            if let Ok(hb) = serde_json::from_str::<serde_json::Value>(hb_json) {
                agent["heartbeat"] = hb;
            }
        }
    }

    // Atomic write: tmp → bak → rename
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("[agent] Failed to serialize config: {}", e))?;
    std::fs::write(&tmp_path, &serialized)
        .map_err(|e| format!("[agent] Failed to write tmp: {}", e))?;
    if config_path.exists() {
        let _ = std::fs::copy(&config_path, &bak_path);
    }
    std::fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("[agent] Failed to rename tmp → config: {}", e))?;

    ulog_info!("[agent] Persisted config patch for agent {}", agent_id);
    Ok(())
}

/// Resolve which channel to use for proactive messages (heartbeat/cron).
/// Fallback chain:
/// 1. lastActiveChannel if that channel is enabled + connected (Online status)
/// 2. Any other channel with active sessions and Online status
/// 3. First enabled channel with Online status (no history needed)
/// 4. None — no available channel
fn resolve_target_channel(
    agent: &AgentInstance,
    agent_statuses: &HashMap<String, ChannelStatus>,
) -> Option<String> {
    // Helper: check if a channel is online
    let is_online = |ch_id: &str| -> bool {
        agent_statuses
            .get(ch_id)
            .map_or(false, |s| s.status == ImStatus::Online)
    };

    // 1. Try lastActiveChannel
    if let Ok(guard) = agent.last_active_channel.try_read() {
        if let Some(ref lac) = *guard {
            if is_online(&lac.channel_id) {
                return Some(lac.channel_id.clone());
            }
        }
    }

    // 2. Find any channel with active sessions and Online status
    for (ch_id, status) in agent_statuses {
        if status.status == ImStatus::Online && !status.active_sessions.is_empty() {
            return Some(ch_id.clone());
        }
    }

    // 3. First enabled channel with Online status (even without sessions)
    for (ch_id, status) in agent_statuses {
        if status.status == ImStatus::Online {
            return Some(ch_id.clone());
        }
    }

    // 4. No available channel
    None
}

/// Build channel statuses from a running AgentInstance (async helper for heartbeat).
/// Build channel statuses using clone-then-collect pattern (caller should NOT hold ManagedAgents lock).
/// Auto-start all enabled Agent channels.
/// Called from schedule_auto_start after the legacy IM bot startup.
pub fn schedule_agent_auto_start<R: Runtime>(app_handle: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Give the app time to fully initialize
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;

        let agents = read_agent_configs_from_disk();
        if agents.is_empty() {
            return;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        for agent_config in agents {
            if !agent_config.enabled {
                continue;
            }

            // Shared last_active_channel Arc for this agent (all channels share it)
            let shared_lac: Arc<RwLock<Option<LastActiveChannel>>> =
                Arc::new(RwLock::new(agent_config.last_active_channel.clone()));

            let mut started_channel_ids: Vec<String> = Vec::new();

            for channel in &agent_config.channels {
                if !channel.enabled {
                    continue;
                }
                let mut im_config = channel.to_im_config(&agent_config);
                // Suppress per-channel heartbeat interval — agent-level heartbeat controls timing.
                im_config.heartbeat_config = Some(types::HeartbeatConfig {
                    enabled: false,
                    ..types::HeartbeatConfig::default()
                });

                let has_credentials = match im_config.platform {
                    ImPlatform::Telegram => !im_config.bot_token.is_empty(),
                    ImPlatform::Feishu => {
                        im_config.feishu_app_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                            && im_config.feishu_app_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                    }
                    ImPlatform::Dingtalk => {
                        im_config.dingtalk_client_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                            && im_config.dingtalk_client_secret.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                    }
                    ImPlatform::OpenClaw(_) => {
                        im_config.openclaw_plugin_id.as_ref().map(|s| !s.is_empty()).unwrap_or(false)
                    }
                };
                if has_credentials {
                    let bot_id = channel.id.clone();
                    // Dedup: skip if channel already running (and healthy) in agent state.
                    // If channel exists but is Error/Stopped, remove it to allow restart.
                    {
                        let mut agents_guard = agent_state.lock().await;
                        if let Some(agent) = agents_guard.get_mut(&agent_config.id) {
                            if agent.channels.contains_key(&bot_id) {
                                let is_dead = {
                                    let ch = agent.channels.get(&bot_id).unwrap();
                                    let health_state = ch.bot_instance.health.get_state().await;
                                    matches!(health_state.status, types::ImStatus::Error | types::ImStatus::Stopped)
                                };
                                if is_dead {
                                    ulog_info!("[agent] Channel {} in agent {} is dead, removing for auto-restart", bot_id, agent_config.id);
                                    agent.channels.remove(&bot_id);
                                } else {
                                    ulog_info!("[agent] Channel {} already running in agent {}, skipping auto-start", bot_id, agent_config.id);
                                    continue;
                                }
                            }
                        }
                    }
                    ulog_info!("[agent] Auto-starting channel {} of agent {}", bot_id, agent_config.id);
                    // Create bot instance directly (no transit through ManagedImBots)
                    match create_bot_instance(&app_handle, &sidecar_manager, bot_id.clone(), im_config, Some(agent_config.id.clone())).await {
                        Ok((bot_instance, _bot_status)) => {
                            ulog_info!("[agent] Auto-start succeeded for channel {}", bot_id);
                            // Register channel directly in agent state
                            let mut agents_guard = agent_state.lock().await;
                            let agent_instance = agents_guard.entry(agent_config.id.clone()).or_insert_with(|| {
                                AgentInstance {
                                    agent_id: agent_config.id.clone(),
                                    config: agent_config.clone(),
                                    channels: HashMap::new(),
                                    last_active_channel: Arc::clone(&shared_lac),
                                    heartbeat_handle: None,
                                    heartbeat_wake_tx: None,
                                    heartbeat_config: None,
                                    current_model: Arc::new(RwLock::new(agent_config.model.clone())),
                                    current_provider_env: Arc::new(RwLock::new(
                                        agent_config.provider_env_json.as_ref()
                                            .and_then(|s| serde_json::from_str(s).ok())
                                    )),
                                    permission_mode: Arc::new(RwLock::new(agent_config.permission_mode.clone())),
                                    mcp_servers_json: Arc::new(RwLock::new(agent_config.mcp_servers_json.clone())),
                                    memory_update_config: None,
                                    memory_update_running: None,
                                }
                            });
                            // Set agent_link so the processing loop can update lastActiveChannel
                            let link = AgentChannelLink {
                                channel_id: channel.id.clone(),
                                agent_id: agent_config.id.clone(),
                                last_active_channel: Arc::clone(&shared_lac),
                            };
                            *bot_instance.agent_link.write().await = Some(link);

                            agent_instance.channels.insert(channel.id.clone(), ChannelInstance {
                                channel_id: channel.id.clone(),
                                bot_instance,
                            });
                            started_channel_ids.push(channel.id.clone());
                            drop(agents_guard);
                        }
                        Err(e) => ulog_warn!("[agent] Auto-start failed for channel {}: {}", bot_id, e),
                    }
                }
            }

            // Start agent-level heartbeat if configured and at least one channel started
            if !started_channel_ids.is_empty() {
                let hb_config = agent_config.heartbeat.clone().unwrap_or_default();
                let agent_id = agent_config.id.clone();
                let agent_label = agent_config.name.clone();
                let agent_state_for_hb = Arc::clone(&*agent_state);
                let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
                let hb_config_arc = Arc::new(RwLock::new(hb_config));
                let hb_config_for_loop = Arc::clone(&hb_config_arc);
                // Memory auto-update arcs (v0.1.43)
                let mau_config_arc = Arc::new(RwLock::new(agent_config.memory_auto_update.clone()));
                let mau_running_arc = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let mau_config_for_loop = Arc::clone(&mau_config_arc);
                let mau_running_for_loop = Arc::clone(&mau_running_arc);
                let mau_workspace = agent_config.workspace_path.clone();
                let mau_agent_id = agent_config.id.clone();
                let mau_sidecar_mgr = Arc::clone(&*sidecar_manager);
                let mau_app_handle = app_handle.clone();
                // Clone agent-level AI config Arcs from AgentInstance
                let (mau_model, mau_provider_env, mau_mcp_json) = {
                    let agents_guard = agent_state.lock().await;
                    if let Some(inst) = agents_guard.get(&agent_config.id) {
                        (
                            Arc::clone(&inst.current_model),
                            Arc::clone(&inst.current_provider_env),
                            Arc::clone(&inst.mcp_servers_json),
                        )
                    } else {
                        // Agent instance not found (shouldn't happen), use defaults
                        (
                            Arc::new(RwLock::new(agent_config.model.clone())),
                            Arc::new(RwLock::new(None)),
                            Arc::new(RwLock::new(agent_config.mcp_servers_json.clone())),
                        )
                    }
                };

                let hb_handle = tokio::spawn(async move {
                    use heartbeat::is_in_active_hours;

                    let initial_interval = {
                        let cfg = hb_config_for_loop.read().await;
                        Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
                    };
                    let mut interval = tokio::time::interval(initial_interval);
                    interval.tick().await; // skip first immediate tick

                    ulog_info!(
                        "[agent-heartbeat] Runner started for agent {} (interval={}min)",
                        agent_label,
                        initial_interval.as_secs() / 60
                    );

                    loop {
                        // Check if interval needs updating
                        {
                            let cfg = hb_config_for_loop.read().await;
                            let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                            if desired != interval.period() {
                                ulog_info!(
                                    "[agent-heartbeat] Interval changed to {}min",
                                    desired.as_secs() / 60
                                );
                                interval = tokio::time::interval(desired);
                                interval.tick().await;
                            }
                        }

                        let reason = tokio::select! {
                            _ = interval.tick() => types::WakeReason::Interval,
                            Some(reason) = wake_rx.recv() => {
                                // Coalesce: drain additional signals within 250ms
                                let mut reasons = vec![reason];
                                tokio::time::sleep(Duration::from_millis(250)).await;
                                while let Ok(r) = wake_rx.try_recv() {
                                    reasons.push(r);
                                }
                                reasons.into_iter()
                                    .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                                    .unwrap_or(types::WakeReason::Interval)
                            }
                        };

                        let is_high_priority = reason.is_high_priority();

                        // Memory auto-update check (v0.1.43) — runs independently of heartbeat enabled
                        // Placed BEFORE heartbeat gate so memory update works even when heartbeat is off
                        {
                            let hb_tz = {
                                let cfg = hb_config_for_loop.read().await;
                                cfg.active_hours.as_ref().map(|ah| ah.timezone.clone())
                            };
                            memory_update::check_and_spawn(
                                &mau_agent_id,
                                &mau_workspace,
                                &mau_config_for_loop,
                                &mau_running_for_loop,
                                &mau_sidecar_mgr,
                                &mau_app_handle,
                                &mau_model,
                                &mau_provider_env,
                                &mau_mcp_json,
                                hb_tz.as_deref(),
                            ).await;
                        }

                        // Gate: heartbeat enabled check
                        let config = hb_config_for_loop.read().await.clone();
                        if !config.enabled {
                            ulog_debug!("[agent-heartbeat] Skipped: disabled");
                            continue;
                        }

                        // Gate: active hours (high-priority wakes skip)
                        if !is_high_priority {
                            if let Some(ref active_hours) = config.active_hours {
                                if !is_in_active_hours(active_hours) {
                                    ulog_debug!("[agent-heartbeat] Skipped: outside active hours");
                                    continue;
                                }
                            }
                        }

                        // Clone refs from agent state, then drop the lock before async work
                        let channel_snapshot = {
                            let agents_guard = agent_state_for_hb.lock().await;
                            let agent = match agents_guard.get(&agent_id) {
                                Some(a) => a,
                                None => {
                                    ulog_debug!("[agent-heartbeat] Agent {} not found, stopping", agent_id);
                                    break;
                                }
                            };
                            // Clone channel refs for status collection + wake_tx for delegation
                            let refs: Vec<_> = agent.channels.iter().map(|(ch_id, ch_inst)| {
                                (
                                    ch_id.clone(),
                                    Arc::clone(&ch_inst.bot_instance.health),
                                    Arc::clone(&ch_inst.bot_instance.router),
                                    ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                                    ch_inst.bot_instance.started_at,
                                    ch_inst.bot_instance.config.platform.clone(),
                                    ch_inst.bot_instance.config.name.clone(),
                                    ch_inst.bot_instance.bind_code.clone(),
                                )
                            }).collect();
                            let lac = Arc::clone(&agent.last_active_channel);
                            (refs, lac)
                        }; // agents_guard dropped here

                        // Build channel statuses without holding the Mutex
                        let (ch_refs, _lac) = channel_snapshot;
                        let mut statuses_map = HashMap::new();
                        let mut wake_txs: HashMap<String, mpsc::Sender<types::WakeReason>> = HashMap::new();
                        for (ch_id, health, router, wake_tx, started_at, platform, name, bind_code) in &ch_refs {
                            let health_state = health.get_state().await;
                            let active_sessions = router.lock().await.active_sessions();
                            statuses_map.insert(ch_id.clone(), ChannelStatus {
                                channel_id: ch_id.clone(),
                                channel_type: platform.clone(),
                                name: name.clone(),
                                status: health_state.status,
                                bot_username: health_state.bot_username,
                                uptime_seconds: started_at.elapsed().as_secs(),
                                last_message_at: health_state.last_message_at,
                                active_sessions,
                                error_message: health_state.error_message,
                                restart_count: health_state.restart_count,
                                buffered_messages: health_state.buffered_messages,
                                bind_url: None,
                                bind_code: Some(bind_code.clone()),
                            });
                            if let Some(tx) = wake_tx {
                                wake_txs.insert(ch_id.clone(), tx.clone());
                            }
                        }

                        // Re-acquire lock briefly to resolve target channel
                        let target_ch_id = {
                            let agents_guard = agent_state_for_hb.lock().await;
                            match agents_guard.get(&agent_id) {
                                Some(agent) => resolve_target_channel(agent, &statuses_map),
                                None => None,
                            }
                        };
                        let target_ch_id = match target_ch_id {
                            Some(id) => id,
                            None => {
                                ulog_debug!("[agent-heartbeat] No available channel for agent {}", agent_id);
                                continue;
                            }
                        };

                        // Delegate to the target channel's per-bot heartbeat wake_tx (no lock held)
                        let delegated_reason = if reason.is_high_priority() {
                            reason
                        } else {
                            types::WakeReason::Manual
                        };
                        if let Some(wake_tx) = wake_txs.get(&target_ch_id) {
                            let _ = wake_tx.send(delegated_reason).await;
                            ulog_debug!(
                                "[agent-heartbeat] Routed heartbeat to channel {} for agent {}",
                                target_ch_id, agent_id
                            );
                        } else {
                            ulog_debug!(
                                "[agent-heartbeat] Channel {} has no heartbeat runner, skipping",
                                target_ch_id
                            );
                        }

                        // Reset interval after wake
                        if is_high_priority {
                            interval.reset();
                        }

                    }

                    ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
                });

                // Store heartbeat handles on the agent instance
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent_instance) = agents_guard.get_mut(&agent_config.id) {
                    agent_instance.heartbeat_handle = Some(hb_handle);
                    agent_instance.heartbeat_wake_tx = Some(wake_tx);
                    agent_instance.heartbeat_config = Some(hb_config_arc);
                    agent_instance.memory_update_config = Some(mau_config_arc);
                    agent_instance.memory_update_running = Some(mau_running_arc);
                    ulog_info!("[agent] Agent-level heartbeat started for {}", agent_config.id);
                }
                drop(agents_guard);
            }
        }
    });
}


/// Monitor agent channels and auto-restart dead ones (Error/Stopped).
/// Periodically scans all agent channels, restarts dead ones using the same
/// dedup + create_bot_instance pattern as schedule_agent_auto_start.
pub async fn monitor_agent_channels(
    app_handle: AppHandle,
    shutdown: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering::Relaxed;

    const CHECK_INTERVAL_SECS: u64 = 30;
    const MAX_CONSECUTIVE_FAILURES: u32 = 5;
    const BACKOFF_BASE_SECS: u64 = 30;
    const MAX_BACKOFF_SECS: u64 = 300;

    // Initial delay: let auto-start finish first
    tokio::time::sleep(Duration::from_secs(15)).await;
    ulog_info!("[agent-monitor] Agent channel health monitor started");

    // Track per-channel: consecutive failures + next retry timestamp.
    // failure_counts keys persist across cycles even if the channel is removed from
    // agent_state during a failed restart — this prevents orphaned channels from
    // being lost to monitoring.
    let mut failure_counts: HashMap<String, u32> = HashMap::new();
    let mut next_retry: HashMap<String, tokio::time::Instant> = HashMap::new();
    // Orphaned channels: (channel_id → agent_id) for channels removed from agent_state
    // during a failed restart. Merged into dead_channels on each cycle so they get retried.
    let mut orphaned: HashMap<String, String> = HashMap::new();

    loop {
        tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
        if shutdown.load(Relaxed) {
            break;
        }

        use tauri::Manager;
        let agent_state = app_handle.state::<ManagedAgents>();
        let sidecar_manager = app_handle.state::<ManagedSidecarManager>();

        // Phase 1: Find dead channels — snapshot health refs under lock, check outside
        let channel_health_refs: Vec<(String, String, Arc<crate::im::health::HealthManager>)> = {
            let agents_guard = agent_state.lock().await;
            let mut refs = Vec::new();
            for (agent_id, agent) in agents_guard.iter() {
                for (channel_id, channel) in agent.channels.iter() {
                    refs.push((
                        agent_id.clone(),
                        channel_id.clone(),
                        Arc::clone(&channel.bot_instance.health),
                    ));
                }
            }
            refs
            // lock dropped here
        };

        let mut dead_channels: Vec<(String, String)> = Vec::new();
        for (agent_id, channel_id, health) in &channel_health_refs {
            let state = health.get_state().await;
            if matches!(state.status, types::ImStatus::Error | types::ImStatus::Stopped) {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        // Merge orphaned channels (failed restart last cycle, no longer in agent_state)
        for (channel_id, agent_id) in &orphaned {
            if !dead_channels.iter().any(|(_, cid)| cid == channel_id) {
                dead_channels.push((agent_id.clone(), channel_id.clone()));
            }
        }

        if dead_channels.is_empty() {
            failure_counts.clear();
            next_retry.clear();
            continue;
        }

        // Phase 2: Read configs from disk for restart
        let agent_configs = read_agent_configs_from_disk();
        if agent_configs.is_empty() {
            continue;
        }

        let now = tokio::time::Instant::now();

        for (agent_id, channel_id) in &dead_channels {
            if shutdown.load(Relaxed) {
                break;
            }

            let count = failure_counts.entry(channel_id.clone()).or_insert(0);
            if *count >= MAX_CONSECUTIVE_FAILURES {
                continue;
            }

            // Skip if backoff hasn't elapsed yet (non-blocking)
            if let Some(&retry_at) = next_retry.get(channel_id) {
                if now < retry_at {
                    continue;
                }
            }

            // Find matching config from disk
            let agent_cfg = match agent_configs.iter().find(|a| a.id == *agent_id) {
                Some(c) => c,
                None => continue,
            };
            if !agent_cfg.enabled {
                continue;
            }
            let channel_cfg = match agent_cfg.channels.iter().find(|c| c.id == *channel_id) {
                Some(c) => c,
                None => continue,
            };
            if !channel_cfg.enabled {
                continue;
            }

            let mut im_config = channel_cfg.to_im_config(agent_cfg);
            im_config.heartbeat_config = Some(types::HeartbeatConfig {
                enabled: false,
                ..types::HeartbeatConfig::default()
            });

            // Remove dead channel — shut down old instance properly first
            let old_instance: Option<ImBotInstance> = {
                let mut agents_guard = agent_state.lock().await;
                if let Some(agent) = agents_guard.get_mut(agent_id) {
                    agent.channels.remove(channel_id).map(|ch| ch.bot_instance)
                } else {
                    None
                }
            };
            if let Some(instance) = old_instance {
                let _ = shutdown_bot_instance(instance, &sidecar_manager, channel_id).await;
            }

            ulog_info!(
                "[agent-monitor] Auto-restarting channel {} of agent {}",
                channel_id,
                agent_id
            );

            match create_bot_instance(
                &app_handle,
                &sidecar_manager,
                channel_id.clone(),
                im_config,
                Some(agent_id.clone()),
            )
            .await
            {
                Ok((bot_instance, _status)) => {
                    failure_counts.remove(channel_id);
                    next_retry.remove(channel_id);
                    orphaned.remove(channel_id);

                    // Re-insert into agent state
                    let mut agents_guard = agent_state.lock().await;
                    if let Some(agent) = agents_guard.get_mut(agent_id) {
                        let link = AgentChannelLink {
                            channel_id: channel_id.clone(),
                            agent_id: agent_id.clone(),
                            last_active_channel: Arc::clone(&agent.last_active_channel),
                        };
                        *bot_instance.agent_link.write().await = Some(link);

                        agent.channels.insert(
                            channel_id.clone(),
                            ChannelInstance {
                                channel_id: channel_id.clone(),
                                bot_instance,
                            },
                        );
                    }
                    drop(agents_guard);

                    ulog_info!(
                        "[agent-monitor] Channel {} restarted successfully",
                        channel_id
                    );
                    let _ = app_handle.emit(
                        "agent:status-changed",
                        serde_json::json!({
                            "agentId": agent_id,
                            "event": "channel_auto_restarted",
                            "channelId": channel_id,
                        }),
                    );
                }
                Err(e) => {
                    *count += 1;
                    // Track as orphaned so next cycle retries even though
                    // the channel was removed from agent_state
                    orphaned.insert(channel_id.clone(), agent_id.clone());
                    // Schedule next retry with exponential backoff
                    let backoff = std::cmp::min(
                        BACKOFF_BASE_SECS.saturating_mul(2u64.saturating_pow(*count - 1)),
                        MAX_BACKOFF_SECS,
                    );
                    next_retry.insert(
                        channel_id.clone(),
                        now + Duration::from_secs(backoff),
                    );
                    ulog_error!(
                        "[agent-monitor] Failed to restart channel {} (attempt {}, next retry in {}s): {}",
                        channel_id,
                        count,
                        backoff,
                        e
                    );
                }
            }
        }

        // Clean up: remove entries for channels that recovered or were manually stopped
        // Keep entries that are in orphaned (awaiting retry) or in dead_channels
        let tracked: std::collections::HashSet<String> = dead_channels
            .iter()
            .map(|(_, cid)| cid.clone())
            .chain(orphaned.keys().cloned())
            .collect();
        failure_counts.retain(|cid, _| tracked.contains(cid));
        next_retry.retain(|cid, _| tracked.contains(cid));
    }
}

// ===== Tauri Commands =====

#[deprecated(note = "Use cmd_start_agent_channel instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_start_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
    botToken: String,
    allowedUsers: Vec<String>,
    permissionMode: String,
    workspacePath: String,
    model: Option<String>,
    providerEnvJson: Option<String>,
    mcpServersJson: Option<String>,
    platform: Option<String>,
    feishuAppId: Option<String>,
    feishuAppSecret: Option<String>,
    dingtalkClientId: Option<String>,
    dingtalkClientSecret: Option<String>,
    dingtalkUseAiCard: Option<bool>,
    dingtalkCardTemplateId: Option<String>,
    telegramUseDraft: Option<bool>,
    heartbeatConfigJson: Option<String>,
    botName: Option<String>,
    openclawPluginId: Option<String>,
    openclawNpmSpec: Option<String>,
    openclawPluginConfig: Option<serde_json::Value>,
) -> Result<ImBotStatus, String> {
    ulog_warn!("[im] Deprecated cmd_start_im_bot called for bot={}", botId);
    let im_platform = match platform.as_deref() {
        Some("feishu") => ImPlatform::Feishu,
        Some("dingtalk") => ImPlatform::Dingtalk,
        Some(p) if p.starts_with("openclaw:") => {
            let channel_id = p.strip_prefix("openclaw:").unwrap_or("").to_string();
            ImPlatform::OpenClaw(channel_id)
        }
        _ => ImPlatform::Telegram,
    };
    let heartbeat_config = heartbeatConfigJson
        .as_deref()
        .filter(|s| !s.is_empty() && *s != "null")
        .and_then(|s| serde_json::from_str::<types::HeartbeatConfig>(s).ok());
    // Load persisted group fields from disk so manual start/restart doesn't lose approvals
    let existing_configs = read_im_configs_from_disk();
    let existing = existing_configs.iter().find(|(id, _)| id == &botId).map(|(_, c)| c);

    let config = ImConfig {
        platform: im_platform,
        name: botName,
        bot_token: botToken,
        allowed_users: allowedUsers,
        permission_mode: permissionMode,
        default_workspace_path: Some(workspacePath),
        enabled: true,
        feishu_app_id: feishuAppId,
        feishu_app_secret: feishuAppSecret,
        dingtalk_client_id: dingtalkClientId,
        dingtalk_client_secret: dingtalkClientSecret,
        dingtalk_use_ai_card: dingtalkUseAiCard,
        dingtalk_card_template_id: dingtalkCardTemplateId,
        telegram_use_draft: telegramUseDraft,
        provider_id: None, // Not needed here — frontend passes providerEnvJson directly
        model,
        provider_env_json: providerEnvJson,
        mcp_servers_json: mcpServersJson,
        heartbeat_config,
        group_permissions: existing.map(|c| c.group_permissions.clone()).unwrap_or_default(),
        group_activation: existing.and_then(|c| c.group_activation.clone()),
        group_tools_deny: existing.map(|c| c.group_tools_deny.clone()).unwrap_or_default(),
        openclaw_plugin_id: openclawPluginId,
        openclaw_npm_spec: openclawNpmSpec,
        openclaw_plugin_config: openclawPluginConfig,
        openclaw_enabled_tool_groups: None, // Legacy bot path — tool groups set via Agent channel config
    };

    start_im_bot(
        &app_handle,
        &imState,
        &sidecarManager,
        botId,
        config,
    )
    .await
}

#[deprecated(note = "Use cmd_stop_agent_channel instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_stop_im_bot(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
) -> Result<(), String> {
    ulog_warn!("[im] Deprecated cmd_stop_im_bot called for bot={}", botId);
    stop_im_bot(&imState, &sidecarManager, &botId).await?;
    let _ = app_handle.emit("im:status-changed", json!({ "event": "stopped" }));
    Ok(())
}

#[deprecated(note = "Use cmd_agent_channel_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_im_bot_status(
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
) -> Result<ImBotStatus, String> {
    // First check legacy ManagedImBots
    let status = get_im_bot_status(&imState, &botId).await;
    if status.status != types::ImStatus::Stopped {
        return Ok(status);
    }

    // Fallback: check ManagedAgents (bot may have been moved there by cmd_start_agent_channel)
    let agents_guard = agentState.lock().await;
    for (_agent_id, agent) in agents_guard.iter() {
        if let Some(ch) = agent.channels.get(&botId) {
            let health_state = ch.bot_instance.health.get_state().await;

            // Compute bind_url/bind_code like get_im_bot_status does
            let (bind_url, bind_code) = match ch.bot_instance.platform {
                types::ImPlatform::Telegram => {
                    let url = health_state.bot_username.as_ref()
                        .map(|u| format!("https://t.me/{}?start={}", u, ch.bot_instance.bind_code));
                    (url, None)
                }
                types::ImPlatform::Feishu => (None, Some(ch.bot_instance.bind_code.clone())),
                types::ImPlatform::Dingtalk => (None, Some(ch.bot_instance.bind_code.clone())),
                _ => (None, None),
            };

            return Ok(types::ImBotStatus {
                bot_username: health_state.bot_username,
                status: health_state.status,
                uptime_seconds: ch.bot_instance.started_at.elapsed().as_secs(),
                last_message_at: health_state.last_message_at,
                active_sessions: ch.bot_instance.router.lock().await.active_sessions(),
                error_message: health_state.error_message,
                restart_count: health_state.restart_count,
                buffered_messages: ch.bot_instance.buffer.lock().await.len(),
                bind_url,
                bind_code,
            });
        }
    }

    Ok(status)
}

#[deprecated(note = "Use cmd_all_agents_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_im_all_bots_status(
    imState: tauri::State<'_, ManagedImBots>,
) -> Result<HashMap<String, ImBotStatus>, String> {
    ulog_warn!("[im] Deprecated cmd_im_all_bots_status called");
    Ok(get_all_bots_status(&imState).await)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_im_conversations(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<Vec<ImConversation>, String> {
    let im_guard = imState.lock().await;

    if let Some(instance) = im_guard.get(&botId) {
        let sessions = instance.router.lock().await.active_sessions();
        let conversations: Vec<ImConversation> = sessions
            .iter()
            .map(|s| {
                let (source_type, source_id) = router::parse_session_key(&s.session_key);

                ImConversation {
                    session_id: String::new(), // Could be fetched from PeerSession
                    session_key: s.session_key.clone(),
                    source_type,
                    source_id,
                    workspace_path: s.workspace_path.clone(),
                    message_count: s.message_count,
                    last_active: s.last_active.clone(),
                }
            })
            .collect();
        Ok(conversations)
    } else {
        Ok(Vec::new())
    }
}

// ===== Unified Config Commands (v0.1.26) =====

/// Persist a partial patch to a single bot's entry in `~/.pm-copilot/config.json`.
/// Uses atomic write (.tmp.rust → .bak → rename). `None` = no change, `Some("")` = clear.
fn persist_bot_config_patch(bot_id: &str, patch: &BotConfigPatch) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home.join(".pm-copilot").join("config.json");
    let tmp_path = config_path.with_extension("json.tmp.rust");
    let bak_path = config_path.with_extension("json.bak");

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("[im] Cannot read config.json: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("[im] Cannot parse config.json: {}", e))?;

    // Find the bot/channel entry: search legacy imBotConfigs first, then agents[].channels[] (v0.1.42)
    // Use JSON Pointer path to locate the entry, then get a mutable reference.
    enum BotLocation { Legacy(usize), AgentChannel(usize, usize) }
    let location = {
        let mut found: Option<BotLocation> = None;
        if let Some(bots) = config.get("imBotConfigs").and_then(|v| v.as_array()) {
            for (i, b) in bots.iter().enumerate() {
                if b.get("id").and_then(|v| v.as_str()) == Some(bot_id) {
                    found = Some(BotLocation::Legacy(i));
                    break;
                }
            }
        }
        if found.is_none() {
            if let Some(agents) = config.get("agents").and_then(|v| v.as_array()) {
                'search: for (ai, agent) in agents.iter().enumerate() {
                    if let Some(channels) = agent.get("channels").and_then(|v| v.as_array()) {
                        for (ci, ch) in channels.iter().enumerate() {
                            if ch.get("id").and_then(|v| v.as_str()) == Some(bot_id) {
                                found = Some(BotLocation::AgentChannel(ai, ci));
                                break 'search;
                            }
                        }
                    }
                }
            }
        }
        found.ok_or_else(|| format!("[im] Bot {} not found in config.json", bot_id))?
    };
    let is_channel = matches!(location, BotLocation::AgentChannel(_, _));
    let bot = match location {
        BotLocation::Legacy(i) => &mut config["imBotConfigs"][i],
        BotLocation::AgentChannel(ai, ci) => &mut config["agents"][ai]["channels"][ci],
    };

    // Helper: apply optional string field (None=skip, Some("")=remove, Some(val)=set)
    fn apply_opt(target: &mut serde_json::Value, key: &str, val: &Option<String>) {
        if let Some(ref v) = *val {
            if v.is_empty() {
                if let Some(o) = target.as_object_mut() { o.remove(key); }
            } else {
                target[key] = serde_json::json!(v);
            }
        }
    }

    // AI-related fields: for AgentChannel → write to `overrides` sub-object
    // (ChannelConfigRust::to_im_config reads from overrides, not channel root)
    // For Legacy → write to root (backward compat)
    if is_channel {
        // Ensure overrides object exists
        if bot["overrides"].is_null() {
            bot["overrides"] = serde_json::json!({});
        }
        // Clean up stale root-level AI fields left by pre-fix code
        if let Some(obj) = bot.as_object_mut() {
            obj.remove("model");
            obj.remove("providerId");
            obj.remove("providerEnvJson");
            obj.remove("permissionMode");
        }
        let ov = &mut bot["overrides"];
        apply_opt(ov, "model", &patch.model);
        apply_opt(ov, "providerId", &patch.provider_id);
        apply_opt(ov, "providerEnvJson", &patch.provider_env_json);
        apply_opt(ov, "permissionMode", &patch.permission_mode);
    } else {
        apply_opt(bot, "model", &patch.model);
        apply_opt(bot, "providerId", &patch.provider_id);
        apply_opt(bot, "providerEnvJson", &patch.provider_env_json);
        apply_opt(bot, "permissionMode", &patch.permission_mode);
    }

    // Platform-specific fields → always at channel/bot root
    apply_opt(bot, "defaultWorkspacePath", &patch.default_workspace_path);
    apply_opt(bot, "name", &patch.name);
    apply_opt(bot, "botToken", &patch.bot_token);
    apply_opt(bot, "feishuAppId", &patch.feishu_app_id);
    apply_opt(bot, "feishuAppSecret", &patch.feishu_app_secret);
    apply_opt(bot, "dingtalkClientId", &patch.dingtalk_client_id);
    apply_opt(bot, "dingtalkClientSecret", &patch.dingtalk_client_secret);
    apply_opt(bot, "dingtalkCardTemplateId", &patch.dingtalk_card_template_id);

    // dingtalk_use_ai_card → boolean field
    if let Some(val) = patch.dingtalk_use_ai_card {
        bot["dingtalkUseAiCard"] = serde_json::json!(val);
    }

    // telegram_use_draft → boolean field
    if let Some(val) = patch.telegram_use_draft {
        bot["telegramUseDraft"] = serde_json::json!(val);
    }

    // mcp_enabled_servers → persisted as "mcpEnabledServers"
    if let Some(ref servers) = patch.mcp_enabled_servers {
        bot["mcpEnabledServers"] = serde_json::json!(servers);
    }

    // mcp_servers_json → persisted as "mcpServersJson" (resolved definitions for auto-start)
    if let Some(ref json) = patch.mcp_servers_json {
        if json.is_empty() {
            if let Some(o) = bot.as_object_mut() { o.remove("mcpServersJson"); }
        } else {
            bot["mcpServersJson"] = serde_json::json!(json);
        }
    }

    // allowed_users → persisted as "allowedUsers"
    if let Some(ref users) = patch.allowed_users {
        bot["allowedUsers"] = serde_json::json!(users);
    }

    // heartbeat_config_json → deserialized and written as "heartbeat" object
    if let Some(ref hcj) = patch.heartbeat_config_json {
        if hcj.is_empty() || hcj == "null" {
            if let Some(o) = bot.as_object_mut() { o.remove("heartbeat"); }
        } else if let Ok(hb) = serde_json::from_str::<serde_json::Value>(hcj) {
            bot["heartbeat"] = hb;
        }
    }

    // enabled / setup_completed → boolean fields
    if let Some(val) = patch.enabled {
        bot["enabled"] = serde_json::json!(val);
    }
    if let Some(val) = patch.setup_completed {
        bot["setupCompleted"] = serde_json::json!(val);
    }

    // OpenClaw plugin config (v0.1.38)
    if let Some(ref val) = patch.openclaw_plugin_config {
        if val.is_null() {
            if let Some(o) = bot.as_object_mut() { o.remove("openclawPluginConfig"); }
        } else {
            bot["openclawPluginConfig"] = val.clone();
        }
    }

    // Group chat fields (v0.1.28)
    if let Some(ref perms) = patch.group_permissions {
        bot["groupPermissions"] = serde_json::json!(perms);
    }
    if let Some(ref activation) = patch.group_activation {
        if activation.is_empty() {
            if let Some(o) = bot.as_object_mut() { o.remove("groupActivation"); }
        } else {
            bot["groupActivation"] = serde_json::json!(activation);
        }
    }
    if let Some(ref tools) = patch.group_tools_deny {
        // For channels: toolsDeny lives in overrides (ChannelOverrides.tools_deny)
        // For legacy: groupToolsDeny at root
        if is_channel {
            if bot["overrides"].is_null() {
                bot["overrides"] = serde_json::json!({});
            }
            bot["overrides"]["toolsDeny"] = serde_json::json!(tools);
            // Clean up stale root-level field
            if let Some(obj) = bot.as_object_mut() { obj.remove("groupToolsDeny"); }
        } else {
            bot["groupToolsDeny"] = serde_json::json!(tools);
        }
    }

    // Atomic write
    let new_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("[im] Cannot serialize config: {}", e))?;
    std::fs::write(&tmp_path, &new_content)
        .map_err(|e| format!("[im] Cannot write tmp config: {}", e))?;
    if config_path.exists() {
        let _ = std::fs::rename(&config_path, &bak_path);
    }
    if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
        if bak_path.exists() && !config_path.exists() {
            let _ = std::fs::rename(&bak_path, &config_path);
        }
        return Err(format!("[im] Cannot rename tmp config: {}", e));
    }

    Ok(())
}

/// Core 4-step config update: disk → Arc → emit → Sidecar push.
async fn update_bot_config_internal<R: Runtime>(
    app: &AppHandle<R>,
    im_state: &ManagedImBots,
    bot_id: &str,
    patch: &BotConfigPatch,
) -> Result<(), String> {
    // 1. Persist to disk (blocking I/O)
    let bid = bot_id.to_string();
    let patch_model = patch.model.clone();
    let patch_provider_id = patch.provider_id.clone();
    let patch_provider_env = patch.provider_env_json.clone();
    let patch_perm = patch.permission_mode.clone();
    let patch_mcp_json = patch.mcp_servers_json.clone();
    let patch_mcp_enabled = patch.mcp_enabled_servers.clone();
    let patch_workspace = patch.default_workspace_path.clone();
    let patch_hb_json = patch.heartbeat_config_json.clone();
    let patch_allowed = patch.allowed_users.clone();
    let patch_enabled = patch.enabled;
    let patch_setup = patch.setup_completed;
    let patch_name = patch.name.clone();
    let patch_bot_token = patch.bot_token.clone();
    let patch_feishu_id = patch.feishu_app_id.clone();
    let patch_feishu_secret = patch.feishu_app_secret.clone();
    let patch_dingtalk_id = patch.dingtalk_client_id.clone();
    let patch_dingtalk_secret = patch.dingtalk_client_secret.clone();
    let patch_dingtalk_ai_card = patch.dingtalk_use_ai_card;
    let patch_dingtalk_template = patch.dingtalk_card_template_id.clone();
    let patch_telegram_draft = patch.telegram_use_draft;
    let patch_group_perms = patch.group_permissions.clone();
    let patch_group_activation = patch.group_activation.clone();
    let patch_group_tools_deny = patch.group_tools_deny.clone();

    let disk_patch = BotConfigPatch {
        model: patch_model.clone(),
        provider_id: patch_provider_id.clone(),
        provider_env_json: patch_provider_env.clone(),
        permission_mode: patch_perm.clone(),
        mcp_servers_json: patch_mcp_json.clone(), // Persisted for auto-start reconstruction
        mcp_enabled_servers: patch_mcp_enabled,
        allowed_users: patch_allowed.clone(),
        default_workspace_path: patch_workspace.clone(),
        heartbeat_config_json: patch_hb_json.clone(),
        name: patch_name,
        bot_token: patch_bot_token,
        feishu_app_id: patch_feishu_id,
        feishu_app_secret: patch_feishu_secret,
        dingtalk_client_id: patch_dingtalk_id,
        dingtalk_client_secret: patch_dingtalk_secret,
        dingtalk_use_ai_card: patch_dingtalk_ai_card,
        dingtalk_card_template_id: patch_dingtalk_template,
        telegram_use_draft: patch_telegram_draft,
        enabled: patch_enabled,
        setup_completed: patch_setup,
        group_permissions: patch_group_perms.clone(),
        group_activation: patch_group_activation.clone(),
        group_tools_deny: patch_group_tools_deny.clone(),
        openclaw_plugin_config: patch.openclaw_plugin_config.clone(),
        openclaw_enabled_tool_groups: patch.openclaw_enabled_tool_groups.clone(),
    };
    let bid_for_disk = bid.clone();
    tokio::task::spawn_blocking(move || {
        persist_bot_config_patch(&bid_for_disk, &disk_patch)
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    // 2. Update Arc fields if bot is running
    {
        let bots = im_state.lock().await;
        if let Some(inst) = bots.get(&bid) {
            if let Some(ref m) = patch_model {
                *inst.current_model.write().await = if m.is_empty() { None } else { Some(m.clone()) };
            }
            if let Some(ref s) = patch_provider_env {
                if s.is_empty() {
                    *inst.current_provider_env.write().await = None;
                } else {
                    *inst.current_provider_env.write().await = serde_json::from_str(s).ok();
                }
            }
            if let Some(ref pm) = patch_perm {
                *inst.permission_mode.write().await = pm.clone();
            }
            if let Some(ref mj) = patch_mcp_json {
                *inst.mcp_servers_json.write().await = if mj.is_empty() { None } else { Some(mj.clone()) };
            }
            if let Some(ref users) = patch_allowed {
                *inst.allowed_users.write().await = users.clone();
            }
            if let Some(ref hcj) = patch_hb_json {
                if let Some(ref config_arc) = inst.heartbeat_config {
                    if let Ok(hb) = serde_json::from_str::<types::HeartbeatConfig>(hcj) {
                        *config_arc.write().await = hb;
                        // Wake heartbeat runner to pick up new interval immediately
                        if let Some(ref tx) = inst.heartbeat_wake_tx {
                            let _ = tx.try_send(types::WakeReason::Interval);
                        }
                    }
                }
            }

            // Group chat fields (v0.1.28)
            if let Some(ref perms) = patch_group_perms {
                *inst.group_permissions.write().await = perms.clone();
            }
            if let Some(ref act) = patch_group_activation {
                let activation = match act.as_str() {
                    "always" => GroupActivation::Always,
                    _ => GroupActivation::Mention,
                };
                *inst.group_activation.write().await = activation;
            }
            if let Some(ref tools) = patch_group_tools_deny {
                *inst.group_tools_deny.write().await = tools.clone();
            }

            // 4. Sidecar push (model / MCP / workspace / permissionMode)
            {
                let mut router = inst.router.lock().await;
                // Workspace (mut, sync)
                if let Some(ref wp) = patch_workspace {
                    if !wp.is_empty() {
                        router.set_default_workspace(PathBuf::from(wp));
                    }
                }
                let ports = router.active_sidecar_ports();
                // Provider env sync (parsed from patch string)
                // MUST POST even when clearing (empty → null) so Bun's setSessionProviderEnv()
                // detects the change and restarts the session with correct environment.
                let parsed_provider_env: Option<serde_json::Value> = patch_provider_env.as_ref()
                    .and_then(|s| if s.is_empty() { None } else { serde_json::from_str(s).ok() });
                if patch_provider_env.is_some() {
                    for port in &ports {
                        if let Some(ref penv) = parsed_provider_env {
                            router.sync_ai_config(*port, None, None, Some(penv)).await;
                        } else {
                            // Clearing provider (switch to subscription) — POST null explicitly.
                            // sync_ai_config skips None provider_env, so POST directly.
                            let url = format!("http://127.0.0.1:{}/api/provider/set", *port);
                            match router.http_client().post(&url)
                                .json(&json!({ "providerEnv": null }))
                                .send().await
                            {
                                Ok(_) => ulog_info!("[im] Cleared provider env on port {}", port),
                                Err(e) => ulog_warn!("[im] Failed to clear provider env on port {}: {}", port, e),
                            }
                        }
                    }
                }
                // Model sync
                if patch_model.is_some() {
                    for port in &ports {
                        router.sync_ai_config(*port, patch_model.as_deref(), None, None).await;
                    }
                }
                // MCP sync (runtime JSON, not enabled-list)
                if patch_mcp_json.is_some() {
                    for port in &ports {
                        router.sync_ai_config(*port, None, patch_mcp_json.as_deref(), None).await;
                    }
                }
                // Permission mode sync to Sidecar
                if let Some(ref pm) = patch_perm {
                    for port in &ports {
                        router.sync_permission_mode(*port, pm).await;
                    }
                }
            }
        }
    }

    // 3. Emit event so frontend can refreshConfig()
    let _ = app.emit("im:bot-config-changed", json!({ "botId": bid }));

    Ok(())
}

/// Add a new bot entry to `~/.pm-copilot/config.json`.
fn add_bot_config_to_disk(bot_config: &serde_json::Value) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home.join(".pm-copilot").join("config.json");
    let tmp_path = config_path.with_extension("json.tmp.rust");
    let bak_path = config_path.with_extension("json.bak");

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("[im] Cannot read config.json: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("[im] Cannot parse config.json: {}", e))?;

    // Ensure imBotConfigs array exists
    if config.get("imBotConfigs").is_none() {
        config["imBotConfigs"] = serde_json::json!([]);
    }
    let bots = config.get_mut("imBotConfigs").unwrap().as_array_mut().unwrap();

    // Upsert: if bot with same id exists, replace it; otherwise append
    let bot_id = bot_config.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if let Some(pos) = bots.iter().position(|b| b.get("id").and_then(|v| v.as_str()) == Some(bot_id)) {
        bots[pos] = bot_config.clone();
    } else {
        bots.push(bot_config.clone());
    }

    // Atomic write
    let new_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("[im] Cannot serialize config: {}", e))?;
    std::fs::write(&tmp_path, &new_content)
        .map_err(|e| format!("[im] Cannot write tmp config: {}", e))?;
    if config_path.exists() {
        let _ = std::fs::rename(&config_path, &bak_path);
    }
    if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
        if bak_path.exists() && !config_path.exists() {
            let _ = std::fs::rename(&bak_path, &config_path);
        }
        return Err(format!("[im] Cannot rename tmp config: {}", e));
    }

    Ok(())
}

/// Remove a bot entry from `~/.pm-copilot/config.json`.
fn remove_bot_config_from_disk(bot_id: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("[im] Home dir not found")?;
    let config_path = home.join(".pm-copilot").join("config.json");
    let tmp_path = config_path.with_extension("json.tmp.rust");
    let bak_path = config_path.with_extension("json.bak");

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("[im] Cannot read config.json: {}", e))?;
    let mut config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("[im] Cannot parse config.json: {}", e))?;

    if let Some(bots) = config.get_mut("imBotConfigs").and_then(|v| v.as_array_mut()) {
        bots.retain(|b| b.get("id").and_then(|v| v.as_str()) != Some(bot_id));
    }

    let new_content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("[im] Cannot serialize config: {}", e))?;
    std::fs::write(&tmp_path, &new_content)
        .map_err(|e| format!("[im] Cannot write tmp config: {}", e))?;
    if config_path.exists() {
        let _ = std::fs::rename(&config_path, &bak_path);
    }
    if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
        if bak_path.exists() && !config_path.exists() {
            let _ = std::fs::rename(&bak_path, &config_path);
        }
        return Err(format!("[im] Cannot rename tmp config: {}", e));
    }

    Ok(())
}

/// Read `availableProvidersJson` from the top-level field of `~/.pm-copilot/config.json`.
fn read_available_providers_from_disk() -> Option<String> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".pm-copilot").join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let config: serde_json::Value = serde_json::from_str(&content).ok()?;
    config.get("availableProvidersJson")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Unified config update command: replaces all 6 old hot-update commands.
#[deprecated(note = "Use cmd_update_agent_config instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_update_im_bot_config(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
    patch: BotConfigPatch,
) -> Result<(), String> {
    update_bot_config_internal(&app_handle, &imState, &botId, &patch).await
}

/// Read runtime config snapshot from a running bot's Arc fields.
/// Returns the hot-reloadable config as a JSON object; returns null fields if bot is not running.
#[deprecated(note = "Use cmd_agent_channel_status or cmd_agent_status instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_get_im_bot_runtime_config(
    imState: tauri::State<'_, ManagedImBots>,
    botId: String,
) -> Result<serde_json::Value, String> {
    let im_guard = imState.lock().await;
    if let Some(instance) = im_guard.get(&botId) {
        let model = instance.current_model.read().await.clone();
        let provider_env = instance.current_provider_env.read().await.clone();
        let permission_mode = instance.permission_mode.read().await.clone();
        let mcp_servers_json = instance.mcp_servers_json.read().await.clone();
        let allowed_users = instance.allowed_users.read().await.clone();
        Ok(json!({
            "running": true,
            "model": model,
            "providerEnv": provider_env,
            "permissionMode": permission_mode,
            "mcpServersJson": mcp_servers_json,
            "allowedUsers": allowed_users,
        }))
    } else {
        Ok(json!({ "running": false }))
    }
}

/// Add a new bot config to disk.
#[deprecated(note = "Use addAgentConfig on the frontend instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_add_im_bot_config(
    app_handle: AppHandle,
    botConfig: serde_json::Value,
) -> Result<(), String> {
    let config_clone = botConfig.clone();
    tokio::task::spawn_blocking(move || {
        add_bot_config_to_disk(&config_clone)
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;
    let bot_id = botConfig.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": bot_id }));
    ulog_info!("[im] Bot config added: {}", bot_id);
    Ok(())
}

/// Remove a bot config from disk (stops the bot first if running).
#[deprecated(note = "Use removeAgentConfig on the frontend instead")]
#[tauri::command]
#[allow(non_snake_case, deprecated, dead_code)]
pub async fn cmd_remove_im_bot_config(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    botId: String,
) -> Result<(), String> {
    // Stop bot if running
    stop_im_bot(&imState, &sidecarManager, &botId).await?;

    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        remove_bot_config_from_disk(&bid)?;
        health::cleanup_bot_data(&bid);
        Ok::<(), String>(())
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Bot config removed: {}", botId);
    Ok(())
}

// ===== Group Permission Commands (v0.1.28) =====
// Pattern: extract Arc clones under the ManagedImBots lock, drop the lock,
// then do I/O (disk persist, network send) to avoid blocking other Tauri commands.
//
// v0.1.41+: Channels may live in ManagedAgents instead of ManagedImBots.
// Helper resolves from both containers.

/// Resolve group-related Arcs from either ManagedImBots (legacy) or ManagedAgents (v0.1.41+).
/// Returns (group_permissions, group_history, adapter, platform_str) or "Bot not running" error.
async fn resolve_group_context(
    im_state: &ManagedImBots,
    agent_state: &ManagedAgents,
    bot_id: &str,
) -> Result<(
    Arc<tokio::sync::RwLock<Vec<GroupPermission>>>,
    Arc<Mutex<GroupHistoryBuffer>>,
    Arc<AnyAdapter>,
    String,
), String> {
    // 1. Check ManagedAgents first (new Agent architecture)
    {
        let agents = agent_state.lock().await;
        for (_agent_id, agent) in agents.iter() {
            if let Some(ch) = agent.channels.get(bot_id) {
                let inst = &ch.bot_instance;
                return Ok((
                    Arc::clone(&inst.group_permissions),
                    Arc::clone(&inst.group_history),
                    Arc::clone(&inst.adapter),
                    inst.platform.to_string(),
                ));
            }
        }
    }
    // 2. Fallback: legacy ManagedImBots
    {
        let bots = im_state.lock().await;
        let inst = bots.get(bot_id).ok_or_else(|| "Bot not running".to_string())?;
        Ok((
            Arc::clone(&inst.group_permissions),
            Arc::clone(&inst.group_history),
            Arc::clone(&inst.adapter),
            inst.platform.to_string(),
        ))
    }
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_approve_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    use adapter::ImAdapter;

    let (group_perms, _group_history, adapter, _platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Update permission status to Approved
    {
        let mut perms = group_perms.write().await;
        if let Some(p) = perms.iter_mut().find(|p| p.group_id == groupId) {
            p.status = GroupPermissionStatus::Approved;
        } else {
            return Err(format!("Group {} not found in permissions", groupId));
        }
    }

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    let gid = groupId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    // Send confirmation message to group (lock-free)
    if let Err(e) = adapter.send_message(&groupId, "✅ 群聊已授权！所有成员现在可以 @我 提问互动。").await {
        ulog_warn!("[im-cmd] send_message (group approved) failed: {}", e);
    }

    let _ = app_handle.emit("im:group-permission-changed", json!({ "botId": botId, "event": "approved" }));
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group approved: {} for bot {}", gid, botId);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_reject_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    let (group_perms, group_history, _adapter, platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Remove pending permission
    {
        let mut perms = group_perms.write().await;
        perms.retain(|p| p.group_id != groupId);
    }

    // Clean up group history buffer
    let session_key = format!("im:{}:group:{}", platform, groupId);
    group_history.lock().await.clear(&session_key);

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("im:group-permission-changed", json!({ "botId": botId, "event": "rejected" }));
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group rejected: {} for bot {}", groupId, botId);
    Ok(())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_remove_group(
    app_handle: AppHandle,
    imState: tauri::State<'_, ManagedImBots>,
    agentState: tauri::State<'_, ManagedAgents>,
    botId: String,
    groupId: String,
) -> Result<(), String> {
    let (group_perms, group_history, _adapter, platform) =
        resolve_group_context(&imState, &agentState, &botId).await?;

    // Remove approved permission
    {
        let mut perms = group_perms.write().await;
        perms.retain(|p| p.group_id != groupId);
    }

    // Clean up group history buffer
    let session_key = format!("im:{}:group:{}", platform, groupId);
    group_history.lock().await.clear(&session_key);

    // Persist (lock-free)
    let new_perms = group_perms.read().await.clone();
    let bid = botId.clone();
    tokio::task::spawn_blocking(move || {
        let patch = BotConfigPatch {
            group_permissions: Some(new_perms),
            ..Default::default()
        };
        persist_bot_config_patch(&bid, &patch)
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("im:group-permission-changed", json!({ "botId": botId, "event": "removed" }));
    let _ = app_handle.emit("im:bot-config-changed", json!({ "botId": botId }));
    ulog_info!("[im] Group removed: {} for bot {}", groupId, botId);
    Ok(())
}

// ===== OpenClaw Channel Plugin Commands =====

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_install_openclaw_plugin(
    app_handle: AppHandle,
    npmSpec: String,
) -> Result<serde_json::Value, String> {
    bridge::install_openclaw_plugin(&app_handle, &npmSpec).await
}

#[tauri::command]
pub async fn cmd_list_openclaw_plugins() -> Result<Vec<serde_json::Value>, String> {
    bridge::list_openclaw_plugins().await
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_uninstall_openclaw_plugin(pluginId: String) -> Result<(), String> {
    bridge::uninstall_openclaw_plugin(&pluginId).await
}

/// Helper: get bridge port from agent channel.
/// Both the outer (ManagedAgents) and inner (BridgeProcess) locks are held briefly
/// to extract the port value, then released before the actual HTTP call.
async fn get_bridge_port(agent_state: &ManagedAgents, agent_id: &str, channel_id: &str) -> Result<u16, String> {
    let agents_guard = agent_state.lock().await;
    let agent = agents_guard.get(agent_id)
        .ok_or_else(|| format!("Agent '{}' not found", agent_id))?;
    let ch = agent.channels.get(channel_id)
        .ok_or_else(|| format!("Channel '{}' not found on agent '{}'", channel_id, agent_id))?;
    let bp_mutex = ch.bot_instance.bridge_process.as_ref()
        .ok_or_else(|| "Channel has no Bridge process (not an OpenClaw plugin)".to_string())?;
    let port = bp_mutex.lock().await.port;
    drop(agents_guard);
    Ok(port)
}

/// QR login: start QR code generation via Bridge.
/// The channel must already be started (Bridge process running).
/// Returns { ok, qrDataUrl?, message, sessionKey? }.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_qr_login_start(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::qr_login_start(port, None).await
}

/// QR login: wait for user to scan QR code via Bridge.
/// Long-polls (up to 60s). Returns { ok, connected, message }.
/// `sessionKey` is returned by `cmd_plugin_qr_login_start` and MUST be forwarded here
/// (WeChat plugin uses it to track the active login session).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_qr_login_wait(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
    sessionKey: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::qr_login_wait(port, None, sessionKey.as_deref()).await
}

/// Restart the gateway after QR login success.
/// Re-resolves credentials and starts the plugin's message listener.
/// `accountId` is returned by the plugin during QR login (e.g. WeChat's ilink_bot_id)
/// and is REQUIRED for `resolveAccount()` to find the newly-saved credentials.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_plugin_restart_gateway(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
    accountId: Option<String>,
) -> Result<serde_json::Value, String> {
    let port = get_bridge_port(&agentState, &agentId, &channelId).await?;
    bridge::restart_gateway(port, accountId.as_deref()).await
}

/// Restart all running channels that use the given OpenClaw plugin.
/// Called after a plugin update to reload the new plugin code.
/// Returns `{ restarted, failed }` so the frontend can show appropriate feedback.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_restart_channels_using_plugin(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    pluginId: String,
) -> Result<serde_json::Value, String> {
    let running_bot_ids = bridge::get_bot_ids_using_plugin(&pluginId).await;
    if running_bot_ids.is_empty() {
        return Ok(json!({ "restarted": 0, "failed": 0 }));
    }

    ulog_info!(
        "[agent] Restarting {} channel(s) using plugin {}",
        running_bot_ids.len(),
        pluginId
    );

    let mut restarted = 0u32;
    let mut failed = 0u32;

    for bot_id in &running_bot_ids {
        // Find the agent_id for this bot in ManagedAgents
        let found = {
            let agents = agentState.lock().await;
            agents.iter()
                .find(|(_, agent)| agent.channels.contains_key(bot_id))
                .map(|(agent_id, _)| agent_id.clone())
        };

        let agent_id = match found {
            Some(id) => id,
            None => {
                ulog_warn!("[agent] Bot {} not found in ManagedAgents, skipping restart", bot_id);
                continue;
            }
        };

        // Remove channel and clone its config for restart
        let (channel_instance, im_config) = {
            let mut agents = agentState.lock().await;
            let agent = match agents.get_mut(&agent_id) {
                Some(a) => a,
                None => continue,
            };
            let ch = match agent.channels.remove(bot_id) {
                Some(c) => c,
                None => continue,
            };
            let config = ch.bot_instance.config.clone();
            (ch, config)
        };

        // Shutdown the old instance (consumes bot_instance — cannot be re-inserted on failure)
        if let Err(e) = shutdown_bot_instance(
            channel_instance.bot_instance,
            &sidecarManager,
            bot_id,
        ).await {
            ulog_warn!("[agent] Failed to shutdown channel {}: {}", bot_id, e);
            failed += 1;
            // Instance is consumed and partially cleaned up; attempt restart anyway
        }

        // Restart with the same config
        match create_bot_instance(
            &app_handle,
            &sidecarManager,
            bot_id.clone(),
            im_config,
            Some(agent_id.clone()),
        ).await {
            Ok((new_instance, _status)) => {
                // Set agent_link before acquiring the agents lock
                let link = AgentChannelLink {
                    channel_id: bot_id.clone(),
                    agent_id: agent_id.clone(),
                    last_active_channel: {
                        let agents = agentState.lock().await;
                        agents.get(&agent_id)
                            .map(|a| Arc::clone(&a.last_active_channel))
                            .unwrap_or_else(|| Arc::new(RwLock::new(None)))
                    },
                };
                *new_instance.agent_link.write().await = Some(link);

                let mut agents = agentState.lock().await;
                if let Some(agent) = agents.get_mut(&agent_id) {
                    agent.channels.insert(bot_id.clone(), ChannelInstance {
                        channel_id: bot_id.clone(),
                        bot_instance: new_instance,
                    });
                    restarted += 1;
                    ulog_info!("[agent] Channel {} restarted successfully", bot_id);
                }
            }
            Err(e) => {
                ulog_warn!("[agent] Failed to restart channel {}: {}", bot_id, e);
                failed += 1;
            }
        }
    }

    // Always emit status change when channels were touched
    let _ = app_handle.emit("agent:status-changed", ());

    Ok(json!({ "restarted": restarted, "failed": failed }))
}

// ===== Agent Tauri Commands (v0.1.41) =====

/// Start a single channel within an agent.
/// Creates an ImBotInstance directly via create_bot_instance and inserts into ManagedAgents.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_start_agent_channel(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
    agentConfig: AgentConfigRust,
    channelConfig: ChannelConfigRust,
) -> Result<ChannelStatus, String> {
    // Dedup: check if channel is already running in agent state.
    // If channel exists but is in Error/Stopped state, remove it to allow restart.
    {
        let mut agents_guard = agentState.lock().await;
        if let Some(agent) = agents_guard.get_mut(&agentId) {
            if agent.channels.contains_key(&channelId) {
                let is_dead = {
                    let ch = agent.channels.get(&channelId).unwrap();
                    let health_state = ch.bot_instance.health.get_state().await;
                    matches!(health_state.status, types::ImStatus::Error | types::ImStatus::Stopped)
                };
                if is_dead {
                    ulog_info!("[agent] Channel {} in agent {} is dead, removing to allow restart", channelId, agentId);
                    agent.channels.remove(&channelId);
                } else {
                    ulog_warn!("[agent] Channel {} already running in agent {}, skipping start", channelId, agentId);
                    let ch = agent.channels.get(&channelId)
                        .ok_or_else(|| format!("[agent] Channel {} disappeared from agent {}", channelId, agentId))?;
                    let health_state = ch.bot_instance.health.get_state().await;
                    let active_sessions = ch.bot_instance.router.lock().await.active_sessions();
                    return Ok(ChannelStatus {
                        channel_id: channelId,
                        channel_type: ch.bot_instance.config.platform.clone(),
                        name: ch.bot_instance.config.name.clone(),
                        status: health_state.status,
                        bot_username: health_state.bot_username,
                        uptime_seconds: ch.bot_instance.started_at.elapsed().as_secs(),
                        last_message_at: health_state.last_message_at,
                        active_sessions,
                        error_message: health_state.error_message,
                        restart_count: health_state.restart_count,
                        buffered_messages: health_state.buffered_messages,
                        bind_url: None,
                        bind_code: Some(ch.bot_instance.bind_code.clone()),
                    });
                }
            }
        }
    } // agents_guard dropped

    let mut im_config = channelConfig.to_im_config(&agentConfig);
    // Suppress per-channel heartbeat interval — agent-level heartbeat controls timing
    im_config.heartbeat_config = Some(types::HeartbeatConfig {
        enabled: false,
        ..types::HeartbeatConfig::default()
    });

    // Create bot instance directly (no transit through ManagedImBots)
    let (bot_instance, bot_status) = create_bot_instance(
        &app_handle,
        &sidecarManager,
        channelId.clone(),
        im_config,
        Some(agentId.clone()),
    )
    .await?;

    // Insert directly into agent state
    let mut agents_guard = agentState.lock().await;
    let agent_instance = agents_guard.entry(agentId.clone()).or_insert_with(|| {
        AgentInstance {
            agent_id: agentId.clone(),
            config: agentConfig.clone(),
            channels: HashMap::new(),
            last_active_channel: Arc::new(RwLock::new(agentConfig.last_active_channel.clone())),
            heartbeat_handle: None,
            heartbeat_wake_tx: None,
            heartbeat_config: None,
            current_model: Arc::new(RwLock::new(agentConfig.model.clone())),
            current_provider_env: Arc::new(RwLock::new(
                agentConfig.provider_env_json.as_ref()
                    .and_then(|s| serde_json::from_str(s).ok())
            )),
            permission_mode: Arc::new(RwLock::new(agentConfig.permission_mode.clone())),
            mcp_servers_json: Arc::new(RwLock::new(agentConfig.mcp_servers_json.clone())),
            memory_update_config: None,
            memory_update_running: None,
        }
    });

    // Set agent_link so the processing loop can update lastActiveChannel
    let link = AgentChannelLink {
        channel_id: channelId.clone(),
        agent_id: agentId.clone(),
        last_active_channel: Arc::clone(&agent_instance.last_active_channel),
    };
    *bot_instance.agent_link.write().await = Some(link);

    agent_instance.channels.insert(channelId.clone(), ChannelInstance {
        channel_id: channelId.clone(),
        bot_instance,
    });

    // Start agent-level heartbeat if not already running
    let needs_heartbeat = agent_instance.heartbeat_handle.is_none() && !agent_instance.channels.is_empty();
    if needs_heartbeat {
        let hb_config = agentConfig.heartbeat.clone().unwrap_or_default();
        let agent_id_hb = agentId.clone();
        let agent_label = agentConfig.name.clone();
        let agent_state_for_hb = Arc::clone(&*agentState);
        let (wake_tx, mut wake_rx) = mpsc::channel::<types::WakeReason>(64);
        let hb_config_arc = Arc::new(RwLock::new(hb_config));
        let hb_config_for_loop = Arc::clone(&hb_config_arc);

        let hb_handle = tokio::spawn(async move {
            use heartbeat::is_in_active_hours;

            let initial_interval = {
                let cfg = hb_config_for_loop.read().await;
                Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
            };
            let mut interval = tokio::time::interval(initial_interval);
            interval.tick().await; // skip first immediate tick

            ulog_info!(
                "[agent-heartbeat] Runner started for agent {} (interval={}min)",
                agent_label,
                initial_interval.as_secs() / 60
            );

            loop {
                {
                    let cfg = hb_config_for_loop.read().await;
                    let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                    if desired != interval.period() {
                        interval = tokio::time::interval(desired);
                        interval.tick().await;
                    }
                }

                let reason = tokio::select! {
                    _ = interval.tick() => types::WakeReason::Interval,
                    Some(reason) = wake_rx.recv() => {
                        let mut reasons = vec![reason];
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        while let Ok(r) = wake_rx.try_recv() {
                            reasons.push(r);
                        }
                        reasons.into_iter()
                            .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                            .unwrap_or(types::WakeReason::Interval)
                    }
                };

                let is_high_priority = reason.is_high_priority();

                let config = hb_config_for_loop.read().await.clone();
                if !config.enabled {
                    continue;
                }

                if !is_high_priority {
                    if let Some(ref active_hours) = config.active_hours {
                        if !is_in_active_hours(active_hours) {
                            continue;
                        }
                    }
                }

                // Clone refs from agent state, then drop the lock before async work
                let channel_snapshot = {
                    let agents_guard = agent_state_for_hb.lock().await;
                    let agent = match agents_guard.get(&agent_id_hb) {
                        Some(a) => a,
                        None => break,
                    };
                    let refs: Vec<_> = agent.channels.iter().map(|(ch_id, ch_inst)| {
                        (
                            ch_id.clone(),
                            Arc::clone(&ch_inst.bot_instance.health),
                            Arc::clone(&ch_inst.bot_instance.router),
                            ch_inst.bot_instance.heartbeat_wake_tx.clone(),
                            ch_inst.bot_instance.started_at,
                            ch_inst.bot_instance.config.platform.clone(),
                            ch_inst.bot_instance.config.name.clone(),
                            ch_inst.bot_instance.bind_code.clone(),
                        )
                    }).collect();
                    refs
                }; // agents_guard dropped here

                // Build channel statuses without holding the Mutex
                let mut statuses_map = HashMap::new();
                let mut wake_txs: HashMap<String, mpsc::Sender<types::WakeReason>> = HashMap::new();
                for (ch_id, health, router, wake_tx, started_at, platform, name, bind_code) in &channel_snapshot {
                    let health_state = health.get_state().await;
                    let active_sessions = router.lock().await.active_sessions();
                    statuses_map.insert(ch_id.clone(), ChannelStatus {
                        channel_id: ch_id.clone(),
                        channel_type: platform.clone(),
                        name: name.clone(),
                        status: health_state.status,
                        bot_username: health_state.bot_username,
                        uptime_seconds: started_at.elapsed().as_secs(),
                        last_message_at: health_state.last_message_at,
                        active_sessions,
                        error_message: health_state.error_message,
                        restart_count: health_state.restart_count,
                        buffered_messages: health_state.buffered_messages,
                        bind_url: None,
                        bind_code: Some(bind_code.clone()),
                    });
                    if let Some(tx) = wake_tx {
                        wake_txs.insert(ch_id.clone(), tx.clone());
                    }
                }

                // Re-acquire lock briefly to resolve target channel
                let target_ch_id = {
                    let agents_guard = agent_state_for_hb.lock().await;
                    match agents_guard.get(&agent_id_hb) {
                        Some(agent) => resolve_target_channel(agent, &statuses_map),
                        None => None,
                    }
                };
                let target_ch_id = match target_ch_id {
                    Some(id) => id,
                    None => continue,
                };

                // Delegate to the target channel's per-bot heartbeat wake_tx (no lock held)
                let delegated_reason = if reason.is_high_priority() {
                    reason
                } else {
                    types::WakeReason::Manual
                };
                if let Some(wake_tx) = wake_txs.get(&target_ch_id) {
                    let _ = wake_tx.send(delegated_reason).await;
                }

                if is_high_priority {
                    interval.reset();
                }
            }

            ulog_info!("[agent-heartbeat] Runner stopped for agent {}", agent_label);
        });

        agent_instance.heartbeat_handle = Some(hb_handle);
        agent_instance.heartbeat_wake_tx = Some(wake_tx);
        agent_instance.heartbeat_config = Some(hb_config_arc);
    }

    drop(agents_guard);

    // Convert ImBotStatus to ChannelStatus
    let channel_status = ChannelStatus {
        channel_id: channelId,
        channel_type: channelConfig.channel_type,
        name: channelConfig.name,
        status: bot_status.status,
        bot_username: bot_status.bot_username,
        uptime_seconds: bot_status.uptime_seconds,
        last_message_at: bot_status.last_message_at,
        active_sessions: bot_status.active_sessions,
        error_message: bot_status.error_message,
        restart_count: bot_status.restart_count,
        buffered_messages: bot_status.buffered_messages,
        bind_url: bot_status.bind_url,
        bind_code: bot_status.bind_code,
    };

    let _ = app_handle.emit("agent:status-changed", json!({ "agentId": agentId, "event": "channel_started" }));

    Ok(channel_status)
}

/// Stop a single channel within an agent.
/// Directly removes from ManagedAgents and shuts down — no transit through ManagedImBots.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_stop_agent_channel(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
    channelId: String,
) -> Result<(), String> {
    let bot_instance = {
        let mut agents_guard = agentState.lock().await;
        if let Some(agent) = agents_guard.get_mut(&agentId) {
            agent.channels.remove(&channelId).map(|ch| ch.bot_instance)
        } else {
            None
        }
    };

    if let Some(instance) = bot_instance {
        shutdown_bot_instance(instance, &sidecarManager, &channelId).await?;
    } else {
        ulog_debug!("[agent] Channel {} not found in agent {}", channelId, agentId);
    }

    let _ = app_handle.emit("agent:status-changed", json!({ "agentId": agentId, "event": "channel_stopped" }));
    Ok(())
}

/// Snapshot of channel refs needed for status collection (clone-then-drop pattern).
struct ChannelStatusRef {
    channel_id: String,
    channel_type: ImPlatform,
    name: Option<String>,
    health: Arc<HealthManager>,
    router: Arc<Mutex<SessionRouter>>,
    started_at: Instant,
    bind_code: String,
}

/// Collect channel status from pre-cloned refs (no Mutex held).
async fn collect_channel_statuses(refs: Vec<ChannelStatusRef>) -> Vec<ChannelStatus> {
    let mut out = Vec::with_capacity(refs.len());
    for r in refs {
        let health_state = r.health.get_state().await;
        let active_sessions = r.router.lock().await.active_sessions();
        out.push(ChannelStatus {
            channel_id: r.channel_id,
            channel_type: r.channel_type,
            name: r.name,
            status: health_state.status,
            bot_username: health_state.bot_username,
            uptime_seconds: r.started_at.elapsed().as_secs(),
            last_message_at: health_state.last_message_at,
            active_sessions,
            error_message: health_state.error_message,
            restart_count: health_state.restart_count,
            buffered_messages: health_state.buffered_messages,
            bind_url: None,
            bind_code: Some(r.bind_code),
        });
    }
    out
}

/// Get status for a single agent channel.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_agent_channel_status(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    channelId: String,
) -> Result<Option<ChannelStatus>, String> {
    let snapshot = {
        let agents_guard = agentState.lock().await;
        agents_guard.get(&agentId).and_then(|agent| {
            agent.channels.get(&channelId).map(|ch_inst| {
                ChannelStatusRef {
                    channel_id: channelId.clone(),
                    channel_type: ch_inst.bot_instance.config.platform.clone(),
                    name: ch_inst.bot_instance.config.name.clone(),
                    health: Arc::clone(&ch_inst.bot_instance.health),
                    router: Arc::clone(&ch_inst.bot_instance.router),
                    started_at: ch_inst.bot_instance.started_at,
                    bind_code: ch_inst.bot_instance.bind_code.clone(),
                }
            })
        })
    }; // agents_guard dropped

    if let Some(r) = snapshot {
        let statuses = collect_channel_statuses(vec![r]).await;
        Ok(statuses.into_iter().next())
    } else {
        Ok(None)
    }
}

/// Get status for a single agent (all channels).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_agent_status(
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
) -> Result<AgentStatus, String> {
    // Clone refs inside lock, then drop lock before any .await work
    let snapshot = {
        let agents_guard = agentState.lock().await;
        agents_guard.get(&agentId).map(|agent| {
            let ch_refs: Vec<ChannelStatusRef> = agent.channels.iter().map(|(ch_id, ch_inst)| {
                ChannelStatusRef {
                    channel_id: ch_id.clone(),
                    channel_type: ch_inst.bot_instance.config.platform.clone(),
                    name: ch_inst.bot_instance.config.name.clone(),
                    health: Arc::clone(&ch_inst.bot_instance.health),
                    router: Arc::clone(&ch_inst.bot_instance.router),
                    started_at: ch_inst.bot_instance.started_at,
                    bind_code: ch_inst.bot_instance.bind_code.clone(),
                }
            }).collect();
            (agent.agent_id.clone(), agent.config.name.clone(), agent.config.enabled, ch_refs)
        })
    }; // agents_guard dropped here

    if let Some((aid, aname, enabled, ch_refs)) = snapshot {
        let channels = collect_channel_statuses(ch_refs).await;
        Ok(AgentStatus { agent_id: aid, agent_name: aname, enabled, channels })
    } else {
        Ok(AgentStatus {
            agent_id: agentId,
            agent_name: String::new(),
            enabled: false,
            channels: Vec::new(),
        })
    }
}

/// Get status for all agents.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_all_agents_status(
    agentState: tauri::State<'_, ManagedAgents>,
) -> Result<HashMap<String, AgentStatus>, String> {
    // Clone refs inside lock, then drop lock before any .await work
    let snapshots: Vec<_> = {
        let agents_guard = agentState.lock().await;
        agents_guard.iter().map(|(agent_id, agent)| {
            let ch_refs: Vec<ChannelStatusRef> = agent.channels.iter().map(|(ch_id, ch_inst)| {
                ChannelStatusRef {
                    channel_id: ch_id.clone(),
                    channel_type: ch_inst.bot_instance.config.platform.clone(),
                    name: ch_inst.bot_instance.config.name.clone(),
                    health: Arc::clone(&ch_inst.bot_instance.health),
                    router: Arc::clone(&ch_inst.bot_instance.router),
                    started_at: ch_inst.bot_instance.started_at,
                    bind_code: ch_inst.bot_instance.bind_code.clone(),
                }
            }).collect();
            (agent_id.clone(), agent.agent_id.clone(), agent.config.name.clone(), agent.config.enabled, ch_refs)
        }).collect()
    }; // agents_guard dropped here

    let mut result = HashMap::new();
    for (key, aid, aname, enabled, ch_refs) in snapshots {
        let channels = collect_channel_statuses(ch_refs).await;
        result.insert(key, AgentStatus { agent_id: aid, agent_name: aname, enabled, channels });
    }
    Ok(result)
}

/// Update an agent's config (hot-reload where possible, persist to disk).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_update_agent_config(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    agentId: String,
    patch: AgentConfigPatch,
) -> Result<(), String> {
    // Hot-reload running instance if present (runtime only — disk persistence
    // is handled by the TypeScript patchAgentConfig service)
    let agents_guard = agentState.lock().await;
    if let Some(agent) = agents_guard.get(&agentId) {
        if let Some(ref model) = patch.model {
            *agent.current_model.write().await = Some(model.clone());
            for (_ch_id, ch_inst) in &agent.channels {
                *ch_inst.bot_instance.current_model.write().await = Some(model.clone());
            }
        }
        if let Some(ref env_json) = patch.provider_env_json {
            let parsed: Option<serde_json::Value> = if env_json.is_empty() {
                None
            } else {
                serde_json::from_str(env_json).ok()
            };
            *agent.current_provider_env.write().await = parsed.clone();
            for (_ch_id, ch_inst) in &agent.channels {
                *ch_inst.bot_instance.current_provider_env.write().await = parsed.clone();
            }
        }
        if let Some(ref pm) = patch.permission_mode {
            *agent.permission_mode.write().await = pm.clone();
            for (_ch_id, ch_inst) in &agent.channels {
                *ch_inst.bot_instance.permission_mode.write().await = pm.clone();
            }
        }
        if let Some(ref mcp) = patch.mcp_servers_json {
            *agent.mcp_servers_json.write().await = Some(mcp.clone());
            for (_ch_id, ch_inst) in &agent.channels {
                *ch_inst.bot_instance.mcp_servers_json.write().await = Some(mcp.clone());
            }
        }
        // Hot-reload heartbeat config
        if let Some(ref hb_json) = patch.heartbeat_config_json {
            if let Ok(hb_config) = serde_json::from_str::<types::HeartbeatConfig>(hb_json) {
                if let Some(ref hb_arc) = agent.heartbeat_config {
                    *hb_arc.write().await = hb_config;
                }
                // Wake the heartbeat runner so it picks up the new interval immediately
                // (otherwise it stays blocked on the old interval.tick())
                // Use try_send (non-async) to avoid holding the agents mutex across an await point
                if let Some(ref tx) = agent.heartbeat_wake_tx {
                    let _ = tx.try_send(types::WakeReason::Interval);
                }
            }
        }
        // Hot-reload memory auto-update config (v0.1.43)
        if let Some(ref mau_json) = patch.memory_auto_update_config_json {
            if let Some(ref mau_arc) = agent.memory_update_config {
                let parsed: Option<types::MemoryAutoUpdateConfig> = if mau_json.is_empty() {
                    None
                } else {
                    serde_json::from_str(mau_json).ok()
                };
                *mau_arc.write().await = parsed;
            }
        }

        // Hot-reload per-channel group settings when channels array is patched.
        // Frontend patchChannel() writes the full channels array to disk, then sends
        // the patch here for runtime sync. Match by channel ID to update the running instance.
        if let Some(ref channels) = patch.channels {
            for ch_config in channels {
                if let Some(ch_inst) = agent.channels.get(&ch_config.id) {
                    // groupActivation
                    if let Some(ref act) = ch_config.group_activation {
                        let activation = match act.as_str() {
                            "always" => GroupActivation::Always,
                            _ => GroupActivation::Mention,
                        };
                        *ch_inst.bot_instance.group_activation.write().await = activation;
                    }
                    // groupPermissions — always overwrite (the full channels array is sent,
                    // so empty Vec means "no permissions", not "field absent")
                    *ch_inst.bot_instance.group_permissions.write().await = ch_config.group_permissions.clone();
                }
            }
        }

        // Push config changes to all active Sidecar ports (same as legacy update_bot_config_internal)
        let parsed_provider_env: Option<serde_json::Value> = patch.provider_env_json.as_ref()
            .and_then(|s| if s.is_empty() { None } else { serde_json::from_str(s).ok() });
        for (_ch_id, ch_inst) in &agent.channels {
            let router = ch_inst.bot_instance.router.lock().await;
            let ports = router.active_sidecar_ports();
            if !ports.is_empty() {
                if patch.provider_env_json.is_some() {
                    for port in &ports {
                        if let Some(ref penv) = parsed_provider_env {
                            router.sync_ai_config(*port, None, None, Some(penv)).await;
                        } else {
                            // Clearing provider — POST null so Bun detects the change
                            let url = format!("http://127.0.0.1:{}/api/provider/set", *port);
                            match router.http_client().post(&url)
                                .json(&json!({ "providerEnv": null }))
                                .send().await
                            {
                                Ok(_) => ulog_info!("[im] Cleared provider env on port {}", port),
                                Err(e) => ulog_warn!("[im] Failed to clear provider env on port {}: {}", port, e),
                            }
                        }
                    }
                }
                if patch.model.is_some() {
                    for port in &ports {
                        router.sync_ai_config(*port, patch.model.as_deref(), None, None).await;
                    }
                }
                if patch.mcp_servers_json.is_some() {
                    for port in &ports {
                        router.sync_ai_config(*port, None, patch.mcp_servers_json.as_deref(), None).await;
                    }
                }
                if let Some(ref pm) = patch.permission_mode {
                    for port in &ports {
                        router.sync_permission_mode(*port, pm).await;
                    }
                }
            }
        }
    }
    drop(agents_guard);

    let _ = app_handle.emit("agent:config-changed", json!({}));
    Ok(())
}

/// Create a new agent config (persist to disk, no channels started).
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_create_agent(
    app_handle: AppHandle,
    config: AgentConfigRust,
) -> Result<String, String> {
    let agent_id = config.id.clone();

    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("[agent] Home dir not found")?;
        let config_path = home.join(".pm-copilot").join("config.json");
        let tmp_path = config_path.with_extension("json.tmp.rust");
        let bak_path = config_path.with_extension("json.bak");

        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("[agent] Cannot read config.json: {}", e))?;
        let mut app_config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("[agent] Cannot parse config.json: {}", e))?;

        let agents = app_config.get_mut("agents")
            .and_then(|v| v.as_array_mut());
        let agent_value = serde_json::to_value(&config)
            .map_err(|e| format!("[agent] Failed to serialize agent: {}", e))?;
        if let Some(arr) = agents {
            arr.push(agent_value);
        } else {
            app_config["agents"] = serde_json::json!([agent_value]);
        }

        let serialized = serde_json::to_string_pretty(&app_config)
            .map_err(|e| format!("[agent] Failed to serialize config: {}", e))?;
        std::fs::write(&tmp_path, &serialized)
            .map_err(|e| format!("[agent] Failed to write tmp: {}", e))?;
        if config_path.exists() {
            let _ = std::fs::copy(&config_path, &bak_path);
        }
        std::fs::rename(&tmp_path, &config_path)
            .map_err(|e| format!("[agent] Failed to rename: {}", e))?;

        Ok::<(), String>(())
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("agent:config-changed", json!({}));
    Ok(agent_id)
}

/// Delete an agent config from disk and stop all its channels.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_delete_agent(
    app_handle: AppHandle,
    agentState: tauri::State<'_, ManagedAgents>,
    sidecarManager: tauri::State<'_, ManagedSidecarManager>,
    agentId: String,
) -> Result<(), String> {
    // Stop all running channels directly via shutdown_bot_instance
    let channels = {
        let mut agents_guard = agentState.lock().await;
        if let Some(agent) = agents_guard.remove(&agentId) {
            agent.channels
        } else {
            HashMap::new()
        }
    }; // agents_guard dropped

    for (ch_id, ch_inst) in channels {
        let _ = shutdown_bot_instance(ch_inst.bot_instance, &sidecarManager, &ch_id).await;
    }

    // Remove from disk (config.json entry + agent data directory)
    let aid = agentId.clone();
    tokio::task::spawn_blocking(move || {
        let home = dirs::home_dir().ok_or("[agent] Home dir not found")?;
        let config_path = home.join(".pm-copilot").join("config.json");
        let tmp_path = config_path.with_extension("json.tmp.rust");
        let bak_path = config_path.with_extension("json.bak");

        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("[agent] Cannot read config.json: {}", e))?;
        let mut app_config: serde_json::Value = serde_json::from_str(&content)
            .map_err(|e| format!("[agent] Cannot parse config.json: {}", e))?;

        if let Some(agents) = app_config.get_mut("agents").and_then(|v| v.as_array_mut()) {
            agents.retain(|a| a.get("id").and_then(|v| v.as_str()) != Some(&aid));
        }

        let serialized = serde_json::to_string_pretty(&app_config)
            .map_err(|e| format!("[agent] Failed to serialize config: {}", e))?;
        std::fs::write(&tmp_path, &serialized)
            .map_err(|e| format!("[agent] Failed to write tmp: {}", e))?;
        if config_path.exists() {
            let _ = std::fs::copy(&config_path, &bak_path);
        }
        std::fs::rename(&tmp_path, &config_path)
            .map_err(|e| format!("[agent] Failed to rename: {}", e))?;

        // Clean up agent data directory (~/.pm-copilot/agents/{agentId}/)
        let agent_data_dir = home.join(".pm-copilot").join("agents").join(&aid);
        if agent_data_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&agent_data_dir) {
                log::warn!("[agent] Failed to remove agent data dir {:?}: {}", agent_data_dir, e);
            } else {
                log::info!("[agent] Removed agent data dir {:?}", agent_data_dir);
            }
        }

        Ok::<(), String>(())
    }).await.map_err(|e| format!("spawn_blocking: {}", e))??;

    let _ = app_handle.emit("agent:config-changed", json!({}));
    Ok(())
}
