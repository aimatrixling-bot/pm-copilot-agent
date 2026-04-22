//! Centralized application data directory and PID lock file management.
//!
//! All code that needs `~/.pm-copilot/` SHOULD use [`pm_copilot_data_dir()`] instead of
//! hardcoding the path. This enables future dev/prod isolation (separate data dirs
//! for debug vs release builds) with a single change to this module.
//!
//! ## PID Lock File
//!
//! `~/.pm-copilot/app.lock` contains the PID of the running PM Copilot instance.
//! - Written by [`acquire_lock()`] during app startup (after single-instance check).
//! - Read by build scripts (`build_dev.sh`, `start_dev.sh`) to precisely kill the
//!   running instance before starting a new one.
//! - Removed by [`release_lock()`] on graceful exit.

use std::fs;
use std::path::PathBuf;

/// Return the PM Copilot data directory (`~/.pm-copilot/` by default).
///
/// Future: debug builds may return `~/.pm-copilot-dev/` to enable simultaneous
/// dev/prod operation with fully isolated state (config, bots, sidecars, ports).
/// For now, both profiles share the same directory.
pub fn pm_copilot_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".pm-copilot"))
}

/// Path to the PID lock file.
fn lock_file_path() -> Option<PathBuf> {
    pm_copilot_data_dir().map(|d| d.join("app.lock"))
}

/// Write the current process PID to `~/.pm-copilot/app.lock`.
///
/// If an existing lock file contains a PID of a still-running PM Copilot process,
/// that process is killed with SIGKILL before the new PID is written. This handles
/// the case where macOS auto-restarts a killed `.app` (Automatic Termination)
/// before the new build starts, leaving two instances fighting over shared resources.
///
/// Called once in `lib.rs` `setup()`, after the Tauri single-instance plugin has
/// already handled the normal "user double-clicked the app" scenario.
pub fn acquire_lock() {
    let Some(lock_path) = lock_file_path() else { return };

    // Ensure parent dir exists
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Check existing lock
    if let Ok(content) = fs::read_to_string(&lock_path) {
        if let Ok(old_pid) = content.trim().parse::<u32>() {
            let current_pid = std::process::id();
            if old_pid != current_pid && is_pm_copilot_process(old_pid) {
                log::warn!(
                    "[app-lock] Killing stale PM Copilot instance (PID {}) before acquiring lock",
                    old_pid
                );
                kill_pid(old_pid);
                // Give it a moment to die (SIGKILL is near-instant on modern kernels)
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
        }
    }

    // Write our PID
    let pid = std::process::id();
    if let Err(e) = fs::write(&lock_path, pid.to_string()) {
        log::error!("[app-lock] Failed to write lock file: {}", e);
    } else {
        log::info!("[app-lock] Lock acquired (PID {})", pid);
    }
}

/// Remove the lock file on graceful exit.
///
/// Only removes if the file still contains OUR PID (another instance may have
/// overwritten it if we're being replaced).
pub fn release_lock() {
    let Some(lock_path) = lock_file_path() else { return };
    let current_pid = std::process::id().to_string();

    match fs::read_to_string(&lock_path) {
        Ok(content) if content.trim() == current_pid => {
            let _ = fs::remove_file(&lock_path);
            log::info!("[app-lock] Lock released (PID {})", current_pid);
        }
        _ => {
            // Lock file doesn't exist or belongs to another instance — don't touch it
        }
    }
}

/// Check if a PID belongs to a running PM Copilot process (not just any process).
/// Prevents SIGKILL-ing an unrelated process that recycled the stale PID.
#[cfg(unix)]
fn is_pm_copilot_process(pid: u32) -> bool {
    // SAFETY: kill(pid, 0) checks process existence without sending a signal.
    // Valid for any positive PID; signal 0 is always safe.
    let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
    if !alive {
        return false;
    }
    // Verify process name contains "PM Copilot" to avoid killing recycled PIDs.
    // `ps -p PID -o comm=` returns just the process name, portable across macOS/Linux.
    std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .map(|o| {
            let name = String::from_utf8_lossy(&o.stdout);
            name.contains("PM Copilot")
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_pm_copilot_process(pid: u32) -> bool {
    // Use tasklist filtered by PID; verify image name contains PM Copilot.
    // CREATE_NO_WINDOW (0x08000000) prevents console flash from GUI app.
    crate::process_cmd::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
        .output()
        .map(|o| {
            let out = String::from_utf8_lossy(&o.stdout);
            out.contains("PM Copilot")
        })
        .unwrap_or(false)
}

/// Kill a process with SIGKILL (Unix) or TerminateProcess (Windows).
#[cfg(unix)]
fn kill_pid(pid: u32) {
    // SAFETY: SIGKILL is a valid signal for any PID we own permission to kill.
    // Caller has already verified this PID is a PM Copilot process.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    // /F = force, /T = kill process tree, /PID = target
    // Uses process_cmd::new() to set CREATE_NO_WINDOW (prevents console flash).
    let _ = crate::process_cmd::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
}
