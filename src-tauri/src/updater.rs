// PM Copilot Auto-Updater Module
// Provides silent background update checking, downloading, and installation
//
// Flow:
// 1. App starts → wait 5s → check for update
// 2. If update available → silently download in background (user unaware)
// 3. Download complete → emit event to show "Restart to Update" button in titlebar
// 4. User clicks button → restart and apply update
// 5. Or next app launch → update is automatically applied
//
// Windows-specific:
// - download_and_install() launches NSIS installer which exit(0)s the process
// - To avoid closing the app without consent, we split download/install:
//   download() saves bytes to disk, install() only runs on user action
// - On next startup, check_pending_update detects saved bytes and prompts user

use crate::logger;
use crate::proxy_config;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// Global flag to prevent concurrent update checks/downloads
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Metadata persisted to disk alongside the update binary
#[cfg(target_os = "windows")]
#[derive(Serialize, serde::Deserialize)]
struct PendingUpdateMeta {
    version: String,
}

/// Get the ~/.pm-copilot/ directory path
#[cfg(target_os = "windows")]
fn get_pm_copilot_dir() -> Result<std::path::PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
    Ok(home.join(".pm-copilot"))
}

/// Atomically save pending update bytes + metadata to disk
/// Writes to .tmp first, then renames to avoid partial files
#[cfg(target_os = "windows")]
fn save_pending_update_to_disk(version: &str, bytes: &[u8]) -> Result<(), String> {
    let dir = get_pm_copilot_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;

    let bin_path = dir.join("pending_update.bin");
    let bin_tmp = dir.join("pending_update.bin.tmp");
    let meta_path = dir.join("pending_update.json");

    // Write binary atomically: tmp → rename
    std::fs::write(&bin_tmp, bytes)
        .map_err(|e| format!("Failed to write update binary: {}", e))?;
    std::fs::rename(&bin_tmp, &bin_path)
        .map_err(|e| format!("Failed to rename update binary: {}", e))?;

    // Write metadata
    let meta = PendingUpdateMeta { version: version.to_string() };
    let json = serde_json::to_string(&meta)
        .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
    std::fs::write(&meta_path, json)
        .map_err(|e| format!("Failed to write metadata: {}", e))?;

    Ok(())
}

/// Remove pending update files from disk
#[cfg(target_os = "windows")]
fn clear_pending_update_from_disk() {
    if let Ok(dir) = get_pm_copilot_dir() {
        let _ = std::fs::remove_file(dir.join("pending_update.bin"));
        let _ = std::fs::remove_file(dir.join("pending_update.bin.tmp"));
        let _ = std::fs::remove_file(dir.join("pending_update.json"));
    }
}

/// Read the version of the pending update from disk metadata (None if not present or corrupt)
#[cfg(target_os = "windows")]
fn read_pending_update_version() -> Option<String> {
    let dir = get_pm_copilot_dir().ok()?;
    let meta_path = dir.join("pending_update.json");
    let bin_path = dir.join("pending_update.bin");
    if !meta_path.exists() || !bin_path.exists() {
        return None;
    }
    let json = std::fs::read_to_string(&meta_path).ok()?;
    let meta: PendingUpdateMeta = serde_json::from_str(&json).ok()?;
    Some(meta.version)
}

/// RAII guard to reset UPDATE_IN_PROGRESS on drop
struct UpdateGuard;

impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Update information sent to the frontend (only when download is complete)
#[derive(Clone, Serialize)]
pub struct UpdateReadyInfo {
    pub version: String,
}

/// Download progress sent to the frontend during download
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    /// Bytes downloaded so far
    pub downloaded: u64,
    /// Total file size (None if server didn't provide Content-Length)
    pub total: Option<u64>,
    /// Progress percentage 0-100 (None if total is unknown)
    pub percent: Option<u32>,
}

