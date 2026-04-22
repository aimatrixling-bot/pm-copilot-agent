// Unified logger for Rust - sends logs to frontend AND persists to file
//
// Two usage modes:
//
// 1. With explicit AppHandle (original):
//      emit_log!(app, LogLevel::Info, "Message {}", arg);
//
// 2. Via global handle (no AppHandle needed — for IM module etc.):
//      ulog_info!("[feishu] Connected");
//      ulog_warn!("[im] Timeout: {}", err);
//
// Features:
// - Sends to frontend via "log:rust" Tauri event
// - Persists to ~/.pm-copilot/logs/unified-{YYYY-MM-DD}.log
// - Same format as Bun's UnifiedLogger

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Runtime};

/// Log level enum
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
    Debug,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
            LogLevel::Debug => "DEBUG",
        }
    }
}

/// Log entry sent to frontend
#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub source: &'static str,
    pub level: LogLevel,
    pub message: String,
    pub timestamp: String,
}

/// Get logs directory path (~/.pm-copilot/logs/)
fn get_logs_dir() -> PathBuf {
    static LOGS_DIR: OnceLock<PathBuf> = OnceLock::new();
    LOGS_DIR
        .get_or_init(|| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            home.join(".pm-copilot").join("logs")
        })
        .clone()
}

/// Ensure logs directory exists
fn ensure_logs_dir() -> std::io::Result<()> {
    let logs_dir = get_logs_dir();
    if !logs_dir.exists() {
        fs::create_dir_all(&logs_dir)?;
    }
    Ok(())
}

/// Get today's unified log file path
fn get_log_file_path() -> PathBuf {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    get_logs_dir().join(format!("unified-{}.log", today))
}

/// Append log entry to unified log file
fn persist_log(entry: &LogEntry) {
    if let Err(e) = ensure_logs_dir() {
        log::error!("Failed to create logs directory: {}", e);
        return;
    }

    let path = get_log_file_path();
    let line = format!(
        "{} [RUST ] [{}] {}\n",
        entry.timestamp,
        entry.level.as_str(),
        entry.message
    );

    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()) {
                log::error!("Failed to write to log file: {}", e);
            }
        }
        Err(e) => {
            log::error!("Failed to open log file: {}", e);
        }
    }
}

/// Create a log entry with current timestamp
pub fn create_log_entry(level: LogLevel, message: String) -> LogEntry {
    LogEntry {
        source: "rust",
        level,
        message,
        timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
    }
}

/// Send a log entry to the frontend and persist to file
pub fn emit_log<R: Runtime>(app: &AppHandle<R>, level: LogLevel, message: String) {
    let entry = create_log_entry(level, message.clone());

    // 1. Log to Rust's log system (stdout)
    match level {
        LogLevel::Info => log::info!("{}", message),
        LogLevel::Warn => log::warn!("{}", message),
        LogLevel::Error => log::error!("{}", message),
        LogLevel::Debug => log::debug!("{}", message),
    }

    // 2. Persist to unified log file
    persist_log(&entry);

    // 3. Send to frontend for UI display
    if let Err(e) = app.emit("log:rust", &entry) {
        log::error!("Failed to emit log to frontend: {}", e);
    }
}

/// Macro for convenient logging with format strings (requires AppHandle)
#[macro_export]
macro_rules! emit_log {
    ($app:expr, $level:expr, $($arg:tt)*) => {{
        $crate::logger::emit_log($app, $level, format!($($arg)*));
    }};
}

/// Convenience functions (require AppHandle)
pub fn info<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Info, message.into());
}

pub fn warn<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Warn, message.into());
}

pub fn error<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Error, message.into());
}

pub fn debug<R: Runtime>(app: &AppHandle<R>, message: impl Into<String>) {
    emit_log(app, LogLevel::Debug, message.into());
}

// ── Global AppHandle for modules without direct access ──────────────

/// Global AppHandle stored at app startup.
/// Enables unified logging from any Rust module without threading AppHandle through every struct.
static GLOBAL_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Initialize the global AppHandle. Call once during app setup.
pub fn init_app_handle(app: AppHandle) {
    if GLOBAL_APP_HANDLE.set(app).is_err() {
        log::warn!("Global AppHandle already initialized");
    }
}

/// Retrieve the global AppHandle (returns None if not yet initialized).
pub fn get_app_handle() -> Option<&'static AppHandle> {
    GLOBAL_APP_HANDLE.get()
}

/// Log via the global AppHandle — writes to stdout, unified log file, and frontend.
/// Falls back to stdout-only if called before init_app_handle().
pub fn unified_log(level: LogLevel, message: String) {
    if let Some(app) = GLOBAL_APP_HANDLE.get() {
        emit_log(app, level, message);
    } else {
        // Fallback: stdout + file only (no frontend event)
        match level {
            LogLevel::Info => log::info!("{}", message),
            LogLevel::Warn => log::warn!("{}", message),
            LogLevel::Error => log::error!("{}", message),
            LogLevel::Debug => log::debug!("{}", message),
        }
        let entry = create_log_entry(level, message);
        persist_log(&entry);
    }
}

/// Global unified log macros — no AppHandle needed.
/// Usage: ulog_info!("[module] message {}", arg);
#[macro_export]
macro_rules! ulog_info {
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Info, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_warn {
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Warn, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_error {
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Error, format!($($arg)*));
    }};
}

#[macro_export]
macro_rules! ulog_debug {
    ($($arg:tt)*) => {{
        $crate::logger::unified_log($crate::logger::LogLevel::Debug, format!($($arg)*));
    }};
}
