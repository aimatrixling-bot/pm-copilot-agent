import { useCallback, useEffect, useState, useRef, memo } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

import { initAnalytics, track } from '@/analytics';
import { stopTabSidecar, startGlobalSidecar, initGlobalSidecarReadyPromise, markGlobalSidecarReady, getGlobalServerUrl, getSessionActivation, updateSessionTab, ensureSessionSidecar, releaseSessionSidecar, activateSession, deactivateSession, upgradeSessionId, getSessionPort, stopSseProxy, startBackgroundCompletion, cancelBackgroundCompletion, updateGlobalServerUrl } from '@/api/tauriClient';
import ConfirmDialog from '@/components/ConfirmDialog';
import BugReportOverlay from '@/components/BugReportOverlay';
import CustomTitleBar from '@/components/CustomTitleBar';
import TabBar from '@/components/TabBar';
import TabProvider from '@/context/TabProvider';
import { useToast } from '@/components/Toast';
import { useUpdater } from '@/hooks/useUpdater';
import { useTrayEvents } from '@/hooks/useTrayEvents';
import { notifyCronTaskComplete } from '@/services/notificationService';
import { useConfig } from '@/hooks/useConfig';
import { useThemeEffect } from '@/hooks/useTheme';
import { useTabSwipeGesture } from '@/hooks/useTabSwipeGesture';
import Chat from '@/pages/Chat';
import Launcher from '@/pages/Launcher';
import Settings from '@/pages/Settings';
import {
  type Project,
  type Provider,
} from '@/config/types';
import { type Tab, type InitialMessage, createNewTab, getFolderName, MAX_TABS } from '@/types/tab';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import { getAllCronTasks, getTabCronTask, updateCronTaskTab } from '@/api/cronTaskClient';
import { type CronRecoverySummaryPayload, type CronTaskRecoveredPayload, CRON_EVENTS } from '@/types/cronEvents';
import { isBrowserDevMode, isTauriEnvironment } from '@/utils/browserMock';
import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { updateSession } from '@/api/sessionClient';
import { dismissTopmost } from '@/utils/closeLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { forceFlushLogs, setLogServerUrl, clearLogServerUrl } from '@/utils/frontendLogger';
import { CUSTOM_EVENTS, createPendingSessionId } from '../shared/constants';
import { ensureSelfAwarenessWorkspace } from '@/config/configService';
import { Loader2 } from 'lucide-react';

// ============================================================
// User Support Prompt Builder
// ============================================================

function buildSupportPrompt(description: string, appVersion: string): string {
  return [
    `## 用户反馈`,
    ``,
    `**App 版本**: ${appVersion}`,
    ``,
    `> ${description}`,
    ``,
    `请使用 /support skill 帮助用户解决这个问题。`,
  ].join('\n');
}

// ============================================================
// MemoizedTabContent — prevents re-rendering tabs whose props haven't changed.
// When switching tabs, only the newly active and previously active tabs re-render.
// ============================================================

interface TabContentProps {
  tab: Tab;
  isActive: boolean;
  isLoading: boolean;
  error: string | null;
  settingsInitialSection: string | undefined;
  settingsInitialMcpId: string | undefined;
  // Launcher callbacks
  onLaunchProject: (project: Project, provider: Provider, sessionId?: string, initialMessage?: InitialMessage) => void;
  // Chat callbacks
  onBack: () => Promise<void>;
  onSwitchSession: (tabId: string, sessionId: string) => Promise<void>;
  onNewSession: (tabId: string) => Promise<boolean>;
  onUpdateGenerating: (tabId: string, isGenerating: boolean) => void;
  onUpdateTitle: (tabId: string, title: string) => void;
  onUpdateUnread: (tabId: string, hasUnread: boolean) => void;
  onRenameSession: (tabId: string, newTitle: string) => void;
  onForkSession: (tabId: string, newSessionId: string, agentDir: string, title: string, initialMessage?: string) => void;
  onUpdateSessionId: (tabId: string, newSessionId: string) => Promise<void>;
  onClearInitialMessage: (tabId: string) => void;
  onClearJoinedExistingSidecar: (tabId: string) => void;
  // Settings callbacks
  onSettingsSectionChange: () => void;
  updateReady: boolean;
  updateVersion: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  onCheckForUpdate: () => Promise<'up-to-date' | 'downloading' | 'error'>;
  onRestartAndUpdate: () => void;
}

const MemoizedTabContent = memo(function TabContent({
  tab, isActive, isLoading, error,
  onLaunchProject, onBack, onSwitchSession, onNewSession,
  onUpdateGenerating, onUpdateTitle, onUpdateUnread, onRenameSession, onForkSession, onUpdateSessionId, onClearInitialMessage,
  onClearJoinedExistingSidecar,
  settingsInitialSection, settingsInitialMcpId, onSettingsSectionChange,
  updateReady, updateVersion, updateChecking, updateDownloading,
  onCheckForUpdate, onRestartAndUpdate,
}: TabContentProps) {
  return (
    <div
      className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
      style={isActive ? undefined : { contentVisibility: 'hidden' }}
    >
      {tab.view === 'launcher' ? (
        <Launcher
          onLaunchProject={onLaunchProject}
          isStarting={isLoading}
          startError={error}
          isActive={isActive}
        />
      ) : tab.view === 'settings' ? (
        <Settings
          initialSection={settingsInitialSection}
          initialMcpId={settingsInitialMcpId}
          onSectionChange={onSettingsSectionChange}
          isActive={isActive}
          updateReady={updateReady}
          updateVersion={updateVersion}
          updateChecking={updateChecking}
          updateDownloading={updateDownloading}
          onCheckForUpdate={onCheckForUpdate}
          onRestartAndUpdate={onRestartAndUpdate}
        />
      ) : (
        <TabProvider
          tabId={tab.id}
          agentDir={tab.agentDir ?? ''}
          sessionId={tab.sessionId}
          isActive={isActive}
          onGeneratingChange={(isGenerating) => onUpdateGenerating(tab.id, isGenerating)}
          onTitleChange={(title) => onUpdateTitle(tab.id, title)}
          onUnreadChange={(hasUnread) => onUpdateUnread(tab.id, hasUnread)}
          onSessionIdChange={(newSessionId) => onUpdateSessionId(tab.id, newSessionId)}
        >
          <Chat
            onBack={onBack}
            onSwitchSession={(sessionId) => onSwitchSession(tab.id, sessionId)}
            onNewSession={() => onNewSession(tab.id)}
            initialMessage={tab.initialMessage}
            onInitialMessageConsumed={() => onClearInitialMessage(tab.id)}
            joinedExistingSidecar={tab.joinedExistingSidecar}
            onJoinedExistingSidecarHandled={() => onClearJoinedExistingSidecar(tab.id)}
            sessionTitle={tab.title}
            onRenameSession={(newTitle: string) => onRenameSession(tab.id, newTitle)}
            onForkSession={(newSessionId: string, agentDir: string, title: string, initialMessage?: string) => onForkSession(tab.id, newSessionId, agentDir, title, initialMessage)}
          />
        </TabProvider>
      )}
    </div>
  );
}, (prev, next) => {
  // Return true = skip re-render
  // All callbacks are stable (via tabsRef/activeTabIdRef), so we only compare data props
  return (
    prev.tab === next.tab &&
    prev.isActive === next.isActive &&
    prev.isLoading === next.isLoading &&
    prev.error === next.error &&
    prev.settingsInitialSection === next.settingsInitialSection &&
    prev.settingsInitialMcpId === next.settingsInitialMcpId &&
    prev.updateReady === next.updateReady &&
    prev.updateVersion === next.updateVersion &&
    prev.updateChecking === next.updateChecking &&
    prev.updateDownloading === next.updateDownloading
  );
});

