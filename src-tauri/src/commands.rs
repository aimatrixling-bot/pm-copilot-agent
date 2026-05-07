// Tauri IPC commands for sidecar management and app operations
// Supports both legacy single-instance and new multi-instance APIs

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::sidecar::{
    // Legacy exports
    get_sidecar_status, start_sidecar, stop_sidecar, restart_sidecar,
    ensure_sidecar_running, check_process_alive,
    ManagedSidecar, LegacySidecarConfig, SidecarStatus,
    // New multi-instance exports
    start_tab_sidecar, stop_tab_sidecar, get_tab_server_url, get_tab_sidecar_status,
    start_global_sidecar, stop_all_sidecars, GLOBAL_SIDECAR_ID,
    // Update shutdown
    shutdown_for_update,
};
use crate::logger;
use crate::{ulog_error, ulog_info, ulog_warn};

// ============= Legacy Commands (for backward compatibility) =============

/// Command: Start the sidecar for a project (legacy single-instance)
#[tauri::command]
pub async fn cmd_start_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    agent_dir: String,
    initial_prompt: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, format!("[sidecar] Starting for project: {}", agent_dir));

    let config = LegacySidecarConfig {
        port: find_available_port().unwrap_or(31415),
        agent_dir: PathBuf::from(&agent_dir),
        initial_prompt,
    };

    match start_sidecar(&app_handle, &state, config) {
        Ok(_) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Started on port {}", status.port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Failed to start: {}", e));
            Err(e)
        }
    }
}

/// Command: Stop the sidecar (legacy)
#[tauri::command]
pub async fn cmd_stop_sidecar(state: State<'_, ManagedSidecar>) -> Result<(), String> {
    stop_sidecar(&state)
}

/// Command: Get sidecar status (legacy)
#[tauri::command]
pub async fn cmd_get_sidecar_status(
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    get_sidecar_status(&state)
}

/// Command: Get the backend server URL (legacy)
#[tauri::command]
pub async fn cmd_get_server_url(state: State<'_, ManagedSidecar>) -> Result<String, String> {
    let status = get_sidecar_status(&state)?;
    if status.running {
        Ok(format!("http://127.0.0.1:{}", status.port))
    } else {
        Err("Sidecar is not running".to_string())
    }
}

