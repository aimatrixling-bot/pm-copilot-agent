// PM Copilot Tauri Application
// Main entry point with sidecar lifecycle management

pub mod app_dirs;
pub mod cli;
mod commands;
pub mod cron_task;
pub mod im;
pub mod local_http;
pub mod logger;
pub mod management_api;
pub mod process_cmd;
mod proxy_config;
pub mod system_binary;
mod sidecar;
mod sse_proxy;
pub mod terminal;
pub mod browser;
mod tray;
mod updater;

use sidecar::{
    cleanup_stale_sidecars, create_sidecar_state, stop_all_sidecars,
    // Session activation commands (for Session singleton tracking)
    cmd_get_session_activation, cmd_activate_session, cmd_deactivate_session,
    cmd_update_session_tab,
    // Cron task execution command
    cmd_execute_cron_task,
    // Session-centric Sidecar API (v0.1.11)
    cmd_ensure_session_sidecar, cmd_release_session_sidecar, cmd_get_session_port,
    cmd_upgrade_session_id, cmd_session_has_persistent_owners,
    // Background session completion
    cmd_start_background_completion, cmd_cancel_background_completion,
    cmd_get_background_sessions,
    // Proxy hot-reload
    cmd_propagate_proxy,
};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;

/// Check if CLI arguments indicate CLI mode (delegates to cli module).
pub fn is_cli_mode(args: &[String]) -> bool {
    cli::is_cli_mode(args)
}

