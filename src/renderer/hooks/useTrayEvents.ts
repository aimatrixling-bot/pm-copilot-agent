// Hook for handling system tray events and window close behavior
// Manages minimize-to-tray functionality and exit confirmation

import { useEffect, useCallback, useRef } from 'react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { dismissTopmost } from '@/utils/closeLayer';
import { setWindowVisible, consumePendingNavigation } from '@/services/notificationService';

interface TrayEventsOptions {
  /** Whether minimize to tray is enabled */
  minimizeToTray: boolean;
  /** Callback when settings should be opened */
  onOpenSettings?: () => void;
  /** Callback when exit is requested (for confirmation if cron tasks are running) */
  onExitRequested?: () => Promise<boolean>;
  /** Callback when notification click triggers navigation to a specific tab */
  onNavigateToTab?: (tabId: string) => void;
  /** Callback for Cmd+W close-tab action (after overlay dismissal).
   *  closeCurrentTab() auto-creates launcher on last tab; launcher is a no-op. */
  onCmdWCloseTab?: () => void;
}

export function useTrayEvents(options: TrayEventsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Handle window hide (minimize to tray)
  const hideWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.hide();
      console.log('[useTrayEvents] Window hidden to tray');
    } catch (error) {
      console.error('[useTrayEvents] Failed to hide window:', error);
    }
  }, []);

  // Handle window close (either hide or exit)
  const closeWindow = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.close();
    } catch (error) {
      console.error('[useTrayEvents] Failed to close window:', error);
    }
  }, []);

  // Confirm and exit the app
  const confirmExit = useCallback(async () => {
    if (!isTauriEnvironment()) return;

    try {
      const { emit } = await import('@tauri-apps/api/event');
      // Emit event to Rust to confirm exit
      await emit('tray:confirm-exit');
    } catch (error) {
      console.error('[useTrayEvents] Failed to emit exit event:', error);
    }
  }, []);

  // Setup event listeners
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlistenCmdW: (() => void) | null = null;
    let unlistenCloseRequested: (() => void) | null = null;
    let unlistenOpenSettings: (() => void) | null = null;
    let unlistenExitRequested: (() => void) | null = null;
    let unlistenFocusChanged: (() => void) | null = null;

    const setupListeners = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const window = getCurrentWindow();

        // Listen for window focus changes (including when window is shown from tray)
        // Track previous visibility to detect hidden→visible transitions
        let wasHidden = false;
        unlistenFocusChanged = await window.onFocusChanged(({ payload: focused }) => {
          console.debug('[useTrayEvents] Window focus changed:', focused);
          if (focused) {
            // Only consume pending navigation when window transitions from hidden to visible
            // (not on every focus event, which would hijack navigation on alt-tab)
            const shouldConsumeNav = wasHidden;
            wasHidden = false;

            // Window is now visible and focused
            setWindowVisible(true);

            if (shouldConsumeNav) {
              // Check if a notification was recently sent — auto-navigate to that tab
              const targetTabId = consumePendingNavigation();
              if (targetTabId) {
                console.log('[useTrayEvents] Auto-navigating to tab from notification:', targetTabId);
                optionsRef.current.onNavigateToTab?.(targetTabId);
              }
            }
          }
        });

        // ── Cmd+W handler (macOS custom menu item → window:cmd-w) ──
        // Separated from X button (CloseRequested). Cmd+W walks the close hierarchy:
        // overlay → split panel → tab → launcher (terminal state, never exits).
        unlistenCmdW = await listen('window:cmd-w', () => {
          console.log('[useTrayEvents] Cmd+W received');
          // 1. Try dismissing topmost overlay/panel
          if (dismissTopmost()) {
            console.log('[useTrayEvents] Cmd+W: overlay dismissed');
            return;
          }
          // 2. Safety net: unregistered overlay visible → block (safe degradation)
          if (document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')) {
            console.log('[useTrayEvents] Cmd+W: unregistered overlay visible, blocked');
            return;
          }
          // 3. Close current tab (auto-creates launcher on last tab; launcher is no-op)
          optionsRef.current.onCmdWCloseTab?.();
          console.log('[useTrayEvents] Cmd+W: tab closed');
        });

        // ── X button / system close (CloseRequested → window:close-requested) ──
        // Pure tray/exit behavior — no overlay/tab logic (that's Cmd+W's job).
        unlistenCloseRequested = await listen('window:close-requested', async () => {
          console.log('[useTrayEvents] Window close requested (X button)');
          const { minimizeToTray } = optionsRef.current;

          if (minimizeToTray) {
            const window = getCurrentWindow();
            await window.hide();
            wasHidden = true;
            setWindowVisible(false);
            console.log('[useTrayEvents] Window hidden to tray');
          } else {
            const { onExitRequested } = optionsRef.current;
            if (onExitRequested) {
              const canExit = await onExitRequested();
              if (canExit) {
                const { emit } = await import('@tauri-apps/api/event');
                await emit('tray:confirm-exit');
              }
            } else {
              const { emit } = await import('@tauri-apps/api/event');
              await emit('tray:confirm-exit');
            }
          }
        });

        // Listen for tray "open settings" menu click
        unlistenOpenSettings = await listen('tray:open-settings', () => {
          console.log('[useTrayEvents] Open settings from tray');
          const { onOpenSettings } = optionsRef.current;
          if (onOpenSettings) {
            onOpenSettings();
          }
        });

        // Listen for tray "exit" menu click
        unlistenExitRequested = await listen('tray:exit-requested', async () => {
          console.log('[useTrayEvents] Exit requested from tray');
          const { onExitRequested } = optionsRef.current;
          if (onExitRequested) {
            const canExit = await onExitRequested();
            if (canExit) {
              const { emit } = await import('@tauri-apps/api/event');
              await emit('tray:confirm-exit');
            }
          } else {
            const { emit } = await import('@tauri-apps/api/event');
            await emit('tray:confirm-exit');
          }
        });

        console.log('[useTrayEvents] Event listeners setup complete');
      } catch (error) {
        console.error('[useTrayEvents] Failed to setup listeners:', error);
      }
    };

    setupListeners();

    return () => {
      if (unlistenCmdW) unlistenCmdW();
      if (unlistenCloseRequested) unlistenCloseRequested();
      if (unlistenOpenSettings) unlistenOpenSettings();
      if (unlistenExitRequested) unlistenExitRequested();
      if (unlistenFocusChanged) unlistenFocusChanged();
    };
  }, []);

  return {
    hideWindow,
    closeWindow,
    confirmExit,
  };
}