/// Command: Restart the sidecar (legacy)
#[tauri::command]
pub async fn cmd_restart_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Restart requested".to_string());

    match restart_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::info(&app_handle, format!("[sidecar] Restarted on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Restart failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Ensure sidecar is running (legacy)
#[tauri::command]
pub async fn cmd_ensure_sidecar_running<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    match ensure_sidecar_running(&app_handle, &state) {
        Ok(port) => {
            let status = get_sidecar_status(&state)?;
            logger::debug(&app_handle, format!("[sidecar] Ensured running on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Ensure running failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Check if sidecar process is alive (legacy)
#[tauri::command]
pub async fn cmd_check_sidecar_alive(
    state: State<'_, ManagedSidecar>,
) -> Result<bool, String> {
    check_process_alive(&state)
}

// ============= New Multi-instance Commands =============

/// Command: Start a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_start_tab_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
    agent_dir: Option<String>,
) -> Result<SidecarStatus, String> {
    logger::info(
        &app_handle,
        format!("[sidecar] Starting for tab {}, agent_dir: {:?}", tab_id, agent_dir),
    );

    let agent_path = agent_dir.map(PathBuf::from);

    match start_tab_sidecar(&app_handle, &state, &tab_id, agent_path) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, &tab_id)?;
            logger::info(&app_handle, format!("[sidecar] Tab {} started on port {}", tab_id, port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Tab {} failed to start: {}", tab_id, e));
            Err(e)
        }
    }
}

/// Command: Stop a sidecar for a specific Tab
#[tauri::command]
pub async fn cmd_stop_tab_sidecar(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<(), String> {
    logger::info(&app_handle, format!("[sidecar] Stopping tab {}", tab_id));
    stop_tab_sidecar(&state, &tab_id)
}

/// Command: Get server URL for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_server_url(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<String, String> {
    get_tab_server_url(&state, &tab_id)
}

/// Command: Get sidecar status for a specific Tab
#[tauri::command]
pub async fn cmd_get_tab_sidecar_status(
    state: State<'_, ManagedSidecar>,
    tab_id: String,
) -> Result<SidecarStatus, String> {
    get_tab_sidecar_status(&state, &tab_id)
}

/// Command: Start the global sidecar (for Settings page)
#[tauri::command]
pub async fn cmd_start_global_sidecar<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ManagedSidecar>,
) -> Result<SidecarStatus, String> {
    logger::info(&app_handle, "[sidecar] Starting global sidecar".to_string());

    match start_global_sidecar(&app_handle, &state) {
        Ok(port) => {
            let status = get_tab_sidecar_status(&state, GLOBAL_SIDECAR_ID)?;
            logger::info(&app_handle, format!("[sidecar] Global sidecar started on port {}", port));
            Ok(status)
        }
        Err(e) => {
            logger::error(&app_handle, format!("[sidecar] Global sidecar failed: {}", e));
            Err(e)
        }
    }
}

/// Command: Get global sidecar server URL
#[tauri::command]
pub async fn cmd_get_global_server_url(
    state: State<'_, ManagedSidecar>,
) -> Result<String, String> {
    get_tab_server_url(&state, GLOBAL_SIDECAR_ID)
}

/// Command: Stop all sidecar instances (for app exit)
#[tauri::command]
pub async fn cmd_stop_all_sidecars(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Stopping all instances".to_string());
    stop_all_sidecars(&state)
}

/// Command: Shutdown for update — blocks until all child processes are fully terminated.
/// Must be called before relaunch() to prevent NSIS installer file-lock errors on Windows.
#[tauri::command]
pub async fn cmd_shutdown_for_update(
    app_handle: AppHandle,
    state: State<'_, ManagedSidecar>,
) -> Result<(), String> {
    logger::info(&app_handle, "[sidecar] Shutdown for update requested".to_string());
    shutdown_for_update(&state)
}

// ============= Utility Functions =============

/// Find an available port
fn find_available_port() -> Option<u16> {
    let preferred = [31415, 31416, 31417, 31418, 31419];

    for &port in &preferred {
        if is_port_available(port) {
            return Some(port);
        }
    }

    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
}

/// Check if a port is available
fn is_port_available(port: u16) -> bool {
    std::net::TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

// ============= Platform & Device Info Commands =============

/// Command: Get platform identifier (matches build target naming)
/// Returns: darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64, etc.
#[tauri::command]
pub fn cmd_get_platform() -> String {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "darwin-aarch64".to_string();

    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "darwin-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "windows-x86_64".to_string();

    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "windows-aarch64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "linux-x86_64".to_string();

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "linux-aarch64".to_string();

    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "unknown".to_string();
}

/// Command: Get or create device ID
/// Stored in ~/.pm-copilot/device_id to persist across app reinstalls
/// Only regenerates if the file is deleted by user
#[tauri::command]
pub fn cmd_get_device_id() -> Result<String, String> {
    use std::fs;
    use uuid::Uuid;

    // Get home directory
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "Failed to get home directory".to_string())?;

    // ~/.pm-copilot/ directory
    let pm_copilot_dir = home_dir.join(".pm-copilot");
    let device_id_file = pm_copilot_dir.join("device_id");

    // Try to read existing device_id
    if device_id_file.exists() {
        match fs::read_to_string(&device_id_file) {
            Ok(id) => {
                let id = id.trim().to_string();
                if !id.is_empty() {
                    return Ok(id);
                }
            }
            Err(_) => {
                // File exists but can't read, will regenerate
            }
        }
    }

    // Generate new UUID
    let new_id = Uuid::new_v4().to_string();

    // Ensure directory exists
    if !pm_copilot_dir.exists() {
        fs::create_dir_all(&pm_copilot_dir)
            .map_err(|e| format!("Failed to create ~/.pm-copilot directory: {}", e))?;
    }

    // Write device_id to file
    fs::write(&device_id_file, &new_id)
        .map_err(|e| format!("Failed to write device_id file: {}", e))?;

    Ok(new_id)
}

// ============= Bundled Workspace Commands =============

#[derive(serde::Serialize)]
pub struct InitBundledWorkspaceResult {
    pub path: String,
    pub is_new: bool,
}

/// Command: Initialize bundled workspace (mino) on first launch
/// Copies from app resources to ~/.pm-copilot/projects/mino/
#[tauri::command]
pub fn cmd_initialize_bundled_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let mino_dest = home_dir.join(".pm-copilot").join("projects").join("mino");

    if mino_dest.exists() {
        return Ok(InitBundledWorkspaceResult {
            path: mino_dest.to_string_lossy().to_string(),
            is_new: false,
        });
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");
    if !mino_src.exists() || !mino_src.join("CLAUDE.md").exists() {
        return Err(format!(
            "Bundled mino not found or incomplete in resources: {:?}",
            mino_src
        ));
    }

    ulog_info!("[workspace] Initializing bundled workspace from {:?}", mino_src);
    copy_dir_recursive(&mino_src, &mino_dest)
        .map_err(|e| format!("Failed to copy mino workspace: {}", e))?;

    // Validate the copy produced a valid workspace
    if !mino_dest.join("CLAUDE.md").exists() {
        let _ = fs::remove_dir_all(&mino_dest);
        return Err("Bundled mino copy produced incomplete workspace".to_string());
    }

    Ok(InitBundledWorkspaceResult {
        path: mino_dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Create a dedicated workspace for an IM Bot by copying bundled mino template.
/// Sanitizes the name for path safety and auto-appends numeric suffix on collision.
/// Falls back to local mino copy if bundled resources are incomplete.
/// Returns the created workspace path.
#[tauri::command]
pub fn cmd_create_bot_workspace<R: Runtime>(
    app_handle: AppHandle<R>,
    workspace_name: String,
) -> Result<InitBundledWorkspaceResult, String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".pm-copilot").join("projects");

    // Sanitize name: remove @, replace non-alphanumeric (except CJK) with dash, trim
    let sanitized = sanitize_workspace_name(&workspace_name);
    if sanitized.is_empty() {
        return Err("Workspace name is empty after sanitization".to_string());
    }

    // Find available path (handle collisions with numeric suffix)
    let dest = find_available_workspace_path(&projects_dir, &sanitized);

    // Primary: copy from bundled resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let mino_src = resource_dir.join("mino");

    if mino_src.exists() && mino_src.join("CLAUDE.md").exists() {
        ulog_info!("[workspace] Copying bundled mino from {:?} to {:?}", mino_src, dest);
        copy_dir_recursive(&mino_src, &dest)
            .map_err(|e| format!("Failed to copy workspace template: {}", e))?;
    }

    // Validate: CLAUDE.md must exist in destination (marker file for a valid mino template)
    if !dest.join("CLAUDE.md").exists() {
        // Fallback: copy from the local mino created on first launch
        let local_mino = projects_dir.join("mino");
        if local_mino.exists() && local_mino.join("CLAUDE.md").exists() {
            ulog_warn!("[workspace] Bundled mino incomplete, falling back to local {:?}", local_mino);
            // Clean up the potentially empty dest before fallback copy
            let _ = fs::remove_dir_all(&dest);
            copy_dir_recursive(&local_mino, &dest)
                .map_err(|e| format!("Failed to copy from local mino: {}", e))?;
        } else {
            // Clean up the empty dest
            let _ = fs::remove_dir_all(&dest);
            return Err("Mino template not found: bundled resources incomplete and no local copy available".to_string());
        }
    }

    ulog_info!("[workspace] Bot workspace created: {:?}", dest);
    Ok(InitBundledWorkspaceResult {
        path: dest.to_string_lossy().to_string(),
        is_new: true,
    })
}

/// Command: Remove a workspace directory created by `cmd_create_bot_workspace`.
/// Safety: only allows deleting directories under `~/.pm-copilot/projects/`.
#[tauri::command]
pub fn cmd_remove_bot_workspace(workspace_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let projects_dir = home_dir.join(".pm-copilot").join("projects");

    let target = PathBuf::from(&workspace_path);
    // Canonicalize both paths to prevent traversal attacks
    let canon_projects = projects_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve projects dir: {}", e))?;
    let canon_target = target.canonicalize()
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    if !canon_target.starts_with(&canon_projects) || canon_target == canon_projects {
        return Err("Refusing to delete: path is not inside ~/.pm-copilot/projects/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove workspace directory: {}", e))?;

    Ok(())
}

/// Command: Remove a template directory from ~/.pm-copilot/templates/.
/// Safety: only allows deleting directories under ~/.pm-copilot/templates/.
#[tauri::command]
pub fn cmd_remove_template_folder(template_path: String) -> Result<(), String> {
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".pm-copilot").join("templates");

    if !templates_dir.exists() {
        return Err("Templates directory does not exist".to_string());
    }

    let target = PathBuf::from(&template_path);

    // If the folder no longer exists, treat as success (already cleaned up)
    if !target.exists() {
        ulog_info!("[template] Template folder already removed: {:?}", target);
        return Ok(());
    }

    let canon_templates = templates_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    let canon_target = target.canonicalize()
        .map_err(|e| format!("Failed to resolve template path: {}", e))?;

    if !canon_target.starts_with(&canon_templates) || canon_target == canon_templates {
        return Err("Refusing to delete: path is not inside ~/.pm-copilot/templates/".to_string());
    }

    fs::remove_dir_all(&canon_target)
        .map_err(|e| format!("Failed to remove template directory: {}", e))?;

    ulog_info!("[template] Removed template folder: {:?}", canon_target);
    Ok(())
}

/// Sanitize a workspace name for use as a directory name.
/// Keeps alphanumeric, CJK characters, hyphens, and underscores.
fn sanitize_workspace_name(name: &str) -> String {
    let result: String = name
        .chars()
        .filter_map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                Some(c)
            } else if c == ' ' || c == '@' || c == '/' || c == '\\' {
                Some('-')
            } else if c > '\u{2E7F}' {
                // Keep CJK and other non-ASCII characters
                Some(c)
            } else {
                None
            }
        })
        .collect();

    // Trim leading/trailing dashes and collapse consecutive dashes
    let mut collapsed = String::new();
    let mut prev_dash = false;
    for c in result.chars() {
        if c == '-' {
            if !prev_dash && !collapsed.is_empty() {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    collapsed.trim_end_matches('-').to_string()
}

/// Find an available workspace path, appending numeric suffix on collision.
fn find_available_workspace_path(projects_dir: &Path, base_name: &str) -> PathBuf {
    let first = projects_dir.join(base_name);
    if !first.exists() {
        return first;
    }
    for i in 2..=100 {
        let candidate = projects_dir.join(format!("{}-{}", base_name, i));
        if !candidate.exists() {
            return candidate;
        }
    }
    // Extremely unlikely fallback
    projects_dir.join(format!("{}-{}", base_name, uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("x")))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        // Skip .git and node_modules
        if name == ".git" || name == "node_modules" {
            continue;
        }
        // Skip symlinks to avoid circular copies and unexpected data
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let dest = dst.join(name);
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(&entry.path(), &dest)?;
        }
    }
    Ok(())
}

// ============= Workspace Template Commands =============

/// Command: Create a workspace from a user template (copy source dir to dest dir).
/// Reuses copy_dir_recursive which skips .git and node_modules.
/// Safety: source_path must be under ~/.pm-copilot/templates/.
/// The dest_path parent must exist; the dest_path itself must NOT exist.
#[tauri::command]
pub fn cmd_create_workspace_from_template(
    source_path: String,
    dest_path: String,
) -> Result<(), String> {
    let src = PathBuf::from(&source_path);
    let dst = PathBuf::from(&dest_path);

    if !src.exists() {
        return Err(format!("Template source not found: {}", source_path));
    }

    // Validate source is under ~/.pm-copilot/templates/
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".pm-copilot").join("templates");
    if templates_dir.exists() {
        let canon_templates = templates_dir.canonicalize()
            .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
        let canon_src = src.canonicalize()
            .map_err(|e| format!("Failed to resolve source path: {}", e))?;
        if !canon_src.starts_with(&canon_templates) {
            return Err("Source path must be inside ~/.pm-copilot/templates/".to_string());
        }
    } else {
        return Err("Templates directory does not exist".to_string());
    }

    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    // Ensure parent directory exists
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    ulog_info!("[template] Copying template from {:?} to {:?}", src, dst);
    copy_dir_recursive(&src, &dst)
        .map_err(|e| format!("Failed to copy template: {}", e))?;

    Ok(())
}

