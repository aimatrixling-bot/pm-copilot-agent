// IM Bot integration types (Rust side)

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Instant;

/// Partial update patch for IM Bot config.
/// Each `None` field means "no change"; `Some("")` means "clear the field".
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotConfigPatch {
    pub model: Option<String>,
    pub provider_id: Option<String>,
    pub provider_env_json: Option<String>,
    pub permission_mode: Option<String>,
    /// Complete MCP server definitions JSON (pushed to Sidecar at runtime, also persisted for auto-start)
    pub mcp_servers_json: Option<String>,
    /// Enabled MCP server ID list (persisted to imBotConfigs)
    pub mcp_enabled_servers: Option<Vec<String>>,
    pub allowed_users: Option<Vec<String>>,
    pub default_workspace_path: Option<String>,
    pub heartbeat_config_json: Option<String>,
    pub name: Option<String>,
    pub bot_token: Option<String>,
    pub feishu_app_id: Option<String>,
    pub feishu_app_secret: Option<String>,
    // ===== DingTalk-specific credentials =====
    pub dingtalk_client_id: Option<String>,
    pub dingtalk_client_secret: Option<String>,
    pub dingtalk_use_ai_card: Option<bool>,
    pub dingtalk_card_template_id: Option<String>,
    // ===== Telegram-specific options =====
    pub telegram_use_draft: Option<bool>,
    pub enabled: Option<bool>,
    pub setup_completed: Option<bool>,
    pub group_permissions: Option<Vec<GroupPermission>>,
    pub group_activation: Option<String>,
    pub group_tools_deny: Option<Vec<String>>,
    // ===== OpenClaw Channel Plugin =====
    pub openclaw_plugin_config: Option<serde_json::Value>,
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,
}

/// IM platform type
#[derive(Debug, Clone, PartialEq)]
pub enum ImPlatform {
    Telegram,
    Feishu,
    Dingtalk,
    /// OpenClaw channel plugin (String = channel ID, e.g. "qqbot")
    OpenClaw(String),
}

impl Serialize for ImPlatform {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Telegram => serializer.serialize_str("telegram"),
            Self::Feishu => serializer.serialize_str("feishu"),
            Self::Dingtalk => serializer.serialize_str("dingtalk"),
            Self::OpenClaw(id) => serializer.serialize_str(&format!("openclaw:{}", id)),
        }
    }
}

impl<'de> Deserialize<'de> for ImPlatform {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "telegram" => Ok(Self::Telegram),
            "feishu" => Ok(Self::Feishu),
            "dingtalk" => Ok(Self::Dingtalk),
            other if other.starts_with("openclaw:") => {
                let channel_id = other.strip_prefix("openclaw:").unwrap_or("").to_string();
                if channel_id.is_empty() {
                    Err(serde::de::Error::custom("openclaw: missing channel ID"))
                } else {
                    Ok(Self::OpenClaw(channel_id))
                }
            }
            _ => Err(serde::de::Error::unknown_variant(&s, &["telegram", "feishu", "dingtalk", "openclaw:<id>"])),
        }
    }
}

impl std::fmt::Display for ImPlatform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Telegram => write!(f, "telegram"),
            Self::Feishu => write!(f, "feishu"),
            Self::Dingtalk => write!(f, "dingtalk"),
            Self::OpenClaw(id) => write!(f, "openclaw:{}", id),
        }
    }
}

/// IM Bot operational status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImStatus {
    Online,
    Connecting,
    Error,
    Stopped,
}

/// IM source type (private chat vs group)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ImSourceType {
    Private,
    Group,
}

/// Group permission status
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GroupPermissionStatus {
    Pending,
    Approved,
}

/// Group chat permission record
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPermission {
    pub group_id: String,
    pub group_name: String,
    pub platform: ImPlatform,
    pub status: GroupPermissionStatus,
    pub discovered_at: String,
    pub added_by: Option<String>,
}

/// Group activation mode (when bot responds in groups)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GroupActivation {
    /// Only respond when @mentioned, replied-to, or /ask
    Mention,
    /// Respond to all messages (with NO_REPLY option)
    Always,
}

impl Default for GroupActivation {
    fn default() -> Self {
        Self::Mention
    }
}

/// Group lifecycle events from platform adapters
#[derive(Debug, Clone)]
pub enum GroupEvent {
    BotAdded {
        chat_id: String,
        chat_title: String,
        platform: ImPlatform,
        added_by_name: Option<String>,
    },
    BotRemoved {
        chat_id: String,
        platform: ImPlatform,
    },
}