/// Build an updater with user's proxy configuration applied.
/// Reads proxy settings from ~/.pm-copilot/config.json:
/// - Proxy enabled → `.proxy(url)`
/// - No proxy configured → inherit system network behavior (respect system proxy)
fn build_updater_with_proxy(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let target = get_update_target();
    let mut builder = app.updater_builder().target(target.to_string());

    if let Some(proxy_settings) = proxy_config::read_proxy_settings() {
        let proxy_url = proxy_config::get_proxy_url(&proxy_settings)?;
        log::info!("[Updater] Using proxy for update requests: {}", proxy_url);
        let url = reqwest::Url::parse(&proxy_url)
            .map_err(|e| format!("Invalid proxy URL '{}': {}", proxy_url, e))?;
        builder = builder.proxy(url);
    } else {
        log::info!("[Updater] No proxy configured, inheriting system network behavior");
        // Don't call .no_proxy() — let the updater respect system proxy settings
        // (Clash TUN, global proxy, etc.) just like other normal applications.
    }

    builder.build().map_err(|e| format!("Failed to build updater: {}", e))
}

/// Check for updates on startup and silently download if available
/// This is the main entry point called from setup hook
pub async fn check_update_on_startup(app: AppHandle) {
    // Wait 5 seconds before checking to let the app fully initialize
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;

    logger::info(&app, "[Updater] Starting background update check...");

    // Check and download silently
    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!("[Updater] Update v{} downloaded and ready to install", version),
            );
            // Only notify frontend when download is complete
            let info = UpdateReadyInfo {
                version: version.clone(),
            };
            logger::info(&app, "[Updater] Emitting 'updater:ready-to-restart' event to frontend...");
            match app.emit("updater:ready-to-restart", info) {
                Ok(_) => {
                    logger::info(&app, format!("[Updater] Event emitted successfully for v{}", version));
                }
                Err(e) => {
                    logger::error(&app, format!("[Updater] Failed to emit ready event: {}", e));
                }
            }
        }
        Ok(None) => {
            logger::info(&app, "[Updater] No update available, already on latest version");
        }
        Err(e) => {
            logger::error(&app, format!("[Updater] Background update failed: {}", e));
        }
    }
}

/// Silently check for updates and download if available
/// Returns the version string if an update was downloaded, None if no update
/// Protected against concurrent calls
async fn check_and_download_silently(app: &AppHandle) -> Result<Option<String>, String> {
    // Prevent concurrent update checks
    if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        logger::info(app, "[Updater] Update check already in progress, skipping");
        return Ok(None);
    }

    // RAII guard ensures flag is reset even if function panics/errors
    let _guard = UpdateGuard;

    // Get platform target (e.g., "darwin-aarch64", "darwin-x86_64")
    let target = get_update_target();
    let current_version = app.package_info().version.to_string();

    // Build updater with user's proxy configuration
    let updater = build_updater_with_proxy(app)?;
    logger::info(
        app,
        format!(
            "[Updater] Checking for updates... Current: v{}, Target: {}, Endpoint: https://aimatrixling-bot.github.io/pm-copilot-agent/update/{}.json",
            current_version, target, target
        ),
    );

    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            logger::info(app, "[Updater] Server returned no update (current version is latest or newer)");
            return Ok(None);
        }
        Err(e) => {
            // Log the full error details
            let error_debug = format!("{:?}", e);
            let error_display = format!("{}", e);
            logger::error(
                app,
                format!(
                    "[Updater] Check failed!\n  Display: {}\n  Debug: {}\n  Note: Use 'Test Update Connectivity' in Settings > About > Developer for detailed diagnostics",
                    error_display, error_debug
                ),
            );
            return Err(format!("Update check failed: {}", e));
        }
    };

    let version = update.version.clone();
    logger::info(
        app,
        format!("[Updater] Found update v{}, starting silent download...", version),
    );

    // Download with progress events to frontend
    let app_clone = app.clone();
    let downloaded = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last_emitted_percent = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let downloaded_clone = downloaded.clone();
    let last_emitted_clone = last_emitted_percent.clone();

    let on_chunk = move |chunk_length: usize, content_length: Option<u64>| {
        let new_downloaded = downloaded_clone.fetch_add(
            chunk_length as u64,
            std::sync::atomic::Ordering::SeqCst,
        ) + chunk_length as u64;

        if let Some(total) = content_length.filter(|&t| t > 0) {
            let percent = ((new_downloaded as f64 / total as f64 * 100.0) as u32).min(100);
            let last = last_emitted_clone.load(std::sync::atomic::Ordering::SeqCst);

            // Emit event every 2% and log every 25%
            if percent >= last + 2 || (percent == 100 && last != 100) {
                last_emitted_clone.store(percent, std::sync::atomic::Ordering::SeqCst);

                let _ = app_clone.emit("updater:download-progress", DownloadProgress {
                    downloaded: new_downloaded,
                    total: Some(total),
                    percent: Some(percent),
                });

                // Log at 25% intervals (less verbose)
                if percent / 25 > last / 25 {
                    logger::info(
                        &app_clone,
                        format!("[Updater] Download progress: {}%", percent),
                    );
                }
            }
        } else {
            // No Content-Length: emit byte count every 5MB
            let mb = new_downloaded / (5 * 1024 * 1024);
            let prev_mb = (new_downloaded - chunk_length as u64) / (5 * 1024 * 1024);
            if mb > prev_mb {
                let _ = app_clone.emit("updater:download-progress", DownloadProgress {
                    downloaded: new_downloaded,
                    total: None,
                    percent: None,
                });
            }
        }
    };

    // Windows: download only (don't install) to avoid NSIS killing the process
    // macOS: download_and_install is safe because .app replacement doesn't affect running process
    #[cfg(target_os = "windows")]
    {
        // Skip download if we already have this version cached on disk
        if let Some(cached_version) = read_pending_update_version() {
            if cached_version == version {
                logger::info(
                    app,
                    format!("[Updater] Windows: v{} already cached on disk, skipping re-download", version),
                );
                return Ok(Some(version));
            }
        }

        let bytes = update
            .download(on_chunk, || {})
            .await
            .map_err(|e| format!("Silent download failed: {}", e))?;

        logger::info(
            app,
            format!("[Updater] Windows: Downloaded {} bytes for v{}, saving to disk...", bytes.len(), version),
        );

        // Save to disk — install_pending_update will read from here
        if let Err(e) = save_pending_update_to_disk(&version, &bytes) {
            logger::error(app, format!("[Updater] Failed to save update to disk: {}", e));
            return Err(format!("Failed to persist update: {}", e));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        update
            .download_and_install(on_chunk, || {})
            .await
            .map_err(|e| format!("Silent download failed: {}", e))?;
    }

    Ok(Some(version))
}