export default function App() {
  // Auto-update state (silent background updates)
  const { updateReady, updateVersion, restartAndUpdate, checking: updateChecking, downloading: updateDownloading, checkForUpdate, pendingUpdateOnStartup, dismissPendingUpdate } = useUpdater();

  // Stable callback for Settings prop — ref pattern ensures memo comparator correctness
  const restartAndUpdateRef = useRef(restartAndUpdate);
  restartAndUpdateRef.current = restartAndUpdate;

  const handleRestartAndUpdate = useCallback(() => {
    void restartAndUpdateRef.current();
  }, []);

  // App config for tray behavior (shared via ConfigProvider — no CONFIG_CHANGED event needed)
  // Also get projects + CRUD actions for bug report (ensureSelfAwarenessWorkspace needs them)
  const { config, isLoading: configLoading, updateConfig, providers: appProviders, apiKeys: appApiKeys, providerVerifyStatus: appProviderVerifyStatus, projects: configProjects, addProject: configAddProject, patchProject: configPatchProject } = useConfig();

  // Apply theme (light/dark/system) to <html> element
  useThemeEffect();

  // Settings initial section state (for deep linking to specific section)
  const [settingsInitialSection, setSettingsInitialSection] = useState<string | undefined>(undefined);
  const [settingsInitialMcpId, setSettingsInitialMcpId] = useState<string | undefined>(undefined);

  // Bug report overlay state (triggered from titlebar feedback button)
  const [showBugReport, setShowBugReport] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    if (isTauriEnvironment()) {
      import('@tauri-apps/api/app').then(m => m.getVersion()).then(setAppVersion).catch(() => setAppVersion('unknown'));
    } else {
      setAppVersion('dev');
    }
  }, []);

  // Multi-tab state
  const [tabs, setTabs] = useState<Tab[]>(() => [createNewTab()]);
  const [activeTabId, setActiveTabId] = useState<string | null>(() => tabs[0]?.id ?? null);

  // Refs for stable callback access (avoids re-creating callbacks when tabs/activeTabId change)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const appProvidersRef = useRef(appProviders);
  appProvidersRef.current = appProviders;

  const configProjectsRef = useRef(configProjects);
  configProjectsRef.current = configProjects;

  // Toast (ref-stabilized per CLAUDE.md rules)
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Per-tab loading state (keyed by tabId)
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const [tabErrors, setTabErrors] = useState<Record<string, string | null>>({});

  // Exit confirmation state (for cron tasks)
  const [exitConfirmState, setExitConfirmState] = useState<{
    runningTaskCount: number;
    resolve: (value: boolean) => void;
  } | null>(null);

  // Claude settings env override warning (cc-switch etc.)
  const [claudeEnvOverride, setClaudeEnvOverride] = useState<{
    baseUrl?: string;
    hasApiKey: boolean;
  } | null>(null);
  const [claudeEnvClearing, setClaudeEnvClearing] = useState(false);

  // Content container ref for tab swipe gesture
  const contentRef = useRef<HTMLDivElement>(null);

  // Per-tab launch guard — prevents concurrent launches overwriting each other's state
  const launchingTabRef = useRef<string | null>(null);

  // Global Sidecar silent retry mechanism
  const mountedRef = useRef(true);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);

  // Silent background retry with exponential backoff
  const startGlobalSidecarSilent = useCallback(async () => {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 2000; // 2 seconds

    try {
      // NOTE: Do NOT reset the ready promise on retry.
      // Existing waiters (useTaskCenterData etc.) hold a reference to the original promise.
      // Resetting it would orphan those waiters — they'd wait for a dead promise until
      // the 60s timeout expires, even if the sidecar is already running.
      // Keep the original promise; markGlobalSidecarReady() resolves it for ALL waiters.

      await startGlobalSidecar();

      if (!mountedRef.current) return;

      markGlobalSidecarReady();
      retryCountRef.current = 0; // Reset on success

      // Set log server URL to global sidecar for unified logging
      try {
        const globalUrl = await getGlobalServerUrl();
        setLogServerUrl(globalUrl);
        console.log('[App] Global sidecar started, log URL set:', globalUrl);
      } catch (e) {
        console.warn('[App] Failed to set log server URL:', e);
      }
    } catch (error) {
      if (!mountedRef.current) return;

      retryCountRef.current += 1;
      const currentRetry = retryCountRef.current;

      if (currentRetry <= MAX_RETRIES) {
        // Exponential backoff: 2s, 4s, 8s, 16s, 32s
        const delay = BASE_DELAY * Math.pow(2, currentRetry - 1);
        console.log(`[App] Global sidecar failed, retry ${currentRetry}/${MAX_RETRIES} in ${delay}ms`);

        retryTimeoutRef.current = setTimeout(() => {
          if (mountedRef.current) {
            void startGlobalSidecarSilent();
          }
        }, delay);
      } else {
        // Max retries reached, mark as ready to unblock waiting components
        markGlobalSidecarReady();
        console.error('[App] Global sidecar failed after max retries:', error);
      }
    }
  }, []);

  // 方案 A: Rust 统一恢复 - 前端不再主动恢复，只监听事件
  // Rust 层 initialize_cron_manager 会自动恢复所有 running 状态的任务

  // Start Global Sidecar on mount, cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    retryCountRef.current = 0;

    // Initialize analytics (async, non-blocking)
    void initAnalytics().then(() => {
      // Track app launch event
      track('app_launch', { launch_type: 'cold' });
    });

    // Initialize the ready promise BEFORE starting the sidecar
    // This allows other components to wait for it
    initGlobalSidecarReadyPromise();

    // WebView2 fix: show window only after React has mounted and applied theme.
    // Window starts hidden (visible: false in tauri.conf.json) to prevent black screen.
    if (isTauriEnvironment()) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        getCurrentWindow().show().catch((e: unknown) => console.warn('[App] Failed to show window:', e));
      });
    }

    // Start Global Sidecar immediately on app launch
    // This ensures MCP and other global API calls work from any page
    void startGlobalSidecarSilent();

    // NOTE: Bundled workspace (pm-copilot) initialization is handled by
    // ensureBundledWorkspace() inside ConfigProvider.load(), which runs
    // before loadProjects() to eliminate race conditions.

    // 方案 A: Rust 统一恢复 - 监听恢复事件（仅用于日志和 UI 反馈）
    // Rust 层会自动恢复任务，前端只需要监听结果
    let unlistenManagerReady: (() => void) | null = null;
    let unlistenRecoverySummary: (() => void) | null = null;
    let unlistenTaskRecovered: (() => void) | null = null;
    let unlistenBgComplete: (() => void) | null = null;
    let unlistenSidecarRestarted: (() => void) | null = null;

    const setupCronRecoveryListeners = async () => {
      if (!isTauriEnvironment()) return;

      try {
        const { listen } = await import('@tauri-apps/api/event');

        // Listen for background session completion events
        unlistenBgComplete = await listen<{ sessionId: string; sidecarStopped: boolean }>(
          'session:background-complete',
          (event) => {
            if (mountedRef.current) {
              const { sessionId, sidecarStopped } = event.payload;
              console.log(`[App] Background session completion finished: session=${sessionId}, sidecarStopped=${sidecarStopped}`);
            }
          }
        );

        // Listen for individual task recovered events
        unlistenTaskRecovered = await listen<CronTaskRecoveredPayload>(
          CRON_EVENTS.TASK_RECOVERED,
          (event) => {
            if (mountedRef.current) {
              const { taskId, sessionId, port } = event.payload;
              console.log(`[App] Cron task recovered: ${taskId} (session: ${sessionId}, port: ${port})`);
            }
          }
        );

        // Listen for recovery summary event
        unlistenRecoverySummary = await listen<CronRecoverySummaryPayload>(
          CRON_EVENTS.RECOVERY_SUMMARY,
          (event) => {
            if (mountedRef.current) {
              const { totalTasks, recoveredCount, failedCount, failedTasks } = event.payload;
              if (totalTasks > 0) {
                console.log(
                  `[App] Cron recovery summary: ${recoveredCount}/${totalTasks} recovered, ${failedCount} failed`
                );
                if (failedTasks.length > 0) {
                  console.warn('[App] Failed tasks:', failedTasks);
                }
                // Track cron_recover event
                track('cron_recover', {
                  recovered_count: recoveredCount,
                  failed_count: failedCount,
                });
              }
            }
          }
        );

        // Listen for manager ready event (indicates recovery is complete)
        unlistenManagerReady = await listen(CRON_EVENTS.MANAGER_READY, () => {
          if (mountedRef.current) {
            console.log('[App] Cron manager ready (Rust recovery complete)');
          }
        });

        // Listen for Global Sidecar auto-restart by Rust health monitor
        unlistenSidecarRestarted = await listen<string>('global-sidecar:restarted', (event) => {
          if (mountedRef.current) {
            const newUrl = event.payload;
            console.log('[App] Global sidecar auto-restarted by health monitor:', newUrl);
            updateGlobalServerUrl(newUrl);
            setLogServerUrl(newUrl);
            // Safety net: if the initial startGlobalSidecar() invoke is still blocked
            // (e.g., monitor killed the first sidecar during its TCP health check),
            // the ready promise would never resolve. Resolve it here so that components
            // waiting on waitForGlobalSidecar() can proceed with the new sidecar. (#58)
            markGlobalSidecarReady();
          }
        });
      } catch (error) {
        console.error('[App] Failed to setup cron recovery listeners:', error);
      }
    };

    void setupCronRecoveryListeners();

    return () => {
      mountedRef.current = false;
      // Clear any pending retry
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
      // Cleanup cron recovery listeners
      if (unlistenTaskRecovered) {
        unlistenTaskRecovered();
      }
      if (unlistenRecoverySummary) {
        unlistenRecoverySummary();
      }
      if (unlistenManagerReady) {
        unlistenManagerReady();
      }
      if (unlistenBgComplete) {
        unlistenBgComplete();
      }
      if (unlistenSidecarRestarted) {
        unlistenSidecarRestarted();
      }
      // Flush any pending frontend logs before shutdown
      forceFlushLogs();
      clearLogServerUrl();
      // NOTE: Do NOT call stopAllSidecars() here.
      // This cleanup runs on ANY unmount (including error boundary recovery),
      // not just app exit. Killing the sidecar during error recovery creates a
      // death loop: error → unmount → kill sidecar → sidecar unavailable → more errors.
      // Rust handles sidecar cleanup on actual exit (WindowEvent::Destroyed, ExitRequested).
    };
  }, [startGlobalSidecarSilent]);

  // Check ~/.claude/settings.json for env overrides on startup
  // External tools (cc-switch etc.) may write ANTHROPIC_BASE_URL which overrides all providers
  useEffect(() => {
    if (configLoading) return; // Wait for config to load from disk before checking
    if (config.dismissClaudeEnvWarning) return;
    const checkClaudeEnvOverrides = async () => {
      try {
        const result = await apiGetJson<{
          hasOverrides: boolean;
          baseUrl?: string;
          hasApiKey: boolean;
        }>('/api/claude-settings/check-env');
        if (result.hasOverrides) {
          setClaudeEnvOverride({ baseUrl: result.baseUrl, hasApiKey: result.hasApiKey });
        }
      } catch {
        // Silently ignore — non-critical check
      }
    };
    void checkClaudeEnvOverrides();
  }, [configLoading, config.dismissClaudeEnvWarning]);

  // Update tab isGenerating state (called from TabProvider via callback)
  const updateTabGenerating = useCallback((tabId: string, isGenerating: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isGenerating } : t
    ));
  }, []);

  // Update tab title (called from TabProvider when auto-title or rename occurs)
  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title } : t));
  }, []);

  // Update tab unread state (called from TabProvider when message completes on non-active tab)
  const updateTabUnread = useCallback((tabId: string, hasUnread: boolean) => {
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId);
      if (tab && tab.hasUnread !== hasUnread) {
        return prev.map(t => t.id === tabId ? { ...t, hasUnread } : t);
      }
      return prev; // no-op: avoid unnecessary re-render
    });
  }, []);

  // Update tab sessionId when backend creates real session (called from TabProvider)
  // This ensures Session singleton constraint works correctly:
  // - Tab.sessionId syncs with the actual session ID
  // - History dropdown can detect if session is already open in a Tab
  // - Rust HashMap keys are upgraded from "pending-xxx" to real session ID
  const updateTabSessionId = useCallback(async (tabId: string, newSessionId: string) => {
    // Find the current tab to get the old sessionId
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    const oldSessionId = currentTab?.sessionId;

    console.log(`[App] Tab ${tabId} sessionId updating: ${oldSessionId} -> ${newSessionId}`);

    // Upgrade the session ID in Rust HashMap (sidecars + session_activations)
    // This is a no-op if oldSessionId is null or same as newSessionId
    if (oldSessionId && oldSessionId !== newSessionId) {
      const upgraded = await upgradeSessionId(oldSessionId, newSessionId);
      console.log(`[App] Rust HashMap upgrade: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
    }

    // Update UI state
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, sessionId: newSessionId } : t
    ));
  }, []);

  // Perform the actual tab close operation (pure function, no confirmation)
  // UI updates are immediate; resource cleanup runs in background (non-blocking)
  const performCloseTab = useCallback((tabId: string) => {
    const currentTabs = tabsRef.current;

    // Double-check: tab might have been removed
    const tab = currentTabs.find(t => t.id === tabId);
    if (!tab) return;

    // Calculate actual tab_count after close:
    // - If closing the last tab, a new launcher is created, so count = 1
    // - Otherwise, count = currentTabs.length - 1
    const isLastTab = currentTabs.length === 1;
    const actualTabCount = isLastTab ? 1 : currentTabs.length - 1;

    // Track tab_close event with correct count
    track('tab_close', { view: tab.view, tab_count: actualTabCount });

    // ========== IMMEDIATE UI UPDATE (non-blocking) ==========
    // Update UI state first for instant response
    if (isLastTab) {
      // Special case: If this is the last tab, replace with launcher (don't close the app)
      const newTab = createNewTab();
      setTabs([newTab]);
      setActiveTabId(newTab.id);
    } else {
      // Normal case: close the tab
      const newTabs = currentTabs.filter((t) => t.id !== tabId);

      // If closing the active tab, switch to the last remaining tab
      if (tabId === activeTabIdRef.current && newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }

      setTabs(newTabs);
    }

    // ========== BACKGROUND CLEANUP (non-blocking) ==========
    // Capture tab data before cleanup to avoid stale closure issues
    const tabSessionId = tab.sessionId;
    const tabAgentDir = tab.agentDir;

    // Resource cleanup runs asynchronously without blocking UI
    // CRITICAL: SSE proxy must be stopped BEFORE Sidecar to avoid "unexpected EOF" errors
    // When Sidecar dies, open HTTP connections break mid-stream causing errors
    const cleanupResources = async () => {
      try {
        // Step 1: Try to start background completion if AI is running
        // This keeps the Sidecar alive so AI can finish its response
        if (tabSessionId) {
          const bgResult = await startBackgroundCompletion(tabSessionId);
          if (bgResult.started) {
            console.log(`[App] Tab ${tabId} closing: AI still running, background completion started for session ${tabSessionId}`);
          }
        }

        // Step 2: Stop SSE proxy FIRST to ensure clean disconnection
        // This prevents "unexpected EOF" errors when Sidecar is stopped
        await stopSseProxy(tabId);

        // Step 3: Release Tab's ownership of the Session Sidecar
        // If background completion is active, Sidecar continues running (BG owner keeps it alive)
        if (tabSessionId) {
          try {
            // Update cron task tab association if exists
            const cronTask = await getTabCronTask(tabId);
            if (cronTask && cronTask.status === 'running') {
              await updateCronTaskTab(cronTask.id, undefined);
            }

            const stopped = await releaseSessionSidecar(tabSessionId, 'tab', tabId);
            console.log(`[App] Tab ${tabId} released session ${tabSessionId}, sidecar stopped: ${stopped}`);

            // Clean up session activation
            if (!cronTask || cronTask.status !== 'running') {
              await deactivateSession(tabSessionId);
            }
          } catch (error) {
            console.error(`[App] Error releasing session sidecar for tab ${tabId}:`, error);
            // Fallback to legacy stopTabSidecar
            void stopTabSidecar(tabId);
          }
        } else if (tabAgentDir) {
          // No sessionId but has agentDir - legacy case, use stopTabSidecar
          void stopTabSidecar(tabId);
        }
      } catch (error) {
        console.error(`[App] Background cleanup error for tab ${tabId}:`, error);
      }
    };

    // Fire and forget - cleanup runs in background
    void cleanupResources();
  }, []);

  // Close tab — if AI is generating, close immediately and let it finish in background.
  // No confirmation dialog: background completion keeps the Sidecar alive.
  const closeTabWithConfirmation = useCallback(async (tabId: string) => {
    const tab = tabsRef.current.find(t => t.id === tabId);

    if (tab?.isGenerating && tab.sessionId) {
      void performCloseTab(tabId);
      toastRef.current.info('AI 继续在后台完成任务');
      return;
    }

    void performCloseTab(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  // Close current active tab (for Cmd+W)
  const closeCurrentTab = useCallback(() => {
    const currentActiveTabId = activeTabIdRef.current;
    if (!currentActiveTabId) return;

    const currentTabs = tabsRef.current;
    const activeTab = currentTabs.find(t => t.id === currentActiveTabId);

    // Special case: If only one launcher tab, do nothing
    if (currentTabs.length === 1 && activeTab?.view === 'launcher') {
      return;
    }

    // Multiple tabs OR last tab is chat/settings: use the unified confirmation logic
    void closeTabWithConfirmation(currentActiveTabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  // Keyboard shortcuts: Cmd+T, Cmd+W, Cmd+Shift+[/], Cmd+1~9, Ctrl+Tab/Ctrl+Shift+Tab
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes('mac');
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      // --- Ctrl+Tab / Ctrl+Shift+Tab: cycle through tabs (both platforms use Ctrl) ---
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault();
        const tabs = tabsRef.current;
        const activeId = activeTabIdRef.current;
        if (tabs.length <= 1 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const newIdx = e.shiftKey
          ? (idx - 1 + tabs.length) % tabs.length   // wrap backward
          : (idx + 1) % tabs.length;                 // wrap forward
        setActiveTabId(tabs[newIdx].id);
        return;
      }

      if (!modKey) return;

      // --- Cmd/Ctrl + 1~9: jump to Nth tab (9 = last tab) ---
      const digit = parseInt(e.key, 10);
      if (digit >= 1 && digit <= 9 && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const tabs = tabsRef.current;
        if (tabs.length === 0) return;
        const targetIdx = digit === 9 ? tabs.length - 1 : digit - 1;
        if (targetIdx < tabs.length) {
          setActiveTabId(tabs[targetIdx].id);
        }
        return;
      }

      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        // New tab
        if (tabsRef.current.length < MAX_TABS) {
          const newTab = createNewTab();
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
        }
      } else if (e.key === 'w' || e.key === 'W') {
        // macOS: handled by native menu → window:cmd-w → useTrayEvents.ts.
        // Windows/Linux: no native menu with Ctrl+W, so handle here directly.
        // (On macOS this branch is dead code — the menu intercepts before JS.)
        e.preventDefault();
        if (!dismissTopmost()) {
          if (!document.querySelector('.fixed.inset-0[class*="backdrop-blur"]')) {
            closeCurrentTab();
          }
        }
      } else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        // Cmd+Shift+[ = previous tab, Cmd+Shift+] = next tab
        e.preventDefault();
        const tabs = tabsRef.current;
        const activeId = activeTabIdRef.current;
        if (tabs.length <= 1 || !activeId) return;
        const idx = tabs.findIndex((t) => t.id === activeId);
        if (idx === -1) return;
        const newIdx = e.code === 'BracketLeft' ? idx - 1 : idx + 1;
        if (newIdx >= 0 && newIdx < tabs.length) {
          setActiveTabId(tabs[newIdx].id);
        }
      }
    };

    // Capture phase: application-level shortcuts (Cmd+W/T/Tab, etc.) MUST fire before
    // any component-level handlers. Without capture, Monaco editor (or any component
    // calling stopPropagation) blocks the event → our handler never fires →
    // e.preventDefault() never called → Tauri native Cmd+W closes the window.
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  /**
   * Launch a project with Session Singleton Architecture
   *
   * Four scenarios (evaluated in order):
   * 1. Session already open in a Tab → Jump to that Tab
   * 2. Session has running cron task (no Tab) → New Tab connects to Cron Sidecar
   * 3. Current Tab has running cron task → New Tab + New Sidecar
   * 4. Normal switch → Current Tab switches Session
   */
  const handleLaunchProject = useCallback(async (
    project: Project,
    _provider: Provider,
    sessionId?: string,
    initialMessage?: InitialMessage
  ) => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;

    // Per-tab launch guard: prevent concurrent launches on the same tab
    // A second launch would overwrite the first's initialMessage and kill its sidecar
    if (launchingTabRef.current === activeTabId) {
      console.warn(`[App] handleLaunchProject: launch already in progress for tab ${activeTabId}, ignoring`);
      return;
    }
    launchingTabRef.current = activeTabId;

    // Track workspace_open or history_open event
    if (sessionId) {
      track('history_open');
    } else {
      track('workspace_open');
    }

    setTabErrors((prev) => ({ ...prev, [activeTabId]: null }));
    setLoadingTabs((prev) => ({ ...prev, [activeTabId]: true }));

    try {
      // ========================================
      // Scenario 1: Session already open in a Tab
      // ========================================
      if (sessionId) {
        // Find if session is already open in any existing Tab
        const existingTab = tabsRef.current.find(t => t.sessionId === sessionId);
        if (existingTab) {
          console.log(`[App] Scenario 1: Session ${sessionId} already in tab ${existingTab.id}, jumping to it`);
          setActiveTabId(existingTab.id);
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
          launchingTabRef.current = null;
          return;
        }
      }

      // ========================================
      // Scenario 2: Session has running cron task (no Tab)
      // Using Session-centric API: add Tab as owner to existing Sidecar
      // ========================================
      if (sessionId) {
        const activation = await getSessionActivation(sessionId);
        console.log(`[App] Scenario 2 check: sessionId=${sessionId}, activation=`, activation);
        if (activation && activation.task_id) {
          // Session is activated by a cron task - add Tab as owner to its Sidecar
          console.log(`[App] Scenario 2: Session ${sessionId} has cron task ${activation.task_id} on port ${activation.port}`);

          // Determine target Tab (may need new Tab if current has cron task)
          let targetTabId = activeTabId;
          const currentTabCronTask = await getTabCronTask(activeTabId);
          if (currentTabCronTask && currentTabCronTask.status === 'running') {
            // Current Tab has running cron task, need new Tab
            if (tabsRef.current.length >= MAX_TABS) {
              setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
              setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
              launchingTabRef.current = null;
              return;
            }
            const newTab = createNewTab();
            setTabs((prev) => [...prev, newTab]);
            targetTabId = newTab.id;
            setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
          }

          // Add Tab as owner to the Session's Sidecar (cron task already owns it)
          // This uses ensureSessionSidecar which will add Tab as owner without creating new Sidecar
          const result = await ensureSessionSidecar(sessionId, project.path, 'tab', targetTabId);
          console.log(`[App] Tab ${targetTabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);

          // Update session activation to include this Tab
          await updateSessionTab(sessionId, targetTabId);

          // Update tab state (no cronTaskId/sidecarPort - managed by Owner model)
          setTabs((prev) =>
            prev.map((t) =>
              t.id === targetTabId
                ? {
                  ...t,
                  agentDir: project.path,
                  sessionId: sessionId,
                  view: 'chat',
                  title: project.displayName || getFolderName(project.path),
                  joinedExistingSidecar: !result.isNew,
                }
                : t
            )
          );

          if (targetTabId !== activeTabId) {
            setActiveTabId(targetTabId);
          }
          setLoadingTabs((prev) => ({ ...prev, [targetTabId]: false }));
          launchingTabRef.current = null;
          return;
        }
      }

      // ========================================
      // Scenario 3: Current Tab has running cron task
      // ========================================
      let targetTabId = activeTabId;
      const currentTabCronTask = await getTabCronTask(activeTabId);
      if (currentTabCronTask && currentTabCronTask.status === 'running') {
        console.log(`[App] Scenario 3: Current tab ${activeTabId} has running cron task ${currentTabCronTask.id}, creating new tab`);

        if (tabsRef.current.length >= MAX_TABS) {
          setTabErrors((prev) => ({ ...prev, [activeTabId]: '已达到最大标签页数量，请关闭其他标签页后重试' }));
          setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
          launchingTabRef.current = null;
          return;
        }

        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        targetTabId = newTab.id;
        setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false, [targetTabId]: true }));
      }

      // ========================================
      // Scenario 4: Normal switch (or Scenario 3 continuation)
      // Using Session-centric API: Tab becomes owner of Session's Sidecar
      // ========================================
      console.log(`[App] Scenario 4: Normal launch - tab ${targetTabId}, project: ${project.path}, sessionId: ${sessionId}`);

      // If current tab has an active session, release it before launching new one
      const currentTabForLaunch = tabsRef.current.find(t => t.id === targetTabId);
      const oldSessionForLaunch = currentTabForLaunch?.sessionId;
      if (oldSessionForLaunch) {
        const bgResult = await startBackgroundCompletion(oldSessionForLaunch);
        if (bgResult.started) {
          console.log(`[App] Scenario 4: AI running on ${oldSessionForLaunch}, background completion started`);
        }
        // Always release old session regardless of AI state:
        // - If BG started: Sidecar stays alive via BG owner
        // - If idle: Sidecar stops (no more owners)
        await stopSseProxy(targetTabId);
        await releaseSessionSidecar(oldSessionForLaunch, 'tab', targetTabId);
        await deactivateSession(oldSessionForLaunch);
      }

      // Cancel background completion on target session if reconnecting
      if (sessionId) {
        await cancelBackgroundCompletion(sessionId);
      }

      // For new sessions (no sessionId), generate a temporary session ID
      // The actual session ID will be created by the backend when the session starts
      const effectiveSessionId = sessionId ?? createPendingSessionId(targetTabId);

      // Ensure Sidecar is running for this Session, Tab as owner
      const result = await ensureSessionSidecar(effectiveSessionId, project.path, 'tab', targetTabId);
      console.log(`[App] Session Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);

      // Activate session with Tab (for Session singleton tracking and fallback port lookup)
      // Always use effectiveSessionId to ensure session_activations has entry for this Tab
      await activateSession(effectiveSessionId, targetTabId, null, result.port, project.path, false);

      // Update tab state with effectiveSessionId (matches the Sidecar's session)
      // For new sessions, this is "pending-{tabId}" until backend creates the real session
      setTabs((prev) =>
        prev.map((t) =>
          t.id === targetTabId
            ? {
              ...t,
              agentDir: project.path,
              sessionId: effectiveSessionId,
              view: 'chat',
              title: project.displayName || getFolderName(project.path),
              // Only set initialMessage when explicitly provided (from Launcher send).
              // Omitting undefined prevents overwriting a prior initialMessage in race conditions.
              ...(initialMessage ? { initialMessage } : {}),
              joinedExistingSidecar: !result.isNew,
            }
            : t
        )
      );

      if (targetTabId !== activeTabId) {
        setActiveTabId(targetTabId);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[App] Failed to start:', errorMsg);
      setTabErrors((prev) => ({ ...prev, [activeTabId]: errorMsg }));

      // In browser dev mode, still allow navigation
      if (isBrowserDevMode()) {
        console.log('[App] Browser mode: continuing despite error');
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTabId
              ? {
                ...t,
                agentDir: project.path,
                view: 'chat',
                title: project.displayName || getFolderName(project.path),
              }
              : t
          )
        );
      }
    } finally {
      launchingTabRef.current = null;
      setLoadingTabs((prev) => ({ ...prev, [activeTabId]: false }));
    }
  }, []);

  // Clear initialMessage from a tab after it has been consumed by Chat
  const clearInitialMessage = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, initialMessage: undefined } : t
    ));
  }, []);

  const clearJoinedExistingSidecar = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, joinedExistingSidecar: undefined } : t
    ));
  }, []);

  // Rename session: update tab title + persist to backend + notify listeners
  const handleRenameSession = useCallback((tabId: string, newTitle: string) => {
    updateTabTitle(tabId, newTitle);
    const tab = tabsRef.current.find(t => t.id === tabId);
    if (tab?.sessionId) {
      updateSession(tab.sessionId, { title: newTitle, titleSource: 'user' })
        .then(() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED)))
        .catch(err => console.error('[App] Failed to persist renamed title:', err));
    }
  }, [updateTabTitle]);

  /**
   * Handle fork session: create a new tab for the forked session.
   * Called from Chat after the backend has created the forked session metadata + messages.
   */
  const handleForkSession = useCallback(async (_tabId: string, newSessionId: string, forkAgentDir: string, title: string, initialMessage?: string) => {
    // Check tab limit
    if (tabsRef.current.length >= MAX_TABS) {
      toastRef.current.error('标签页已达上限，请关闭一个后重试');
      return;
    }

    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: forkAgentDir,
      sessionId: newSessionId,
      view: 'chat',
      title,
      ...(initialMessage ? { initialMessage: { text: initialMessage } } : {}),
    };

    setTabs(prev => [...prev, newTab]);
    setLoadingTabs(prev => ({ ...prev, [newTab.id]: true }));

    try {
      const result = await ensureSessionSidecar(newSessionId, forkAgentDir, 'tab', newTab.id);
      console.log(`[App] Fork tab ${newTab.id} sidecar ensured: port=${result.port}`);
      await activateSession(newSessionId, newTab.id, null, result.port, forkAgentDir, false);
      setActiveTabId(newTab.id);
    } catch (error) {
      console.error('[App] Failed to start sidecar for forked session:', error);
      setTabs(prev => prev.filter(t => t.id !== newTab.id));
    } finally {
      setLoadingTabs(prev => ({ ...prev, [newTab.id]: false }));
    }
  }, []);

  /**
   * Handle session switch from within Chat (history dropdown)
   * Implements Session singleton with all 4 scenarios
   */
  const handleSwitchSession = useCallback(async (tabId: string, sessionId: string) => {
    // Scenario 1: Session already open in a Tab → Jump to that Tab
    const existingTab = tabsRef.current.find(t => t.sessionId === sessionId);
    if (existingTab) {
      console.log(`[App] handleSwitchSession Scenario 1: Session ${sessionId} already in tab ${existingTab.id}, jumping to it`);
      setActiveTabId(existingTab.id);
      return;
    }

    // Scenario 2: Session has running cron task (no Tab) → Add Tab as owner to existing Sidecar
    const activation = await getSessionActivation(sessionId);
    if (activation && activation.task_id) {
      console.log(`[App] handleSwitchSession Scenario 2: Session ${sessionId} has cron task ${activation.task_id}`);

      // Get current tab info to find agentDir
      const currentTab = tabsRef.current.find(t => t.id === tabId);
      if (!currentTab?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      const oldSessionId = currentTab.sessionId;

      try {
        // Step 1: Add Tab as owner to the cron task's Sidecar FIRST
        const result = await ensureSessionSidecar(sessionId, currentTab.agentDir, 'tab', tabId);
        console.log(`[App] Tab ${tabId} added as owner to session ${sessionId} Sidecar on port ${result.port}`);
        await updateSessionTab(sessionId, tabId);

        // Step 2: Stop SSE proxy FIRST before releasing old session (avoids EOF errors)
        if (oldSessionId) {
          await stopSseProxy(tabId);
          const stopped = await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          console.log(`[App] Released old session ${oldSessionId}, sidecar stopped: ${stopped}`);
        }

        // Step 3: Update UI state (TabProvider will reconnect SSE to new Sidecar)
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                ...t,
                sessionId,
                joinedExistingSidecar: !result.isNew,
              }
              : t
          )
        );
      } catch (error) {
        console.error('[App] Failed to switch to cron task session:', error);
      }
      return;
    }

    // Scenario 3: Current Tab has running cron task → Create new Tab + new Sidecar
    const currentTabCronTask = await getTabCronTask(tabId);
    if (currentTabCronTask && currentTabCronTask.status === 'running') {
      console.log(`[App] handleSwitchSession Scenario 3: Current tab ${tabId} has cron task, creating new tab`);

      // Check max tabs limit
      if (tabsRef.current.length >= MAX_TABS) {
        console.warn('[App] Cannot create new tab: max tabs reached');
        return;
      }

      // Get agentDir from current tab
      const currentTabForScenario3 = tabsRef.current.find(t => t.id === tabId);
      if (!currentTabForScenario3?.agentDir) {
        console.error('[App] Cannot switch: current tab has no agentDir');
        return;
      }

      // Create new tab
      const newTab = createNewTab();
      setTabs((prev) => [...prev, newTab]);
      setLoadingTabs((prev) => ({ ...prev, [newTab.id]: true }));

      try {
        // Ensure Sidecar for new Tab as owner of this Session
        const result = await ensureSessionSidecar(sessionId, currentTabForScenario3.agentDir, 'tab', newTab.id);
        console.log(`[App] New tab ${newTab.id} Sidecar ensured: port=${result.port}, isNew=${result.isNew}`);

        // Update new tab state
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id
              ? {
                ...t,
                agentDir: currentTabForScenario3.agentDir,
                sessionId,
                view: 'chat',
                title: currentTabForScenario3.title || getFolderName(currentTabForScenario3.agentDir ?? ''),
                joinedExistingSidecar: !result.isNew,
              }
              : t
          )
        );

        // Jump to new tab
        setActiveTabId(newTab.id);
        console.log(`[App] handleSwitchSession Scenario 3: Created new tab ${newTab.id} for session ${sessionId}`);
      } catch (error) {
        console.error('[App] Failed to ensure Sidecar for new tab:', error);
        // Remove the failed tab
        setTabs((prev) => prev.filter(t => t.id !== newTab.id));
      } finally {
        setLoadingTabs((prev) => ({ ...prev, [newTab.id]: false }));
      }
      return;
    }

    // Scenario 4: Normal switch
    //
    // Two sub-paths:
    // A) AI is idle → hot-swap Sidecar via upgradeSessionId (no new process)
    // B) AI is running → start background completion for old session,
    //    release Tab from old Sidecar, create new Sidecar for new session
    console.log(`[App] handleSwitchSession Scenario 4: Switching tab ${tabId} to session ${sessionId}`);

    // Get current tab info
    const currentTabForScenario4 = tabsRef.current.find(t => t.id === tabId);
    if (!currentTabForScenario4?.agentDir) {
      console.error('[App] Cannot switch: current tab has no agentDir');
      return;
    }

    const oldSessionId = currentTabForScenario4.sessionId;

    try {
      // First, cancel any background completion on the TARGET session (user reconnecting)
      await cancelBackgroundCompletion(sessionId);

      // Track whether Tab is joining a pre-existing sidecar (e.g. IM Bot session)
      // to skip automatic config sync in Chat.tsx mount
      let joinedExisting = false;

      if (oldSessionId) {
        // Check if AI is running on old session → background completion
        const bgResult = await startBackgroundCompletion(oldSessionId);

        if (bgResult.started) {
          // AI is running → old Sidecar stays alive via BG owner, create new Sidecar for target
          console.log(`[App] AI running on ${oldSessionId}, starting background completion`);
          await stopSseProxy(tabId);
          await releaseSessionSidecar(oldSessionId, 'tab', tabId);
          await deactivateSession(oldSessionId);

          // Create/reuse Sidecar for the target session
          const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
          await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
          joinedExisting = !result.isNew;
          console.log(`[App] Created new Sidecar for session ${sessionId} on port ${result.port}`);
        } else {
          // AI is idle → check if target session already has a sidecar (e.g., from BG completion)
          // If yes, we can't use upgradeSessionId — it would overwrite the existing sidecar
          const targetPort = await getSessionPort(sessionId);

          if (targetPort !== null) {
            // Target session has existing sidecar → release current, reconnect to existing
            console.log(`[App] Target session ${sessionId} has existing sidecar on port ${targetPort}, reconnecting`);
            await stopSseProxy(tabId);
            await releaseSessionSidecar(oldSessionId, 'tab', tabId);
            await deactivateSession(oldSessionId);
            const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
            await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
            joinedExisting = !result.isNew;
          } else {
            // No existing sidecar for target → hot-swap via upgradeSessionId (efficient, no new process)
            const upgraded = await upgradeSessionId(oldSessionId, sessionId);

            if (upgraded) {
              await deactivateSession(oldSessionId);
              const port = await getSessionPort(sessionId);
              if (port !== null) {
                await activateSession(sessionId, tabId, null, port, currentTabForScenario4.agentDir, false);
                console.log(`[App] Session ${sessionId} took over Sidecar from ${oldSessionId} on port ${port}`);
                // upgradeSessionId: Tab already owned this sidecar → joinedExisting stays false
              } else {
                console.warn(`[App] Port not found after upgrade, creating new Sidecar`);
                const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
                await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
                joinedExisting = !result.isNew;
              }
            } else {
              console.log(`[App] Sidecar upgrade failed, creating new Sidecar for session ${sessionId}`);
              await deactivateSession(oldSessionId);
              const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
              await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
              joinedExisting = !result.isNew;
            }
          }
        }
      } else {
        // No old Session → Create new Sidecar
        console.log(`[App] No previous session, creating new Sidecar for session ${sessionId}`);
        const result = await ensureSessionSidecar(sessionId, currentTabForScenario4.agentDir, 'tab', tabId);
        await activateSession(sessionId, tabId, null, result.port, currentTabForScenario4.agentDir, false);
        joinedExisting = !result.isNew;
      }

      // Update UI state - TabProvider will detect sessionId change and call loadSession()
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId, joinedExistingSidecar: joinedExisting }
            : t
        )
      );
      console.log(`[App] handleSwitchSession Scenario 4 complete: tab ${tabId} now on session ${sessionId}`);
    } catch (error) {
      console.error('[App] Failed to switch session:', error);
    }
  }, []);

  const handleBackToLauncher = useCallback(async () => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) return;

    // Get current tab to access sessionId
    const currentTab = tabsRef.current.find(t => t.id === activeTabId);

    // Step 1: Try to start background completion if AI is running
    if (currentTab?.sessionId) {
      const bgResult = await startBackgroundCompletion(currentTab.sessionId);
      if (bgResult.started) {
        console.log(`[App] Back to launcher: AI still running, background completion started for session ${currentTab.sessionId}`);
      }
    }

    // Step 2: Stop SSE proxy FIRST to avoid EOF errors when Sidecar stops
    await stopSseProxy(activeTabId);

    // Step 3: Release Tab's ownership of the Session Sidecar
    // If BackgroundCompletion or CronTask also owns it, Sidecar continues running
    if (currentTab?.sessionId) {
      try {
        // Check if this Tab has an active cron task to update associations
        const cronTask = await getTabCronTask(activeTabId);
        if (cronTask && cronTask.status === 'running') {
          // Clear tab association in cron task
          await updateCronTaskTab(cronTask.id, undefined);
          // Update session activation to remove tab_id but keep task_id
          await updateSessionTab(currentTab.sessionId, undefined);
        }

        // Release Tab's ownership - Sidecar stops only if no other owners
        const stopped = await releaseSessionSidecar(currentTab.sessionId, 'tab', activeTabId);
        console.log(`[App] Tab ${activeTabId} released session ${currentTab.sessionId}, sidecar stopped: ${stopped}`);

        // Clean up session activation (Tab no longer owns this session)
        // If cron task is active, updateSessionTab above already handled it
        if (!cronTask || cronTask.status !== 'running') {
          await deactivateSession(currentTab.sessionId);
        }
      } catch (error) {
        console.error(`[App] Error releasing session sidecar for tab ${activeTabId}:`, error);
        // Fallback to legacy stopTabSidecar
        void stopTabSidecar(activeTabId);
      }
    }

    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { ...t, agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' }
          : t
      )
    );
  }, []);

  /**
   * Handle "New Session" from Chat component.
   * If AI is running, starts background completion on old session and creates new Sidecar.
   * Returns true if handled (Chat should NOT call resetSession), false if AI is idle (Chat falls back to resetSession).
   */
  const handleNewSession = useCallback(async (tabId: string): Promise<boolean> => {
    const currentTab = tabsRef.current.find(t => t.id === tabId);
    if (!currentTab?.sessionId || !currentTab?.agentDir) {
      return false;
    }

    const oldSessionId = currentTab.sessionId;

    // Check if AI is running → start background completion
    const bgResult = await startBackgroundCompletion(oldSessionId);
    if (!bgResult.started) {
      // AI is idle → let Chat handle it via resetSession (more efficient, reuses Sidecar)
      return false;
    }

    // AI is running → release old Sidecar (BG owner keeps it alive), create new one
    console.log(`[App] handleNewSession: AI running on ${oldSessionId}, background completion started`);

    try {
      await stopSseProxy(tabId);
      await releaseSessionSidecar(oldSessionId, 'tab', tabId);
      await deactivateSession(oldSessionId);

      // Create new pending session with new Sidecar
      const pendingSessionId = createPendingSessionId(tabId);
      const result = await ensureSessionSidecar(pendingSessionId, currentTab.agentDir, 'tab', tabId);
      await activateSession(pendingSessionId, tabId, null, result.port, currentTab.agentDir, false);

      // Update tab state → TabProvider will detect sessionId change and reconnect
      // Explicitly clear joinedExistingSidecar to prevent stale flag from blocking config sync
      // on the new session (e.g. user clicks "New Session" while still in IM Bot adoption window)
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, sessionId: pendingSessionId, joinedExistingSidecar: undefined }
            : t
        )
      );
      console.log(`[App] handleNewSession: Created new Sidecar for pending session ${pendingSessionId} on port ${result.port}`);
      return true;
    } catch (error) {
      console.error('[App] handleNewSession failed:', error);
      return false;
    }
  }, []);

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  // Clear unread indicator whenever active tab changes (covers all activation paths:
  // handleSelectTab, keyboard shortcuts, session jumps, cron navigation, etc.)
  useEffect(() => {
    if (activeTabId) {
      setTabs(prev => {
        const tab = prev.find(t => t.id === activeTabId);
        if (tab?.hasUnread) {
          return prev.map(t => t.id === activeTabId ? { ...t, hasUnread: false } : t);
        }
        return prev;
      });
    }
  }, [activeTabId]);

  // Trackpad two-finger horizontal swipe to switch tabs (follow-along animation)
  useTabSwipeGesture({ contentRef, tabsRef, activeTabIdRef, onSwitchTab: handleSelectTab });

  const handleCloseTab = useCallback((tabId: string) => {
    // Special case: If only one launcher tab, do nothing
    const currentTabs = tabsRef.current;
    const tab = currentTabs.find(t => t.id === tabId);
    if (currentTabs.length === 1 && tab?.view === 'launcher') {
      return;
    }

    void closeTabWithConfirmation(tabId);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via tabsRef
  }, []);

  const handleNewTab = useCallback(() => {
    const currentLength = tabsRef.current.length;
    if (currentLength >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }
    const newTab = createNewTab();
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Track tab_new event
    track('tab_new', { tab_count: currentLength + 1 });
  }, []);

  // Handle tab reordering via drag and drop
  const handleReorderTabs = useCallback((activeId: string, overId: string) => {
    setTabs((prev) => {
      const oldIndex = prev.findIndex((t) => t.id === activeId);
      const newIndex = prev.findIndex((t) => t.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  }, []);

  // Open Settings as a new tab (or switch to existing one)
  // Optional initialSection parameter to open a specific section (e.g., 'providers')
  const handleOpenSettings = useCallback(async (initialSection?: string, mcpServerId?: string) => {
    // Track settings_open event
    track('settings_open', { section: initialSection ?? null });

    // Set initial section for Settings component
    setSettingsInitialSection(initialSection);
    setSettingsInitialMcpId(mcpServerId);

    // Check if there's already a Settings tab
    const currentTabs = tabsRef.current;
    const existingSettingsTab = currentTabs.find((t) => t.view === 'settings');
    if (existingSettingsTab) {
      // Switch to existing Settings tab
      setActiveTabId(existingSettingsTab.id);
      return;
    }

    // Create new Settings tab
    if (currentTabs.length >= MAX_TABS) {
      console.warn(`[App] Max tabs (${MAX_TABS}) reached`);
      return;
    }

    // Create Tab first (instant UI response)
    const newTab: Tab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agentDir: null,
      sessionId: null,
      view: 'settings',
      title: '设置',
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    // Global Sidecar is now started on App mount, no need to start here
  }, []);

  // Listen for OPEN_SETTINGS custom event from child components
  useEffect(() => {
    const handleOpenSettingsEvent = (event: CustomEvent<{ section?: string; mcpServerId?: string }>) => {
      handleOpenSettings(event.detail?.section, event.detail?.mcpServerId);
    };
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, handleOpenSettingsEvent as EventListener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callback stabilized via tabsRef
  }, []);

  // Listen for JUMP_TO_TAB custom event (Session singleton constraint)
  useEffect(() => {
    const handleJumpToTab = (event: CustomEvent<{ targetTabId: string; sessionId: string }>) => {
      const { targetTabId, sessionId } = event.detail;
      console.log(`[App] Jump to tab ${targetTabId} for session ${sessionId}`);
      // Check if target Tab exists
      const targetTab = tabsRef.current.find(t => t.id === targetTabId);
      if (targetTab) {
        setActiveTabId(targetTabId);
      } else {
        console.warn(`[App] Target tab ${targetTabId} not found, cannot jump`);
      }
    };
    window.addEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.JUMP_TO_TAB, handleJumpToTab as EventListener);
    };
  }, []);

  // Listen for LAUNCH_BUG_REPORT custom event (AI-powered bug reporting)
  useEffect(() => {
    const handleLaunchBugReport = async (event: CustomEvent<{
      description: string;
      providerId?: string;
      model?: string;
      appVersion: string;
      images?: ImageAttachment[];
    }>) => {
      const { description, appVersion } = event.detail;
      try {
        // --- Pre-checks (before any Tab mutation) ---

        // Prefer the provider chosen in the overlay, fallback to first available
        const providerId = event.detail.providerId;
        const provider = providerId
          ? appProvidersRef.current.find(p => p.id === providerId)
          : appProvidersRef.current[0];
        if (!provider) {
          console.error('[App] No providers available for bug report');
          return;
        }

        if (tabsRef.current.length >= MAX_TABS) {
          console.warn(`[App] Max tabs (${MAX_TABS}) reached, cannot open bug report`);
          return;
        }

        // Ensure ~/.pm-copilot registered as internal project
        // (CLAUDE.md + skills are synced at startup via cmd_sync_admin_agent)
        const project = await ensureSelfAwarenessWorkspace(
          configProjectsRef.current,
          configAddProject,
          configPatchProject,
        );
        if (!project) {
          console.error('[App] ensureSelfAwarenessWorkspace returned null');
          return;
        }

        // --- All checks passed, safe to create Tab ---

        const initialMessage: InitialMessage = {
          text: buildSupportPrompt(description, appVersion),
          providerId: provider.id,
          model: event.detail.model,
          images: event.detail.images,
        };

        const newTab = createNewTab();
        setTabs((prev) => [...prev, newTab]);
        setActiveTabId(newTab.id);
        activeTabIdRef.current = newTab.id;

        await handleLaunchProject(project, provider, undefined, initialMessage);

        // Override tab title
        setTabs((prev) =>
          prev.map((t) =>
            t.id === newTab.id ? { ...t, title: '问题诊断' } : t
          )
        );
      } catch (err) {
        console.error('[App] Failed to launch bug report:', err);
      }
    };
    const listener = ((e: Event) => { void handleLaunchBugReport(e as CustomEvent); }) as EventListener;
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    return () => {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, listener);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks stabilized via refs, configAdd/patchProject are stable useCallbacks
  }, [configAddProject, configPatchProject]);

  // Note: CRON_TASK_STOPPED event listener removed
  // With Session-centric Sidecar (Owner model), stopping a cron task only releases
  // the CronTask owner. If Tab still owns the Sidecar, it continues running.
  // No SSE reconnection or Sidecar restart is needed.

  // Stable callback for Settings onSectionChange — avoids inline arrow creating new ref every render
  const handleSettingsSectionChange = useCallback(() => {
    setSettingsInitialSection(undefined);
    setSettingsInitialMcpId(undefined);
  }, []);

  // System tray event handling (minimize to tray, exit confirmation)
  useTrayEvents({
    minimizeToTray: config.minimizeToTray,
    onOpenSettings: () => handleOpenSettings('general'),
    onCmdWCloseTab: () => {
      // Cmd+W bottom: overlay → split → tab → launcher → STOP.
      closeCurrentTab(); // Last tab auto-creates launcher; launcher is a no-op.
    },
    onNavigateToTab: (tabId: string) => {
      // Verify the tab still exists before switching
      const exists = tabsRef.current.some(t => t.id === tabId);
      if (exists) {
        handleSelectTab(tabId);
      }
    },
    onExitRequested: async () => {
      // Check for running cron tasks
      try {
        const tasks = await getAllCronTasks();
        const runningTasks = tasks.filter(t => t.status === 'running');

        if (runningTasks.length > 0) {
          // Show confirmation dialog
          return new Promise<boolean>((resolve) => {
            setExitConfirmState({
              runningTaskCount: runningTasks.length,
              resolve,
            });
          });
        }
      } catch (error) {
        console.error('[App] Failed to check cron tasks:', error);
      }

      // No running tasks, allow exit
      return true;
    },
  });

  // Listen for cron task notifications from Rust (notification:show)
  // Store tabId as pending navigation so focus-regain auto-switches to the tab
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    let unlisten: (() => void) | null = null;
    const setup = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ title: string; body: string; tabId?: string | null }>(
        'notification:show',
        (event) => {
          const { title, body, tabId } = event.payload;
          // Send actual OS notification (Rust only emits the event, doesn't send OS notification)
          notifyCronTaskComplete(title, body, tabId ?? undefined);
        }
      );
    };
    setup();
    return () => { unlisten?.(); };
  }, []);

  return (
    <div className="flex h-screen flex-col bg-[var(--paper)]">
      {/* Chrome-style titlebar with tabs */}
      <CustomTitleBar
        onSettingsClick={handleOpenSettings}
        onOpenBugReport={() => setShowBugReport(true)}
        updateReady={updateReady}
        updateVersion={updateVersion}
        onRestartAndUpdate={() => void restartAndUpdate()}
      >
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={handleSelectTab}
          onCloseTab={handleCloseTab}
          onNewTab={handleNewTab}
          onReorderTabs={handleReorderTabs}
        />
      </CustomTitleBar>

      {/* Tab content - only Chat views need TabProvider for sidecar communication */}
      <div ref={contentRef} className="relative flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <MemoizedTabContent
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            isLoading={loadingTabs[tab.id] ?? false}
            error={tabErrors[tab.id] ?? null}
            onLaunchProject={handleLaunchProject}
            onBack={handleBackToLauncher}
            onSwitchSession={handleSwitchSession}
            onNewSession={handleNewSession}
            onUpdateGenerating={updateTabGenerating}
            onUpdateTitle={updateTabTitle}
            onUpdateUnread={updateTabUnread}
            onRenameSession={handleRenameSession}
            onForkSession={handleForkSession}
            onUpdateSessionId={updateTabSessionId}
            onClearInitialMessage={clearInitialMessage}
            onClearJoinedExistingSidecar={clearJoinedExistingSidecar}
            settingsInitialSection={tab.view === 'settings' ? settingsInitialSection : undefined}
            settingsInitialMcpId={tab.view === 'settings' ? settingsInitialMcpId : undefined}
            onSettingsSectionChange={handleSettingsSectionChange}
            updateReady={updateReady}
            updateVersion={updateVersion}
            updateChecking={updateChecking}
            updateDownloading={updateDownloading}
            onCheckForUpdate={checkForUpdate}
            onRestartAndUpdate={handleRestartAndUpdate}
          />
        ))}
      </div>

      {/* Exit confirmation dialog for running cron tasks */}
      {exitConfirmState && (
        <ConfirmDialog
          title="退出应用"
          message={`有 ${exitConfirmState.runningTaskCount} 个循环任务正在运行中。退出后任务将被停止。确定要退出吗？`}
          confirmText="退出"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={() => {
            exitConfirmState.resolve(true);
            setExitConfirmState(null);
          }}
          onCancel={() => {
            exitConfirmState.resolve(false);
            setExitConfirmState(null);
          }}
        />
      )}

      {/* Windows: startup dialog for pending update from previous session */}
      {pendingUpdateOnStartup && (
        <ConfirmDialog
          title="发现新版本"
          message={`最新版本 v${pendingUpdateOnStartup} 已下载完成，是否立即安装？`}
          confirmText="安装"
          cancelText="稍后"
          confirmVariant="primary"
          onConfirm={() => {
            dismissPendingUpdate();
            void restartAndUpdate();
          }}
          onCancel={dismissPendingUpdate}
        />
      )}

      {/* Warning: ~/.claude/settings.json env overrides detected */}
      {claudeEnvOverride && (
        <OverlayBackdrop onClose={claudeEnvClearing ? undefined : () => setClaudeEnvOverride(null)} className="z-[300] px-4">
          <div className="glass-panel w-full max-w-sm">
            <div className="border-b border-[var(--line)] px-5 py-4">
              <div className="text-[14px] font-semibold text-[var(--ink)]">检测到全局配置覆盖</div>
            </div>
            <div className="px-5 py-4">
              <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">
                {`~/.claude/settings.json 中检测到${claudeEnvOverride.baseUrl ? ` ANTHROPIC_BASE_URL = ${claudeEnvOverride.baseUrl.length > 60 ? claudeEnvOverride.baseUrl.slice(0, 60) + '...' : claudeEnvOverride.baseUrl}` : ''}${claudeEnvOverride.baseUrl && claudeEnvOverride.hasApiKey ? '，' : ''}${claudeEnvOverride.hasApiKey ? 'ANTHROPIC_API_KEY' : ''}，该配置会覆盖 PM Copilot 的供应商设置，导致所有请求发送到非预期地址。是否清除？`}
              </p>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3">
              <button
                type="button"
                disabled={claudeEnvClearing}
                className="text-[12px] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink-muted)] disabled:opacity-50"
                onClick={() => {
                  void updateConfig({ dismissClaudeEnvWarning: true });
                  setClaudeEnvOverride(null);
                }}
              >
                不再提示
              </button>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setClaudeEnvOverride(null)}
                  disabled={claudeEnvClearing}
                  className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={claudeEnvClearing}
                  className="flex items-center gap-1.5 rounded-full bg-[var(--error)] px-4 py-1.5 text-[12px] font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-50"
                  onClick={() => {
                    setClaudeEnvClearing(true);
                    void apiPostJson('/api/claude-settings/clear-env', {}).then(() => {
                      setClaudeEnvOverride(null);
                    }).catch((err) => {
                      console.error('[App] Failed to clear claude settings env:', err);
                      setClaudeEnvOverride(null);
                    }).finally(() => {
                      setClaudeEnvClearing(false);
                    });
                  }}
                >
                  {claudeEnvClearing && <Loader2 className="h-3 w-3 animate-spin" />}
                  清除
                </button>
              </div>
            </div>
          </div>
        </OverlayBackdrop>
      )}

      {/* Bug report overlay triggered from titlebar feedback button */}
      {showBugReport && (
        <BugReportOverlay
          onClose={() => setShowBugReport(false)}
          onNavigateToProviders={() => { setShowBugReport(false); handleOpenSettings('providers'); }}
          appVersion={appVersion}
          providers={appProviders}
          apiKeys={appApiKeys}
          providerVerifyStatus={appProviderVerifyStatus}
        />
      )}
    </div>
  );
}