/// Command: Create a workspace from a bundled (preset) template.
/// Copies from app resources/<template_id> to dest_path.
/// Falls back to local copy at ~/.pm-copilot/projects/<template_id> if bundled is incomplete.
/// Safety: template_id is sanitized to prevent path traversal.
#[tauri::command]
pub fn cmd_create_workspace_from_bundled_template<R: Runtime>(
    app_handle: AppHandle<R>,
    template_id: String,
    dest_path: String,
) -> Result<(), String> {
    // Sanitize template_id: reject path separators and traversal components
    if template_id.contains('/') || template_id.contains('\\') || template_id.contains("..") || template_id.is_empty() {
        return Err("Invalid template ID".to_string());
    }

    let dst = PathBuf::from(&dest_path);
    if dst.exists() {
        return Err(format!("Destination already exists: {}", dest_path));
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    // Primary: copy from bundled resources
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;
    let template_src = resource_dir.join(&template_id);

    if template_src.exists() && template_src.join("CLAUDE.md").exists() {
        ulog_info!("[template] Copying bundled template '{}' from {:?} to {:?}", template_id, template_src, dst);
        copy_dir_recursive(&template_src, &dst)
            .map_err(|e| format!("Failed to copy bundled template: {}", e))?;
        return Ok(());
    }

    // Fallback: copy from local projects/<template_id>
    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let local_src = home_dir.join(".pm-copilot").join("projects").join(&template_id);
    if local_src.exists() && local_src.join("CLAUDE.md").exists() {
        ulog_warn!("[template] Bundled template '{}' incomplete, falling back to local {:?}", template_id, local_src);
        copy_dir_recursive(&local_src, &dst)
            .map_err(|e| format!("Failed to copy from local template: {}", e))?;
        return Ok(());
    }

    Err(format!("Template '{}' not found in bundled resources or local copies", template_id))
}

/// Command: Copy a local folder into the templates library (~/.pm-copilot/templates/<name>/).
/// Returns the destination path.
#[tauri::command]
pub fn cmd_copy_folder_to_templates(
    source_path: String,
    template_name: String,
) -> Result<String, String> {
    let src = PathBuf::from(&source_path);
    if !src.exists() || !src.is_dir() {
        return Err(format!("Source folder not found: {}", source_path));
    }

    let home_dir = dirs::home_dir().ok_or("Failed to get home dir")?;
    let templates_dir = home_dir.join(".pm-copilot").join("templates");
    fs::create_dir_all(&templates_dir)
        .map_err(|e| format!("Failed to create templates dir: {}", e))?;

    // Sanitize name and find available path
    let sanitized = sanitize_workspace_name(&template_name);
    if sanitized.is_empty() {
        return Err("Template name is empty after sanitization".to_string());
    }
    let dest = find_available_workspace_path(&templates_dir, &sanitized);

    // Prevent overlapping source/destination (would cause infinite recursion)
    let canon_src = src.canonicalize()
        .map_err(|e| format!("Failed to resolve source: {}", e))?;
    let canon_templates = templates_dir.canonicalize()
        .map_err(|e| format!("Failed to resolve templates dir: {}", e))?;
    if canon_src.starts_with(&canon_templates) {
        return Err("Source folder is already inside the templates directory".to_string());
    }

    ulog_info!("[template] Copying folder {:?} to template library {:?}", src, dest);
    copy_dir_recursive(&src, &dest)
        .map_err(|e| format!("Failed to copy to template library: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

// ============= Admin Agent Sync =============

const ADMIN_AGENT_VERSION: &str = "pm-20";

/// Merge bundled admin agent files into ~/.pm-copilot/
/// Version-gated: only runs when ADMIN_AGENT_VERSION changes.
#[tauri::command]
pub fn cmd_sync_admin_agent<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let dest = home.join(".pm-copilot");

    // Version gate
    let ver_file = dest.join(".admin-agent-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == ADMIN_AGENT_VERSION {
            return Ok(false);
        }
    }

    // Source: app resources
    let res = app_handle.path().resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let src = res.join("bundled-agents").join("pm-copilot");
    if !src.exists() {
        return Err(format!("Admin agent not found: {:?}", src));
    }

    // Merge into ~/.pm-copilot/
    merge_dir_recursive(&src, &dest)
        .map_err(|e| format!("Merge failed: {}", e))?;

    fs::write(&ver_file, ADMIN_AGENT_VERSION)
        .map_err(|e| format!("Version write failed: {}", e))?;

    ulog_info!("[admin-agent] Synced v{}", ADMIN_AGENT_VERSION);
    Ok(true)
}

// ============= CLI Sync =============

const CLI_VERSION: &str = "2";

/// Sync the CLI script from bundled resources to ~/.pm-copilot/bin/.
/// Version-gated: only runs when CLI_VERSION changes.
/// Renames pm-copilot.ts → pm-copilot (strips .ts extension for shebang execution).
#[tauri::command]
pub fn cmd_sync_cli<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<bool, String> {
    let home = dirs::home_dir().ok_or("Home dir not found")?;
    let bin_dir = home.join(".pm-copilot").join("bin");

    // Version gate
    let ver_file = home.join(".pm-copilot").join(".cli-version");
    if ver_file.exists() {
        let ver = fs::read_to_string(&ver_file).unwrap_or_default();
        if ver.trim() == CLI_VERSION {
            return Ok(false);
        }
    }

    // Source: app resources/cli/
    let res = app_handle.path().resource_dir()
        .map_err(|e| format!("Resource dir: {}", e))?;
    let cli_src = res.join("cli");
    if !cli_src.exists() {
        return Err(format!("CLI source not found: {:?}", cli_src));
    }

    // Ensure ~/.pm-copilot/bin/ exists
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create bin dir: {}", e))?;

    // Copy pm-copilot.ts → pm-copilot (strip .ts extension)
    let src_script = cli_src.join("pm-copilot.ts");
    let dst_script = bin_dir.join("pm-copilot");
    if !src_script.exists() {
        return Err(format!("CLI script not found: {:?} (packaging issue?)", src_script));
    }
    fs::copy(&src_script, &dst_script)
        .map_err(|e| format!("Failed to copy CLI script: {}", e))?;
    // Ensure executable permission on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o755);
        fs::set_permissions(&dst_script, perms)
            .map_err(|e| format!("Failed to set permissions: {}", e))?;
    }

    // Copy pm-copilot.cmd (Windows launcher, no rename needed)
    let src_cmd = cli_src.join("pm-copilot.cmd");
    let dst_cmd = bin_dir.join("pm-copilot.cmd");
    if src_cmd.exists() {
        fs::copy(&src_cmd, &dst_cmd)
            .map_err(|e| format!("Failed to copy CLI cmd script: {}", e))?;
    }

    // Write version gate
    fs::write(&ver_file, CLI_VERSION)
        .map_err(|e| format!("CLI version write failed: {}", e))?;

    ulog_info!("[cli] Synced CLI v{}", CLI_VERSION);
    Ok(true)
}

/// Merge src/ into dst/ recursively. Creates missing dirs, overwrites files, never deletes.
fn merge_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".git" || name == "node_modules" { continue; }
        let ft = entry.file_type()?;
        if ft.is_symlink() { continue; }
        let d = dst.join(&name);
        if ft.is_dir() {
            merge_dir_recursive(&entry.path(), &d)?;
        } else {
            fs::copy(&entry.path(), &d)?;
        }
    }
    Ok(())
}