/// Run in CLI mode — forward args to the Bun CLI script and return exit code.
pub fn run_cli(args: &[String]) -> i32 {
    cli::run(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NOTE: cleanup_stale_sidecars() was moved into .setup() callback below.
    // This ensures it only runs for the PRIMARY app instance, not when a second
    // instance is launched (which would kill the running app's sidecar processes).
    // The single-instance plugin exits the second process before .setup() is called.

    // Create managed sidecar state (now supports multiple instances)
    let sidecar_state = create_sidecar_state();

    // Create IM Bot managed state
    let im_bot_state = im::create_im_bot_state();
    // Create Agent managed state (v0.1.41)
    let agent_state = im::create_agent_state();
    let sidecar_state_for_window = sidecar_state.clone();
    let sidecar_state_for_exit = sidecar_state.clone();
    let sidecar_state_for_tray_exit = sidecar_state.clone();
    let sidecar_state_for_monitor = sidecar_state.clone();
    let sidecar_state_for_session_monitor = sidecar_state.clone();

    let im_state_for_management = im_bot_state.clone();
    let agent_state_for_management = agent_state.clone();
    let sidecar_state_for_management = sidecar_state.clone();
    let im_state_for_window = im_bot_state.clone();
    let im_state_for_exit = im_bot_state.clone();
    let im_state_for_tray_exit = im_bot_state.clone();
    let agent_state_for_window = agent_state.clone();
    let agent_state_for_exit = agent_state.clone();
    let agent_state_for_tray_exit = agent_state.clone();

    // Track if cleanup has been performed to avoid duplicate cleanup
    // All clones share the same underlying AtomicBool - whichever exit path
    // triggers first will do cleanup, and all others will see the flag as true
    // and skip. The separate variables are needed because each is moved into
    // a different closure (window event, tray exit, app exit).
    let cleanup_done = Arc::new(AtomicBool::new(false));
    let cleanup_done_for_window = cleanup_done.clone();
    let cleanup_done_for_exit = cleanup_done.clone();
    let cleanup_done_for_tray_exit = cleanup_done.clone();
    let cleanup_done_for_monitor = cleanup_done.clone();
    let cleanup_done_for_session_monitor = cleanup_done.clone();
    let cleanup_done_for_agent_monitor = cleanup_done.clone();

    // Create terminal manager state
    let terminal_state = terminal::TerminalManager::new();
    let terminal_state_for_exit = terminal_state.clone();
    let terminal_state_for_window = terminal_state.clone();
    let terminal_state_for_tray_exit = terminal_state.clone();

    // Create browser manager state
    let browser_state = browser::BrowserManager::new();
    let browser_state_for_exit = browser_state.clone();
    let browser_state_for_window = browser_state.clone();
    let browser_state_for_tray_exit = browser_state.clone();

    // Create SSE proxy state
    let sse_proxy_state = Arc::new(sse_proxy::SseProxyState::default());

    // Build the app first, then run with event handler
    // This allows us to handle RunEvent::ExitRequested for Cmd+Q and Dock quit
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Another instance was launched — bring the existing window to the foreground
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .manage(sidecar_state)
        .manage(sse_proxy_state)
        .manage(im_bot_state)
        .manage(agent_state)
        .manage(terminal_state)
        .manage(browser_state)
        .invoke_handler(tauri::generate_handler![
            // Legacy commands (backward compatibility)
            commands::cmd_start_sidecar,
            commands::cmd_stop_sidecar,
            commands::cmd_get_sidecar_status,
            commands::cmd_get_server_url,
            commands::cmd_restart_sidecar,
            commands::cmd_ensure_sidecar_running,
            commands::cmd_check_sidecar_alive,
            // New multi-instance commands
            commands::cmd_start_tab_sidecar,
            commands::cmd_stop_tab_sidecar,
            commands::cmd_get_tab_server_url,
            commands::cmd_get_tab_sidecar_status,
            commands::cmd_start_global_sidecar,
            commands::cmd_get_global_server_url,
            commands::cmd_stop_all_sidecars,
            commands::cmd_shutdown_for_update,
            // SSE proxy commands (multi-instance)
            sse_proxy::start_sse_proxy,
            sse_proxy::stop_sse_proxy,
            sse_proxy::stop_all_sse_proxies,
            sse_proxy::proxy_http_request,
            // Updater commands
            updater::check_and_download_update,
            updater::restart_app,
            updater::test_update_connectivity,
            updater::check_pending_update,
            updater::install_pending_update,
            // Platform & device info
            commands::cmd_get_platform,
            commands::cmd_get_device_id,
            // Bundled workspace initialization
            commands::cmd_initialize_bundled_workspace,
            commands::cmd_create_bot_workspace,
            commands::cmd_remove_bot_workspace,
            // Agent Runtime detection (v0.1.59)
            commands::cmd_detect_runtimes,
            // Workspace template commands
            commands::cmd_create_workspace_from_template,
            commands::cmd_create_workspace_from_bundled_template,
            commands::cmd_copy_folder_to_templates,
            commands::cmd_remove_template_folder,
            // Admin agent sync
            commands::cmd_sync_admin_agent,
            // CLI sync (independent version gate)
            commands::cmd_sync_cli,
            // Cron task commands
            cron_task::cmd_create_cron_task,
            cron_task::cmd_start_cron_task,
            cron_task::cmd_stop_cron_task,
            cron_task::cmd_delete_cron_task,
            cron_task::cmd_get_cron_task,
            cron_task::cmd_get_cron_tasks,
            cron_task::cmd_get_workspace_cron_tasks,
            cron_task::cmd_get_session_cron_task,
            cron_task::cmd_get_tab_cron_task,
            cron_task::cmd_record_cron_execution,
            cron_task::cmd_update_cron_task_tab,
            cron_task::cmd_update_cron_task_session,
            cron_task::cmd_get_tasks_to_recover,
            // Cron scheduler commands
            cron_task::cmd_start_cron_scheduler,
            cron_task::cmd_mark_task_executing,
            cron_task::cmd_mark_task_complete,
            cron_task::cmd_is_task_executing,
            cron_task::cmd_get_cron_runs,
            cron_task::cmd_update_cron_task_fields,
            // Session activation commands (for Session singleton)
            cmd_get_session_activation,
            cmd_activate_session,
            cmd_deactivate_session,
            cmd_update_session_tab,
            // Cron task execution (Rust -> Sidecar direct call)
            cmd_execute_cron_task,
            // Session-centric Sidecar API (v0.1.11)
            cmd_ensure_session_sidecar,
            cmd_release_session_sidecar,
            cmd_get_session_port,
            cmd_upgrade_session_id,
            cmd_session_has_persistent_owners,
            // Background session completion
            cmd_start_background_completion,
            cmd_cancel_background_completion,
            cmd_get_background_sessions,
            // Proxy hot-reload
            cmd_propagate_proxy,
            // IM Bot commands (non-deprecated survivors)
            im::cmd_im_conversations,
            // Group permission commands (v0.1.28)
            im::cmd_approve_group,
            im::cmd_reject_group,
            im::cmd_remove_group,
            // OpenClaw Channel Plugin commands
            im::cmd_install_openclaw_plugin,
            im::cmd_list_openclaw_plugins,
            im::cmd_uninstall_openclaw_plugin,
            im::cmd_restart_channels_using_plugin,
            im::cmd_plugin_qr_login_start,
            im::cmd_plugin_qr_login_wait,
            im::cmd_plugin_restart_gateway,
            // Agent commands (v0.1.41)
            im::cmd_start_agent_channel,
            im::cmd_stop_agent_channel,
            im::cmd_agent_channel_status,
            im::cmd_agent_status,
            im::cmd_all_agents_status,
            im::cmd_update_agent_config,
            im::cmd_create_agent,
            im::cmd_delete_agent,
            // WeCom QR code commands (public API, not plugin gateway)
            commands::cmd_wecom_qr_generate,
            commands::cmd_wecom_qr_poll,
            // Model discovery
            commands::cmd_fetch_provider_models,
            // Terminal commands (embedded PTY)
            terminal::cmd_terminal_create,
            terminal::cmd_terminal_write,
            terminal::cmd_terminal_resize,
            terminal::cmd_terminal_close,
            // Browser commands (embedded webview)
            browser::cmd_browser_create,
            browser::cmd_browser_navigate,
            browser::cmd_browser_go_back,
            browser::cmd_browser_go_forward,
            browser::cmd_browser_reload,
            browser::cmd_browser_resize,
            browser::cmd_browser_show,
            browser::cmd_browser_hide,
            browser::cmd_browser_close,
            // File utility commands
            commands::cmd_read_workspace_file,
            commands::cmd_write_workspace_file,
            commands::cmd_delete_workspace_file,
            commands::cmd_read_file_base64,
            commands::cmd_open_file,
        ])
        .setup(|app| {
            // Initialize logging FIRST — acquire_lock() and cleanup_stale_sidecars()
            // need a logger backend for their log::warn!/info! calls.
            use tauri_plugin_log::{Target, TargetKind};

            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .target(Target::new(TargetKind::Stdout))
                    .target(Target::new(TargetKind::LogDir { file_name: None }))
                    .build(),
            )?;

            // Initialize global AppHandle for unified logging (IM module etc.)
            logger::init_app_handle(app.handle().clone());

            // Acquire PID lock — kills any stale instance that macOS auto-restarted
            // (e.g., after build_dev.sh pkill). Must run before cleanup_stale_sidecars
            // so we don't kill sidecars belonging to an instance we're about to replace.
            // The single-instance plugin handles the "user double-clicked" case via IPC;
            // this lock handles the "build script killed + macOS restarted" case via PID.
            app_dirs::acquire_lock();

            // IMPORTANT: Clean up stale sidecar processes from previous app instances.
            // This prevents "No available port found" errors caused by orphaned processes.
            // Placed here (inside .setup()) instead of before Builder so it only runs
            // for the primary instance. The single-instance plugin exits duplicate
            // processes before .setup() is called, preventing accidental kills.
            cleanup_stale_sidecars();

            // ── Boot Banner: single-line consolidated diagnostics for AI grep ──
            {
                let pkg = app.package_info();
                let version = pkg.version.to_string();
                let build_mode = if cfg!(debug_assertions) { "debug" } else { "release" };
                let os = std::env::consts::OS;
                let arch = std::env::consts::ARCH;
                let data_dir = app_dirs::pm_copilot_data_dir();
                let dir_str = data_dir.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "?".into());

                // Read config.json for counts (best-effort)
                let (mut provider, mut mcp, mut agents, mut channels, mut cron, mut proxy) =
                    ("?".to_string(), 0u32, 0u32, 0u32, 0u32, false);
                if let Some(ref dir) = data_dir {
                    if let Ok(c) = std::fs::read_to_string(dir.join("config.json"))
                        .ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).ok_or(()) {
                        // won't reach — see below
                        let _ = c;
                    }
                    // Simpler: parse as Value directly
                    if let Ok(cfg) = std::fs::read_to_string(dir.join("config.json"))
                        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))) {
                        provider = cfg.get("defaultProviderId").and_then(|v| v.as_str()).unwrap_or("none").to_string();
                        mcp = cfg.get("mcpEnabledServers").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0);
                        if let Some(ags) = cfg.get("agents").and_then(|v| v.as_array()) {
                            agents = ags.len() as u32;
                            for a in ags { channels += a.get("channels").and_then(|v| v.as_array()).map(|a| a.len() as u32).unwrap_or(0); }
                        }
                        proxy = cfg.get("proxySettings").and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
                    }
                    if let Ok(s) = std::fs::read_to_string(dir.join("cron_tasks.json")) {
                        // Structure: {"tasks": [{...,"enabled":true/false}, ...]}
                        cron = serde_json::from_str::<serde_json::Value>(&s).ok()
                            .and_then(|v| v.get("tasks")?.as_array().map(|tasks|
                                tasks.iter().filter(|t| t.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)).count() as u32
                            )).unwrap_or(0);
                    }
                }

                ulog_info!("[boot] v={} build={} os={}-{} provider={} mcp={} agents={} channels={} cron={} proxy={} dir={}", version, build_mode, os, arch, provider, mcp, agents, channels, cron, proxy, dir_str);
            }

            // Setup system tray
            if let Err(e) = tray::setup_tray(app) {
                log::error!("[App] Failed to setup system tray: {}", e);
            }

            // Setup tray exit handler (for when user confirms exit from tray menu)
            let app_handle_for_tray = app.handle().clone();
            app.listen("tray:confirm-exit", move |_| {
                log::info!("[App] Tray exit confirmed by user");
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_tray_exit.swap(true, Relaxed) {
                    log::info!("[App] Cleaning up sidecars before exit...");
                    im::signal_all_agents_shutdown(&agent_state_for_tray_exit);
                    im::signal_all_bots_shutdown(&im_state_for_tray_exit);
                    let _ = stop_all_sidecars(&sidecar_state_for_tray_exit);
                    // Clean up terminal PTY sessions
                    let ts = terminal_state_for_tray_exit.clone();
                    tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                    // Clean up browser webviews
                    let bs = browser_state_for_tray_exit.clone();
                    tauri::async_runtime::block_on(browser::close_all_browsers(&bs, &app_handle_for_tray));
                    app_dirs::release_lock();
                }
                app_handle_for_tray.exit(0);
            });

            // Open DevTools in debug builds
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // macOS: Custom menu — replace native "Close Window" (Cmd+W) with a custom
            // menu item that emits window:cmd-w to the frontend. This separates the
            // Cmd+W path (overlay → tab → launcher → stop) from the X button path
            // (CloseRequested → tray/exit). Without this, Cmd+W triggers CloseRequested
            // which hides the window before JS can handle it.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder, MenuItemBuilder, PredefinedMenuItem};

                let app_name = app.package_info().name.clone();
                let app_handle = app.handle();

                let close_tab = MenuItemBuilder::with_id("cmd-w-close", "Close Tab")
                    .accelerator("CmdOrCtrl+W")
                    .build(app_handle)?;

                let app_menu = SubmenuBuilder::new(app_handle, &app_name)
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let window_menu = SubmenuBuilder::new(app_handle, "Window")
                    .item(&close_tab)
                    .item(&PredefinedMenuItem::minimize(app_handle, None)?)
                    .item(&PredefinedMenuItem::maximize(app_handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app_handle, None)?)
                    .build()?;

                let menu = MenuBuilder::new(app_handle)
                    .item(&app_menu)
                    .item(&edit_menu)
                    .item(&window_menu)
                    .build()?;

                app.set_menu(menu)?;

                // Handle custom menu item click
                let app_handle_for_menu = app.handle().clone();
                app.on_menu_event(move |_app, event| {
                    if event.id().as_ref() == "cmd-w-close" {
                        let _ = app_handle_for_menu.emit("window:cmd-w", ());
                    }
                });
            }

            // Windows: Remove system decorations for custom title bar
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                    log::info!("[App] Windows: Disabled system decorations for custom title bar");
                }
            }

            // Inject IM/Agent/Sidecar state into management API (for /api/im/wake endpoint etc.)
            management_api::set_im_bots_state(im_state_for_management);
            management_api::set_agent_state(agent_state_for_management);
            management_api::set_sidecar_state(sidecar_state_for_management);

            // Start management API (internal HTTP server for Bun→Rust IPC)
            tauri::async_runtime::spawn(async move {
                match management_api::start_management_api().await {
                    Ok(port) => log::info!("[App] Management API started on port {}", port),
                    Err(e) => log::error!("[App] Failed to start management API: {}", e),
                }
            });

            // Initialize cron task manager with app handle
            let cron_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                cron_task::initialize_cron_manager(cron_app_handle).await;
            });
            ulog_info!("[App] Cron task manager initialization scheduled");

            // Auto-start IM Bot if previously enabled (3s delay)
            im::schedule_auto_start(app.handle().clone());
            log::info!("[App] IM Bot auto-start scheduled");

            // Auto-start Agent channels (4s delay, after IM bots)
            im::schedule_agent_auto_start(app.handle().clone());
            log::info!("[App] Agent auto-start scheduled");

            // Start Global Sidecar health monitor
            // Periodically checks if the Global Sidecar is alive and auto-restarts it
            // This prevents the "all network broken" state on Windows when the window
            // is minimized to tray and the OS kills child processes
            let app_handle_for_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_global_sidecar(
                    app_handle_for_monitor,
                    sidecar_state_for_monitor,
                    cleanup_done_for_monitor,
                ).await;
            });
            log::info!("[App] Global sidecar health monitor spawned");

            // Start Session Sidecar health monitor (20s initial delay)
            let app_handle_for_session_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::monitor_session_sidecars(
                    app_handle_for_session_monitor,
                    sidecar_state_for_session_monitor,
                    cleanup_done_for_session_monitor,
                ).await;
            });
            ulog_info!("[App] Session sidecar health monitor spawned");

            // Start Agent Channel health monitor (15s initial delay)
            let app_handle_for_agent_monitor = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                im::monitor_agent_channels(
                    app_handle_for_agent_monitor,
                    cleanup_done_for_agent_monitor,
                ).await;
            });
            ulog_info!("[App] Agent channel health monitor spawned");

            // Start background update check (5 second delay to let app initialize)
            log::info!("[App] Setup complete, spawning background update check task...");
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                log::info!("[App] Background update task started, waiting 5 seconds...");
                updater::check_update_on_startup(app_handle).await;
                log::info!("[App] Background update task completed");
            });
            log::info!("[App] Background update task spawned successfully");

            Ok(())
        })
        .on_window_event(move |window, event| {
            match event {
                // Handle window close request (X button) - minimize to tray instead
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Check if minimize to tray is enabled
                    // Emit event to frontend to check config and decide
                    log::info!("[App] Window close requested, emitting event to frontend");
                    let _ = window.emit("window:close-requested", ());
                    // Prevent default close behavior - let frontend decide
                    api.prevent_close();
                }
                // Clean up when window is actually destroyed
                tauri::WindowEvent::Destroyed => {
                    use std::sync::atomic::Ordering::Relaxed;
                    if !cleanup_done_for_window.swap(true, Relaxed) {
                        log::info!("[App] Window destroyed, cleaning up sidecars...");
                        im::signal_all_agents_shutdown(&agent_state_for_window);
                        im::signal_all_bots_shutdown(&im_state_for_window);
                        let _ = stop_all_sidecars(&sidecar_state_for_window);
                        // Clean up terminal PTY sessions
                        let ts = terminal_state_for_window.clone();
                        tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                        // Clean up browser webviews
                        let bs = browser_state_for_window.clone();
                        let app_for_browser = window.app_handle().clone();
                        tauri::async_runtime::block_on(browser::close_all_browsers(&bs, &app_for_browser));
                        app_dirs::release_lock();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to catch Cmd+Q, Dock quit, and Dock click
    app.run(move |_app_handle, event| {
        match event {
            // Handle app exit events (Cmd+Q, Dock right-click quit, etc.)
            tauri::RunEvent::ExitRequested { .. } => {
                // Only cleanup once (Relaxed is sufficient for simple flag)
                use std::sync::atomic::Ordering::Relaxed;
                if !cleanup_done_for_exit.swap(true, Relaxed) {
                    log::info!("[App] Exit requested (Cmd+Q or Dock quit), cleaning up sidecars...");
                    im::signal_all_agents_shutdown(&agent_state_for_exit);
                    im::signal_all_bots_shutdown(&im_state_for_exit);
                    let _ = stop_all_sidecars(&sidecar_state_for_exit);
                    // Clean up terminal PTY sessions
                    let ts = terminal_state_for_exit.clone();
                    tauri::async_runtime::block_on(terminal::close_all_terminals(&ts));
                    // Clean up browser webviews
                    let bs = browser_state_for_exit.clone();
                    tauri::async_runtime::block_on(browser::close_all_browsers(&bs, _app_handle));
                    app_dirs::release_lock();
                }
            }
            // Handle Dock icon click on macOS (Reopen event)
            // This is triggered when user clicks the Dock icon while app is running but window is hidden
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                log::info!("[App] Dock icon clicked (Reopen), showing main window");
                use tauri::Manager;
                if let Some(window) = _app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        }
    });
}
