/**
 * Runtime Path Utilities
 *
 * Provides functions to locate bundled bun or fallback to system runtimes.
 * This ensures the app can run without requiring users to have Node.js installed.
 */

import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get script directory at runtime (not compile-time).
 * IMPORTANT: bun build hardcodes __dirname at compile time, breaking production builds.
 * This function uses import.meta.url which is evaluated at runtime.
 */
export function getScriptDir(): string {
  // For ESM modules: use import.meta.url
  if (typeof import.meta?.url === 'string') {
    return dirname(fileURLToPath(import.meta.url));
  }
  // Fallback for bundled environments - use cwd
  // NOTE: In production, sidecar.rs sets cwd to Resources directory
  console.warn('[getScriptDir] import.meta.url unavailable, falling back to cwd:', process.cwd());
  return process.cwd();
}

/**
 * Check if running on Windows
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Get the bun executable name based on platform
 */
function getBunExecutableName(): string {
  return isWindows() ? 'bun.exe' : 'bun';
}

/**
 * Get bundled bun paths inside the app bundle.
 * These are the primary paths we check first.
 *
 * Directory structure:
 * - Windows: Flat structure, bun.exe and server-dist.js in same directory
 *   C:\Users\xxx\AppData\Local\PM Copilot\
 *   ├── bun.exe
 *   ├── server-dist.js
 *   └── pm-copilot.exe
 *
 * - macOS: App bundle structure
 *   PM Copilot.app/Contents/
 *   ├── MacOS/bun         <- bundled bun
 *   └── Resources/server-dist.js  <- scriptDir
 */
function getBundledBunPaths(): string[] {
  const scriptDir = getScriptDir();
  const bunExe = getBunExecutableName();

  if (isWindows()) {
    // Windows: Flat structure - bun.exe is in the same directory as server-dist.js
    // scriptDir = C:\Users\xxx\AppData\Local\PM Copilot (installation directory)
    return [
      resolve(scriptDir, bunExe),
      resolve(scriptDir, 'bun-x86_64-pc-windows-msvc.exe'),
    ];
  }

  // macOS: bun is in Contents/MacOS
  // In bundled app: scriptDir = .../Contents/Resources
  // So MacOS is at .../Contents/MacOS
  return [
    resolve(scriptDir, '..', 'MacOS', 'bun'),
  ];
}

/**
 * Get the directory containing bundled bun executable.
 * Returns null if bundled bun is not found.
 *
 * This is used by agent-session.ts to add the bundled bun directory to PATH.
 */
export function getBundledBunDir(): string | null {
  const scriptDir = getScriptDir();
  const bunExe = getBunExecutableName();

  if (isWindows()) {
    // Windows: Check same directory as server-dist.js
    const bunPath = resolve(scriptDir, bunExe);
    if (existsSync(bunPath)) {
      return scriptDir;
    }
    // Also check for alternative bun naming
    const altBunPath = resolve(scriptDir, 'bun-x86_64-pc-windows-msvc.exe');
    if (existsSync(altBunPath)) {
      return scriptDir;
    }
  } else {
    // macOS: Check Contents/MacOS directory
    const macOSDir = resolve(scriptDir, '..', 'MacOS');
    const bunPath = resolve(macOSDir, 'bun');
    if (existsSync(bunPath)) {
      return macOSDir;
    }
  }

  return null;
}

/**
 * Get system bun paths (user-installed).
 */
function getSystemBunPaths(): string[] {
  const paths: string[] = [];

  if (isWindows()) {
    // Windows paths
    const userProfile = process.env.USERPROFILE;
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.PROGRAMFILES;

    if (userProfile) {
      paths.push(resolve(userProfile, '.bun', 'bin', 'bun.exe'));
    }
    if (localAppData) {
      paths.push(resolve(localAppData, 'bun', 'bin', 'bun.exe'));
    }
    if (programFiles) {
      paths.push(resolve(programFiles, 'bun', 'bun.exe'));
    }
  } else {
    // Unix paths (macOS/Linux)
    const homeDir = process.env.HOME;

    // User's bun installation
    if (homeDir) {
      paths.push(`${homeDir}/.bun/bin/bun`);
    }

    // macOS Homebrew paths
    paths.push('/opt/homebrew/bin/bun');

    // Linux paths
    paths.push('/usr/local/bin/bun');
    paths.push('/usr/bin/bun');
  }

  return paths;
}

/**
 * Get system node paths (user-installed).
 */
