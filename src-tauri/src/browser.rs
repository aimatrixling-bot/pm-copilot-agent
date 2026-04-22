// browser.rs — Embedded browser panel (Tauri Multi-Webview)
//
// Manages child Webview instances for in-app web browsing.
// Each Chat Tab can have one browser Webview. The Webview floats
// above the React DOM at OS level, positioned by frontend coordinates.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    webview::{PageLoadEvent, WebviewBuilder},
    LogicalPosition, LogicalSize, Url,
};

use std::path::Path;
use crate::ulog_info;

/// Parse a URL string that may be an absolute file path or an http(s) URL.
/// Handles both Unix (`/Users/...`) and Windows (`C:\Users\...`) paths.
fn parse_url_or_path(url: &str) -> Result<Url, String> {
    let path = Path::new(url);
    if path.is_absolute() {
        Url::from_file_path(path).map_err(|_| format!("Invalid file path: {}", url))
    } else {
        url.parse().map_err(|e| format!("Invalid URL: {e}"))
    }
}

/// Per-tab browser session.
struct BrowserSession {
    webview_label: String,
    #[allow(dead_code)]
    tab_id: String,
    visible: bool,
    /// Cache last-known position/size for show-after-hide restoration.
    last_x: f64,
    last_y: f64,
    last_width: f64,
    last_height: f64,
}

pub struct BrowserManager {
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

impl BrowserManager {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
        })
    }
}

// ──────────────────────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────────────────────

/// Create a child Webview for the given tab, positioned at (x, y) with (width, height).
#[tauri::command]
pub async fn cmd_browser_create(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("browser-{}", tab_id);

    ulog_info!(
        "[browser] cmd_browser_create: tab={} url={} pos=({},{}) size={}x{}",
        tab_id, url, x, y, width, height
    );

    // Prevent duplicate creation
    {
        let sessions = state.sessions.lock().await;
        if sessions.contains_key(&tab_id) {
            ulog_info!("[browser] Duplicate creation blocked for tab {}", tab_id);
            return Err(format!("Browser already exists for tab {}", tab_id));
        }
    }

    let parsed_url = parse_url_or_path(&url)?;

    // Clone values for closures
    let app_nav = app.clone();
    let tab_id_nav = tab_id.clone();
    let app_load = app.clone();
    let tab_id_load = tab_id.clone();
    let app_new_win = app.clone();
    let label_new_win = label.clone();

    let builder = WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url.clone()))
        .on_navigation(move |nav_url| {
            let scheme = nav_url.scheme();
            // Security: block dangerous schemes; allow everything else.
            // file: is allowed — used for local HTML preview; the webview is
            // already sandboxed (browser.json zero Tauri permissions).
            if scheme == "javascript" {
                ulog_info!("[browser] on_navigation BLOCKED: {} (scheme: {})", nav_url, scheme);
                return false;
            }
            // Emit URL changes for http/https/file (skip about:, data:, blob: noise)
            if scheme == "http" || scheme == "https" || scheme == "file" {
                ulog_info!("[browser] on_navigation ALLOW: {}", nav_url);
                let _ = app_nav.emit(
                    &format!("browser:url-changed:{}", tab_id_nav),
                    nav_url.to_string(),
                );
            } else {
                ulog_info!("[browser] on_navigation ALLOW (internal): {} (scheme: {})", nav_url, scheme);
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let url_str = payload.url().to_string();
            let event_name = format!("browser:loading:{}", tab_id_load);
            match payload.event() {
                PageLoadEvent::Started => {
                    ulog_info!("[browser] on_page_load STARTED: {}", url_str);
                    let _ = app_load.emit(&event_name, true);
                }
                PageLoadEvent::Finished => {
                    ulog_info!("[browser] on_page_load FINISHED: {}", url_str);
                    let _ = app_load.emit(&event_name, false);
                    // Emit final URL (may differ from navigation URL due to redirects)
                    if let Ok(final_url) = _webview.url() {
                        ulog_info!("[browser] Final URL after load: {}", final_url);
                        let _ = app_load.emit(
                            &format!("browser:url-changed:{}", tab_id_load),
                            final_url.to_string(),
                        );
                    }
                }
            }
        })
        .on_new_window(move |url, _features| {
            ulog_info!("[browser] on_new_window: {} — redirecting to current webview", url);
            // Redirect target="_blank" / window.open() into the current webview
            let app = app_new_win.clone();
            let lbl = label_new_win.clone();
            let nav_url = url.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(webview) = app.get_webview(&lbl) {
                    let _ = webview.navigate(nav_url);
                }
            });
            tauri::webview::NewWindowResponse::Deny
        });

    // Get the Window (not WebviewWindow) to add a child webview
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let position = LogicalPosition::new(x, y);
    let size = LogicalSize::new(width, height);

    ulog_info!("[browser] Calling window.add_child for label='{}' url={}", label, parsed_url);
    window
        .add_child(builder, position, size)
        .map_err(|e| {
            ulog_info!("[browser] add_child FAILED: {}", e);
            format!("Failed to create browser webview: {e}")
        })?;

    ulog_info!("[browser] add_child SUCCESS for label='{}'", label);

    // Verify webview is accessible
    if let Some(wv) = app.get_webview(&label) {
        match wv.url() {
            Ok(u) => ulog_info!("[browser] Webview current url: {}", u),
            Err(e) => ulog_info!("[browser] Webview url() error: {}", e),
        }
    } else {
        ulog_info!("[browser] WARNING: webview '{}' not found after add_child!", label);
    }

    // Store session
    let mut sessions = state.sessions.lock().await;
    sessions.insert(
        tab_id.clone(),
        BrowserSession {
            webview_label: label.clone(),
            tab_id: tab_id.clone(),
            visible: true,
            last_x: x,
            last_y: y,
            last_width: width,
            last_height: height,
        },
    );

    ulog_info!("[browser] Created webview '{}' for tab {} — session stored", label, tab_id);
    Ok(())
}