/// Read a workspace text file. Returns content if exists, null if not.
/// Bypasses Tauri fs plugin scope (which only covers ~/.pm-copilot).
#[tauri::command]
pub async fn cmd_read_workspace_file(path: String) -> Result<Option<String>, String> {
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read {}: {}", path, e)),
    }
}

/// Write content to a workspace text file, creating parent directories if needed.
/// Bypasses Tauri fs plugin scope (which only covers ~/.pm-copilot).
#[tauri::command]
pub async fn cmd_write_workspace_file(path: String, content: String) -> Result<(), String> {
    let file_path = std::path::Path::new(&path);
    if let Some(parent) = file_path.parent() {
        tokio::fs::create_dir_all(parent).await
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    tokio::fs::write(&path, content).await
        .map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Delete a workspace file. Returns true if deleted, false if not found.
/// Bypasses Tauri fs plugin scope (which only covers ~/.pm-copilot).
#[tauri::command]
pub async fn cmd_delete_workspace_file(path: String) -> Result<bool, String> {
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Failed to delete {}: {}", path, e)),
    }
}

/// Read a local file and return its contents as base64.
/// Used by the audio player to create blob URLs without asset protocol scope issues.
#[tauri::command]
pub async fn cmd_read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    let bytes = tokio::fs::read(&path).await.map_err(|e| format!("Failed to read {}: {}", path, e))?;
    Ok(BASE64.encode(&bytes))
}

