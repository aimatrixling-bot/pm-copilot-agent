// Heartbeat Runner for IM Bot
// Periodically checks a user-defined checklist and pushes results to IM.
// Supports active hours, instant wake (from cron completion), and dedup.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use chrono::Timelike;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tokio::sync::{mpsc, watch, Mutex, RwLock};

use crate::sidecar::ManagedSidecarManager;
use crate::{ulog_info, ulog_warn, ulog_debug};

use super::adapter::ImAdapter;
use super::router::{EnsureSidecarPrep, SessionRouter};
use super::types::{ActiveHours, HeartbeatConfig, WakeReason};
use super::{AnyAdapter, PeerLocks};

/// Response from Bun /api/im/heartbeat endpoint
#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    status: String,       // "silent" | "content" | "error"
    text: Option<String>,
    #[allow(dead_code)]
    reason: Option<String>,
}

/// Heartbeat prompt sent to Bun
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatRequest {
    prompt: String,
    source: String,
    source_id: String,
    ack_max_chars: u32,
    is_high_priority: bool,
}

/// HeartbeatRunner manages the periodic heartbeat loop for an IM Bot.
pub struct HeartbeatRunner {
    bot_label: String, // e.g. "feishu_mino" or "@mino115_bot" for log identification
    config: Arc<RwLock<HeartbeatConfig>>,
    last_push_text: Arc<Mutex<Option<String>>>,
    last_error_text: Arc<Mutex<Option<String>>>, // Last error from heartbeat for user notification
    http_client: reqwest::Client,
    executing: Arc<Mutex<bool>>,
    // Hot-reloadable config refs — needed to sync AI config when waking up an idle-collected sidecar
    current_model: Arc<RwLock<Option<String>>>,
    current_provider_env: Arc<RwLock<Option<serde_json::Value>>>,
    mcp_servers_json: Arc<RwLock<Option<String>>>,
    // Memory auto-update (v0.1.43)
    memory_update_config: Arc<RwLock<Option<super::types::MemoryAutoUpdateConfig>>>,
    memory_update_running: Arc<AtomicBool>,
}

impl HeartbeatRunner {
    /// Create a new HeartbeatRunner.
    /// Returns (runner, config_arc, mau_config_arc, mau_running_arc) — caller keeps arcs for hot-updating.
    pub fn new(
        config: HeartbeatConfig,
        bot_label: String,
        current_model: Arc<RwLock<Option<String>>>,
        current_provider_env: Arc<RwLock<Option<serde_json::Value>>>,
        mcp_servers_json: Arc<RwLock<Option<String>>>,
        memory_update_config: Option<super::types::MemoryAutoUpdateConfig>,
    ) -> (Self, Arc<RwLock<HeartbeatConfig>>, Arc<RwLock<Option<super::types::MemoryAutoUpdateConfig>>>, Arc<AtomicBool>) {
        let config = Arc::new(RwLock::new(config));
        let mau_config = Arc::new(RwLock::new(memory_update_config));
        let mau_running = Arc::new(AtomicBool::new(false));
        let runner = Self {
            bot_label,
            config: Arc::clone(&config),
            last_push_text: Arc::new(Mutex::new(None)),
            last_error_text: Arc::new(Mutex::new(None)),
            http_client: crate::local_http::json_client(Duration::from_secs(330)), // 5.5 min (heartbeat timeout is 5 min)
            executing: Arc::new(Mutex::new(false)),
            current_model,
            current_provider_env,
            mcp_servers_json,
            memory_update_config: Arc::clone(&mau_config),
            memory_update_running: Arc::clone(&mau_running),
        };
        (runner, config, mau_config, mau_running)
    }

    /// Main heartbeat loop. Runs until shutdown signal.
    pub(crate) async fn run_loop<R: Runtime>(
        self,
        mut shutdown_rx: watch::Receiver<bool>,
        mut wake_rx: mpsc::Receiver<WakeReason>,
        router: Arc<Mutex<SessionRouter>>,
        sidecar_manager: ManagedSidecarManager,
        adapter: Arc<AnyAdapter>,
        app_handle: AppHandle<R>,
        peer_locks: PeerLocks,
        agent_id: String,
        workspace_path: String,
    ) {
        let initial_interval = {
            let cfg = self.config.read().await;
            Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60)
        };
        let mut interval = tokio::time::interval(initial_interval);
        // Skip the first immediate tick
        interval.tick().await;