/// Media type classification for outbound file sending
#[derive(Debug, Clone, PartialEq)]
pub enum MediaType {
    /// Image formats: jpg, jpeg, png, gif, webp, bmp, svg
    Image,
    /// Document/media formats: pdf, doc(x), xls(x), ppt(x), mp4, mp3, ogg, wav, zip, csv, json, xml, html
    File,
    /// Code and other non-media files: ts, js, py, rs, etc. — not sent as media
    NonMedia,
}

impl MediaType {
    /// Classify a file extension into a media type for outbound sending.
    pub fn from_extension(ext: &str) -> Self {
        match ext.to_lowercase().as_str() {
            // Images
            "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "svg" => Self::Image,
            // Documents & media files
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
            | "mp4" | "mp3" | "ogg" | "wav" | "avi" | "mov" | "mkv"
            | "zip" | "rar" | "7z" | "tar" | "gz"
            | "csv" | "json" | "xml" | "html" | "txt" => Self::File,
            // Everything else (code files, etc.)
            _ => Self::NonMedia,
        }
    }

    /// Check if a file extension is a sendable media type (Image or File).
    pub fn is_media_extension(ext: &str) -> bool {
        !matches!(Self::from_extension(ext), Self::NonMedia)
    }
}

/// Attachment type determines processing path
#[derive(Debug, Clone)]
pub enum ImAttachmentType {
    /// SDK Vision (base64 image content block) — photo, static sticker
    Image,
    /// Copy to workspace + @path reference — voice, audio, video, document
    File,
}

/// Media attachment downloaded from Telegram
#[derive(Debug, Clone)]
pub struct ImAttachment {
    pub file_name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
    pub attachment_type: ImAttachmentType,
}

/// Incoming IM message (from adapter)
#[derive(Debug, Clone)]
pub struct ImMessage {
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
    pub platform: ImPlatform,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub attachments: Vec<ImAttachment>,
    pub media_group_id: Option<String>,
    /// Whether this message triggers bot response (@mention, /ask, reply-to-bot)
    pub is_mention: bool,
    /// Whether this is specifically a reply to bot's message
    pub reply_to_bot: bool,
    /// Human-readable group name hint (from Bridge plugins; native adapters resolve via API)
    pub hint_group_name: Option<String>,
    /// Quoted reply body (for threaded replies from Bridge plugins)
    pub reply_to_body: Option<String>,
    /// Group-level custom system prompt (from Bridge plugin config)
    pub group_system_prompt: Option<String>,
}

impl ImMessage {
    /// Canonical session key for routing (single source of truth for the format).
    pub fn session_key(&self) -> String {
        let source = match self.source_type {
            ImSourceType::Private => "private",
            ImSourceType::Group => "group",
        };
        format!("im:{}:{}:{}", self.platform, source, self.chat_id)
    }
}

/// IM Bot configuration (from frontend settings)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConfig {
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    #[serde(default)]
    pub name: Option<String>,
    pub bot_token: String,
    pub allowed_users: Vec<String>,
    pub permission_mode: String,
    pub default_workspace_path: Option<String>,
    pub enabled: bool,
    // ===== Feishu-specific credentials =====
    #[serde(default)]
    pub feishu_app_id: Option<String>,
    #[serde(default)]
    pub feishu_app_secret: Option<String>,
    // ===== DingTalk-specific credentials =====
    #[serde(default)]
    pub dingtalk_client_id: Option<String>,
    #[serde(default)]
    pub dingtalk_client_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_use_ai_card: Option<bool>,
    #[serde(default)]
    pub dingtalk_card_template_id: Option<String>,
    // ===== Telegram-specific options =====
    #[serde(default)]
    pub telegram_use_draft: Option<bool>,
    // ===== AI config =====
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default)]
    pub mcp_servers_json: Option<String>,
    // ===== Heartbeat (v0.1.21) =====
    #[serde(default)]
    pub heartbeat_config: Option<HeartbeatConfig>,
    // ===== Group Chat (v0.1.28) =====
    #[serde(default)]
    pub group_permissions: Vec<GroupPermission>,
    #[serde(default)]
    pub group_activation: Option<String>,
    #[serde(default)]
    pub group_tools_deny: Vec<String>,
    // ===== OpenClaw Channel Plugin =====
    #[serde(default)]
    pub openclaw_plugin_id: Option<String>,
    #[serde(default)]
    pub openclaw_npm_spec: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_config: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,
}

