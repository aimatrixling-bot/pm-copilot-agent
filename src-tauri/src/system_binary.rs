//! Centralized system binary discovery for GUI applications.
//!
//! **All** system binary lookups MUST use `system_binary::find()` instead of
//! raw `which::which()`. Tauri apps launched from Finder/launchd don't inherit
//! shell PATH (no `/opt/homebrew/bin`, `/usr/local/bin`, etc.), so bare
//! `which::which("npm")` fails even when npm is installed.
//!
//! This follows the same "pit of success" pattern as [`crate::local_http`]
//! and [`crate::process_cmd`]: the correct behavior is the default — callers
//! don't need to remember platform-specific PATH augmentation.
//!
//! ## Usage
//!
//! ```rust,ignore
//! use crate::system_binary;
//!
//! if let Some(npm) = system_binary::find("npm") {
//!     let mut cmd = process_cmd::new(&npm);
//!     cmd.arg("install").arg("some-package");
//! }
//! ```

use std::path::PathBuf;

/// Common binary directories that may be missing from the GUI process PATH.
/// macOS: Finder launch inherits only `/usr/bin:/bin:/usr/sbin:/sbin`.
/// These entries are appended (not prepended) to preserve existing PATH priority.
#[cfg(not(target_os = "windows"))]
const EXTRA_SEARCH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",   // macOS Apple Silicon homebrew
    "/opt/homebrew/sbin",
    "/usr/local/bin",      // macOS Intel homebrew / Linux manual installs
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
];

/// User-relative directories that require $HOME expansion at runtime.
/// e.g., `~/.local/bin` is where `claude` (Claude Code CLI) is installed globally.
#[cfg(not(target_os = "windows"))]
const USER_RELATIVE_DIRS: &[&str] = &[
    ".local/bin",          // Claude Code CLI global install (`claude`)
    ".bun/bin",            // Bun global installs
];

/// Find a system binary by name, searching both the process PATH and common
/// system directories that GUI apps may miss.
///
/// Returns the full path to the binary, or `None` if not found anywhere.
pub fn find(binary_name: &str) -> Option<PathBuf> {
    // Build augmented search path: process PATH + platform-specific extras
    let search_path = augmented_path();

    which::which_in(binary_name, Some(&search_path), ".")
        .ok()
}

/// Build an augmented PATH string that includes common system binary directories.
/// Useful when spawning subprocesses that need the full search path.
pub fn augmented_path() -> std::ffi::OsString {
    let system_path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    // mut needed on non-Windows (EXTRA_SEARCH_DIRS / USER_RELATIVE_DIRS push below)
    #[allow(unused_mut)]
    let mut parts: Vec<String> = system_path.split(sep).map(|s| s.to_string()).collect();

    #[cfg(not(target_os = "windows"))]
    {
        // Static system directories
        for dir in EXTRA_SEARCH_DIRS {
            let d = dir.to_string();
            if !parts.contains(&d) {
                parts.push(d);
            }
        }

        // User-relative directories (expand $HOME)
        if let Some(home) = dirs::home_dir() {
            for rel in USER_RELATIVE_DIRS {
                let abs = home.join(rel).to_string_lossy().to_string();
                if !parts.contains(&abs) {
                    parts.push(abs);
                }
            }
        }
    }

    std::env::join_paths(parts).unwrap_or_default()
}