        ulog_info!(
            "[heartbeat] Runner started for {} (interval={}min)",
            self.bot_label,
            initial_interval.as_secs() / 60
        );

        let mut consecutive_errors: u32 = 0;
        let mut pause_notified = false;
        const MAX_CONSECUTIVE_ERRORS: u32 = 3;

        loop {
            // Check if interval needs updating
            {
                let cfg = self.config.read().await;
                let desired = Duration::from_secs(cfg.interval_minutes.max(5) as u64 * 60);
                if desired != interval.period() {
                    ulog_info!(
                        "[heartbeat] Interval changed to {}min",
                        desired.as_secs() / 60
                    );
                    interval = tokio::time::interval(desired);
                    interval.tick().await; // skip immediate tick
                    // Config changed — reset error counter to give the new config a chance
                    consecutive_errors = 0;
                    pause_notified = false;
                }
            }

            // Back off: if too many consecutive errors, skip this cycle to stop
            // injecting heartbeat prompts into a broken session (e.g. context overflow)
            if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                ulog_warn!(
                    "[heartbeat] {} consecutive errors for {}, pausing until config change or success",
                    consecutive_errors, self.bot_label
                );

                // Notify user via IM on first pause (not on every skipped tick)
                if !pause_notified {
                    pause_notified = true;
                    let notify_target = {
                        let rg = router.lock().await;
                        rg.find_any_peer_session()
                    };
                    if let Some((_session_key, _source, source_id)) = notify_target {
                        let error_detail = self.last_error_text.lock().await.take()
                            .map(|d| if d.len() > 200 { format!("{}...", &d[..200]) } else { d });
                        let msg = if let Some(detail) = error_detail {
                            format!(
                                "[PM Copilot] {} 心跳连续 {} 次失败，已暂停。\n\n错误: {}\n\n请在客户端重启该 Channel 或开始新对话以恢复。",
                                self.bot_label, MAX_CONSECUTIVE_ERRORS, detail
                            )
                        } else {
                            format!(
                                "[PM Copilot] {} 心跳连续 {} 次失败，已暂停。请在客户端重启该 Channel 或开始新对话以恢复。",
                                self.bot_label, MAX_CONSECUTIVE_ERRORS
                            )
                        };
                        if let Err(e) = adapter.send_message(&source_id, &msg).await {
                            ulog_warn!("[heartbeat] Failed to send pause notification: {}", e);
                        }
                    }
                }

                // Wait for either shutdown, wake signal (config change), or next interval
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() { break; }
                    }
                    Some(_) = wake_rx.recv() => {
                        // Config change or external wake — reset and retry
                        consecutive_errors = 0;
                        pause_notified = false;
                        ulog_info!("[heartbeat] {} resuming after wake signal", self.bot_label);
                        interval.reset();
                    }
                    _ = interval.tick() => {
                        // Still paused — skip this tick
                        continue;
                    }
                }
                continue;
            }

            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        ulog_info!("[heartbeat] Shutdown signal received, exiting");
                        break;
                    }
                }
                _ = interval.tick() => {
                    let ok = self.run_once(
                        WakeReason::Interval,
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                        &peer_locks,
                        &agent_id,
                        &workspace_path,
                    ).await;
                    if ok { consecutive_errors = 0; } else { consecutive_errors += 1; }
                }
                Some(reason) = wake_rx.recv() => {
                    // Coalesce: drain any additional wake signals within 250ms window
                    let mut reasons = vec![reason];
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    while let Ok(r) = wake_rx.try_recv() {
                        reasons.push(r);
                    }

                    // Use highest-priority reason
                    let best_reason = reasons.into_iter()
                        .max_by_key(|r| if r.is_high_priority() { 1 } else { 0 })
                        .unwrap_or(WakeReason::Interval);

                    let ok = self.run_once(
                        best_reason,
                        &router,
                        &sidecar_manager,
                        &adapter,
                        &app_handle,
                        &peer_locks,
                        &agent_id,
                        &workspace_path,
                    ).await;
                    if ok { consecutive_errors = 0; } else { consecutive_errors += 1; }

                    // Reset interval timer after wake to avoid rapid fire
                    interval.reset();
                }
            }
        }

        ulog_info!("[heartbeat] Runner stopped for {}", self.bot_label);
    }

    /// Execute a single heartbeat cycle.
    /// Returns `true` if the heartbeat was successful (AI responded), `false` on error/skip.
    /// Uses the same ensure_sidecar flow as user messages — if the sidecar was
    /// idle-collected, it will be automatically restarted.
    ///
    /// Acquires the per-peer lock for the target session_key before calling Sidecar
    /// HTTP APIs. This serializes heartbeat with user messages on the same Sidecar,
    /// preventing imStreamCallback conflicts that would cause lost responses or
    /// double "(No response)" messages.
    async fn run_once<R: Runtime>(
        &self,
        reason: WakeReason,
        router: &Arc<Mutex<SessionRouter>>,
        sidecar_manager: &ManagedSidecarManager,
        adapter: &Arc<AnyAdapter>,
        app_handle: &AppHandle<R>,
        peer_locks: &PeerLocks,
        agent_id: &str,
        workspace_path: &str,
    ) -> bool {
        let config = self.config.read().await.clone();
        let is_high_priority = reason.is_high_priority();

        // Gate 1: Enabled check (high-priority wakes bypass — agent-level heartbeat
        // sends delegated wakes to per-channel runners that have enabled=false)
        if !config.enabled && !is_high_priority {
            ulog_debug!("[heartbeat] Skipped: disabled");
            return true; // Gate skip is not a failure
        }

        // Gate 2: Active hours (high-priority wakes skip this)
        if !is_high_priority {
            if let Some(ref active_hours) = config.active_hours {
                if !is_in_active_hours(active_hours) {
                    ulog_debug!("[heartbeat] Skipped: outside active hours");
                    return true; // Gate skip is not a failure
                }
            }
        }

        // Gate 3: Concurrent execution guard
        // Both paths do check+set in a single lock acquisition to avoid TOCTOU races.
        if is_high_priority {
            // High priority (e.g. CronComplete): poll-wait for the lock to become free
            let start = std::time::Instant::now();
            loop {
                let mut executing = self.executing.lock().await;
                if !*executing {
                    *executing = true;
                    break;
                }
                drop(executing);
                if start.elapsed() > Duration::from_secs(60) {
                    ulog_warn!("[heartbeat] High-priority wake timed out waiting for concurrent execution");
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        } else {
            let mut executing = self.executing.lock().await;
            if *executing {
                ulog_debug!("[heartbeat] Skipped: previous heartbeat still executing");
                return true; // Gate skip is not a failure
            }
            *executing = true;
        }

        // Find any peer session (even if sidecar was idle-collected).
        // Unlike the old find_any_active_session which gave up when port=0,
        // we pick any session and let ensure_sidecar handle the wake-up.
        let (session_key, source, source_id) = {
            let router_guard = router.lock().await;
            match router_guard.find_any_peer_session() {
                Some(info) => info,
                None => {
                    // No peer sessions at all — no one has ever talked to this bot
                    ulog_debug!("[heartbeat] No peer sessions for {}, skipping", self.bot_label);
                    *self.executing.lock().await = false;
                    return true; // No peers is not a failure
                }
            }
        };

        // Acquire per-peer lock BEFORE any Sidecar I/O.
        // Lock ordering: peer_lock → router_lock (same as processing loop, no deadlock).
        // This ensures heartbeat and user messages to the same Sidecar are serialized,
        // preventing imStreamCallback from being overwritten while a response is in-flight.
        let peer_lock = {
            let mut locks = peer_locks.lock().await;
            locks
                .entry(session_key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _peer_guard = peer_lock.lock().await;

        ulog_debug!("[heartbeat] Acquired peer lock for {}", session_key);

        // Ensure sidecar is running — split into 3 phases to avoid holding router lock
        // during the blocking sidecar creation (up to 5 minutes).
        // Phase 1: Check health / extract info (brief lock)
        let prep = {
            let mut router_guard = router.lock().await;
            router_guard.prepare_ensure_sidecar(&session_key).await
        };

        let (port, is_new_sidecar) = match prep {
            EnsureSidecarPrep::Healthy(p) => (p, false),
            EnsureSidecarPrep::NeedCreate(info) => {
                // Phase 2: Create sidecar (NO lock held — blocking up to 5 min)
                match super::router::SessionRouter::create_sidecar_blocking(
                    info.clone(), app_handle, sidecar_manager,
                ).await {
                    Ok(port) => {
                        // Phase 3: Write result back (brief lock)
                        {
                            let mut router_guard = router.lock().await;
                            router_guard.commit_ensure_sidecar(&session_key, &info, port);
                        }
                        (port, true)
                    }
                    Err(e) => {
                        ulog_warn!("[heartbeat] Failed to ensure sidecar for {}: {}", self.bot_label, e);
                        *self.executing.lock().await = false;
                        return false;
                    }
                }
            }
        };

        // Sync AI config for newly created sidecar (same as user message flow).
        // Use brief lock to get http_client, then release — HTTP calls happen outside the lock.
        if is_new_sidecar {
            let model = self.current_model.read().await.clone();
            let penv = self.current_provider_env.read().await.clone();
            let mcp = self.mcp_servers_json.read().await.clone();
            let http_client = {
                let rg = router.lock().await;
                rg.http_client().clone()
            };
            super::router::SessionRouter::sync_ai_config_with_client(
                &http_client, port, model.as_deref(), mcp.as_deref(), penv.as_ref(),
            ).await;
            ulog_info!("[heartbeat] Woke up sidecar for {} on port {}", self.bot_label, port);
        }

        // Touch session activity BEFORE the HTTP call.
        // ensure_sidecar sets last_active when creating a new sidecar, but NOT when
        // returning an existing healthy one. We must touch here to prevent idle collection
        // even if the heartbeat HTTP call times out (which can take up to 5.5 minutes).
        {
            let mut router_guard = router.lock().await;
            router_guard.touch_session_activity(&session_key);
        }

        // Build heartbeat prompt — a FIXED template.
        // The actual checklist lives in HEARTBEAT.md in the workspace root.
        // AI reads the file itself via tool use; we don't inject file content here.
        // System events (cron completion, etc.) are appended by the Bun endpoint
        // via drainSystemEvents() to avoid duplication.
        let now_text = chrono::Local::now().format("%Y-%m-%d %H:%M (%Z)").to_string();
        let prompt = format!(
            "This is a heartbeat from the system.\n\
             Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.\n\
             Do not infer or repeat old tasks from prior chats.\n\
             If there is nothing that needs attention, reply exactly: HEARTBEAT_OK\n\
             If something needs attention, do NOT include \"HEARTBEAT_OK\"\n\
             \n\
             Current time: {}",
            now_text
        );

        let ack_max_chars = config.ack_max_chars.unwrap_or(300);

        // Call Bun heartbeat endpoint (peer_lock is held — no concurrent IM chat possible)
        let request = HeartbeatRequest {
            prompt,
            source: source.clone(),
            source_id: source_id.clone(),
            ack_max_chars,
            is_high_priority,
        };

        let url = format!("http://127.0.0.1:{}/api/im/heartbeat", port);
        ulog_debug!("[heartbeat] Calling {} (reason={:?})", url, reason_label(&reason));

        let result = match self.http_client.post(&url).json(&request).send().await {
            Ok(resp) => {
                let status_code = resp.status();
                // Read body as text first for diagnostic logging on parse failure
                let body_text = match resp.text().await {
                    Ok(t) => t,
                    Err(e) => {
                        ulog_warn!("[heartbeat] Failed to read response body: {} (status={})", e, status_code);
                        *self.last_error_text.lock().await = Some(format!("HTTP read error: {}", e));
                        *self.executing.lock().await = false;
                        return false;
                    }
                };
                match serde_json::from_str::<HeartbeatResponse>(&body_text) {
                    Ok(r) => r,
                    Err(e) => {
                        // Log truncated body for debugging (cap at 300 chars)
                        let preview = if body_text.len() > 300 { &body_text[..300] } else { &body_text };
                        ulog_warn!("[heartbeat] Failed to parse response: {} (status={}, body={})", e, status_code, preview);
                        *self.last_error_text.lock().await = Some(format!("Response parse error (status={})", status_code));
                        *self.executing.lock().await = false;
                        return false;
                    }
                }
            }
            Err(e) => {
                ulog_warn!("[heartbeat] HTTP call failed: {}", e);
                *self.last_error_text.lock().await = Some(format!("HTTP call failed: {}", e));
                *self.executing.lock().await = false;
                return false;
            }
        };

        // Handle response (still under peer_lock — IM message send is safe)
        let success = match result.status.as_str() {
            "silent" => {
                ulog_debug!("[heartbeat] AI responded HEARTBEAT_OK (silent)");
                true
            }
            "content" => {
                if let Some(text) = &result.text {
                    // Dedup check
                    let mut last_push = self.last_push_text.lock().await;
                    if last_push.as_deref() == Some(text.as_str()) {
                        ulog_debug!("[heartbeat] Dedup suppressed (same content as last push)");
                    } else {
                        ulog_info!("[heartbeat] Pushing content to IM (len={})", text.len());
                        if let Err(e) = adapter.send_message(&source_id, text).await {
                            ulog_warn!("[heartbeat] Failed to send IM message: {}", e);
                        }
                        *last_push = Some(text.clone());
                    }
                }
                true
            }
            "error" => {
                ulog_warn!("[heartbeat] Heartbeat returned error: {:?}", result.text);
                *self.last_error_text.lock().await = result.text.clone();
                false
            }
            other => {
                ulog_warn!("[heartbeat] Unknown status: {}", other);
                false
            }
        };

        // Release executing flag (peer_lock is dropped automatically when _peer_guard goes out of scope)
        *self.executing.lock().await = false;

        // Memory auto-update check (v0.1.43)
        // Lightweight check after heartbeat — spawns independent task if conditions met
        if success {
            super::memory_update::check_and_spawn(
                agent_id,
                workspace_path,
                &self.memory_update_config,
                &self.memory_update_running,
                sidecar_manager,
                app_handle,
                &self.current_model,
                &self.current_provider_env,
                &self.mcp_servers_json,
                {
                    let cfg = self.config.read().await;
                    cfg.active_hours.as_ref().map(|ah| ah.timezone.clone())
                }.as_deref(),
            ).await;
        }

        success
    }
}

/// Check if current time is within the active hours window.
pub fn is_in_active_hours(hours: &ActiveHours) -> bool {
    // Parse timezone
    let tz: chrono_tz::Tz = match hours.timezone.parse() {
        Ok(tz) => tz,
        Err(_) => {
            ulog_warn!("[heartbeat] Invalid timezone '{}', assuming active", hours.timezone);
            return true;
        }
    };

    let now = chrono::Utc::now().with_timezone(&tz);
    let now_minutes = now.hour() * 60 + now.minute();

    let start_minutes = parse_hhmm(&hours.start).unwrap_or(0);
    let end_minutes = parse_hhmm(&hours.end).unwrap_or(24 * 60);

    if start_minutes <= end_minutes {
        // Normal window: e.g. 09:00-22:00
        now_minutes >= start_minutes && now_minutes < end_minutes
    } else {
        // Cross-midnight window: e.g. 22:00-06:00
        now_minutes >= start_minutes || now_minutes < end_minutes
    }
}

/// Parse "HH:MM" to total minutes since midnight.
fn parse_hhmm(s: &str) -> Option<u32> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    Some(h * 60 + m)
}

fn reason_label(reason: &WakeReason) -> &str {
    match reason {
        WakeReason::Interval => "interval",
        WakeReason::CronComplete { .. } => "cron_complete",
        WakeReason::Manual => "manual",
    }
}