/// Open a local file with the system default application.
/// Bypasses shell plugin URL-only scope restriction.
#[tauri::command]
pub async fn cmd_open_file(path: String) -> Result<(), String> {
    // Validate: path must resolve to an existing file (prevents opening arbitrary commands)
    let canonical = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Invalid path '{}': {}", path, e))?;
    if !canonical.is_file() {
        return Err(format!("Not a file: {}", canonical.display()));
    }
    let safe_path = canonical.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "windows")]
    {
        // Use explorer.exe instead of cmd /C start to avoid shell metacharacter injection
        std::process::Command::new("explorer")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&safe_path)
            .spawn()
            .map_err(|e| format!("Failed to open {}: {}", safe_path, e))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// WeCom QR Code — generate & poll for bot credentials
// Uses the public WeCom QR API (same flow as @wecom/wecom-openclaw-cli).
// These are external HTTPS requests — use proxy_config for outbound proxy.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
pub struct WecomQrGenerateResult {
    pub scode: String,
    pub auth_url: String,
}

/// Generate a WeCom QR code for one-click bot creation.
/// Returns scode (for polling) and auth_url (to render as QR image).
#[tauri::command]
pub async fn cmd_wecom_qr_generate() -> Result<WecomQrGenerateResult, String> {
    let plat = if cfg!(target_os = "macos") { 1 }
               else if cfg!(target_os = "windows") { 2 }
               else { 3 };
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/generate?source=pm-copilot&plat={}",
        plat
    );

    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR generate request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR generate parse failed: {}", e))?;

    // Check for API-level errors (same pattern as poll)
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        return Err(format!("WeCom QR generate API error {}: {}", errcode, errmsg));
    }

    let data = resp.get("data").ok_or("WeCom QR response missing 'data'")?;
    let scode = data["scode"]
        .as_str()
        .ok_or("WeCom QR response missing 'scode'")?
        .to_string();
    let auth_url = data["auth_url"]
        .as_str()
        .ok_or("WeCom QR response missing 'auth_url'")?
        .to_string();

    let scode_preview: String = scode.chars().take(8).collect();
    ulog_info!("[wecom-qr] Generated QR code, scode={}", scode_preview);
    Ok(WecomQrGenerateResult { scode, auth_url })
}