fn default_platform() -> ImPlatform {
    ImPlatform::Telegram
}

impl Default for ImConfig {
    fn default() -> Self {
        Self {
            platform: ImPlatform::Telegram,
            name: None,
            bot_token: String::new(),
            allowed_users: Vec::new(),
            permission_mode: "plan".to_string(),
            default_workspace_path: None,
            enabled: false,
            feishu_app_id: None,
            feishu_app_secret: None,
            dingtalk_client_id: None,
            dingtalk_client_secret: None,
            dingtalk_use_ai_card: None,
            dingtalk_card_template_id: None,
            telegram_use_draft: None,
            provider_id: None,
            model: None,
            provider_env_json: None,
            mcp_servers_json: None,
            heartbeat_config: None,
            group_permissions: Vec::new(),
            group_activation: None,
            group_tools_deny: Vec::new(),
            openclaw_plugin_id: None,
            openclaw_npm_spec: None,
            openclaw_plugin_config: None,
            openclaw_enabled_tool_groups: None,
        }
    }
}

/// Active session info for status display
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImActiveSession {
    pub session_key: String,
    pub session_id: String,
    pub source_type: ImSourceType,
    pub workspace_path: String,
    pub message_count: u32,
    pub last_active: String,
}

/// IM Bot runtime status (returned to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImBotStatus {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    /// Deep link URL for QR code (e.g. https://t.me/BotName?start=BIND_xxxx)
    pub bind_url: Option<String>,
    /// Plain bind code for platforms without deep links (e.g. Feishu)
    pub bind_code: Option<String>,
}

impl Default for ImBotStatus {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            bind_url: None,
            bind_code: None,
        }
    }
}

/// IM conversation summary (for listing in Desktop UI)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImConversation {
    pub session_id: String,
    pub session_key: String,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub workspace_path: String,
    pub message_count: u32,
    pub last_active: String,
}

/// Per-peer session tracking in SessionRouter
#[derive(Debug)]
pub struct PeerSession {
    pub session_key: String,
    pub session_id: String,
    pub sidecar_port: u16,
    pub workspace_path: PathBuf,
    pub source_type: ImSourceType,
    pub source_id: String,
    pub message_count: u32,
    pub last_active: Instant,
}

/// Buffered message (when Sidecar is unavailable)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BufferedMessage {
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub sender_id: String,
    pub sender_name: Option<String>,
    pub source_type: ImSourceType,
    #[serde(default = "default_platform")]
    pub platform: ImPlatform,
    pub timestamp: String,
    pub retry_count: u32,
    /// Cached session key for efficient pop_for_session matching
    #[serde(default)]
    pub session_key: String,
    /// Whether this message triggers bot response (@mention, /ask, reply-to-bot)
    #[serde(default)]
    pub is_mention: bool,
    /// Whether this is specifically a reply to bot's message
    #[serde(default)]
    pub reply_to_bot: bool,
    /// Human-readable group name hint (from Bridge plugins; native adapters resolve via API)
    #[serde(default)]
    pub hint_group_name: Option<String>,
    /// Quoted reply body (for threaded replies from Bridge plugins)
    #[serde(default)]
    pub reply_to_body: Option<String>,
    /// Group-level custom system prompt (from Bridge plugin config)
    #[serde(default)]
    pub group_system_prompt: Option<String>,
}

impl BufferedMessage {
    pub fn from_im_message(msg: &ImMessage) -> Self {
        Self {
            session_key: msg.session_key(),
            chat_id: msg.chat_id.clone(),
            message_id: msg.message_id.clone(),
            text: msg.text.clone(),
            sender_id: msg.sender_id.clone(),
            sender_name: msg.sender_name.clone(),
            source_type: msg.source_type.clone(),
            platform: msg.platform.clone(),
            timestamp: msg.timestamp.to_rfc3339(),
            retry_count: 0,
            is_mention: msg.is_mention,
            reply_to_bot: msg.reply_to_bot,
            hint_group_name: msg.hint_group_name.clone(),
            reply_to_body: msg.reply_to_body.clone(),
            group_system_prompt: msg.group_system_prompt.clone(),
        }
    }

