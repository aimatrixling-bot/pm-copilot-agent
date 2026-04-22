// Infrastructure layer — async locks, safe file I/O, config directory management
import {
    copyFile,
    exists,
    mkdir,
    readTextFile,
    writeTextFile,
    remove,
    rename,
} from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';
import { isBrowserDevMode } from '@/utils/browserMock';

// Re-export for convenience
export { isBrowserDevMode };

// ============= Async Lock =============

export function createAsyncLock() {
    let queue: Promise<void> = Promise.resolve();
    return function withLock<T>(fn: () => Promise<T>): Promise<T> {
        let release: () => void;
        const next = new Promise<void>(resolve => { release = resolve; });
        const prev = queue;
        queue = next;
        return prev.then(fn).finally(() => release!());
    };
}

export const withProjectsLock = createAsyncLock();
export const withConfigLock = createAsyncLock();

// ============= Constants =============

export const CONFIG_DIR_NAME = '.pm-copilot';
export const CONFIG_FILE = 'config.json';
export const PROJECTS_FILE = 'projects.json';
export const PROVIDERS_DIR = 'providers';

// ============= Safe File I/O Utilities =============

/**
 * Atomically write JSON data to a file with .bak backup.
 *
 * Steps:
 * 1. Write to .tmp (if interrupted here, original file is untouched)
 * 2. Copy current file → .bak (best-effort backup; main file stays intact)
 * 3. Rename .tmp → target (atomic overwrite — main is never absent)
 *
 * Key invariant: the main file is never removed. rename() atomically replaces
 * the destination on both POSIX (rename syscall) and Windows (MOVEFILE_REPLACE_EXISTING).
 * This eliminates the window where concurrent readers would see "file not found".
 */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
    const tmpPath = filePath + '.tmp';
    const bakPath = filePath + '.bak';
    const content = JSON.stringify(data, null, 2);

    // 1. Write new data to .tmp
    await writeTextFile(tmpPath, content);

    // 2. Backup current file → .bak (best-effort, copy preserves main)
    try {
        if (await exists(filePath)) {
            if (await exists(bakPath)) {
                await remove(bakPath);
            }
            await copyFile(filePath, bakPath);
        }
    } catch (bakErr) {
        console.warn('[configStore] Failed to create .bak backup:', bakErr);
    }

    // 3. Atomic overwrite: .tmp → target (main file is never absent)
    await rename(tmpPath, filePath);
}

/**
 * Load and parse a JSON file with automatic recovery from .bak and .tmp.
 *
 * Read-only: this function never writes files. Recovery from .bak/.tmp is
 * transparent — the next safeWriteJson call will overwrite main with fresh data.
 * This avoids race conditions where a "recovery write" inside a read could
 * conflict with a concurrent writer holding the config lock.
 */
export async function safeLoadJson<T>(
    filePath: string,
    validate?: (data: unknown) => data is T,
): Promise<T | null> {
    const candidates = [
        { path: filePath, label: 'main' },
        { path: filePath + '.bak', label: 'bak' },
        { path: filePath + '.tmp', label: 'tmp' },
    ];

    for (const { path, label } of candidates) {
        if (!(await exists(path))) continue;
        try {
            const content = await readTextFile(path);
            const parsed = JSON.parse(content);
            if (validate && !validate(parsed)) {
                console.error(`[configStore] ${label} file has invalid structure, skipping`);
                continue;
            }
            if (label !== 'main') {
                console.warn(`[configStore] Recovered data from .${label} file (next write will restore main)`);
            }
            return parsed as T;
        } catch (err) {
            console.error(`[configStore] ${label} file corrupted or unreadable:`, err);
        }
    }
    return null;
}

// ============= Config Directory =============

let configDirPath: string | null = null;

export async function getConfigDir(): Promise<string> {
    if (configDirPath) return configDirPath;

    const home = await homeDir();
    configDirPath = await join(home, CONFIG_DIR_NAME);
    console.log('[configStore] Config directory:', configDirPath);
    return configDirPath;
}

export async function ensureConfigDir(): Promise<void> {
    const dir = await getConfigDir();
    if (!(await exists(dir))) {
        console.log('[configStore] Creating config directory:', dir);
        await mkdir(dir, { recursive: true });
    }

    const providersDir = await join(dir, PROVIDERS_DIR);
    if (!(await exists(providersDir))) {
        await mkdir(providersDir, { recursive: true });
    }
}