#[derive(serde::Serialize)]
pub struct WecomQrPollResult {
    /// "waiting" — user hasn't scanned yet; "success" — bot created, credentials available
    pub status: String,
    pub bot_id: Option<String>,
    pub secret: Option<String>,
}

/// Poll the WeCom QR scan result. Call repeatedly until status is "success".
/// `poll_index` is used for periodic logging (log every 10th poll to reduce noise).
#[tauri::command]
pub async fn cmd_wecom_qr_poll(scode: String, poll_index: Option<u32>) -> Result<WecomQrPollResult, String> {
    // Sanitize scode: only allow alphanumeric (defense-in-depth against URL injection)
    let safe_scode: String = scode.chars().filter(|c| c.is_alphanumeric()).collect();
    let url = format!(
        "https://work.weixin.qq.com/ai/qc/query_result?scode={}",
        safe_scode
    );

    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10));
    let client = crate::proxy_config::build_client_with_proxy(builder)?;

    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("WeCom QR poll failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("WeCom QR poll parse failed: {}", e))?;

    // Check for API-level errors first
    let errcode = resp["errcode"].as_i64().unwrap_or(0);
    if errcode != 0 {
        let errmsg = resp["errmsg"].as_str().unwrap_or("unknown error");
        ulog_error!("[wecom-qr] Poll API error {}: {}", errcode, errmsg);
        return Err(format!("WeCom QR poll API error {}: {}", errcode, errmsg));
    }

    let status_str = resp["data"]["status"].as_str().unwrap_or("waiting");
    let idx = poll_index.unwrap_or(0);

    match status_str {
        "success" => {
            let bot_info = &resp["data"]["bot_info"];
            let bot_id = bot_info["botid"].as_str().map(String::from);
            let secret = bot_info["secret"].as_str().map(String::from);
            if bot_id.is_some() && secret.is_some() {
                ulog_info!("[wecom-qr] QR scan success, bot created (poll #{})", idx);
                Ok(WecomQrPollResult { status: "success".into(), bot_id, secret })
            } else {
                // Log raw response for debugging unexpected format
                ulog_error!("[wecom-qr] Poll #{} status=success but bot_info incomplete: {}", idx, resp);
                Err("WeCom QR scan succeeded but bot_info is incomplete".into())
            }
        }
        "expired" | "cancelled" | "denied" => {
            ulog_info!("[wecom-qr] Poll #{} terminal status: {}", idx, status_str);
            Ok(WecomQrPollResult { status: status_str.into(), bot_id: None, secret: None })
        }
        _ => {
            // Periodic logging: first poll, then every 10th
            if idx == 0 || idx % 10 == 0 {
                let scode_preview: String = safe_scode.chars().take(8).collect();
                ulog_info!("[wecom-qr] Poll #{} scode={} status={}", idx, scode_preview, status_str);
            }
            Ok(WecomQrPollResult { status: "waiting".into(), bot_id: None, secret: None })
        }
    }
}