    /// Convert back to ImMessage for route_message() replay.
    /// Note: attachments are lost (binary data too large for JSON serialization).
    pub fn to_im_message(&self) -> ImMessage {
        ImMessage {
            chat_id: self.chat_id.clone(),
            message_id: self.message_id.clone(),
            text: self.text.clone(),
            sender_id: self.sender_id.clone(),
            sender_name: self.sender_name.clone(),
            source_type: self.source_type.clone(),
            platform: self.platform.clone(),
            timestamp: chrono::DateTime::parse_from_rfc3339(&self.timestamp)
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| chrono::Utc::now()),
            attachments: Vec::new(),
            media_group_id: None,
            is_mention: self.is_mention,
            reply_to_bot: self.reply_to_bot,
            hint_group_name: self.hint_group_name.clone(),
            reply_to_body: self.reply_to_body.clone(),
            group_system_prompt: self.group_system_prompt.clone(),
        }
    }
}

/// Persistent message buffer (serializable for disk persistence)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBufferData {
    pub messages: VecDeque<BufferedMessage>,
}

impl Default for MessageBufferData {
    fn default() -> Self {
        Self {
            messages: VecDeque::new(),
        }
    }
}

/// Health state for persistence (written to im_state.json)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImHealthState {
    pub bot_username: Option<String>,
    pub status: ImStatus,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub last_persisted: String,
}

impl Default for ImHealthState {
    fn default() -> Self {
        Self {
            bot_username: None,
            status: ImStatus::Stopped,
            uptime_seconds: 0,
            last_message_at: None,
            active_sessions: Vec::new(),
            error_message: None,
            restart_count: 0,
            buffered_messages: 0,
            last_persisted: chrono::Utc::now().to_rfc3339(),
        }
    }
}

// ===== Heartbeat types (v0.1.21) =====

/// Heartbeat configuration for periodic autonomous checks.
/// The actual checklist content lives in HEARTBEAT.md in the workspace root,
/// not in this config — the config only controls timing and behavior.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatConfig {
    /// Enable/disable heartbeat (default: true)
    #[serde(default = "default_hb_enabled")]
    pub enabled: bool,
    /// Interval in minutes between checks (default: 30, min: 5)
    #[serde(default = "default_hb_interval")]
    pub interval_minutes: u32,
    /// Active hours window
    #[serde(default)]
    pub active_hours: Option<ActiveHours>,
    /// Max chars for HEARTBEAT_OK detection (default: 300)
    #[serde(default)]
    pub ack_max_chars: Option<u32>,
}

fn default_hb_enabled() -> bool {
    true
}

fn default_hb_interval() -> u32 {
    30
}

impl Default for HeartbeatConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_minutes: 30,
            active_hours: None,
            ack_max_chars: None,
        }
    }
}

/// Active hours window for heartbeat scheduling
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveHours {
    /// Start time in HH:MM format (inclusive)
    pub start: String,
    /// End time in HH:MM format (exclusive)
    pub end: String,
    /// IANA timezone name (e.g. "Asia/Shanghai")
    pub timezone: String,
}

// ===== Memory Auto-Update types (v0.1.43) =====

/// Memory auto-update configuration for periodic memory maintenance.
/// The actual update instructions live in UPDATE_MEMORY.md in the workspace root.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAutoUpdateConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_mau_interval")]
    pub interval_hours: u32,
    #[serde(default = "default_mau_threshold")]
    pub query_threshold: u32,
    #[serde(default = "default_mau_window_start")]
    pub update_window_start: String,
    #[serde(default = "default_mau_window_end")]
    pub update_window_end: String,
    #[serde(default)]
    pub update_window_timezone: Option<String>,
    #[serde(default)]
    pub last_batch_at: Option<String>,
    #[serde(default)]
    pub last_batch_session_count: Option<u32>,
}

fn default_mau_interval() -> u32 { 24 }
fn default_mau_threshold() -> u32 { 5 }
fn default_mau_window_start() -> String { "00:00".to_string() }
fn default_mau_window_end() -> String { "06:00".to_string() }

impl Default for MemoryAutoUpdateConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: 24,
            query_threshold: 5,
            update_window_start: "00:00".to_string(),
            update_window_end: "06:00".to_string(),
            update_window_timezone: None,
            last_batch_at: None,
            last_batch_session_count: None,
        }
    }
}

/// Reason for heartbeat wake-up
#[derive(Debug, Clone)]
pub enum WakeReason {
    /// Regular interval tick
    Interval,
    /// Cron task completed — high priority, skips active hours check
    CronComplete { task_id: String, summary: String },
    /// Manual/external trigger — high priority
    Manual,
}

impl WakeReason {
    /// High-priority wakes skip active hours and empty-prompt checks
    pub fn is_high_priority(&self) -> bool {
        !matches!(self, WakeReason::Interval)
    }
}