/**
 * Get system Node.js directories where node/npm/npx are co-located.
 * Single source of truth — node, npm, npx share the same directories.
 */
export function getSystemNodeDirs(): string[] {
  if (isWindows()) {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env['PROGRAMFILES(X86)'];
    const localAppData = process.env.LOCALAPPDATA;
    const dirs: string[] = [];
    // Standard Node.js installer
    if (programFiles) dirs.push(resolve(programFiles, 'nodejs'));
    if (programFilesX86) dirs.push(resolve(programFilesX86, 'nodejs'));
    // nvm-windows: symlinks active version to NVM_SYMLINK (default: Program Files\nodejs)
    const nvmSymlink = process.env.NVM_SYMLINK;
    if (nvmSymlink) dirs.push(nvmSymlink);
    // Volta: shims live in %LOCALAPPDATA%\Volta\bin
    if (localAppData) dirs.push(resolve(localAppData, 'Volta', 'bin'));
    // fnm: session-specific path via env var
    const fnmPath = process.env.FNM_MULTISHELL_PATH;
    if (fnmPath) dirs.push(fnmPath);
    return dirs;
  }

  const home = process.env.HOME || '';
  return [
    '/opt/homebrew/bin',      // macOS Homebrew (Apple Silicon)
    '/usr/local/bin',         // macOS Homebrew (Intel) / Linux manual install
    '/usr/bin',               // Linux apt/yum
    ...(home ? [
      `${home}/.volta/bin`,   // Volta
      `${home}/.nvm/current/bin`,  // nvm
      `${home}/.fnm/current/bin`,  // fnm
    ] : []),
  ];
}