// ============= Model Discovery =============

/// Fetch provider model list via external API.
/// Returns raw JSON response — parsing is done in the frontend.
#[tauri::command]
pub async fn cmd_fetch_provider_models(
    url: String,
    auth_header_name: String,
    auth_header_value: String,
    extra_headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    ulog_info!("[model-discovery] Fetching models from {}", url);

    // Determine if URL points to localhost — if so, use local_http (no proxy) to avoid
    // the system-proxy-intercepts-localhost bug. Otherwise, use proxy_config for external APIs.
    let is_localhost = url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
        || url.starts_with("https://127.0.0.1")
        || url.starts_with("https://localhost");

    let client = if is_localhost {
        crate::local_http::json_client(std::time::Duration::from_secs(15))
    } else {
        let builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15));
        crate::proxy_config::build_client_with_proxy(builder)?
    };

    let mut request = client.get(&url)
        .header(&auth_header_name, &auth_header_value);

    if let Some(headers) = extra_headers {
        for (key, value) in headers {
            request = request.header(key, value);
        }
    }

    let response = request.send().await
        .map_err(|e| {
            ulog_error!("[model-discovery] Network error for {}: {}", url, e);
            format!("Network error: {}", e)
        })?;

    let status = response.status();
    if !status.is_success() {
        // Limit error body to ~2KB to avoid unbounded allocation (char-boundary safe for UTF-8)
        let body = response.text().await.unwrap_or_default();
        let truncated = match body.char_indices().nth(2048) {
            Some((byte_pos, _)) => &body[..byte_pos],
            None => &body,
        };
        ulog_error!("[model-discovery] HTTP {} from {}", status.as_u16(), url);
        return Err(format!("HTTP {}: {}", status.as_u16(), truncated));
    }

    let result = response.json::<serde_json::Value>().await
        .map_err(|e| {
            ulog_error!("[model-discovery] Invalid JSON from {}: {}", url, e);
            format!("Invalid JSON response: {}", e)
        })?;

    ulog_info!("[model-discovery] Success from {}", url);
    Ok(result)
}

