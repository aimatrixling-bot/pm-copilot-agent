// React hook for managing auto-updates (silent background updates)
//
// Flow:
// 1. Rust checks and downloads updates silently on startup
// 2. When ready, Rust emits 'updater:ready-to-restart' event
// 3. This hook receives the event and sets updateReady = true
// 4. UI shows "Restart to Update" button in titlebar
// 5. User clicks → restartAndUpdate() → app restarts with new version

import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { relaunch } from '@tauri-apps/plugin-process';

import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { compareVersions } from '../../shared/utils';

export interface UpdateReadyInfo {
    version: string;
}

/** Result of a manual update check, used by caller for user-facing feedback (toast) */
export type CheckUpdateResult = 'up-to-date' | 'downloading' | 'error';

interface UseUpdaterResult {
    /** Whether an update has been downloaded and is ready to install */
    updateReady: boolean;
    /** The version that's ready to install */
    updateVersion: string | null;
    /** Restart the app to apply the update */
    restartAndUpdate: () => Promise<void>;
    /** Whether a manual check is in progress */
    checking: boolean;
    /** Whether an update is being downloaded */
    downloading: boolean;
    /** Manually trigger an update check. Returns result for caller to show toast feedback. */
    checkForUpdate: () => Promise<CheckUpdateResult>;
    /** Version of a pending update discovered on startup (Windows only, from disk) */
    pendingUpdateOnStartup: string | null;
    /** Dismiss the startup pending update dialog (keeps "Restart to Update" button visible) */
    dismissPendingUpdate: () => void;
}

// Detect Windows platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

// Periodic check interval: 30 minutes
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