/// Telegram API error types
#[derive(Debug)]
pub enum TelegramError {
    /// Network timeout during API call
    NetworkTimeout,
    /// Rate limited by Telegram (retry after N seconds)
    RateLimited(u64),
    /// Markdown parsing failed (should retry as plain text)
    MarkdownParseError,
    /// Message content didn't change (safe to ignore)
    MessageNotModified,
    /// Message exceeds 4096 char limit
    MessageTooLong,
    /// Group thread no longer exists
    ThreadNotFound,
    /// Bot was kicked from group
    BotKicked,
    /// Bot token is invalid
    TokenUnauthorized,
    /// sendMessageDraft not supported for this peer/chat type
    DraftPeerInvalid,
    /// Other API error
    Other(String),
}

impl std::fmt::Display for TelegramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NetworkTimeout => write!(f, "Network timeout"),
            Self::RateLimited(secs) => write!(f, "Rate limited, retry after {}s", secs),
            Self::MarkdownParseError => write!(f, "Markdown parse error"),
            Self::MessageNotModified => write!(f, "Message not modified"),
            Self::MessageTooLong => write!(f, "Message too long"),
            Self::ThreadNotFound => write!(f, "Thread not found"),
            Self::BotKicked => write!(f, "Bot kicked from group"),
            Self::TokenUnauthorized => write!(f, "Token unauthorized"),
            Self::DraftPeerInvalid => write!(f, "Draft peer invalid"),
            Self::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for TelegramError {}

// ===== Agent Architecture types (v0.1.41) =====

/// Channel-level config overrides (None = inherit from Agent)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelOverrides {
    pub provider_id: Option<String>,
    pub provider_env_json: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub tools_deny: Option<Vec<String>>,
}

/// Channel configuration within an Agent
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfigRust {
    pub id: String,
    #[serde(rename = "type")]
    pub channel_type: ImPlatform,
    #[serde(default)]
    pub name: Option<String>,
    pub enabled: bool,

    // Platform credentials
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub telegram_use_draft: Option<bool>,
    #[serde(default)]
    pub feishu_app_id: Option<String>,
    #[serde(default)]
    pub feishu_app_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_client_id: Option<String>,
    #[serde(default)]
    pub dingtalk_client_secret: Option<String>,
    #[serde(default)]
    pub dingtalk_use_ai_card: Option<bool>,
    #[serde(default)]
    pub dingtalk_card_template_id: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_id: Option<String>,
    #[serde(default)]
    pub openclaw_npm_spec: Option<String>,
    #[serde(default)]
    pub openclaw_plugin_config: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub openclaw_enabled_tool_groups: Option<Vec<String>>,

    // User management
    #[serde(default)]
    pub allowed_users: Vec<String>,

    // Group chat
    #[serde(default)]
    pub group_permissions: Vec<GroupPermission>,
    #[serde(default)]
    pub group_activation: Option<String>,

    // Overrides
    #[serde(default)]
    pub overrides: Option<ChannelOverrides>,

    // Legacy root-level AI fields (written by /provider command before v0.1.45 bc06386 fix).
    // Only used as fallback in to_im_config when overrides + agent are both missing.
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    provider_env_json: Option<String>,
    #[serde(default)]
    model: Option<String>,

    #[serde(default)]
    pub setup_completed: Option<bool>,
}

/// Last active channel tracking for heartbeat/cron routing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastActiveChannel {
    pub channel_id: String,
    pub session_key: String,
    pub last_active_at: String,
}

/// Agent configuration (read from config.json agents[])
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigRust {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    pub enabled: bool,

    pub workspace_path: String,

    // AI config (Agent-level defaults)
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider_env_json: Option<String>,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    #[serde(default)]
    pub mcp_enabled_servers: Option<Vec<String>>,
    /// Complete MCP server definitions JSON (persisted for auto-start, rebuilt on manual start)
    #[serde(default)]
    pub mcp_servers_json: Option<String>,

    // Heartbeat (Agent-level)
    #[serde(default)]
    pub heartbeat: Option<HeartbeatConfig>,

    // Memory auto-update (v0.1.43)
    #[serde(default)]
    pub memory_auto_update: Option<MemoryAutoUpdateConfig>,

    // Channels
    #[serde(default)]
    pub channels: Vec<ChannelConfigRust>,

    // Active message routing
    #[serde(default)]
    pub last_active_channel: Option<LastActiveChannel>,

    // Agent Runtime (v0.1.59) — 'builtin' | 'claude-code' | 'codex'
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub runtime_config: Option<serde_json::Value>,

    #[serde(default)]
    pub setup_completed: Option<bool>,
}