/// Command: Manual check and silent download (for periodic checks from frontend)
/// Returns true if an update was downloaded and is ready
#[tauri::command]
pub async fn check_and_download_update(app: AppHandle) -> Result<bool, String> {
    logger::info(&app, "[Updater] Manual update check requested");

    match check_and_download_silently(&app).await {
        Ok(Some(version)) => {
            logger::info(
                &app,
                format!("[Updater] Update v{} downloaded and ready", version),
            );
            // Notify frontend
            let info = UpdateReadyInfo {
                version: version.clone(),
            };
            if let Err(e) = app.emit("updater:ready-to-restart", info) {
                logger::error(&app, format!("[Updater] Failed to emit event: {}", e));
            }
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Command: Restart the application to apply the update
/// Note: This function never returns as app.restart() terminates the process
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    logger::info(&app, "[Updater] Restarting application to apply update...");
    app.restart();
}

/// Command: Check if a pending update exists on disk (for Windows startup prompt)
/// Returns the version string if a pending update is ready, None otherwise
#[tauri::command]
pub fn check_pending_update() -> Option<String> {
    #[cfg(not(target_os = "windows"))]
    {
        return None;
    }

    #[cfg(target_os = "windows")]
    {
        match read_pending_update_version() {
            Some(version) => Some(version),
            None => {
                // If metadata is corrupt/missing but bin exists, clean up
                clear_pending_update_from_disk();
                None
            }
        }
    }
}

/// Command: Install a previously downloaded update (Windows only)
/// Reads bytes from disk, verifies version matches server, then calls update.install()
/// which launches NSIS + exit(0). Requires network to obtain Update object for install().
#[tauri::command]
pub async fn install_pending_update(app: AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        return Err("install_pending_update is only supported on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        logger::info(&app, "[Updater] install_pending_update called");

        // Step 1: Read update bytes and version from disk
        let dir = get_pm_copilot_dir()?;
        let bin_path = dir.join("pending_update.bin");
        let meta_path = dir.join("pending_update.json");

        let bytes = std::fs::read(&bin_path)
            .map_err(|e| format!("Failed to read pending update from disk: {}", e))?;

        let json = std::fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read pending update metadata: {}", e))?;
        let meta: PendingUpdateMeta = serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse pending update metadata: {}", e))?;
        let pending_version = meta.version;

        logger::info(
            &app,
            format!("[Updater] Read {} bytes for v{} from disk", bytes.len(), pending_version),
        );

        // Step 2: Build updater and check for latest version to get Update object
        // Note: This requires network. If offline, the user will need to connect first.
        let updater = build_updater_with_proxy(&app)?;

        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                // Server says no update available — our cached bytes are stale
                logger::info(&app, "[Updater] No update available from server, clearing stale pending update");
                clear_pending_update_from_disk();
                return Err("VERSION_MISMATCH".to_string());
            }
            Err(e) => {
                logger::error(
                    &app,
                    format!("[Updater] Cannot verify update (network required): {}", e),
                );
                return Err("NETWORK_ERROR".to_string());
            }
        };

        // Step 3: Version match check — if server has newer version than our cached bytes, discard
        if update.version != pending_version {
            logger::info(
                &app,
                format!(
                    "[Updater] Version mismatch: pending={}, server={}. Clearing stale update.",
                    pending_version, update.version
                ),
            );
            clear_pending_update_from_disk();
            return Err("VERSION_MISMATCH".to_string());
        }

        // Step 4: Install — on Windows this launches NSIS installer and calls exit(0)
        // This function will NOT return on success
        logger::info(&app, format!("[Updater] Installing v{}...", pending_version));
        clear_pending_update_from_disk();
        update
            .install(bytes)
            .map_err(|e| format!("Installation failed: {}", e))?;

        // If we get here (unlikely on Windows), the install completed without exit
        Ok(())
    }
}

