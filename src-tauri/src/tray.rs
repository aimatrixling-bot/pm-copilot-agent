// System tray implementation for PM Copilot
// Provides minimize-to-tray functionality and right-click menu

use serde::Deserialize;
use std::fs;
use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{MenuBuilder, MenuItemBuilder},
    Emitter, Manager, Runtime,
};
#[cfg(target_os = "macos")]
use tauri::image::Image;

/// Menu item IDs for tray right-click menu
const MENU_OPEN: &str = "open";
const MENU_SETTINGS: &str = "settings";
const MENU_EXIT: &str = "exit";

/// Initialize the system tray with icon and menu
pub fn setup_tray<R: Runtime>(app: &tauri::App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Build the tray menu
    let open_item = MenuItemBuilder::with_id(MENU_OPEN, "打开 PM Copilot").build(app)?;
    let settings_item = MenuItemBuilder::with_id(MENU_SETTINGS, "设置").build(app)?;
    let exit_item = MenuItemBuilder::with_id(MENU_EXIT, "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&settings_item)
        .separator()
        .item(&exit_item)
        .build()?;

    // Load tray icon - use template icon on macOS for proper menu bar appearance
    #[cfg(target_os = "macos")]
    let tray_icon = {
        // Load template icon from embedded bytes (22x22 for best menu bar appearance)
        let icon_bytes = include_bytes!("../icons/trayIconTemplate@2x.png");
        Image::from_bytes(icon_bytes).unwrap_or_else(|_| {
            log::warn!("[Tray] Failed to load template icon, using default");
            app.default_window_icon().unwrap().clone()
        })
    };

    #[cfg(not(target_os = "macos"))]
    let tray_icon = app.default_window_icon().unwrap().clone();

    // Build the tray icon
    let tray_builder = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .tooltip("PM Copilot")
        .show_menu_on_left_click(false);

    // On macOS, mark as template image so system can adjust colors for light/dark mode
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);

    let _tray = tray_builder
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                MENU_OPEN => {
                    log::info!("[Tray] Open menu clicked");
                    show_main_window(app);
                }
                MENU_SETTINGS => {
                    log::info!("[Tray] Settings menu clicked");
                    show_main_window(app);
                    // Emit event to navigate to settings
                    if let Err(e) = app.emit("tray:open-settings", ()) {
                        log::error!("[Tray] Failed to emit settings event: {}", e);
                    }
                }
                MENU_EXIT => {
                    log::info!("[Tray] Exit menu clicked");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click on tray icon shows the window
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                log::info!("[Tray] Tray icon left-clicked");
                let app = tray.app_handle();
                show_main_window(app);
            }
        })
        .build(app)?;

    log::info!("[Tray] System tray initialized successfully");
    Ok(())
}

/// Show the main window (and focus it)
fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Hide the main window to tray (called when close button is clicked)
#[allow(dead_code)]
pub fn hide_to_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    if let Some(window) = app.get_webview_window("main") {
        log::info!("[Tray] Hiding window to tray");
        let _ = window.hide();
        return true;
    }
    false
}

/// Partial app config for reading minimize to tray setting
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    minimize_to_tray: Option<bool>,
}

/// Check if minimize to tray is enabled
/// Reads from ~/.pm-copilot/config.json, defaults to false if not configured
#[allow(dead_code)]
pub fn should_minimize_to_tray() -> bool {
    // Try to read from user config
    if let Some(home) = dirs::home_dir() {
        let config_path = home.join(".pm-copilot").join("config.json");

        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<PartialAppConfig>(&content) {
                if let Some(minimize) = config.minimize_to_tray {
                    log::debug!("[Tray] minimizeToTray from config: {}", minimize);
                    return minimize;
                }
            }
        }
    }

    // Default to false (close app instead of minimize to tray)
    log::debug!("[Tray] minimizeToTray not configured, using default: false");
    false
}