fn default_permission_mode() -> String {
    "plan".to_string()
}

/// Agent-level status (aggregates all channel statuses)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent_id: String,
    pub agent_name: String,
    pub enabled: bool,
    pub channels: Vec<ChannelStatus>,
}

/// Per-channel runtime status
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    pub channel_id: String,
    pub channel_type: ImPlatform,
    pub name: Option<String>,
    pub status: ImStatus,
    pub bot_username: Option<String>,
    pub uptime_seconds: u64,
    pub last_message_at: Option<String>,
    pub active_sessions: Vec<ImActiveSession>,
    pub error_message: Option<String>,
    pub restart_count: u32,
    pub buffered_messages: usize,
    pub bind_url: Option<String>,
    pub bind_code: Option<String>,
}

impl ChannelConfigRust {
    /// Convert to ImConfig for backward compatibility with existing start_im_bot logic.
    pub fn to_im_config(&self, agent: &AgentConfigRust) -> ImConfig {
        let overrides = self.overrides.as_ref();
        ImConfig {
            platform: self.channel_type.clone(),
            // For OpenClaw channels, self.name is the npm package name (e.g., "larksuite/openclaw-lark")
            // which is meaningless as a bot display name. Prefer agent name in that case.
            name: if self.channel_type.to_string().starts_with("openclaw:") {
                Some(agent.name.clone())
            } else {
                self.name.clone().or_else(|| Some(agent.name.clone()))
            },
            bot_token: self.bot_token.clone().unwrap_or_default(),
            allowed_users: self.allowed_users.clone(),
            permission_mode: overrides.and_then(|o| o.permission_mode.clone()).unwrap_or_else(|| agent.permission_mode.clone()),
            default_workspace_path: Some(agent.workspace_path.clone()),
            enabled: self.enabled && agent.enabled,
            feishu_app_id: self.feishu_app_id.clone(),
            feishu_app_secret: self.feishu_app_secret.clone(),
            dingtalk_client_id: self.dingtalk_client_id.clone(),
            dingtalk_client_secret: self.dingtalk_client_secret.clone(),
            dingtalk_use_ai_card: self.dingtalk_use_ai_card,
            dingtalk_card_template_id: self.dingtalk_card_template_id.clone(),
            telegram_use_draft: self.telegram_use_draft,
            // Fallback chain: overrides → channel root (legacy pre-v0.1.45) → agent default
            // Channel root has higher priority than agent default because the user explicitly
            // chose a provider for this specific channel via /provider command (written to root
            // by persist_bot_config_patch before the bc06386 fix moved writes to overrides).
            provider_id: overrides.and_then(|o| o.provider_id.clone())
                .or_else(|| self.provider_id.clone())
                .or_else(|| agent.provider_id.clone()),
            model: overrides.and_then(|o| o.model.clone())
                .or_else(|| self.model.clone())
                .or_else(|| agent.model.clone()),
            provider_env_json: overrides.and_then(|o| o.provider_env_json.clone())
                .or_else(|| self.provider_env_json.clone())
                .or_else(|| agent.provider_env_json.clone()),
            mcp_servers_json: agent.mcp_servers_json.clone(),
            heartbeat_config: agent.heartbeat.clone(),
            group_permissions: self.group_permissions.clone(),
            group_activation: self.group_activation.clone(),
            group_tools_deny: overrides.and_then(|o| o.tools_deny.clone()).unwrap_or_default(),
            openclaw_plugin_id: self.openclaw_plugin_id.clone(),
            openclaw_npm_spec: self.openclaw_npm_spec.clone(),
            openclaw_plugin_config: self.openclaw_plugin_config.clone(),
            openclaw_enabled_tool_groups: self.openclaw_enabled_tool_groups.clone(),
        }
    }
}

/// Partial update patch for Agent config (used by cmd_update_agent_config)
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPatch {
    pub name: Option<String>,
    pub icon: Option<String>,
    pub enabled: Option<bool>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub provider_env_json: Option<String>,
    pub permission_mode: Option<String>,
    pub mcp_enabled_servers: Option<Vec<String>>,
    pub mcp_servers_json: Option<String>,
    pub heartbeat_config_json: Option<String>,
    pub memory_auto_update_config_json: Option<String>,
    pub channels: Option<Vec<ChannelConfigRust>>,
    pub setup_completed: Option<bool>,
}