// ============= Agent Runtime Detection (v0.1.59) =============

/// Runtime detection result for a single CLI
#[derive(serde::Serialize, Clone)]
pub struct RuntimeDetectionResult {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

/// Detect whether external Agent Runtime CLIs are installed
#[tauri::command]
pub fn cmd_detect_runtimes() -> HashMap<String, RuntimeDetectionResult> {
    let mut results = HashMap::new();

    // Builtin is always available
    results.insert("builtin".to_string(), RuntimeDetectionResult {
        installed: true,
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        path: None,
    });

    // Claude Code CLI
    results.insert("claude-code".to_string(), detect_cli("claude"));

    // Codex CLI
    results.insert("codex".to_string(), detect_cli("codex"));

    results
}

fn detect_cli(binary_name: &str) -> RuntimeDetectionResult {
    match crate::system_binary::find(binary_name) {
        Some(path) => {
            // Try to get version — MUST use process_cmd::new() to prevent Windows console flash
            let version = crate::process_cmd::new(&path)
                .arg("--version")
                .output()
                .ok()
                .and_then(|output| {
                    if output.status.success() {
                        String::from_utf8(output.stdout).ok().map(|s| s.trim().to_string())
                    } else {
                        None
                    }
                });

            RuntimeDetectionResult {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
        None => RuntimeDetectionResult {
            installed: false,
            version: None,
            path: None,
        },
    }
}