/// Navigate the existing browser webview to a new URL.
#[tauri::command]
pub async fn cmd_browser_navigate(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    ulog_info!("[browser] cmd_browser_navigate: tab={} url={}", tab_id, url);
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let parsed_url = parse_url_or_path(&url)?;
    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .navigate(parsed_url)
        .map_err(|e| format!("Navigation failed: {e}"))
}

/// Go back in browser history.
#[tauri::command]
pub async fn cmd_browser_go_back(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.back()")
        .map_err(|e| format!("Go back failed: {e}"))
}

/// Go forward in browser history.
#[tauri::command]
pub async fn cmd_browser_go_forward(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .eval("window.history.forward()")
        .map_err(|e| format!("Go forward failed: {e}"))
}

/// Reload the current page.
#[tauri::command]
pub async fn cmd_browser_reload(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    webview
        .reload()
        .map_err(|e| format!("Reload failed: {e}"))
}

/// Update webview position and size.
#[tauri::command]
pub async fn cmd_browser_resize(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    // Update cached position
    session.last_x = x;
    session.last_y = y;
    session.last_width = width;
    session.last_height = height;

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.set_position(LogicalPosition::new(x, y));
    let _ = webview.set_size(LogicalSize::new(width, height));
    Ok(())
}

/// Show the browser webview (restore from hidden state).
#[tauri::command]
pub async fn cmd_browser_show(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Restore position and show
    let _ = webview.set_position(LogicalPosition::new(session.last_x, session.last_y));
    let _ = webview.set_size(LogicalSize::new(session.last_width, session.last_height));
    let _ = webview.show();
    session.visible = true;
    ulog_info!("[browser] SHOW webview '{}' at ({},{}) {}x{}", session.webview_label, session.last_x, session.last_y, session.last_width, session.last_height);
    Ok(())
}

/// Hide the browser webview (move off-screen).
#[tauri::command]
pub async fn cmd_browser_hide(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions
        .get_mut(&tab_id)
        .ok_or_else(|| format!("No browser for tab {}", tab_id))?;

    if !session.visible {
        return Ok(());
    }

    let webview = app
        .get_webview(&session.webview_label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let _ = webview.hide();
    session.visible = false;
    ulog_info!("[browser] HIDE webview '{}'", session.webview_label);
    Ok(())
}

/// Destroy the browser webview for a tab.
#[tauri::command]
pub async fn cmd_browser_close(
    app: AppHandle,
    state: tauri::State<'_, Arc<BrowserManager>>,
    tab_id: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    if let Some(session) = sessions.remove(&tab_id) {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
        ulog_info!(
            "[browser] Closed webview '{}' for tab {}",
            session.webview_label,
            tab_id
        );
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────

/// Close all browser webviews (app exit cleanup).
pub async fn close_all_browsers(state: &Arc<BrowserManager>, app: &AppHandle) {
    let mut sessions = state.sessions.lock().await;
    let count = sessions.len();
    for (_tab_id, session) in sessions.drain() {
        if let Some(webview) = app.get_webview(&session.webview_label) {
            let _ = webview.close();
        }
    }
    if count > 0 {
        ulog_info!("[browser] Closed {} browser(s) on shutdown", count);
    }
}