/// Expected JSON structure for Tauri v2 updater (per-platform file)
/// Reference: https://v2.tauri.app/plugin/updater/
/// Required fields: version, signature, url
/// Optional fields: notes, pub_date
#[derive(Clone, Serialize, serde::Deserialize, Debug)]
struct UpdateJsonFormat {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    pub_date: Option<String>,
    signature: String,
    url: String,
}

/// Get the update target string for the current platform
/// Supports macOS (ARM/Intel) and Windows (x64/ARM)
fn get_update_target() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-aarch64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "windows-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { "windows-aarch64" }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
    )))]
    { "unknown" }
}

/// Command: Test HTTP connectivity to update server (diagnostic)
/// This bypasses tauri-plugin-updater to test raw HTTP connectivity
#[tauri::command]
pub async fn test_update_connectivity(app: AppHandle) -> Result<String, String> {
    // Detect architecture
    let target = get_update_target();

    let url = format!("https://aimatrixling-bot.github.io/pm-copilot-agent/update/{}.json", target);
    logger::info(&app, format!("[Updater] Testing HTTP connectivity to: {}", url));

    // Build a reqwest client with user's proxy configuration
    let current_version = app.package_info().version.to_string();
    let builder = reqwest::Client::builder()
        .user_agent(format!("PM Copilot-Updater/{}", current_version))
        .timeout(std::time::Duration::from_secs(30));

    let client = proxy_config::build_client_with_proxy(builder)
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // Make the request
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            let error_msg = format!(
                "HTTP request failed: {} (is_connect: {}, is_timeout: {}, is_request: {})",
                e,
                e.is_connect(),
                e.is_timeout(),
                e.is_request()
            );
            logger::error(&app, format!("[Updater] {}", error_msg));
            error_msg
        })?;

    let status = response.status();
    let headers = response.headers().clone();

    logger::info(&app, format!("[Updater] Response status: {}", status));

    // Try to get the body
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    // Try to parse as expected JSON format
    let json_parse_result = match serde_json::from_str::<UpdateJsonFormat>(&body) {
        Ok(parsed) => {
            format!(
                "✓ JSON valid!\n  version: {}\n  url: {}\n  signature length: {} chars",
                parsed.version,
                parsed.url,
                parsed.signature.len()
            )
        }
        Err(e) => format!("✗ JSON parse error: {}", e),
    };

    let result = format!(
        "=== Update Connectivity Test ===\n\
         URL: {}\n\
         Target: {}\n\
         Status: {}\n\
         Content-Type: {:?}\n\
         Body length: {} bytes\n\
         \n\
         === JSON Validation ===\n\
         {}\n\
         \n\
         === Raw Body ===\n\
         {}",
        url,
        target,
        status,
        headers.get("content-type"),
        body.len(),
        json_parse_result,
        if body.len() > 800 { &body[..800] } else { &body }
    );

    logger::info(&app, format!("[Updater] Test result:\n{}", result));

    Ok(result)
}
