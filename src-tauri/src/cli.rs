//! CLI mode handler for `pm-copilot` binary.
//!
//! When the binary is invoked with CLI arguments (mcp, model, status, --help, etc.),
//! it runs in CLI mode instead of starting the GUI. This avoids:
//! 1. Killing running sidecar processes (cleanup_stale_sidecars runs in GUI .setup())
//! 2. Triggering single-instance window focus
//! 3. Starting the full Tauri app just for a CLI query
//!
//! The CLI forwards arguments to the Bun CLI script at ~/.pm-copilot/bin/pm-copilot,
//! which handles argument parsing, HTTP requests to the Sidecar Admin API, and
//! output formatting.

use std::path::PathBuf;
use std::process::{Command, Stdio};

/// CLI subcommands that trigger CLI mode
const CLI_COMMANDS: &[&str] = &[
    "mcp", "model", "agent", "config", "status", "reload", "version",
    "cron", "plugin",
];

/// Check if the given args indicate CLI mode.
/// Returns true if any argument is a known CLI subcommand or --help/-h.
pub fn is_cli_mode(args: &[String]) -> bool {
    args.iter().any(|a| {
        CLI_COMMANDS.contains(&a.as_str()) || a == "--help" || a == "-h"
    })
}

/// Run the CLI by forwarding args to the Bun CLI script.
/// Returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    // On Windows, re-attach to parent console so stdout/stderr are visible.
    // The `windows_subsystem = "windows"` attribute suppresses the console for GUI mode,
    // but CLI mode needs it.
    #[cfg(windows)]
    {
        extern "system" {
            fn AttachConsole(dwProcessId: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }

    // 1. Find the bun binary (sibling of this executable in the app bundle)
    let bun_path = match find_bun_binary() {
        Some(p) => p,
        None => {
            eprintln!("Error: Cannot find bundled Bun runtime.");
            return 1;
        }
    };

    // 2. Find the CLI script at ~/.pm-copilot/bin/pm-copilot
    let cli_script = match find_cli_script() {
        Some(p) => p,
        None => {
            eprintln!("Error: CLI script not found at ~/.pm-copilot/bin/pm-copilot");
            eprintln!("Please launch the PM Copilot app at least once to initialize the CLI.");
            return 1;
        }
    };

    // 3. Discover the Global Sidecar port from the port file
    let port = discover_sidecar_port();

    // 4. Spawn the Bun CLI script with all original args
    // NOTE: Intentionally using raw Command::new instead of process_cmd::new().
    // process_cmd applies CREATE_NO_WINDOW on Windows, but CLI mode NEEDS the
    // console for user-visible stdout/stderr output. Same exception category as
    // OS opener commands (open/explorer/xdg-open) documented in CLAUDE.md.
    let mut cmd = Command::new(&bun_path);
    cmd.arg(&cli_script);
    cmd.args(args);

    // Inherit stdio so the user sees output directly
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::inherit());
    cmd.stderr(Stdio::inherit());

    // Inject sidecar port if available (the Bun script reads PM_COPILOT_PORT)
    if let Some(ref p) = port {
        cmd.env("PM_COPILOT_PORT", p);
    }

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            eprintln!("Error: Failed to execute CLI: {}", e);
            1
        }
    }
}

/// Find the bundled bun binary (co-located with this executable in the app bundle).
/// macOS: /Applications/PM Copilot.app/Contents/MacOS/bun
/// Windows: <install-dir>/bun.exe
fn find_bun_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;

    // macOS/Linux
    let bun = dir.join("bun");
    if bun.exists() {
        return Some(bun);
    }

    // Windows
    let bun_exe = dir.join("bun.exe");
    if bun_exe.exists() {
        return Some(bun_exe);
    }

    None
}

/// Find the CLI script at ~/.pm-copilot/bin/pm-copilot.
/// This script is synced from src/cli/ by cmd_sync_cli.
fn find_cli_script() -> Option<PathBuf> {
    let home = dirs::home_dir()?;

    // Primary: ~/.pm-copilot/bin/pm-copilot
    let script = home.join(".pm-copilot").join("bin").join("pm-copilot");
    if script.exists() {
        return Some(script);
    }

    // Windows: ~/.pm-copilot/bin/pm-copilot.cmd
    #[cfg(windows)]
    {
        let cmd_script = home.join(".pm-copilot").join("bin").join("pm-copilot.cmd");
        if cmd_script.exists() {
            return Some(cmd_script);
        }
    }

    None
}

/// Read the Global Sidecar port from ~/.pm-copilot/sidecar.port.
/// This file is written by sidecar.rs when the Global Sidecar starts.
/// Validates the port is a valid u16 to guard against stale/corrupt files.
fn discover_sidecar_port() -> Option<String> {
    let home = dirs::home_dir()?;
    let port_file = home.join(".pm-copilot").join("sidecar.port");
    let content = std::fs::read_to_string(port_file).ok()?;
    let port = content.trim().to_string();
    // Validate: must be a valid port number (1-65535)
    if port.parse::<u16>().is_ok() {
        Some(port)
    } else {
        None
    }
}
