/**
 * File Watcher — 监听工作区文件系统变化，通过 SSE 推送给前端刷新目录树。
 *
 * 设计要点：
 * - 使用 fs.watch({ recursive: true })，macOS/Windows 原生支持递归监听
 * - 500ms debounce：文件操作常常是批量的（npm install、git checkout），
 *   debounce 合并成一次 SSE 事件，前端只刷新一次
 * - 忽略 .git / node_modules / dist 等目录变化（基于 dir-info.ts DEFAULT_IGNORES，额外加 .DS_Store）
 * - 每个 Sidecar 进程最多一个 watcher 实例（Sidecar:Session 1:1，所以一个就够）
 * - Error 自动重启：瞬态错误（EMFILE、目录短暂重命名）不会永久降级到轮询
 */

import { watch, type FSWatcher } from 'fs';
import { broadcast } from './sse';

/** Directories/files to ignore — based on dir-info.ts DEFAULT_IGNORES + .DS_Store (macOS metadata) */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'out', 'dist', 'tmp', '.DS_Store']);

/** Check if a changed path should be ignored */
function shouldIgnore(filename: string | null): boolean {
  if (!filename) return false; // null filename means we can't filter — let it through
  const segments = filename.replace(/\\/g, '/').split('/');
  return segments.some(seg => IGNORED_SEGMENTS.has(seg));
}

let currentWatcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let currentWatchPath: string | null = null;

/** Retry delay for auto-restart after watcher error (3 seconds) */
const RESTART_DELAY_MS = 3_000;

/**
 * Start watching the workspace directory for file changes.
 * Automatically stops any previously running watcher.
 * On error, automatically attempts to restart after a delay.
 */
export function startFileWatcher(workspacePath: string): void {
  // Avoid duplicate watcher on same path
  if (currentWatcher && currentWatchPath === workspacePath) return;

  // Stop existing watcher if switching workspace
  stopFileWatcher();

  currentWatchPath = workspacePath;

  try {
    currentWatcher = watch(workspacePath, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnore(filename as string | null)) return;

      // Debounce: wait 500ms after last change before broadcasting
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        broadcast('workspace:files-changed', { timestamp: Date.now() });
      }, 500);
    });

    currentWatcher.on('error', (err) => {
      // Watcher errors are non-fatal — log, stop, and schedule auto-restart.
      // Common causes: EMFILE (too many open files), directory temporarily renamed
      // during git operations. Without restart, a single transient error would
      // permanently degrade the app to 120s polling for the rest of the sidecar lifetime.
      console.error(`[file-watcher] watcher error: ${err.message}, will restart in ${RESTART_DELAY_MS}ms`);
      const pathToRestart = currentWatchPath;
      // Stop the broken watcher (clears currentWatcher/currentWatchPath)
      cleanupWatcher();
      // Schedule restart — startFileWatcher will re-create the watcher
      if (pathToRestart) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          console.log(`[file-watcher] attempting auto-restart for: ${pathToRestart}`);
          startFileWatcher(pathToRestart);
        }, RESTART_DELAY_MS);
      }
    });

    console.log(`[file-watcher] started watching: ${workspacePath}`);
  } catch (err) {
    // fs.watch can throw on invalid path — non-fatal, fall back to polling
    console.error('[file-watcher] failed to start (falling back to polling):', (err as Error).message);
    currentWatcher = null;
    currentWatchPath = null;
  }
}

/**
 * Stop the file watcher, clear pending timers. Called on workspace switch
 * or externally (e.g., sidecar shutdown hook).
 */
export function stopFileWatcher(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  cleanupWatcher();
}

/** Internal cleanup — stops watcher and debounce timer without cancelling restart */
function cleanupWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (currentWatcher) {
    currentWatcher.close();
    currentWatcher = null;
    currentWatchPath = null;
  }
}