export function useUpdater(): UseUpdaterResult {
    const [updateReady, setUpdateReady] = useState(false);
    const [updateVersion, setUpdateVersion] = useState<string | null>(null);
    const [checking, setChecking] = useState(false);
    const [downloading, setDownloading] = useState(false);
    // Windows: version from disk-persisted pending update (shown as startup dialog)
    const [pendingUpdateOnStartup, setPendingUpdateOnStartup] = useState<string | null>(null);
    const intervalRef = useRef<NodeJS.Timeout | null>(null);
    const updateReadyRef = useRef(false);
    // Ref guards for checkForUpdate to prevent race conditions on rapid clicks.
    // State values in a useCallback closure can be stale; refs are always current.
    const checkingRef = useRef(false);
    const downloadingRef = useRef(false);
    // Cache app version — it never changes during a session, no need to IPC every time.
    const appVersionRef = useRef<string | null>(null);

    // Keep ref in sync with state
    useEffect(() => {
        updateReadyRef.current = updateReady;
    }, [updateReady]);

    // Manual update check: test connectivity → compare version → download if needed
    // Returns a result string so the caller can show appropriate toast feedback.
    const checkForUpdate = useCallback(async (): Promise<CheckUpdateResult> => {
        if (!isTauriEnvironment()) {
            console.warn('[useUpdater] Manual check not available outside Tauri');
            return 'error';
        }
        // Use refs for guards — immune to stale closure on rapid clicks
        if (updateReadyRef.current) return 'downloading';  // Already downloaded, pending restart
        if (checkingRef.current || downloadingRef.current) return 'downloading';  // In progress

        checkingRef.current = true;
        setChecking(true);
        // When background download is already in progress, we keep the downloading
        // spinner visible and let the updater:ready-to-restart event clear it.
        let keepDownloadingState = false;
        try {
            // Step 1: Get remote version
            const result = await invoke('test_update_connectivity') as string;
            const versionMatch = result.match(/version:\s*([^\n]+)/);
            if (!versionMatch) {
                throw new Error('无法解析远程版本信息');
            }
            const remoteVer = versionMatch[1].trim();

            // Step 2: Get local version (cached) and compare
            if (!appVersionRef.current) {
                appVersionRef.current = await getVersion();
            }
            const comparison = compareVersions(remoteVer, appVersionRef.current);

            if (comparison <= 0) {
                // Already up to date
                return 'up-to-date';
            }

            // Step 3: New version available → download
            checkingRef.current = false;
            setChecking(false);
            downloadingRef.current = true;
            setDownloading(true);
            setUpdateVersion(remoteVer);

            const downloaded = await invoke('check_and_download_update') as boolean;
            if (downloaded) {
                // updater:ready-to-restart event will also fire and set updateReady
                setUpdateReady(true);
                return 'downloading';
            }
            // check_and_download_update returned false, but we already confirmed
            // comparison > 0 (newer version exists). This typically means the Rust
            // background download is already in progress (UPDATE_IN_PROGRESS lock).
            // Keep downloading spinner visible — updater:ready-to-restart event will
            // call setDownloading(false) and setUpdateReady(true) when background finishes.
            keepDownloadingState = true;
            return 'downloading';
        } catch (err) {
            console.error('[useUpdater] Manual check failed:', err);
            return 'error';
        } finally {
            // Always reset checking guards
            checkingRef.current = false;
            setChecking(false);
            // Only reset downloading if not handed off to background download
            if (!keepDownloadingState) {
                downloadingRef.current = false;
                setDownloading(false);
            }
        }
    }, []); // Stable reference — all mutable state accessed via refs

    // Dismiss the startup pending update dialog (keeps "Restart to Update" button visible)
    const dismissPendingUpdate = useCallback(() => {
        setPendingUpdateOnStartup(null);
    }, []);

    // Restart app to apply the update
    const restartAndUpdate = useCallback(async () => {
        if (!isTauriEnvironment()) return;

        // Track update_install event before restarting
        if (updateVersion) {
            track('update_install', { version: updateVersion });
        } else {
            track('update_install');
        }

        // Shut down all child processes first to prevent file-lock errors
        // (Windows NSIS installer fails if bun.exe is still held by SDK/MCP processes)
        try {
            await invoke('cmd_shutdown_for_update');
        } catch (err) {
            console.warn('[useUpdater] Pre-restart cleanup failed:', err);
            // Continue anyway — startup cleanup_stale_sidecars will handle leftovers
        }

        // Windows: use install_pending_update which launches NSIS from saved bytes
        // This avoids relaunch() which would just restart without applying the update
        if (isWindows) {
            try {
                await invoke('install_pending_update');
                // install_pending_update calls exit(0) on Windows, so we won't reach here
            } catch (err) {
                const errStr = String(err);
                if (errStr.includes('VERSION_MISMATCH')) {
                    console.warn('[useUpdater] Pending update version mismatch, will re-download');
                    setUpdateReady(false);
                    setUpdateVersion(null);
                    setPendingUpdateOnStartup(null);
                    // Trigger a fresh download
                    void invoke('check_and_download_update');
                } else if (errStr.includes('NETWORK_ERROR')) {
                    // Offline: update bytes are on disk but we can't verify version.
                    // Keep the update ready state so user can retry when online.
                    console.warn('[useUpdater] Network required to verify update, will retry when online');
                } else {
                    console.error('[useUpdater] install_pending_update failed:', err);
                }
            }
            return;
        }

        // macOS: relaunch picks up the already-installed update
        try {
            await relaunch();
        } catch (err) {
            console.error('[useUpdater] Restart failed:', err);
            // Fallback: try invoking the Rust command
            try {
                await invoke('restart_app');
            } catch (e) {
                console.error('[useUpdater] Rust restart also failed:', e);
            }
        }
    }, [updateVersion]);

    // Listen for update ready event from Rust
    useEffect(() => {
        if (!isTauriEnvironment()) {
            if (isDebugMode()) {
                console.log('[useUpdater] Not in Tauri environment, skipping event listener setup');
            }
            return;
        }

        if (isDebugMode()) {
            console.log('[useUpdater] Setting up event listener for updater:ready-to-restart...');
        }
        let isMounted = true;
        let unlisten: UnlistenFn | null = null;

        const setup = async () => {
            try {
                unlisten = await listen<UpdateReadyInfo>('updater:ready-to-restart', (event) => {
                    if (isDebugMode()) {
                        console.log('[useUpdater] Event received: updater:ready-to-restart', event.payload);
                    }
                    if (!isMounted) {
                        return;
                    }
                    setUpdateVersion(event.payload.version);
                    setUpdateReady(true);
                    setDownloading(false);
                });
                if (isDebugMode()) {
                    console.log('[useUpdater] Event listener registered successfully');
                }
            } catch (err) {
                console.error('[useUpdater] Failed to setup event listener:', err);
            }
        };

        void setup();

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    // Windows: check for pending update on disk at startup
    // If found, show a dialog prompting the user to install it
    useEffect(() => {
        if (!isTauriEnvironment() || !isWindows) return;

        const checkPending = async () => {
            try {
                const version = await invoke('check_pending_update') as string | null;
                if (version) {
                    if (isDebugMode()) {
                        console.log(`[useUpdater] Found pending update v${version} on disk`);
                    }
                    setPendingUpdateOnStartup(version);
                    setUpdateVersion(version);
                    setUpdateReady(true);
                }
            } catch (err) {
                console.error('[useUpdater] Failed to check pending update:', err);
            }
        };

        void checkPending();
    }, []);

    // Periodic background check (silent - just triggers Rust to check and download)
    // Uses ref to avoid recreating interval when updateReady changes
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const doCheck = async () => {
            // Use ref to get current value without dependency
            if (updateReadyRef.current) return;
            try {
                await invoke('check_and_download_update');
                // Track update_check event only after successful check
                track('update_check');
            } catch (err) {
                // Silent failure - don't bother user
                console.error('[useUpdater] Periodic check failed:', err);
            }
        };

        intervalRef.current = setInterval(() => {
            void doCheck();
        }, CHECK_INTERVAL_MS);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, []); // Empty deps - interval created once on mount

    return {
        updateReady,
        updateVersion,
        restartAndUpdate,
        checking,
        downloading,
        checkForUpdate,
        pendingUpdateOnStartup,
        dismissPendingUpdate,
    };
}
