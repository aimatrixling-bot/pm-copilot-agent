// Shared environment utilities for external runtime subprocesses (v0.1.60)

import { getShellEnv, getShellPath } from '../utils/shell';
import { which } from 'bun';

const isWindows = process.platform === 'win32';

/**
 * Build an augmented env for spawning external CLI runtimes (claude, codex).
 *
 * Delegates to getShellEnv() which already handles:
 * - Windows: system PATH + npm global (%APPDATA%\npm), Git, Bun, Node.js
 * - macOS: shell -l PATH detection + homebrew, NVM, pnpm, Bun
 * - PATH key normalization (Windows Path vs Unix PATH)
 *
 * Previously this function had its own hardcoded Unix-only PATH augmentation,
 * which missed Windows paths like %APPDATA%\npm → "Executable not found". See: #70
 *
 * NOTE: The Sidecar process already has NO_PROXY injected by Rust's
 * proxy_config::apply_to_subprocess(). getShellEnv() spreads process.env,
 * so external CLI subprocesses spawned here are also protected.
 */
export function augmentedProcessEnv(): Record<string, string | undefined> {
  return getShellEnv();
}

/**
 * Resolve an external CLI command to its full executable path.
 *
 * On Windows, npm global installs create `.cmd` wrappers (e.g., `claude.cmd`).
 * Bun.spawn() uses libuv's uv_spawn which does NOT resolve PATH extensions
 * (.CMD, .BAT, .PS1) like cmd.exe does. Spawning bare `claude` → ENOENT.
 *
 * This function uses Bun.which() with the augmented PATH to find the real path
 * (e.g., `C:\Users\xxx\AppData\Roaming\npm\claude.cmd`), then spawns that directly.
 * On macOS/Linux, returns the command as-is (Unix doesn't have this issue). See: #70
 */
export function resolveCommand(command: string): string {
  if (!isWindows) return command;
  const resolved = which(command, { PATH: getShellPath() });
  if (resolved) return resolved;
  // Fallback: return as-is and let spawn fail with a clear error
  return command;
}