function getSystemNodePaths(): string[] {
  const exe = isWindows() ? 'node.exe' : 'node';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

function getSystemNpmPaths(): string[] {
  const exe = isWindows() ? 'npm.cmd' : 'npm';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

export function getSystemNpxPaths(): string[] {
  const exe = isWindows() ? 'npx.cmd' : 'npx';
  return getSystemNodeDirs().map(d => resolve(d, exe));
}

/**
 * Find the first existing path from a list.
 */
export function findExistingPath(paths: string[]): string | null {
  for (const p of paths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Get the directory containing the bundled Node.js distribution.
 * Returns the directory that should be added to PATH so that `node`, `npm`, `npx`
 * are all available. Returns null if bundled Node.js is not found.
 *
 * Directory structure:
 * - macOS (prod):  Contents/Resources/nodejs/bin/  (contains node, npm, npx)
 * - macOS (dev):   src-tauri/resources/nodejs/bin/
 * - Windows (prod): <install_dir>/nodejs/           (contains node.exe, npm.cmd, npx.cmd)
 * - Windows (dev):  src-tauri/resources/nodejs/
 */
export function getBundledNodeDir(): string | null {
  const scriptDir = getScriptDir();

  if (isWindows()) {
    // Windows prod: nodejs/ is alongside server-dist.js
    const winDir = resolve(scriptDir, 'nodejs');
    if (existsSync(resolve(winDir, 'node.exe'))) {
      return winDir;
    }
  } else {
    // macOS prod: Contents/Resources/nodejs/bin/
    // scriptDir = Contents/Resources, so nodejs/bin/ is a subdirectory
    const macDir = resolve(scriptDir, 'nodejs', 'bin');
    if (existsSync(resolve(macDir, 'node'))) {
      return macDir;
    }
  }

  // Development: walk up from scriptDir to find src-tauri/resources/nodejs/
  let dir = scriptDir;
  for (let i = 0; i < 6; i++) {
    const devBinDir = resolve(dir, 'src-tauri', 'resources', 'nodejs', 'bin');
    const devWinDir = resolve(dir, 'src-tauri', 'resources', 'nodejs');
    if (!isWindows() && existsSync(resolve(devBinDir, 'node'))) {
      return devBinDir;
    }
    if (isWindows() && existsSync(resolve(devWinDir, 'node.exe'))) {
      return devWinDir;
    }
    dir = dirname(dir);
  }

  return null;
}

/**
 * Get the absolute path to the bundled Node.js binary.
 * Returns null if bundled Node.js is not found.
 */
export function getBundledNodePath(): string | null {
  const nodeDir = getBundledNodeDir();
  if (!nodeDir) return null;

  const nodeBin = isWindows() ? resolve(nodeDir, 'node.exe') : resolve(nodeDir, 'node');
  return existsSync(nodeBin) ? nodeBin : null;
}

/**
 * Check if a path is a bun executable (not just contains 'bun' in path).
 */
export function isBunRuntime(runtimePath: string): boolean {
  // Get the executable name from the path (handle both / and \ separators)
  const separator = isWindows() ? /[\\/]/ : /\//;
  const parts = runtimePath.split(separator);
  const execName = (parts.pop() || '').toLowerCase();
  // Check if the executable name is 'bun' or 'bun.exe' or starts with 'bun-'
  return execName === 'bun' || execName === 'bun.exe' || execName.startsWith('bun-');
}

/**
 * Get the path to a JavaScript runtime (bun or node).
 *
 * Priority order:
 * 1. Bundled bun (inside app bundle /Contents/MacOS/bun)
 * 2. System bun (~/.bun/bin/bun, /opt/homebrew/bin/bun)
 * 3. System node (various paths)
 *
 * This ensures MCP and other features work without requiring Node.js.
 *
 * @returns Absolute path to the runtime, or 'node' as fallback
 */
export function getBundledRuntimePath(): string {
  // Try bundled bun first
  const bundledBun = findExistingPath(getBundledBunPaths());
  if (bundledBun) {
    return bundledBun;
  }

  // Try system bun
  const systemBun = findExistingPath(getSystemBunPaths());
  if (systemBun) {
    return systemBun;
  }

  // Try system node
  const systemNode = findExistingPath(getSystemNodePaths());
  if (systemNode) {
    return systemNode;
  }

  // Last resort fallback - rely on PATH
  return 'node';
}

/**
 * Get the path to the bundled agent-browser CLI entry point (agent-browser.js).
 *
 * Search order:
 * 1. Production (macOS): Contents/Resources/agent-browser-cli/node_modules/agent-browser/bin/agent-browser.js
 * 2. Production (Windows): <install-dir>/agent-browser-cli/node_modules/agent-browser/bin/agent-browser.js
 * 3. Development: <project-root>/agent-browser-cli/node_modules/agent-browser/bin/agent-browser.js
 * 4. User-local install: ~/.pm-copilot/agent-browser-cli/node_modules/agent-browser/bin/agent-browser.js
 *
 * @returns Absolute path to agent-browser.js, or null if not found
 */
export function getAgentBrowserCliPath(): string | null {
  const relPath = join('agent-browser-cli', 'node_modules', 'agent-browser', 'bin', 'agent-browser.js');
  const scriptDir = getScriptDir();

  // Production: agent-browser-cli is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, relPath);
  if (existsSync(prodPath)) return prodPath;

  // Development: walk up from scriptDir to find agent-browser-cli at project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, relPath);
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  // User-local: auto-installed to ~/.pm-copilot/agent-browser-cli/
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir) {
    const userPath = resolve(homeDir, '.pm-copilot', relPath);
    if (existsSync(userPath)) return userPath;
  }

  return null;
}

/**
 * Get the path to a package manager for installing npm packages.
 *
 * Priority order:
 * 1. Bundled bun (can install npm packages via `bun add`)
 * 2. System bun
 * 3. System npm (if user has Node.js)
 *
 * @returns { command: string, installArgs: (pkg: string) => string[], type: 'bun' | 'npm' }
 */
export function getPackageManagerPath(): {
  command: string;
  installArgs: (packageName: string) => string[];
  type: 'bun' | 'npm';
} {
  // Try bundled bun first
  const bundledBun = findExistingPath(getBundledBunPaths());
  if (bundledBun) {
    console.log(`[runtime] Using bundled bun: ${bundledBun}`);
    return {
      command: bundledBun,
      installArgs: (pkg) => ['add', pkg],
      type: 'bun' as const,
    };
  }

  // Try system bun
  const systemBun = findExistingPath(getSystemBunPaths());
  if (systemBun) {
    console.log(`[runtime] Using system bun: ${systemBun}`);
    return {
      command: systemBun,
      installArgs: (pkg) => ['add', pkg],
      type: 'bun' as const,
    };
  }

  // Fallback to npm (requires Node.js)
  const systemNpm = findExistingPath(getSystemNpmPaths());
  if (systemNpm) {
    console.log(`[runtime] Using system npm: ${systemNpm}`);
    return {
      command: systemNpm,
      installArgs: (pkg) => ['install', pkg],
      type: 'npm' as const,
    };
  }

  // Last resort - try npm from PATH
  console.warn('[runtime] No bundled runtime found, falling back to npm from PATH');
  return {
    command: 'npm',
    installArgs: (pkg) => ['install', pkg],
    type: 'npm' as const,
  };
}
