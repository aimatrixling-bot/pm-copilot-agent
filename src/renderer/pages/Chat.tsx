import { AlertTriangle, ArrowLeft, Bot, Globe, History, Loader2, Plus, PanelRightOpen, TerminalSquare, X, Download } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { track } from '@/analytics';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import ConfirmDialog from '@/components/ConfirmDialog';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useToast } from '@/components/Toast';
import Tip from '@/components/Tip';
import DirectoryPanel, { type DirectoryPanelHandle } from '@/components/DirectoryPanel';
import DropZoneOverlay from '@/components/DropZoneOverlay';
import MessageList from '@/components/MessageList';
import SessionHistoryDropdown from '@/components/SessionHistoryDropdown';
import { FileActionProvider } from '@/context/FileActionContext';
import SimpleChatInput, { type ImageAttachment, type SimpleChatInputHandle } from '@/components/SimpleChatInput';
import QueryNavigator from '@/components/chat/QueryNavigator';
import SelectionCommentMenu from '@/components/SelectionCommentMenu';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import WorkspaceConfigPanel, { type Tab as WorkspaceTab } from '@/components/WorkspaceConfigPanel';
import CronTaskSettingsModal from '@/components/cron/CronTaskSettingsModal';
import { useTabState, useTabActive } from '@/context/TabContext';
import { useVirtuosoScroll } from '@/hooks/useVirtuosoScroll';
import { useConfig } from '@/hooks/useConfig';
import { useFileDropZone } from '@/hooks/useFileDropZone';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { useCronTask } from '@/hooks/useCronTask';
import { getSessionCronTask, updateCronTaskTab, isTaskExecuting, createCronTask, startCronTask as startCronTaskIpc, startCronScheduler } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatScheduleDescription } from '@/types/cronTask';
import CronTaskCard from '@/components/scheduled-tasks/CronTaskCard';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';
import type { CronSettingsResult } from '@/components/cron/CronTaskSettingsModal';
import { isTauriEnvironment } from '@/utils/browserMock';
import { isDebugMode } from '@/utils/debug';
import { type PermissionMode, type McpServerDefinition, getEffectiveModelAliases } from '@/config/types';
import { syncMcpServerNames } from '@/components/tools/toolBadgeConfig';
import {
  getAllMcpServers,
  getEnabledMcpServerIds,
  resolveProvider,
} from '@/config/configService';
import { patchAgentConfig, getAgentById } from '@/config/services/agentConfigService';
import { BrowserPanelContext } from '@/context/BrowserPanelContext';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import { CC_MODELS, CC_PERMISSION_MODES, CODEX_PERMISSION_MODES } from '../../shared/types/runtime';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';
import type { InitialMessage } from '@/types/tab';
// CronTaskConfig type is used via useCronTask hook

// Lazy load FilePreviewModal for split view panel
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));
// Lazy load TerminalPanel for embedded terminal
const LazyTerminalPanel = lazy(() => import('@/components/TerminalPanel').then(m => ({ default: m.TerminalPanel })));
// Lazy load BrowserPanel for embedded browser
const LazyBrowserPanel = lazy(() => import('@/components/BrowserPanel'));
// Lazy load IntroductionOverlay for empty session welcome content
const LazyIntroductionOverlay = lazy(() => import('@/components/IntroductionOverlay'));
// Terminal chrome now uses CSS tokens that auto-switch with light/dark theme.
// No need for cached theme constants — the header uses var(--paper), var(--ink), etc.

/** Inline-editable session title — click to edit, Enter/Blur to save, Esc to cancel */
function SessionTitleEditor({ title, onRename }: { title: string; onRename: (newTitle: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed && trimmed !== title) {
      track('session_title_edit', {});
      onRename(trimmed);
    }
  };

  return (
    <div className="min-w-0 max-w-[360px]">
      {editing ? (
        <input
          ref={inputRef}
          className="w-full rounded border border-[var(--line)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-sm font-medium text-[var(--ink)] outline-none focus:border-[var(--accent)]"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') inputRef.current?.blur();
            if (e.key === 'Escape') { setDraft(title); setEditing(false); }
          }}
        />
      ) : (
        <span
          className="block truncate cursor-pointer px-1.5 py-0.5 text-sm font-medium text-[var(--ink-subtle)] hover:text-[var(--ink)] transition-colors"
          onClick={() => setEditing(true)}
          title="点击重命名"
        >
          {title}
        </span>
      )}
    </div>
  );
}

interface ChatProps {
  onBack?: () => void;
  /** Called when user starts a new session. Returns true if handled externally (background completion started). */
  onNewSession?: () => Promise<boolean>;
  /** Called when user selects a different session from history - uses Session singleton logic */
  onSwitchSession?: (sessionId: string) => void;
  /** Initial message from Launcher for auto-send on workspace open */
  initialMessage?: InitialMessage;
  /** Called after initialMessage has been consumed */
  onInitialMessageConsumed?: () => void;
  /** Tab joined an already-running sidecar (e.g. IM Bot session) — skip config push, adopt sidecar config */
  joinedExistingSidecar?: boolean;
  /** Called after sidecar config has been adopted */
  onJoinedExistingSidecarHandled?: () => void;
  /** Current session title (from tab state) */
  sessionTitle?: string;
  /** Called when user renames the session */
  onRenameSession?: (newTitle: string) => void;
  /** Called when user forks session at a specific assistant message — App creates new tab */
  onForkSession?: (newSessionId: string, agentDir: string, title: string, initialMessage?: string) => void;
}

export default function Chat({ onBack, onNewSession, onSwitchSession, initialMessage, onInitialMessageConsumed, joinedExistingSidecar, onJoinedExistingSidecarHandled, sessionTitle, onRenameSession, onForkSession }: ChatProps) {
  // Get state from TabContext (required - Chat must be inside TabProvider)
  const {
    tabId,
    agentDir,
    sessionId,
    messages,
    historyMessages,
    streamingMessage,
    isLoading,
    isSessionLoading,
    sessionState,
    sessionRuntime,
    unifiedLogs,
    systemInitInfo: _systemInitInfo,
    agentError,
    systemStatus,
    pendingPermission,
    pendingAskUserQuestion,
    pendingExitPlanMode,
    pendingEnterPlanMode,
    respondExitPlanMode,
    toolCompleteCount,
    setMessages,
    setIsLoading,
    setAgentError,
    connectSse,
    disconnectSse,
    sendMessage,
    stopResponse,
    loadSession,
    resetSession,
    clearUnifiedLogs,
    respondPermission,
    respondAskUserQuestion,
    apiPost,
    apiGet,
    setSessionState,
    onCronTaskExitRequested,
    queuedMessages,
    cancelQueuedMessage,
    forceExecuteQueuedMessage,
    isConnected,
  } = useTabState();
  const isActive = useTabActive();
  const toast = useToast();

  // Get config to find current project provider
  const { config, projects, providers, patchProject, apiKeys, providerVerifyStatus, refreshProviderData, refreshConfig } = useConfig();
  const currentProject = projects.find((p) => p.path === agentDir);
  // AgentConfig is source of truth for AI settings, Project is fallback for non-agent workspaces
  const currentAgent = currentProject?.agentId ? getAgentById(config, currentProject.agentId) : undefined;
  // Local provider state: snapshot from AgentConfig (priority) or Project at creation.
  // Prevents cross-tab pollution when another tab patches the shared project.
  const [selectedProviderId, setSelectedProviderId] = useState<string | undefined>(
    currentAgent?.providerId ?? currentProject?.providerId ?? config.defaultProviderId ?? undefined
  );
  const currentProvider = resolveProvider(selectedProviderId, providers, apiKeys, providerVerifyStatus);

  // PERFORMANCE: Ref-stabilize object deps used in handleSendMessage
  // Prevents useCallback from creating new references when these objects change,
  // which would defeat SimpleChatInput's memo.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const currentProviderRef = useRef(currentProvider);
  currentProviderRef.current = currentProvider;
  const apiKeysRef = useRef(apiKeys);
  apiKeysRef.current = apiKeys;
  const configRef = useRef(config);
  configRef.current = config;

  /** Build providerEnv for a given provider, including modelAliases for sub-agent model resolution */
  const buildProviderEnv = useCallback((provider: typeof currentProvider) => {
    if (!provider || provider.type === 'subscription') return undefined;
    const aliases = getEffectiveModelAliases(provider, configRef.current.providerModelAliases);
    return {
      baseUrl: provider.config.baseUrl,
      apiKey: apiKeysRef.current[provider.id],
      authType: provider.authType,
      apiProtocol: provider.apiProtocol,
      maxOutputTokens: provider.maxOutputTokens,
      maxOutputTokensParamName: provider.maxOutputTokensParamName,
      upstreamFormat: provider.upstreamFormat,
      ...(aliases ? { modelAliases: aliases } : {}),
    };
  }, []);

  // PERFORMANCE: inputValue is now managed internally by SimpleChatInput
  // to avoid re-rendering Chat (and MessageList) on every keystroke
  const [showLogs, setShowLogs] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // Narrow mode: workspace renders as overlay drawer instead of side panel
  // Initialize from window.innerWidth to avoid layout flash (FOUC) on first render
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  // In narrow mode, default workspace to hidden (overlay) — otherwise it blocks chat on startup
  const [showWorkspace, setShowWorkspace] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768);
  const [showWorkspaceConfig, setShowWorkspaceConfig] = useState(false); // Workspace config panel
  // Introduction overlay: INTRODUCTION.md content for empty session welcome
  const [introductionContent, setIntroductionContent] = useState<string | null>(null);
  useEffect(() => {
    const breakpoint = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--breakpoint-mobile') || '768', 10);
    const check = () => setIsNarrowLayout(window.innerWidth < breakpoint);
    check(); // Re-check with actual CSS variable value
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Split view: right-side file preview panel (experimental)
  const isSplitViewEnabled = config.experimentalSplitView ?? true;
  const [splitFile, setSplitFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);
  // Clear split panel when feature is turned off (prevents stale split state)
  useEffect(() => { if (!isSplitViewEnabled) setSplitFile(null); }, [isSplitViewEnabled]);
  const [splitRatio, setSplitRatio] = useState(0.5); // 0-1, left panel fraction
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const isDraggingSplitRef = useRef(false);
  const splitRatioRef = useRef(splitRatio);
  splitRatioRef.current = splitRatio;
  // Store drag listeners in refs so unmount cleanup can remove them
  const dragMoveRef = useRef<((ev: MouseEvent) => void) | null>(null);
  const dragUpRef = useRef<(() => void) | null>(null);

  // ── Embedded terminal state ──
  // Terminal lifecycle is tied to this Tab, not to the panel visibility.
  // Hiding the panel keeps the PTY alive; only Tab close kills it.
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [terminalAlive, setTerminalAlive] = useState(false);
  const terminalIdRef = useRef<string | null>(null);
  terminalIdRef.current = terminalId;
  // Whether the user has the terminal "pinned" to the split panel.
  // true = terminal is shown in the panel (or being created).
  // false = terminal may be alive in background but not displayed.
  // Clicking terminal icon sets true; clicking terminal × sets false.
  const [terminalPinned, setTerminalPinned] = useState(false);
  // Which view is active in the right panel: 'file', 'terminal', or 'browser'
  const [splitActiveView, setSplitActiveView] = useState<'file' | 'terminal' | 'browser'>('file');

  // ── Embedded browser state ──
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserAlive, setBrowserAlive] = useState(false);
  // When browser is previewing a local file, store its metadata for editor toggle
  const [browserSourceFile, setBrowserSourceFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);

  // ── Introduction overlay: read INTRODUCTION.md per agentDir/sessionId ──
  // sessionId in deps → re-reads when user creates a new session (so edits via settings are reflected)
  useEffect(() => {
    if (!agentDir || !isTauriEnvironment()) return;
    setIntroductionContent(null); // Clear stale content before async read
    let cancelled = false;
    const sep = agentDir.includes('\\') ? '\\' : '/';
    const filePath = `${agentDir}${sep}INTRODUCTION.md`;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string | null>('cmd_read_workspace_file', { path: filePath })
        .then(content => {
          if (!cancelled) setIntroductionContent(content && content.trim() ? content : null);
        })
        .catch(() => {
          if (!cancelled) setIntroductionContent(null);
        });
    });
    return () => { cancelled = true; };
  }, [agentDir, sessionId]);

  // Derived: is the right split panel visible?
  const splitPanelVisible = splitFile !== null
    || (terminalPinned && (terminalAlive || splitActiveView === 'terminal'))
    || (browserUrl !== null);
  // Should the terminal component stay mounted? (for xterm.js state preservation)
  const terminalMounted = terminalAlive || (terminalPinned && splitActiveView === 'terminal');

  // When split view is active or layout is narrow, workspace uses overlay drawer
  const shouldUseWorkspaceOverlay = isNarrowLayout || (isSplitViewEnabled && splitPanelVisible);

  // Cmd+W: split panel visible → always close the active view first (no focus detection).
  // Simpler mental model: Cmd+W closes from right to left, outside to inside.
  // Split panel acts as a buffer — absorbs Cmd+W before it reaches the tab.
  useCloseLayer(() => {
    if (!splitPanelVisible) return false;
    if (splitActiveView === 'file' && splitFile) {
      setSplitFile(null);
      if (browserUrl) setSplitActiveView('browser');
      else if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
      return true;
    }
    if (splitActiveView === 'terminal' && terminalPinned) {
      setTerminalPinned(false);
      if (browserUrl) setSplitActiveView('browser');
      else if (splitFile) setSplitActiveView('file');
      return true;
    }
    if (splitActiveView === 'browser' && browserUrl) {
      setBrowserUrl(null);
      setBrowserAlive(false);
      setBrowserSourceFile(null);
      if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
      else if (splitFile) setSplitActiveView('file');
      return true;
    }
    return false;
  }, 0);

  // Fullscreen preview triggered from split panel's "全屏预览" button
  const [fullscreenPreviewFile, setFullscreenPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);

  const handleSplitFilePreview = useCallback((file: { name: string; content: string; size: number; path: string }) => {
    const ext = file.name.toLowerCase().split('.').pop();
    if ((ext === 'html' || ext === 'htm') && isSplitViewEnabled) {
      // HTML files → open in embedded browser for live preview
      // Store file metadata so browser toolbar can offer "Edit Source" toggle
      setBrowserSourceFile(file);
      // file.path is relative to agentDir — construct absolute path for Rust
      const sep = agentDir?.includes('\\') ? '\\' : '/';
      const absPath = agentDir ? `${agentDir}${sep}${file.path}` : file.path;
      setBrowserUrl(absPath);
      setSplitActiveView('browser');
    } else {
      setSplitFile(file);
      setSplitActiveView('file');
    }
    // Keep workspace open — user can dismiss it manually
  }, [isSplitViewEnabled, agentDir]);

  // Open terminal in split panel (called from DirectoryPanel header button)
  const handleOpenTerminal = useCallback(() => {
    setTerminalPinned(true);
    setSplitActiveView('terminal');
    // If terminal was already created, just switch view; otherwise TerminalPanel will create it
  }, []);

  // Open a URL in the embedded browser panel
  const handleOpenInBrowserPanel = useCallback((url: string) => {
    setBrowserUrl(url);
    setSplitActiveView('browser');
  }, []);

  const handleBrowserCreated = useCallback(() => setBrowserAlive(true), []);
  const handleBrowserCreateFailed = useCallback(() => {
    setBrowserAlive(false);
    setBrowserUrl(null);
    setBrowserSourceFile(null);
  }, []);
  const handleBrowserClose = useCallback(() => {
    setBrowserUrl(null);
    setBrowserAlive(false);
    setBrowserSourceFile(null);
    if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
    else if (splitFile) setSplitActiveView('file');
  }, [terminalPinned, terminalAlive, splitFile]);

  // Switch from browser preview to editor for a local HTML file.
  // Re-reads from disk to ensure editor shows the latest saved content
  // (browserSourceFile holds the initial snapshot which may be stale).
  const handleBrowserSwitchToEditor = useCallback(async () => {
    if (!browserSourceFile || !agentDir) return;
    setSplitActiveView('file');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const sep = agentDir.includes('\\') ? '\\' : '/';
      const absPath = `${agentDir}${sep}${browserSourceFile.path}`;
      const fresh = await invoke<string | null>('cmd_read_workspace_file', { path: absPath });
      if (fresh !== null) {
        const updated = { ...browserSourceFile, content: fresh, size: new Blob([fresh]).size };
        setBrowserSourceFile(updated);
        setSplitFile(updated);
      } else {
        setSplitFile(browserSourceFile);
      }
    } catch {
      setSplitFile(browserSourceFile); // fallback: use cached version
    }
  }, [browserSourceFile, agentDir]);

  // Switch from editor back to browser preview for an HTML file.
  // Reloads webview so it reflects any edits saved to disk.
  const handleEditorSwitchToBrowser = useCallback(() => {
    if (!browserUrl) return;
    setSplitActiveView('browser');
    // Give auto-save a moment to flush, then reload the webview
    setTimeout(() => {
      import('@tauri-apps/api/core').then(({ invoke: inv }) => {
        inv('cmd_browser_reload', { tabId }).catch(() => {});
      });
    }, 300);
  }, [browserUrl, tabId]);

  // Stable context value for BrowserPanelContext (only provided when split view is available)
  const browserPanelCtx = useMemo(
    () => (isSplitViewEnabled && !isNarrowLayout ? { openUrl: handleOpenInBrowserPanel } : null),
    [isSplitViewEnabled, isNarrowLayout, handleOpenInBrowserPanel],
  );

  // When split panel closes entirely, restore workspace sidebar to visible
  const prevSplitVisibleRef = useRef(splitPanelVisible);
  useEffect(() => {
    if (prevSplitVisibleRef.current && !splitPanelVisible) {
      // Split just closed → show workspace sidebar
      setShowWorkspace(true);
    }
    prevSplitVisibleRef.current = splitPanelVisible;
  }, [splitPanelVisible]);

  // Cleanup terminal PTY on unmount (Tab close)
  useEffect(() => {
    return () => {
      const id = terminalIdRef.current;
      if (id) {
        // Fire-and-forget: Rust will clean up the PTY
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('cmd_terminal_close', { terminalId: id }).catch(() => {});
        });
      }
    };
  }, []);

  const handleSplitDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSplitRef.current = true;
    setIsDraggingSplit(true);
    const startX = e.clientX;
    const startRatio = splitRatioRef.current;
    const containerWidth = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingSplitRef.current) return;
      const dx = ev.clientX - startX;
      const newRatio = Math.max(0.35, Math.min(0.65, startRatio + dx / containerWidth));
      setSplitRatio(newRatio);
    };
    const onMouseUp = () => {
      isDraggingSplitRef.current = false;
      setIsDraggingSplit(false);
      dragMoveRef.current = null;
      dragUpRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    dragMoveRef.current = onMouseMove;
    dragUpRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []); // stable — uses ref for splitRatio

  // Cleanup drag listeners on unmount (prevents leak if component unmounts mid-drag)
  useEffect(() => {
    return () => {
      if (dragMoveRef.current) document.removeEventListener('mousemove', dragMoveRef.current);
      if (dragUpRef.current) document.removeEventListener('mouseup', dragUpRef.current);
      isDraggingSplitRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [workspaceRefreshKey, _setWorkspaceRefreshKey] = useState(0); // Key to trigger workspace refresh
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    (currentAgent?.permissionMode as PermissionMode | undefined) ?? currentProject?.permissionMode ?? 'auto'
  );
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    currentAgent?.model ?? currentProject?.model ?? currentProvider?.primaryModel
  );
  // Cron task state
  const [showCronSettings, setShowCronSettings] = useState(false);
  const [cronPrompt, setCronPrompt] = useState('');
  const [cronCardTask, setCronCardTask] = useState<CronTask | null>(null);
  const [cronDetailTask, setCronDetailTask] = useState<CronTask | null>(null);

  // Track permission mode before AI-triggered plan mode (for restore on ExitPlanMode)
  const prePlanPermissionModeRef = useRef<PermissionMode | null>(null);

  // Startup overlay state (for auto-send from Launcher)
  const [showStartupOverlay, setShowStartupOverlay] = useState(!!initialMessage);

  // Time rewind state
  const [rewindTarget, setRewindTarget] = useState<{
    messageId: string;
    content: string;
    attachments?: import('@/types/chat').MessageAttachment[];
  } | null>(null);
  const [rewindStatus, setRewindStatus] = useState<string | null>(null);

  // Fork state
  const [forkTarget, setForkTarget] = useState<string | null>(null); // assistant message ID

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Refs for one-time project settings sync (see effect after provider change effect)
  const hadInitialMessage = useRef(!!initialMessage);
  const projectSyncedRef = useRef(false);

  // Ref for input focus
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Ref for SimpleChatInput to call processDroppedFiles
  const chatInputRef = useRef<SimpleChatInputHandle>(null);

  // Ref for DirectoryPanel to trigger refresh
  const directoryPanelRef = useRef<DirectoryPanelHandle>(null);

  // Ref for tracking previous isActive state (for config sync on tab switch)
  const prevIsActiveRef = useRef(isActive);

  // Track whether we're joining an existing sidecar (e.g. IM Bot session)
  // When true, mount effects skip config push and adopt sidecar's config instead.
  const joinedExistingSidecarRef = useRef(joinedExistingSidecar ?? false);
  joinedExistingSidecarRef.current = joinedExistingSidecar ?? false;

  // Ref for chat content area (for Tauri drop zone)
  const chatContentRef = useRef<HTMLDivElement>(null);

  // Ref for directory panel container (for Tauri drop zone)
  const directoryPanelContainerRef = useRef<HTMLDivElement>(null);

  // State to trigger workspace refresh
  const [workspaceRefreshTrigger, setWorkspaceRefreshTrigger] = useState(0);

  // Enabled sub-agents for sidebar display
  const [enabledAgents, setEnabledAgents] = useState<Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project' }> | undefined>();
  // Enabled skills/commands for sidebar display
  const [enabledSkills, setEnabledSkills] = useState<Array<{ name: string; description: string; scope?: 'user' | 'project'; folderName?: string }>>([]);
  const [enabledCommands, setEnabledCommands] = useState<Array<{ name: string; description: string; scope?: 'user' | 'project' }>>([]);
  const [globalSkillFolderNames, setGlobalSkillFolderNames] = useState<Set<string>>(new Set());
  // Initial tab for workspace config panel (set when opening from capabilities panel)
  const [workspaceConfigInitialTab, setWorkspaceConfigInitialTab] = useState<WorkspaceTab | undefined>();

  // Agent Runtime detection (v0.1.59)
  const [runtimeDetections, setRuntimeDetections] = useState<RuntimeDetections>({
    'builtin': { installed: true },
    'claude-code': { installed: false },
    'codex': { installed: false },
  });
  // Gate: when multiAgentRuntime is off, treat everything as builtin regardless of agent config.
  // This gate is applied at the definition of currentRuntime itself so ALL downstream
  // derivations (runtimePermissionModes, runtimeModels, etc.) are automatically safe.
  const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;
  const currentRuntime = multiAgentRuntimeEnabled
    ? ((currentAgent?.runtime as RuntimeType) || 'builtin')
    : 'builtin';
  const isExternalRuntime = currentRuntime !== 'builtin';

  // Detect installed runtimes once on mount
  useEffect(() => {
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<Record<string, { installed: boolean; version?: string; path?: string }>>('cmd_detect_runtimes')
        .then(detections => { if (!cancelled) setRuntimeDetections(detections as RuntimeDetections); })
        .catch(() => { /* detection failure is non-fatal */ });
    });
    return () => { cancelled = true; };
  }, []);
  const [runtimeModel, setRuntimeModel] = useState<string | undefined>(
    (currentAgent?.runtimeConfig as { model?: string } | undefined)?.model
  );
  const [runtimePermissionMode, setRuntimePermissionMode] = useState<string>(
    (currentAgent?.runtimeConfig as { permissionMode?: string } | undefined)?.permissionMode
    || (currentRuntime === 'claude-code' ? 'default' : 'full-auto')
  );

  // Runtime-specific models and permission modes
  const runtimePermissionModes = currentRuntime === 'claude-code' ? CC_PERMISSION_MODES
    : currentRuntime === 'codex' ? CODEX_PERMISSION_MODES : undefined;

  // Codex models are dynamic (fetched from app-server); CC models are static
  const [codexModels, setCodexModels] = useState<typeof CC_MODELS>([]);
  useEffect(() => {
    if (!multiAgentRuntimeEnabled || currentRuntime !== 'codex') return;
    let cancelled = false;
    apiGet('/api/runtime/models?type=codex').then((res: unknown) => {
      const data = res as { models?: typeof CC_MODELS } | undefined;
      if (!cancelled && data?.models?.length) setCodexModels(data.models);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [multiAgentRuntimeEnabled, currentRuntime, apiGet]);

  const runtimeModels = currentRuntime === 'claude-code' ? CC_MODELS
    : currentRuntime === 'codex' ? codexModels : undefined;

  // Effective model/permission based on runtime
  const effectiveModel = isExternalRuntime ? runtimeModel : selectedModel;
  const effectivePermissionMode = isExternalRuntime
    ? runtimePermissionMode as PermissionMode
    : permissionMode;

  // Callback to refresh workspace (exposed to SimpleChatInput)
  const triggerWorkspaceRefresh = useCallback(() => {
    setWorkspaceRefreshTrigger(prev => prev + 1);
  }, []);

  // Stable callbacks for DirectoryPanel → AgentCapabilitiesPanel
  const handleInsertReference = useCallback((paths: string[]) => {
    chatInputRef.current?.insertReferences(paths);
  }, []);

  const handleInsertSlashCommand = useCallback((command: string) => {
    chatInputRef.current?.insertSlashCommand(command);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setWorkspaceConfigInitialTab('skills');
    setShowWorkspaceConfig(true);
  }, []);

  // Auto-send initial message from Launcher
  const initialMessageConsumedRef = useRef(false);
  const onInitialMessageConsumedRef = useRef(onInitialMessageConsumed);
  onInitialMessageConsumedRef.current = onInitialMessageConsumed;

  useEffect(() => {
    if (!initialMessage || initialMessageConsumedRef.current) return;
    // Wait for SSE connection (sidecar reachable) instead of non-pending sessionId.
    // The sessionId upgrades from pending only after the first message is processed,
    // but the first message IS the auto-send — so checking isPendingSessionId would deadlock.
    if (!isActive || !sessionId || !isConnected) return;

    initialMessageConsumedRef.current = true;

    const autoSend = async () => {
      try {
        // 1. Sync MCP configuration
        if (initialMessage.mcpEnabledServers?.length) {
          const allServers = await getAllMcpServers();
          syncMcpServerNames(allServers);
          const globalEnabled = await getEnabledMcpServerIds();
          const effective = allServers.filter(s =>
            globalEnabled.includes(s.id) && initialMessage.mcpEnabledServers!.includes(s.id)
          );
          await apiPost('/api/mcp/set', { servers: effective });
        }

        // 2. Compute effective values BEFORE setState (avoid stale closure)
        const effectivePermission = initialMessage.permissionMode ?? permissionMode;
        // External runtime uses runtimeModel as fallback (not selectedModel which is the builtin model).
        // When both are undefined (user picked "默认"), pass undefined to let the CLI use its own default.
        const effectiveModel = initialMessage.model ?? (isExternalRuntime ? runtimeModel : selectedModel);

        // 3. Update local UI state to reflect Launcher choices
        if (initialMessage.permissionMode) setPermissionMode(initialMessage.permissionMode);
        if (initialMessage.model) {
          // External runtime (Codex/CC) uses runtimeModel; builtin uses selectedModel.
          // Setting the wrong one causes the model from Launcher to be ignored on subsequent messages.
          if (isExternalRuntime) {
            setRuntimeModel(initialMessage.model);
          } else {
            setSelectedModel(initialMessage.model);
          }
        }
        if (initialMessage.providerId) {
          setSelectedProviderId(initialMessage.providerId);
          providerInitRef.current = true; // suppress deferred provider-change effect
        }

        // 4. Build providerEnv locally from providerId (never stored in Tab state for security)
        const provider = initialMessage.providerId
          ? providers.find(p => p.id === initialMessage.providerId) ?? currentProvider
          : currentProvider;
        const providerEnv = buildProviderEnv(provider);

        // 5. Send message
        setIsLoading(true);
        scrollToBottom();
        await sendMessage(
          initialMessage.text,
          initialMessage.images,
          effectivePermission,
          effectiveModel,
          isExternalRuntime ? undefined : providerEnv
        );

        // 6. Hide overlay
        setShowStartupOverlay(false);
        onInitialMessageConsumedRef.current?.();
      } catch (err) {
        console.error('[Chat] Auto-send failed:', err);
        setShowStartupOverlay(false);
        onInitialMessageConsumedRef.current?.();
        toast.error('发送失败，请重试');
      }
    };
    void autoSend();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage, isActive, sessionId, isConnected]);

  // Safety timeout for startup overlay (30s)
  useEffect(() => {
    if (!showStartupOverlay) return;
    const t = setTimeout(() => setShowStartupOverlay(false), 30000);
    return () => clearTimeout(t);
  }, [showStartupOverlay]);

  // Cron task management hook
  const {
    state: cronState,
    enableCronMode,
    disableCronMode,
    updateConfig: _updateCronConfig,
    updateRunningConfig,
    startTask: startCronTask,
    stop: stopCronTask,
    restoreFromTask: restoreCronTask,
    updateSessionId: updateCronTaskSessionId,
  } = useCronTask({
    workspacePath: agentDir,
    sessionId: sessionId ?? '',
    tabId,
    onExecute: async (_taskId, prompt, _isFirstExecution, _aiCanExit) => {
      // Send cron task message
      // Note: taskId, isFirstExecution, aiCanExit are available for future enhancements
      // (e.g., injecting cron context into system prompt)
      const providerEnv = buildProviderEnv(currentProvider);
      await sendMessage(prompt, undefined, permissionMode, selectedModel, providerEnv, true /* isCron */);
    },
    onComplete: (task, reason) => {
      console.log('[Chat] Cron task completed:', task.id, reason);
    },
    onExecutionComplete: async (task, success) => {
      // Called when a single execution completes (task may still be running)
      // Refresh the session to show the latest messages
      // Use internalSessionId when available, falling back to sessionId.
      // Both point to our internal message storage key (Sidecar session ID).
      const effectiveSessionId = task.internalSessionId || task.sessionId;
      console.log('[Chat] Cron execution complete, refreshing session:', task.id, task.executionCount, 'effectiveSessionId:', effectiveSessionId, 'success:', success);
      setIsLoading(false);
      // Only refresh session on successful execution.
      // On timeout (success=false), the original streaming task may still be running
      // and calling loadSession would abort it (via switchToSession) and lose data.
      if (success && effectiveSessionId) {
        await loadSession(effectiveSessionId);
      }
    },
    // Register for SSE cron:task-exit-requested events via TabContext
    onCronTaskExitRequestedRef: onCronTaskExitRequested,
  });

  // PERFORMANCE: Ref-stabilize cronState for handleSendMessage
  const cronStateRef = useRef(cronState);
  cronStateRef.current = cronState;

  // Sync cron task's sessionId when session is created after task creation
  // This handles two cases:
  // 1. Task has empty sessionId (legacy) - needs to be updated
  // 2. Task has pending sessionId (pending-xxx) and real sessionId is now available
  const sessionIdSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    const task = cronState.task;
    if (!task || !sessionId) return;

    // Skip if sessionId is still pending (no real session ID yet)
    if (isPendingSessionId(sessionId)) return;

    // If task has empty or pending sessionId but we now have a real sessionId, update the task
    // Use ref to prevent duplicate updates for the same sessionId
    const taskNeedsUpdate = task.sessionId === '' || isPendingSessionId(task.sessionId);
    if (taskNeedsUpdate && sessionIdSyncedRef.current !== sessionId) {
      sessionIdSyncedRef.current = sessionId;
      console.log(`[Chat] Syncing cron task sessionId: taskId=${task.id}, oldSessionId=${task.sessionId}, newSessionId=${sessionId}`);
      void updateCronTaskSessionId(sessionId);
    }
  }, [cronState.task, sessionId, updateCronTaskSessionId]);

  // File drop zone for chat area (HTML5 drag-drop for non-Tauri/development)
  const handleFileDrop = useCallback((files: File[]) => {
    chatInputRef.current?.processDroppedFiles(files);
  }, []);

  const { isDragActive, dragHandlers } = useFileDropZone({
    onFilesDropped: handleFileDrop,
  });

  // Handle Tauri file drop on chat area (copy to pm_copilot_files + insert reference)
  const handleTauriChatDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on chat area:', paths);
    }
    // Use the SimpleChatInput's method to process file paths
    await chatInputRef.current?.processDroppedFilePaths?.(paths);
    // Refresh workspace to show new files
    triggerWorkspaceRefresh();
  }, [triggerWorkspaceRefresh]);

  // Handle Tauri file drop on directory panel
  const handleTauriDirectoryDrop = useCallback(async (paths: string[]) => {
    if (isDebugMode()) {
      console.log('[Chat] Tauri drop on directory panel:', paths);
    }
    // DirectoryPanel handles this internally now
    await directoryPanelRef.current?.handleFileDrop(paths);
  }, []);

  // Use refs to avoid recreating onDrop callback when handlers change
  const handleTauriChatDropRef = useRef(handleTauriChatDrop);
  const handleTauriDirectoryDropRef = useRef(handleTauriDirectoryDrop);
  useEffect(() => {
    handleTauriChatDropRef.current = handleTauriChatDrop;
    handleTauriDirectoryDropRef.current = handleTauriDirectoryDrop;
  }, [handleTauriChatDrop, handleTauriDirectoryDrop]);

  const { isDragging: isTauriDragging, activeZoneId, registerZone, unregisterZone } = useTauriFileDrop({
    onDrop: (paths, zoneId) => {
      if (isDebugMode()) {
        console.log('[Chat] Tauri drop event - zoneId:', zoneId, 'paths:', paths);
      }
      if (zoneId === 'chat-content') {
        void handleTauriChatDropRef.current(paths);
      } else if (zoneId === 'directory-panel') {
        void handleTauriDirectoryDropRef.current(paths);
      } else {
        // Default: drop to chat area
        void handleTauriChatDropRef.current(paths);
      }
    },
  });

  // Register drop zones for Tauri (only for position detection, handlers are in onDrop above)
  useEffect(() => {
    if (!isTauriEnvironment()) return;

    // Register chat content drop zone (empty callback - handled in global onDrop)
    registerZone('chat-content', chatContentRef.current, () => {});

    // Register directory panel drop zone (empty callback - handled in global onDrop)
    registerZone('directory-panel', directoryPanelContainerRef.current, () => {});

    return () => {
      unregisterZone('chat-content');
      unregisterZone('directory-panel');
    };
  }, [registerZone, unregisterZone]);

  // Combined drag active state (HTML5 or Tauri)
  const isAnyDragActive = isDragActive || isTauriDragging;

  // MCP state
  const [mcpServers, setMcpServers] = useState<McpServerDefinition[]>([]);
  const [globalMcpEnabled, setGlobalMcpEnabled] = useState<string[]>([]);
  const [workspaceMcpEnabled, setWorkspaceMcpEnabled] = useState<string[]>(
    currentAgent?.mcpEnabledServers ?? currentProject?.mcpEnabledServers ?? []
  );

  // Track which session's cron task state has been loaded
  const cronLoadedSessionRef = useRef<string | null>(null);

  // Track if we need to set loading state after TabProvider's loadSession completes
  // This is used when restoring a cron task that is currently executing
  const pendingCronLoadingRef = useRef(false);

  // Track previous messages reference to detect when loadSession completes
  // Using reference comparison instead of length to handle edge case where
  // message count stays the same after loadSession
  const prevMessagesRef = useRef(messages);

  // Restore or clear cron task state when session changes
  // 方案 A: Rust 统一恢复 - Scheduler 由 Rust 层 initialize_cron_manager 自动恢复
  // 前端只负责同步 UI 状态
  //
  // This handles:
  // 1. App restart recovery - restore cron task UI for running/paused tasks
  //    (Scheduler already started by Rust layer)
  // 2. Tab re-open - reconnect to existing cron task
  // 3. Session switch - clear cron state if switching to a session without cron task
  useEffect(() => {
    if (!sessionId || !tabId || !isTauriEnvironment()) return;

    // Skip if already loaded for this session
    if (cronLoadedSessionRef.current === sessionId) return;

    const loadCronTaskState = async () => {
      try {
        const task = await getSessionCronTask(sessionId);

        if (task && task.status === 'running') {
          console.log('[Chat] Restoring cron task UI for session:', sessionId, task.id, 'to tab:', tabId);

          // Update task's tabId to this new tab
          await updateCronTaskTab(task.id, tabId);

          // Restore UI state only - Scheduler is managed by Rust layer (方案 A)
          // Do NOT call startCronScheduler here to avoid duplicate scheduler starts
          restoreCronTask(task);

          // Check if task is currently executing (e.g., execution started before app restart)
          // If executing, mark it so we can set loading state after TabProvider's loadSession completes
          // NOTE: Do NOT call loadSession here - TabProvider already handles session loading
          // Calling it here causes infinite loop with TabProvider's session loading effect
          const executing = await isTaskExecuting(task.id);
          if (executing) {
            console.log('[Chat] Cron task is currently executing, marking for loading state');
            pendingCronLoadingRef.current = true;
          }
        } else if (cronState.task && cronState.task.sessionId && cronState.task.sessionId !== sessionId) {
          // Current cron state is for a different session - clear FRONTEND state only
          // This happens when user switches from a cron-task session to a regular session
          // Note: Only clear if cronState.task.sessionId is NOT empty (empty means task was just created)
          //
          // IMPORTANT: We do NOT call stopCronTask() here because:
          // 1. The task should continue running for its original session
          // 2. The Rust scheduler executes on session-specific Sidecar
          // 3. When user goes back to the original session, state will be restored (above code)
          // 4. Per PRD: "暂停后允许手动对话" - task continues while user interacts with other sessions
          //
          // EXCEPTION: Don't clear if this is a pending -> real session ID upgrade (same cron task!)
          // This happens when SDK creates the real session after first message
          const isSessionUpgrade = isPendingSessionId(cronState.task.sessionId) && !isPendingSessionId(sessionId);
          if (isSessionUpgrade) {
            console.log('[Chat] Session ID upgraded from pending to real, keeping cron state:', cronState.task.sessionId, '->', sessionId);
          } else {
            console.log('[Chat] Clearing frontend cron state (session changed from', cronState.task.sessionId, 'to', sessionId, ')');
            disableCronMode();
          }
        }

        cronLoadedSessionRef.current = sessionId;
      } catch (error) {
        console.error('[Chat] Failed to load cron task state:', error);
      }
    };

    void loadCronTaskState();
  }, [sessionId, tabId, restoreCronTask, disableCronMode, cronState.task, setIsLoading]);

  // Set loading state after TabProvider's loadSession completes (for cron task executing scenario)
  // This effect watches for messages reference changes, which indicates loadSession has completed
  // Using reference comparison (not length) to handle edge case where message count stays the same
  useEffect(() => {
    // Only proceed if we have pending cron loading and messages array has changed
    if (pendingCronLoadingRef.current && messages !== prevMessagesRef.current) {
      console.log('[Chat] loadSession completed, setting loading state for cron execution');
      setIsLoading(true);
      pendingCronLoadingRef.current = false;
    }
    prevMessagesRef.current = messages;
  }, [messages, setIsLoading]);

  // Load MCP config on mount and sync to backend
  useEffect(() => {
    const loadMcpConfig = async () => {
      try {
        // When joining an existing sidecar (e.g. IM Bot session), skip pushing Tab's
        // MCP config to avoid overwriting the session's current config.
        // Still load local MCP state for sidebar display.
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        syncMcpServerNames(servers);
        setGlobalMcpEnabled(enabledIds);

        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping MCP push (joined existing sidecar)');
          }
          return;
        }

        // CRITICAL: Always sync effective MCP servers to backend on initial load
        // This ensures the Agent SDK has correct MCP config (including empty = no MCP)
        // Without this, backend currentMcpServers stays null and falls back to file config
        const workspaceEnabled = currentAgent?.mcpEnabledServers ?? currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );

        // Always call /api/mcp/set, even with empty array
        // Empty array means "user explicitly disabled all MCP"
        // null (not calling) means "use file config fallback" - which we don't want
        await apiPost('/api/mcp/set', { servers: effectiveServers });
        if (isDebugMode()) {
          console.log('[Chat] Initial MCP sync:', effectiveServers.map(s => s.id).join(', ') || 'none');
        }
      } catch (err) {
        console.error('[Chat] Failed to load MCP config:', err);
      }
    };
    loadMcpConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only reload when agent/project MCP config changes
  }, [currentAgent?.mcpEnabledServers, currentProject?.mcpEnabledServers]);

  // Load enabled agents and sync to backend
  const loadAndSyncAgents = useCallback(async () => {
    try {
      const response = await apiGet<{ success: boolean; agents: Record<string, { description: string; prompt: string; model?: string; scope?: 'user' | 'project' }> }>('/api/agents/enabled');
      if (response.success && response.agents) {
        setEnabledAgents(response.agents);
        // Skip push when joining existing sidecar to avoid overwriting session config
        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping agents push (joined existing sidecar)');
          }
          return;
        }
        // Sync to backend for SDK injection
        await apiPost('/api/agents/set', { agents: response.agents });
        if (isDebugMode()) {
          console.log('[Chat] Agents synced:', Object.keys(response.agents).join(', ') || 'none');
        }
      }
    } catch (err) {
      console.error('[Chat] Failed to load agents:', err);
    }
  }, [apiGet, apiPost]);

  // Load skills/commands for sidebar display
  const loadSkillsAndCommands = useCallback(async () => {
    try {
      const response = await apiGet<{ success: boolean; commands: Array<{ name: string; description: string; source: string; scope?: 'user' | 'project'; folderName?: string }>; globalSkillFolderNames?: string[] }>('/api/commands');
      if (response.success && response.commands) {
        setEnabledSkills(response.commands.filter(c => c.source === 'skill').map(c => ({ name: c.name, description: c.description, scope: c.scope, folderName: c.folderName })));
        setEnabledCommands(response.commands.filter(c => c.source === 'custom').map(c => ({ name: c.name, description: c.description, scope: c.scope })));
        setGlobalSkillFolderNames(new Set(response.globalSkillFolderNames || []));
      }
    } catch (err) {
      console.error('[Chat] Failed to load skills/commands:', err);
    }
  }, [apiGet]);

  // Sync project skill to global
  const loadSkillsAndCommandsRef = useRef(loadSkillsAndCommands);
  loadSkillsAndCommandsRef.current = loadSkillsAndCommands;

  const handleSyncSkillToGlobal = useCallback(async (folderName: string) => {
    try {
      const res = await apiPost<{ success: boolean; error?: string }>('/api/skill/copy-to-global', { folderName });
      if (res.success) {
        toastRef.current.success('已同步至全局技能');
        loadSkillsAndCommandsRef.current();
      } else {
        toastRef.current.error(res.error || '同步失败');
      }
    } catch (err) {
      console.error('[Chat] Sync skill to global failed:', err);
      toastRef.current.error('同步失败，请重试');
    }
  }, [apiPost]);

  // Load capabilities on mount and when workspace config changes (e.g. skill copied, settings saved)
  useEffect(() => {
    loadAndSyncAgents();
    loadSkillsAndCommands();
  }, [loadAndSyncAgents, loadSkillsAndCommands, workspaceRefreshTrigger]);

  // Sync workspace MCP to project config when it changes
  useEffect(() => {
    if (currentProject?.mcpEnabledServers) {
      setWorkspaceMcpEnabled(currentProject.mcpEnabledServers);
    }
  }, [currentProject?.mcpEnabledServers]);

  // Handle workspace MCP toggle — persist via patchProject (updates disk + React state)
  const handleWorkspaceMcpToggle = useCallback(async (serverId: string, enabled: boolean) => {
    const newEnabled = enabled
      ? [...workspaceMcpEnabled, serverId]
      : workspaceMcpEnabled.filter(id => id !== serverId);

    setWorkspaceMcpEnabled(newEnabled);

    // Persist to project config (patchProject updates disk AND projects React state,
    // keeping currentProject.mcpEnabledServers in sync for tab-activate sync at L672)
    if (currentProject) {
      void patchProject(currentProject.id, { mcpEnabledServers: newEnabled });
      if (currentProject?.agentId) {
        void patchAgentConfig(currentProject.agentId, { mcpEnabledServers: newEnabled });
      }
    }

    // Get the effective MCP servers and send to backend
    const effectiveServers = mcpServers.filter(s =>
      globalMcpEnabled.includes(s.id) && newEnabled.includes(s.id)
    );

    try {
      await apiPost('/api/mcp/set', { servers: effectiveServers });
      console.log('[Chat] MCP servers synced:', effectiveServers.map(s => s.id));
    } catch (err) {
      console.error('[Chat] Failed to sync MCP servers:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apiPost is stable, only care about state changes
  }, [workspaceMcpEnabled, currentProject, mcpServers, globalMcpEnabled]);

  // Sync selectedModel when provider changes (skip initial mount to preserve project-stored model)
  const providerInitRef = useRef(true);
  useEffect(() => {
    if (providerInitRef.current) {
      providerInitRef.current = false;
      return;
    }
    if (currentProvider?.primaryModel) {
      setSelectedModel(currentProvider.primaryModel);
    }
  }, [currentProvider?.id, currentProvider?.primaryModel]);

  // One-time sync: apply project-stored settings after useConfig finishes async load.
  // useState initializers run with currentProject=undefined (useConfig loads asynchronously),
  // so project settings must be re-applied once currentProject becomes available.
  // Placed AFTER provider change effect so project model takes priority in same render cycle.
  // Skipped when initialMessage is provided (BrandSection path applies its own settings).
  useEffect(() => {
    if (!currentProject || projectSyncedRef.current || hadInitialMessage.current) return;
    projectSyncedRef.current = true;
    // AgentConfig is source of truth, Project is fallback for non-agent workspaces
    const effectivePermission = (currentAgent?.permissionMode as PermissionMode | undefined) ?? currentProject.permissionMode ?? config.defaultPermissionMode;
    setPermissionMode(effectivePermission);
    // Sync provider (useState initializer runs when currentProject is still undefined).
    // Re-arm providerInitRef to suppress the deferred provider-change effect (fires next render)
    // that would otherwise override the project-stored model with provider's primaryModel.
    const effectiveProvider = currentAgent?.providerId ?? currentProject.providerId;
    if (effectiveProvider) {
      setSelectedProviderId(effectiveProvider);
      providerInitRef.current = true;
    }
    // Skip model override when joining existing sidecar — adoption effect will set the correct model
    const effectiveModel = currentAgent?.model ?? currentProject.model;
    if (effectiveModel && !joinedExistingSidecarRef.current) {
      setSelectedModel(effectiveModel);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time sync when project first loads
  }, [currentProject?.id]);

  // 若 selectedModel 不在当前 provider 的 models 中（如模型已被删除），回退到 primaryModel 并更新项目
  useEffect(() => {
    if (!currentProject || !currentProvider || joinedExistingSidecarRef.current) return;
    if (currentProvider.type === 'subscription' || !Array.isArray(currentProvider.models) || currentProvider.models.length === 0) return;
    if (!selectedModel) return;
    const modelIds = currentProvider.models.map((m) => m.model);
    if (modelIds.includes(selectedModel)) return;
    const fallback = currentProvider.primaryModel;
    if (fallback) {
      setSelectedModel(fallback);
      void patchProject(currentProject.id, { model: fallback });
      if (currentProject?.agentId) {
        void patchAgentConfig(currentProject.agentId, { model: fallback });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to specific sub-properties, not full object refs
  }, [currentProject?.id, currentProvider?.id, currentProvider?.models, currentProvider?.primaryModel, selectedModel, patchProject]);

  // Sync selectedModel to backend so pre-warm uses the correct model.
  // Without this, backend currentModel stays undefined until the first message,
  // causing a blocking setModel() call during pre-warm → active transition.
  useEffect(() => {
    // Skip when external runtime is active — runtimeModel has its own sync effect below.
    // Without this guard, selectedModel (initialized from agent.model, e.g. "glm-5.1")
    // would be pushed to setExternalModel(), overriding the runtime's own model. See: #71
    if (isExternalRuntime) return;
    if (selectedModel) {
      // Skip push when joining existing sidecar — adoption effect will set the correct model
      if (joinedExistingSidecarRef.current) {
        if (isDebugMode()) {
          console.log('[Chat] Skipping model push (joined existing sidecar)');
        }
        return;
      }
      apiPost('/api/model/set', { model: selectedModel }).catch(err => {
        console.error('[Chat] Failed to sync model to backend:', err);
      });
    }
  }, [selectedModel, apiPost, isExternalRuntime]);

  // Sync external runtime model to backend — same pattern as selectedModel above.
  // /api/model/set routes to setExternalModel() when shouldUseExternalRuntime() is true.
  useEffect(() => {
    if (isExternalRuntime && runtimeModel) {
      if (joinedExistingSidecarRef.current) return;
      apiPost('/api/model/set', { model: runtimeModel }).catch(err => {
        console.error('[Chat] Failed to sync runtime model to backend:', err);
      });
    }
  }, [isExternalRuntime, runtimeModel, apiPost]);

  // Adopt sidecar config when joining an existing sidecar (e.g. IM Bot session).
  // Reads the sidecar's current model and applies it to React state so the Tab
  // reflects the session's actual config instead of overwriting it with its own.
  const onJoinedExistingSidecarHandledRef = useRef(onJoinedExistingSidecarHandled);
  onJoinedExistingSidecarHandledRef.current = onJoinedExistingSidecarHandled;
  useEffect(() => {
    if (!joinedExistingSidecar) return;

    const adoptConfig = async () => {
      try {
        const config = await apiGet<{ success: boolean; model?: string | null }>('/api/session/config');
        if (config.success && config.model) {
          setSelectedModel(config.model);
          console.log('[Chat] Adopted sidecar config: model=' + config.model);
        }
      } catch (err) {
        console.error('[Chat] Failed to read sidecar config:', err);
      } finally {
        // Clear the flag whether adoption succeeded or failed
        onJoinedExistingSidecarHandledRef.current?.();
      }
    };

    adoptConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time adoption on mount
  }, [joinedExistingSidecar]);

  const { virtuosoRef, scrollerRef, followEnabledRef, scrollToBottom, pauseAutoScroll, handleAtBottomChange } = useVirtuosoScroll();

  // Capture virtuoso's internal scroller element for QueryNavigator
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    scrollerRef.current = el instanceof HTMLElement ? el : null;
  }, [scrollerRef]);

  // Auto-focus input when Tab becomes active
  useEffect(() => {
    if (isActive && inputRef.current) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isActive]);

  // Sync config when Tab becomes active (from inactive)
  // This ensures settings changes are picked up when switching back to Chat Tab
  useEffect(() => {
    const wasInactive = !prevIsActiveRef.current;
    prevIsActiveRef.current = isActive;

    // Only sync when Tab becomes active (was inactive, now active)
    if (!wasInactive || !isActive) return;

    const syncConfigOnTabActivate = async () => {
      try {
        // 1. Refresh provider data (providers list, API keys, verify status)
        await refreshProviderData();

        // 2. Reload MCP config and sync to backend
        const servers = await getAllMcpServers();
        const enabledIds = await getEnabledMcpServerIds();
        setMcpServers(servers);
        syncMcpServerNames(servers);
        setGlobalMcpEnabled(enabledIds);

        // Skip MCP push when still in the adoption window (joined existing sidecar)
        if (joinedExistingSidecarRef.current) {
          if (isDebugMode()) {
            console.log('[Chat] Skipping MCP push on tab activate (joined existing sidecar)');
          }
          return;
        }

        // 3. Sync effective MCP servers to backend for next message
        const workspaceEnabled = currentAgent?.mcpEnabledServers ?? currentProject?.mcpEnabledServers ?? [];
        const effectiveServers = servers.filter(s =>
          enabledIds.includes(s.id) && workspaceEnabled.includes(s.id)
        );
        await apiPost('/api/mcp/set', { servers: effectiveServers });

        if (isDebugMode()) {
          console.log('[Chat] Config synced on tab activate:', {
            providers: providers.length,
            mcpServers: servers.length,
            effectiveMcp: effectiveServers.map(s => s.id).join(', ') || 'none',
          });
        }
      } catch (err) {
        console.error('[Chat] Failed to sync config on tab activate:', err);
      }
    };

    void syncConfigOnTabActivate();

    // 4. Reload agents & skills/commands (user may have edited in Settings)
    loadAndSyncAgents();
    loadSkillsAndCommands();

    // 5. Refresh file tree
    setWorkspaceRefreshTrigger(prev => prev + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- providers.length is only used for debug logging
  }, [isActive, refreshProviderData, currentProject?.mcpEnabledServers, apiPost]);

  // Connect SSE when component mounts
  useEffect(() => {
    // Only connect if we have a valid agentDir
    if (!agentDir) return;

    void connectSse();

    // Cleanup: disconnect SSE on unmount
    return () => {
      disconnectSse();
    };
    // connectSse/disconnectSse are stable from TabProvider's useCallback
  }, [agentDir, connectSse, disconnectSse]);

  // Listen for skill copy events to refresh DirectoryPanel (file tree shows .claude/skills/)
  // Note: WorkspaceConfigPanel has its own event listener for internalRefreshKey
  useEffect(() => {
    const handleSkillCopied = () => {
      setWorkspaceRefreshTrigger(k => k + 1);
    };
    window.addEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
    return () => window.removeEventListener(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, handleSkillCopied);
  }, []);

  // Handle provider change with analytics tracking.
  // targetModel: when provided, use this model instead of the provider's primaryModel
  // (avoids useEffect race when user picks a specific model from a different provider).
  const handleProviderChange = useCallback((providerId: string, targetModel?: string) => {
    // Skip if selecting the same provider (compare against local state, not shared project)
    if (selectedProviderId === providerId) {
      // Provider unchanged but caller passed a specific model — treat as model change
      if (targetModel) {
        setSelectedModel(targetModel);
        if (currentProject) {
          void patchProject(currentProject.id, { model: targetModel });
          if (currentProject?.agentId) {
            void patchAgentConfig(currentProject.agentId, { model: targetModel });
          }
        }
      }
      return;
    }

    // Track provider_switch event
    track('provider_switch', { provider_id: providerId });

    const newProvider = providers.find(p => p.id === providerId);
    const model = targetModel ?? newProvider?.primaryModel;

    // Cross-protocol guard: third-party (OpenAI bridge) → Anthropic native.
    // Anthropic validates thinking block signatures that third-party providers don't,
    // so session history is incompatible. Show confirm dialog instead of switching inline.
    // Only guard when there are existing messages (fresh sessions can switch freely).
    // Use apiProtocol as primary discriminator (not baseUrl) to avoid false positives
    // with Anthropic API preset which has baseUrl but is still Anthropic-native.
    const currentIsThirdParty = currentProvider?.apiProtocol === 'openai';
    const newIsAnthropicNative = !newProvider?.apiProtocol || newProvider.apiProtocol === 'anthropic';
    if (currentIsThirdParty && newIsAnthropicNative && messagesRef.current.length > 0) {
      setPendingProviderSwitch({ providerId, model });
      return;  // Don't update state — dialog will handle it
    }

    // Update local state — explicitly set both provider and model.
    // Don't rely on the provider-change effect for model cascade, because
    // providerInitRef may be stale (re-armed by one-time sync) and suppress it.
    setSelectedProviderId(providerId);
    if (model) {
      setSelectedModel(model);
    }

    // Suppress the deferred provider-change useEffect — we've already set the correct model
    providerInitRef.current = true;

    // Write back to project (last-writer-wins for new tabs)
    if (currentProject) {
      void patchProject(currentProject.id, { providerId, model: model ?? null });
      if (currentProject?.agentId) {
        void patchAgentConfig(currentProject.agentId, { providerId, model: model ?? undefined });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; messagesRef avoids dep on messages array
  }, [selectedProviderId, currentProject?.id, patchProject, providers, currentProvider?.apiProtocol]);

  // Handle model change with analytics tracking and project write-back
  const handleModelChange = useCallback((model: string) => {
    // Skip if selecting the same model
    if (selectedModel === model) {
      return;
    }

    // Track model_switch event
    track('model_switch', { model });

    setSelectedModel(model);
    if (currentProject) {
      void patchProject(currentProject.id, { model });
      if (currentProject?.agentId) {
        void patchAgentConfig(currentProject.agentId, { model });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id to avoid recreating on unrelated project changes
  }, [selectedModel, currentProject?.id, patchProject]);

  // Handle permission mode change with project write-back
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    if (currentProject) {
      void patchProject(currentProject.id, { permissionMode: mode });
      if (currentProject?.agentId) {
        void patchAgentConfig(currentProject.agentId, { permissionMode: mode });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id to avoid recreating on unrelated project changes
  }, [currentProject?.id, patchProject]);

  // Cross-runtime session detection: session was created by external runtime, but current is builtin.
  // User should be warned before sending new messages (which would use a different runtime).
  const isCrossRuntimeSession = !isExternalRuntime && !!sessionRuntime && sessionRuntime !== 'builtin';
  const [pendingCrossRuntimeMessage, setPendingCrossRuntimeMessage] = useState<{
    text: string;
    images: ImageAttachment[];
  } | null>(null);

  // PERFORMANCE: text is now passed from SimpleChatInput (which manages its own state)
  // This avoids re-rendering Chat on every keystroke.
  // Returns false to signal SimpleChatInput NOT to clear the input (e.g., on rejection).
  const handleSendMessage = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean | void> => {
    // Must have content and not be in stopping state
    if ((!text && (!images || images.length === 0)) || sessionState === 'stopping') {
      return false;
    }

    // Cross-runtime guard: session was created by external runtime (Codex/CC) but
    // current runtime is builtin. Show confirm dialog instead of sending directly.
    if (isCrossRuntimeSession) {
      setPendingCrossRuntimeMessage({ text, images: images ?? [] });
      return false;  // Signal SimpleChatInput NOT to clear the input
    }

    // Queue limit: max 5 queued messages
    const isAiBusy = isLoading || sessionState === 'running';
    if (isAiBusy && queuedMessages.length >= 5) {
      toastRef.current.warning('最多排队 5 条消息');
      return false;
    }

    // Scroll to bottom immediately so user sees their query
    // This also re-enables auto-scroll if user had scrolled up
    scrollToBottom();

    // Only set loading if AI is idle (direct send). For queued sends, don't change loading state.
    if (!isAiBusy) {
      setIsLoading(true);
    }

    // Note: User message is added by SSE replay from backend
    // TabProvider.sendMessage passes attachments which will be merged with the replay message

    try {
      // Build provider env from current provider config (read from refs for stability)
      // For subscription type, don't send providerEnv (use SDK's default auth)
      const providerEnv = buildProviderEnv(currentProviderRef.current);

      // If cron mode is enabled and task hasn't started yet, start the task
      const cron = cronStateRef.current;
      if (cron.isEnabled && !cron.task && cron.config) {
        if (cron.config.executionTarget === 'new_task') {
          // ── New standalone task: create independently, show card in chat ──
          try {
            const sessionId = `cron-standalone-${crypto.randomUUID()}`;
            const task = await createCronTask({
              workspacePath: agentDir,
              sessionId,
              prompt: text,
              intervalMinutes: cron.config.intervalMinutes,
              endConditions: cron.config.endConditions,
              runMode: 'new_session',
              notifyEnabled: cron.config.notifyEnabled,
              model: cron.config.model,
              permissionMode: cron.config.permissionMode,
              providerEnv: cron.config.providerEnv,
              schedule: cron.config.schedule,
              delivery: cron.config.delivery,
            });
            await startCronTaskIpc(task.id);
            await startCronScheduler(task.id);
            setCronCardTask(task);
            disableCronMode();
            setIsLoading(false);
            toastRef.current?.success('定时任务已创建');
          } catch (err) {
            disableCronMode();
            setIsLoading(false);
            toastRef.current?.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        // ── Current session: legacy cron behavior ──
        await startCronTask(text);
        return; // startCronTask handles the message sending via onExecute callback
      }

      // sendMessage is fire-and-forget (returns true immediately for optimistic UI).
      // Error handling is done inside sendMessage's .then()/.catch() in TabProvider.
      // Use effective model/permission (runtime-aware) — not the builtin values
      await sendMessage(text, images, effectivePermissionMode, effectiveModel, isExternalRuntime ? undefined : providerEnv);
    } catch (error) {
      const errorMessage = {
        id: `error-${crypto.randomUUID()}`,
        role: 'assistant' as const,
        content: `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`,
        timestamp: new Date()
      };
      setMessages((prev) => [...prev, errorMessage]);
      // Reset both isLoading and sessionState to ensure UI recovers
      if (!isAiBusy) {
        setIsLoading(false);
        setSessionState('idle');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- toastRef/currentProviderRef/apiKeysRef/cronStateRef are refs (stable); scrollToBottom/setMessages/setIsLoading/setSessionState are stable
  }, [sessionState, isLoading, queuedMessages.length, startCronTask, sendMessage, effectivePermissionMode, effectiveModel, isExternalRuntime, isCrossRuntimeSession, scrollToBottom]);

  // Ref-stabilize handleSendMessage for handleRetry (avoids frequent re-creation)
  const handleSendMessageRef = useRef(handleSendMessage);
  handleSendMessageRef.current = handleSendMessage;

  // Cancel a queued message and restore its text (and images if any) to the input box
  const handleCancelQueued = useCallback(async (queueId: string) => {
    // Snapshot the queued message info before it's removed (for image restore)
    const queuedMsg = queuedMessages.find(q => q.queueId === queueId);
    const cancelledText = await cancelQueuedMessage(queueId);
    if (cancelledText) {
      chatInputRef.current?.setValue(cancelledText);
      // Restore images if the queued message had them
      // Note: We only have preview data URLs (not File blobs) to avoid memory leaks,
      // so we reconstruct ImageAttachment with a minimal placeholder File.
      if (queuedMsg?.images && queuedMsg.images.length > 0) {
        const restoredImages: ImageAttachment[] = queuedMsg.images.map(img => ({
          id: img.id,
          file: new File([], img.name), // Placeholder — original blob is gone
          preview: img.preview,
        }));
        chatInputRef.current?.setImages(restoredImages);
      }
    }
  }, [cancelQueuedMessage, queuedMessages]);

  // Force-execute a queued message (interrupt current AI response)
  const handleForceExecuteQueued = useCallback(async (queueId: string) => {
    await forceExecuteQueuedMessage(queueId);
  }, [forceExecuteQueuedMessage]);

  // Stable callbacks for SimpleChatInput (extracted from inline arrows to enable memo)
  const handleStop = useCallback(async () => {
    try {
      await stopResponse();
    } catch (error) {
      console.error('[Chat] Failed to stop message:', error);
    }
  }, [stopResponse]);

  const handleOpenAgentSettings = useCallback(() => setShowWorkspaceConfig(true), []);

  // Cross-protocol provider switch: third-party (OpenAI bridge) → Anthropic native.
  // Anthropic validates thinking block signatures that third-party providers don't,
  // so we can't resume — show confirm dialog, then open new Tab. See: #68
  const [pendingProviderSwitch, setPendingProviderSwitch] = useState<{
    providerId: string;
    model?: string;
  } | null>(null);

  // Runtime change — show confirm dialog, then open new Tab (v0.1.59)
  const [pendingRuntimeChange, setPendingRuntimeChange] = useState<RuntimeType | null>(null);

  const handleRuntimeChange = useCallback((runtime: RuntimeType) => {
    if (!currentAgent || runtime === currentRuntime) return;
    setPendingRuntimeChange(runtime);
  }, [currentAgent, currentRuntime]);

  const confirmRuntimeChange = useCallback(async () => {
    const runtime = pendingRuntimeChange;
    setPendingRuntimeChange(null);
    if (!runtime || !currentAgent) return;
    try {
      // 1. Save runtime to agent config + refresh React state so new tab sees updated runtime
      await patchAgentConfig(currentAgent.id, { runtime });
      await refreshConfig();  // Must use refreshConfig (not refreshProviderData) to update config.agents
      // 2. Create a new session and open in new Tab
      if (onForkSession && agentDir) {
        const { createSession } = await import('@/api/sessionClient');
        const session = await createSession(agentDir);
        const runtimeLabel = runtime === 'claude-code' ? 'Claude Code' : runtime === 'codex' ? 'Codex' : 'PM Copilot';
        onForkSession(session.id, agentDir, `${runtimeLabel} Session`);
      }
    } catch (err) {
      console.error('[chat] Failed to switch runtime:', err);
      toastRef.current.error('切换 Runtime 失败');
    }
  }, [pendingRuntimeChange, currentAgent, refreshConfig, onForkSession, agentDir]);

  // Cross-protocol provider switch confirm: save new provider to project, create new session in new tab.
  // Current tab stays unchanged (preserving the third-party session). See: #68
  const confirmProviderSwitch = useCallback(async () => {
    const pending = pendingProviderSwitch;
    setPendingProviderSwitch(null);
    if (!pending || !agentDir || !onForkSession) return;
    try {
      // 1. Save provider + model to project config so the new tab picks it up
      if (currentProject) {
        await patchProject(currentProject.id, { providerId: pending.providerId, model: pending.model ?? null });
        if (currentProject?.agentId) {
          await patchAgentConfig(currentProject.agentId, { providerId: pending.providerId, model: pending.model ?? undefined });
        }
      }
      await refreshConfig();  // Sync React state so new tab sees updated provider
      // 2. Create a new session and open in new Tab
      const { createSession } = await import('@/api/sessionClient');
      const session = await createSession(agentDir);
      const newProvider = providers.find(p => p.id === pending.providerId);
      onForkSession(session.id, agentDir, `${newProvider?.name ?? 'Claude'} 会话`);
    } catch (err) {
      console.error('[chat] Failed to create cross-provider session:', err);
      toastRef.current.error('创建新会话失败');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed to .id/.agentId
  }, [pendingProviderSwitch, agentDir, onForkSession, currentProject?.id, currentProject?.agentId, patchProject, refreshConfig, providers]);

  // Cross-runtime confirm: create new session in new tab and send the pending message
  const confirmCrossRuntimeSend = useCallback(async () => {
    const pending = pendingCrossRuntimeMessage;
    setPendingCrossRuntimeMessage(null);
    if (!pending || !agentDir || !onForkSession) return;
    try {
      const { createSession } = await import('@/api/sessionClient');
      const session = await createSession(agentDir);
      // Open new tab with the pending message as initialMessage
      if (pending.images.length > 0) {
        toastRef.current.warning('图片附件无法带入新会话，请重新添加');
      }
      onForkSession(session.id, agentDir, pending.text.slice(0, 40) || '新会话', pending.text);
    } catch (err) {
      console.error('[chat] Failed to create cross-runtime session:', err);
      toastRef.current.error('创建新会话失败');
    }
  }, [pendingCrossRuntimeMessage, agentDir, onForkSession]);

  const handleCollapseWorkspace = useCallback(() => setShowWorkspace(false), []);
  const handleOpenCronSettings = useCallback(() => setShowCronSettings(true), []);

  const handleCronStop = useCallback(async () => {
    const originalPrompt = await stopCronTask();
    if (originalPrompt) {
      chatInputRef.current?.setValue(originalPrompt);
    }
  }, [stopCronTask]);

  const handleCancelQueuedVoid = useCallback(
    (queueId: string) => { void handleCancelQueued(queueId); },
    [handleCancelQueued]
  );

  const handleForceExecuteQueuedVoid = useCallback(
    (queueId: string) => { void handleForceExecuteQueued(queueId); },
    [handleForceExecuteQueued]
  );

  // Format selected text as Markdown blockquote
  const formatQuote = useCallback((text: string) =>
    text.split('\n').map(line => `> ${line}`).join('\n'),
  []);

  // Quote selected text — append blockquote + placeholder for user to type over
  const handleQuoteSelection = useCallback((selectedText: string) => {
    const currentValue = inputRef.current?.value ?? '';
    // Only prepend \n when there's existing content (so the quote starts on a new line)
    const prefix = currentValue ? '\n' : '';
    const quote = `${prefix}${formatQuote(selectedText)}\n针对引用的内容：`;
    const appended = currentValue + quote;
    chatInputRef.current?.setValue(appended);
    // Move cursor to end + scroll textarea to bottom so user sees the appended quote
    setTimeout(() => {
      const textarea = inputRef.current;
      if (textarea) {
        textarea.setSelectionRange(appended.length, appended.length);
        textarea.scrollTop = textarea.scrollHeight;
        textarea.focus();
      }
    }, 0);
  }, [inputRef, formatQuote]);

  // Elaborate = quote + placeholder + "深入讲讲" then auto-send
  const handleElaborateSelection = useCallback((selectedText: string) => {
    const prompt = `${formatQuote(selectedText)}\n针对引用的内容：深入讲讲`;
    void handleSendMessageRef.current(prompt);
  }, [formatQuote]);

  // Navigate to a specific query message (used by QueryNavigator with virtuoso)
  // Uses messagesRef to avoid invalidating the callback on every streaming token update
  const handleNavigateToQuery = useCallback((messageId: string) => {
    const index = messagesRef.current.findIndex(m => m.id === messageId);
    if (index >= 0) {
      pauseAutoScroll(2000);
      virtuosoRef.current?.scrollToIndex({ index, behavior: 'smooth', align: 'start' });
    }
  }, [pauseAutoScroll, virtuosoRef]);

  // Stable callbacks for MessageList (extracted from inline arrows to enable memo)
  const handlePermissionDecision = useCallback((decision: 'deny' | 'allow_once' | 'always_allow') => {
    void respondPermission(decision);
  }, [respondPermission]);

  const handleAskUserQuestionSubmit = useCallback((_requestId: string, answers: Record<string, string>) => {
    void respondAskUserQuestion(answers);
  }, [respondAskUserQuestion]);

  const handleAskUserQuestionCancel = useCallback(() => {
    void respondAskUserQuestion(null);
  }, [respondAskUserQuestion]);

  const handleExitPlanModeApprove = useCallback(() => {
    void respondExitPlanMode(true);
    // Mode restore is handled by the useEffect below reacting to resolved='approved'
  }, [respondExitPlanMode]);

  const handleExitPlanModeReject = useCallback(() => {
    void respondExitPlanMode(false);
  }, [respondExitPlanMode]);

  // React to plan mode changes: auto-approved by SDK, or user-approved via card
  // Single source of truth for permission mode switch during plan mode
  useEffect(() => {
    if (pendingEnterPlanMode?.resolved === 'approved' && permissionMode !== 'plan') {
      prePlanPermissionModeRef.current = permissionMode;
      setPermissionMode('plan');
    }
  }, [pendingEnterPlanMode?.resolved, pendingEnterPlanMode?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps -- read permissionMode without dep to avoid loop

  useEffect(() => {
    if (pendingExitPlanMode?.resolved === 'approved' && prePlanPermissionModeRef.current) {
      setPermissionMode(prePlanPermissionModeRef.current);
      prePlanPermissionModeRef.current = null;
    }
  }, [pendingExitPlanMode?.resolved, pendingExitPlanMode?.requestId]);

  // Sync permission mode from backend → frontend.
  // Backend is the source of truth: SDK tools (EnterPlanMode/ExitPlanMode) and
  // setSessionPermissionMode() all broadcast 'chat:permission-mode-changed'.
  // This ensures the UI toggle always reflects the actual SDK subprocess state.
  const permissionModeRef = useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // Tab isolation: only process events for this tab (SSE is tab-scoped,
      // but the DOM CustomEvent is global — filter by tabId)
      if (detail?.tabId && detail.tabId !== tabId) return;
      const mode = detail?.permissionMode as PermissionMode | undefined;
      if (mode && mode !== permissionModeRef.current) {
        setPermissionMode(mode);
      }
    };
    window.addEventListener('permission-mode-sync', handler);
    return () => window.removeEventListener('permission-mode-sync', handler);
  }, [tabId]); // stable — reads permissionMode via ref

  // Stable callback for time rewind — uses ref for messages to keep reference stable
  const handleRewind = useCallback((messageId: string) => {
    const msgs = messagesRef.current;
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;
    setRewindTarget({
      messageId,
      content: typeof msg.content === 'string' ? msg.content : '',
      attachments: msg.attachments,
    });
  }, []); // [] — 通过 ref 读取 messages，引用永远稳定

  const handleRewindConfirm = useCallback(() => {
    if (!rewindTarget) return;
    const { messageId, content, attachments } = rewindTarget;

    // 快照：保存当前 messages 以便后端失败时回滚
    const snapshot = messagesRef.current.slice();

    // 1. 乐观更新 UI（瞬时反馈）
    // Pause auto-scroll to prevent animated scrolling during rewind's DOM changes.
    // Without this, the smooth scroll animation fights with the browser's natural
    // scroll clamping (messages removed → scrollHeight shrinks → scrollTop adjusts).
    pauseAutoScroll(500);
    setRewindTarget(null);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === messageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    if (content) {
      chatInputRef.current?.setValue(content);
    }
    const imageAttachments = attachments?.filter(a =>
      a.isImage || a.mimeType?.startsWith('image/')
    );
    if (imageAttachments?.length) {
      const restoredImages: ImageAttachment[] = imageAttachments.map(a => ({
        id: a.id,
        file: new File([], a.name, { type: a.mimeType }),
        preview: a.previewUrl || '',
      }));
      chatInputRef.current?.setImages(restoredImages);
    }

    // 2. 后端回溯（rewindPromise 会阻塞 enqueueUserMessage 防止竞态）
    //    成功：丢弃快照；失败：从快照回滚 UI
    track('session_rewind', {});
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost('/chat/rewind', { userMessageId: messageId })
      .then(res => {
        const r = res as { success?: boolean; error?: string } | undefined;
        if (r && !r.success) {
          // 后端明确返回失败 → 回滚 UI
          setMessages(snapshot);
          chatInputRef.current?.setValue('');
          chatInputRef.current?.setImages([]);
          toastRef.current.error('时间回溯失败：' + (r.error || '未知错误'));
        }
      })
      .catch(err => {
        // 网络错误或异常 → 回滚 UI
        console.error('[Chat] Rewind failed:', err);
        setMessages(snapshot);
        chatInputRef.current?.setValue('');
        chatInputRef.current?.setImages([]);
        toastRef.current.error('时间回溯失败，请重试');
      })
      .finally(() => {
        setRewindStatus(null);
        setIsLoading(false);
      });
  }, [rewindTarget, apiPost, setMessages, setIsLoading, pauseAutoScroll]);

  // Retry = rewind to before user message + auto-resend
  // Uses refs for messagesRef/toastRef/handleSendMessageRef — deps are all stable → reference stable
  const handleRetry = useCallback((assistantMessageId: string) => {
    const msgs = messagesRef.current;
    const aIdx = msgs.findIndex(m => m.id === assistantMessageId);
    if (aIdx < 0) return;

    // Find the nearest real user message before this assistant message
    // (skip synthetic task-notification messages which are injected as role='user')
    let userMsg: typeof msgs[number] | null = null;
    for (let i = aIdx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user' && !msgs[i].id.startsWith('task-notification-')) { userMsg = msgs[i]; break; }
    }
    if (!userMsg) return;

    const content = typeof userMsg.content === 'string' ? userMsg.content : '';
    const attachments = userMsg.attachments;
    const userMessageId = userMsg.id;

    // 快照：后端失败时回滚（与 handleRewindConfirm 一致）
    const snapshot = messagesRef.current.slice();

    // 1. Optimistic UI: truncate to before user message
    pauseAutoScroll(500);
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === userMessageId);
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });

    // 2. Rewind + auto-resend
    let resendFired = false;
    setIsLoading(true);
    setRewindStatus('rewinding');
    apiPost('/chat/rewind', { userMessageId })
      .then(res => {
        const r = res as { success?: boolean; error?: string } | undefined;
        if (r && !r.success) {
          setMessages(snapshot);
          toastRef.current.error('重试失败：' + (r.error || '未知错误'));
          return;
        }
        // Rewind succeeded → auto-resend the original message
        track('message_retry', {});
        resendFired = true;
        const imageAttachments = attachments?.filter(a =>
          a.isImage || a.mimeType?.startsWith('image/')
        ).map(a => ({
          id: a.id,
          file: new File([], a.name, { type: a.mimeType }),
          preview: a.previewUrl || '',
        }));
        handleSendMessageRef.current(content, imageAttachments?.length ? imageAttachments : undefined);
      })
      .catch(err => {
        console.error('[Chat] Retry failed:', err);
        setMessages(snapshot);
        toastRef.current.error('重试失败');
      })
      .finally(() => {
        setRewindStatus(null);
        // Only clear loading on error — successful resend manages its own loading state
        if (!resendFired) {
          setIsLoading(false);
        }
      });
  }, [apiPost, setMessages, setIsLoading, pauseAutoScroll]); // all stable — refs handle the rest

  // Fork = create a new independent session branch at a specific assistant message
  const handleFork = useCallback((assistantMessageId: string) => {
    setForkTarget(assistantMessageId);
  }, []);

  const handleForkConfirm = useCallback(() => {
    if (!forkTarget) return;
    const messageId = forkTarget;
    setForkTarget(null);

    track('session_fork', {});
    apiPost('/sessions/fork', { messageId })
      .then(res => {
        const r = res as { success?: boolean; newSessionId?: string; agentDir?: string; title?: string; error?: string } | undefined;
        if (r?.success && r.newSessionId && r.agentDir) {
          onForkSession?.(r.newSessionId, r.agentDir, r.title || 'Fork');
        } else {
          toastRef.current.error('创建分支失败：' + (r?.error || '未知错误'));
        }
      })
      .catch(err => {
        console.error('[Chat] Fork failed:', err);
        toastRef.current.error('创建分支失败');
      });
  }, [forkTarget, apiPost, onForkSession]);

  // Handler for selecting a session from history dropdown
  const handleSelectSession = useCallback((id: string) => {
    track('session_switch');
    if (onSwitchSession) {
      onSwitchSession(id);
    } else {
      if (cronStateRef.current.task?.status === 'running') {
        console.log('[Chat] Cannot switch session while cron task is running (no onSwitchSession handler)');
        return;
      }
      void loadSession(id);
    }
  }, [onSwitchSession, loadSession]);

  // Internal handler for starting a new session
  // If AI is running, App.tsx handles it via background completion (returns true).
  // If AI is idle, falls back to resetSession (reuses Sidecar).
  const handleNewSession = useCallback(async () => {
    if (onNewSession) {
      const handled = await onNewSession();
      if (handled) {
        // App.tsx started background completion and created new Sidecar
        // TabProvider will detect sessionId change and reconnect
        return;
      }
    }

    // Fallback: AI is idle, reset session within existing Sidecar
    console.log('[Chat] Starting new session...');
    const success = await resetSession();
    if (success) {
      console.log('[Chat] New session started');
    } else {
      console.error('[Chat] Failed to start new session');
    }
  }, [onNewSession, resetSession]);

  // Export full conversation as Markdown
  const handleExportSession = useCallback(() => {
    const exportMessages = historyMessages.length > 0 ? historyMessages : messages;
    if (exportMessages.length === 0) return;

    const lines: string[] = [];
    const title = sessionTitle && sessionTitle !== 'New Tab' && sessionTitle !== 'New Chat'
      ? sessionTitle : 'PM Copilot 对话';
    lines.push(`# ${title}\n`);

    for (const msg of exportMessages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : msg.content
          .filter((b): b is typeof b & { type: 'text' } => b.type === 'text')
          .map(b => b.text || '').join('\n');
        lines.push(`## 用户\n\n${text}\n`);
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : msg.content
          .filter((b): b is typeof b & { type: 'text' } => b.type === 'text')
          .map(b => b.text || '').join('\n\n');
        if (text.trim()) {
          lines.push(`## PM Copilot\n\n${text}\n`);
        }
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeTitle = title.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 50);
    a.download = `${safeTitle}.md`;
    a.click();
    URL.revokeObjectURL(url);
    track('session_export_md', {});
  }, [historyMessages, messages, sessionTitle]);

  return (
    <div className="relative flex h-full flex-row overflow-hidden overscroll-none bg-[var(--paper-elevated)] text-[var(--ink)]">
      {/* Left side: chat area (+ side workspace when wide & no split) */}
      <div
        className={`relative flex min-w-0 flex-row overflow-hidden ${!isDraggingSplit ? 'transition-[width] duration-300 ease-in-out' : ''}`}
        style={{ width: splitPanelVisible ? `${splitRatio * 100}%` : '100%' }}
      >
      <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${showWorkspace && !shouldUseWorkspaceOverlay ? 'border-r border-[var(--line-subtle)]' : ''}`}>
        {/* Compact header - single row */}
        <div className="relative z-10 flex h-12 flex-shrink-0 items-center justify-between bg-[var(--paper-elevated)] px-4 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-[var(--paper-elevated)] after:to-transparent">
          <div className="flex min-w-0 items-center gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="flex-shrink-0 rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="Back to projects"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            {/* Project name */}
            {agentDir && (
              <span className="flex flex-shrink-0 items-center gap-1.5 text-sm font-medium text-[var(--ink)]">
                <WorkspaceIcon icon={currentProject?.icon} size={16} />
                {agentDir.split(/[/\\]/).filter(Boolean).pop()}
              </span>
            )}
            {/* Session title — click to rename */}
            {sessionTitle && sessionTitle !== 'New Tab' && sessionTitle !== 'New Chat' && (
              <>
                <span className="flex-shrink-0 text-[var(--ink-subtle)]">/</span>
                <SessionTitleEditor
                  title={sessionTitle}
                  onRename={(newTitle) => onRenameSession?.(newTitle)}
                />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {/* Export conversation */}
            {historyMessages.length > 0 && (
              <button
                type="button"
                onClick={handleExportSession}
                className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="导出对话为 Markdown"
              >
                <Download className="h-3.5 w-3.5 flex-shrink-0" />
                {!splitFile && <span>导出</span>}
              </button>
            )}
            {/* New Session button - before History */}
            <button
              type="button"
              onClick={handleNewSession}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              title="新建对话"
            >
              <Plus className="h-3.5 w-3.5 flex-shrink-0" />
              {!splitFile && <span>新对话</span>}
            </button>
            {/* History button */}
            <div className="relative">
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowHistory((prev) => !prev)}
                className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${showHistory
                  ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                  }`}
              >
                <History className="h-3.5 w-3.5 flex-shrink-0" />
                {!splitFile && <span>历史</span>}
              </button>
              <SessionHistoryDropdown
                agentDir={agentDir}
                currentSessionId={sessionId}
                onSelectSession={handleSelectSession}
                onDeleteCurrentSession={handleNewSession}
                isOpen={showHistory}
                onClose={() => setShowHistory(false)}
              />
            </div>
            {/* Dev-only buttons - controlled by config.showDevTools */}
            {config.showDevTools && (
              <>
                <button
                  type="button"
                  onClick={() => setShowLogs((prev) => !prev)}
                  className={`rounded-lg px-2.5 py-1 text-[13px] font-medium transition-colors ${showLogs
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                  Logs
                </button>
                </>
            )}
            {/* Workspace toggle button - always visible when workspace is hidden */}
            {!showWorkspace && (
              <button
                type="button"
                onClick={() => setShowWorkspace(true)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                title="展开工作区"
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Content area with relative positioning for floating input */}
        <div
          ref={chatContentRef}
          className="relative flex flex-1 flex-col overflow-hidden"
          {...dragHandlers}
        >
          {/* Drop zone overlay for file drag */}
          <DropZoneOverlay
            isVisible={isAnyDragActive && (!isTauriDragging || activeZoneId === 'chat-content' || activeZoneId === null)}
            message="松手将文件加入工作区"
            subtitle="非图片文件将复制到 pm_copilot_files 并自动引用"
          />

          {/* Startup overlay when launching from Launcher with initial message */}
          {showStartupOverlay && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                <p className="text-sm text-[var(--ink-muted)]">正在启动工作区...</p>
              </div>
            </div>
          )}

          {agentError && (
            <div className="relative z-10 flex-shrink-0 border-b border-[var(--line)] bg-[var(--paper-inset)] px-4 py-2 text-[11px] text-[var(--ink)]">
              <div className="mx-auto flex max-w-3xl items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--accent)]" />
                <div className="flex-1">
                  <span className="font-semibold text-[var(--ink)]">Agent error: </span>
                  <span className="text-[var(--ink-muted)]">{agentError}</span>
                  {/* Oversized image hint: detect API 400 about image dimensions and offer rewind.
                      Pattern synced with backend (agent-session.ts shouldResetSessionAfterError).
                      Known API error: "...image dimensions exceed max allowed size: 8000 pixels" */}
                  {/image.*exceed.*max allowed size/i.test(agentError) && (() => {
                    const msgs = messagesRef.current;
                    let lastUserMsg = null;
                    for (let i = msgs.length - 1; i >= 0; i--) {
                      if (msgs[i].role === 'user' && !msgs[i].id.startsWith('task-notification-')) { lastUserMsg = msgs[i]; break; }
                    }
                    if (!lastUserMsg) return null;
                    return (
                      <div className="mt-1">
                        <span className="text-[var(--ink-muted)]">工具截图超过模型处理限制，</span>
                        <button
                          type="button"
                          onClick={() => { setAgentError(null); handleRewind(lastUserMsg!.id); }}
                          className="text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-hover)]"
                        >
                          点击时间回溯到之前
                        </button>
                      </div>
                    );
                  })()}
                </div>
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      const providerName = currentProvider?.name || currentProvider?.id || '未知';
                      const model = selectedModel || currentProvider?.primaryModel || '未知';
                      const workspace = agentDir || '未知';
                      const desc = `我在使用 AI 对话时遇到了报错，请帮我查询日志诊断问题并引导我解决：\n\n**报错信息**: ${agentError}\n**供应商**: ${providerName}\n**模型**: ${model}\n**工作区**: ${workspace}`;
                      setAgentError(null);
                      window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
                        detail: { description: desc, appVersion: '' },
                      }));
                    }}
                    className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium text-[var(--accent-warm)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                  >
                    <Bot className="h-3 w-3" />
                    召唤 PM 助手
                  </button>
                  <button
                    type="button"
                    onClick={() => setAgentError(null)}
                    className="flex-shrink-0 rounded p-0.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
                    title="关闭"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* Unified Logs Panel - fullscreen modal displaying logs */}
          <UnifiedLogsPanel
            sseLogs={unifiedLogs}
            isVisible={showLogs}
            onClose={() => setShowLogs(false)}
            onClearAll={clearUnifiedLogs}
          />

          {/* Query Navigator — floating right-side panel for quick session navigation */}
          <QueryNavigator
            historyMessages={historyMessages}
            streamingMessage={streamingMessage}
            scrollContainerRef={scrollerRef as React.RefObject<HTMLDivElement | null>}
            pauseAutoScroll={pauseAutoScroll}
            onNavigateToQuery={handleNavigateToQuery}
          />

          {/* Message list with max-width */}
          <BrowserPanelContext.Provider value={browserPanelCtx}>
          <FileActionProvider
            onInsertReference={handleInsertReference}
            refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
            onFilePreviewExternal={isSplitViewEnabled && !isNarrowLayout ? handleSplitFilePreview : undefined}
          >
            <MessageList
              historyMessages={historyMessages}
              streamingMessage={streamingMessage}
              isLoading={isLoading}
              isSessionLoading={isSessionLoading}
              sessionId={sessionId}
              virtuosoRef={virtuosoRef}
              onScrollerRef={handleScrollerRef}
              followEnabledRef={followEnabledRef}
              handleAtBottomChange={handleAtBottomChange}
              pendingPermission={pendingPermission}
              onPermissionDecision={handlePermissionDecision}
              pendingAskUserQuestion={pendingAskUserQuestion}
              onAskUserQuestionSubmit={handleAskUserQuestionSubmit}
              onAskUserQuestionCancel={handleAskUserQuestionCancel}
              pendingExitPlanMode={pendingExitPlanMode}
              onExitPlanModeApprove={handleExitPlanModeApprove}
              onExitPlanModeReject={handleExitPlanModeReject}
              systemStatus={rewindStatus || systemStatus}
              isStreaming={isLoading || sessionState === 'running'}
              onRewind={isExternalRuntime ? undefined : handleRewind}
              onRetry={handleRetry}
              onFork={isExternalRuntime ? undefined : handleFork}
            />

            {/* Introduction overlay — shown in empty sessions when INTRODUCTION.md exists */}
            {introductionContent && historyMessages.length === 0 && !streamingMessage && !isSessionLoading && (
              <Suspense fallback={null}>
                <LazyIntroductionOverlay content={introductionContent} />
              </Suspense>
            )}

            {/* Inline cron task card — shown in message flow after creating a "新开对话" task */}
            {cronCardTask && (
              <div className="mx-auto w-full max-w-3xl px-4 py-2">
                <CronTaskCard
                  taskId={cronCardTask.id}
                  name={cronCardTask.name || cronCardTask.prompt.slice(0, 20)}
                  scheduleDesc={formatScheduleDescription(cronCardTask)}
                  onOpenDetail={task => { setCronDetailTask(task); setCronCardTask(null); }}
                />
              </div>
            )}
          </FileActionProvider>
          </BrowserPanelContext.Provider>

          {/* Text selection floating menu for quoting AI text */}
          <SelectionCommentMenu
            onQuote={handleQuoteSelection}
            onElaborate={handleElaborateSelection}
          />

          {/* Floating input with integrated cron task components */}
          <SimpleChatInput
            ref={chatInputRef}
            onSend={handleSendMessage}
            onStop={handleStop}
            isLoading={isLoading || sessionState === 'running'}
            sessionState={sessionState}
            systemStatus={systemStatus}
            agentDir={agentDir}
            provider={currentProvider}
            providers={providers}
            onProviderChange={handleProviderChange}
            selectedModel={isExternalRuntime ? runtimeModel : selectedModel}
            onModelChange={isExternalRuntime ? setRuntimeModel : handleModelChange}
            permissionMode={effectivePermissionMode}
            onPermissionModeChange={isExternalRuntime
              ? ((mode: PermissionMode) => setRuntimePermissionMode(mode))
              : handlePermissionModeChange}
            apiKeys={apiKeys}
            providerVerifyStatus={providerVerifyStatus}
            inputRef={inputRef}
            workspaceMcpEnabled={workspaceMcpEnabled}
            globalMcpEnabled={globalMcpEnabled}
            mcpServers={mcpServers}
            onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
            onRefreshProviders={refreshProviderData}
            onOpenAgentSettings={handleOpenAgentSettings}
            onWorkspaceRefresh={triggerWorkspaceRefresh}
            // Cron task props - StatusBar and Overlay are rendered inside SimpleChatInput
            cronModeEnabled={cronState.isEnabled}
            cronConfig={cronState.config}
            cronTask={cronState.task}
            onCronButtonClick={handleOpenCronSettings}
            onCronSettings={handleOpenCronSettings}
            onCronCancel={disableCronMode}
            onCronStop={handleCronStop}
            onInputChange={setCronPrompt}
            runtime={currentRuntime}
            runtimeDetections={multiAgentRuntimeEnabled ? runtimeDetections : undefined}
            onRuntimeChange={multiAgentRuntimeEnabled ? handleRuntimeChange : undefined}
            runtimeModels={isExternalRuntime ? runtimeModels : undefined}
            runtimePermissionModes={isExternalRuntime ? runtimePermissionModes : undefined}
            queuedMessages={queuedMessages}
            onCancelQueued={handleCancelQueuedVoid}
            onForceExecuteQueued={handleForceExecuteQueuedVoid}
          />
        </div>
      </div>

      {/* Workspace panel — single instance, container style switches between side panel and overlay */}
      {showWorkspace && (
        <>
          {/* Click-away layer for overlay mode */}
          {shouldUseWorkspaceOverlay && (
            <div
              className="absolute inset-0 z-40"
              onClick={handleCollapseWorkspace}
            />
          )}
          <div
            ref={directoryPanelContainerRef}
            className={shouldUseWorkspaceOverlay
              ? 'absolute bottom-0 right-0 top-0 z-50 flex w-[340px] max-w-[85%] flex-col border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg'
              : 'flex w-1/4 flex-col'
            }
            style={shouldUseWorkspaceOverlay ? undefined : { minWidth: 'var(--sidebar-min-width)' }}
          >
            <DirectoryPanel
              ref={directoryPanelRef}
              agentDir={agentDir}
              projectIcon={currentProject?.icon}
              projectDisplayName={currentProject?.displayName}
              provider={currentProvider}
              providers={providers}
              onProviderChange={handleProviderChange}
              onCollapse={handleCollapseWorkspace}
              onOpenConfig={handleOpenAgentSettings}
              refreshTrigger={toolCompleteCount + workspaceRefreshTrigger}
              isTauriDragActive={isTauriDragging && activeZoneId === 'directory-panel'}
              onInsertReference={handleInsertReference}
              enabledAgents={enabledAgents}
              enabledSkills={enabledSkills}
              enabledCommands={enabledCommands}
              globalSkillFolderNames={globalSkillFolderNames}
              onInsertSlashCommand={handleInsertSlashCommand}
              onOpenSettings={handleOpenSettings}
              onSyncSkillToGlobal={handleSyncSkillToGlobal}
              onRefreshAll={triggerWorkspaceRefresh}
              onFilePreviewExternal={isSplitViewEnabled && !isNarrowLayout ? handleSplitFilePreview : undefined}
              onOpenTerminal={isSplitViewEnabled && !isNarrowLayout ? handleOpenTerminal : undefined}
              terminalAlive={terminalAlive}
            />
          </div>
        </>
      )}
      </div>{/* End left-side wrapper */}

      {/* Split view: draggable divider + right panel.
          Rendered when panel is visible OR terminal is alive (to preserve xterm.js state).
          Uses `hidden` CSS when panel is not visible but terminal is alive in background. */}
      {(splitPanelVisible || terminalMounted) && (
        <>
          {/* Draggable divider — hidden when panel is not visible */}
          <div
            className={`z-10 flex w-1 cursor-col-resize items-center justify-center bg-[var(--line)] transition-colors hover:bg-[var(--accent)] ${!splitPanelVisible ? 'hidden' : ''}`}
            onMouseDown={handleSplitDividerMouseDown}
          >
            <div className="h-8 w-0.5 rounded-full bg-[var(--ink-subtle)]" />
          </div>
          {/* Right panel — single flex-1 container for tab bar + file + terminal.
              Uses `hidden` when panel is not visible but terminal is alive in background. */}
          <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${!splitPanelVisible ? 'hidden' : ''}`}>
            {/* Tab switcher — only when 2+ views are active */}
            {(() => {
              const activeViews = [splitFile, terminalPinned && terminalAlive, browserUrl].filter(Boolean).length;
              return activeViews >= 2;
            })() && (
              <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper-elevated)] px-2">
                {/* File tab + its own × */}
                {splitFile && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('file')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      splitActiveView === 'file'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <span className="max-w-[120px] truncate">{splitFile.name}</span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSplitFile(null);
                        if (browserUrl) setSplitActiveView('browser');
                        else if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title="关闭文件"
                    >
                      <span className="text-[13px] leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'file' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
                {/* Terminal tab + its own × */}
                {terminalPinned && terminalAlive && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('terminal')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      splitActiveView === 'terminal'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <TerminalSquare className="h-3 w-3" />
                    终端
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTerminalPinned(false);
                        if (browserUrl) setSplitActiveView('browser');
                        else if (splitFile) setSplitActiveView('file');
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title="隐藏终端"
                    >
                      <span className="text-[13px] leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'terminal' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
                {/* Browser tab + its own × */}
                {browserUrl && (
                  <button
                    type="button"
                    onClick={() => setSplitActiveView('browser')}
                    className={`group relative flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                      splitActiveView === 'browser'
                        ? 'text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}
                  >
                    <Globe className="h-3 w-3" />
                    <span className="max-w-[120px] truncate">
                      {browserSourceFile ? browserSourceFile.name : (() => { try { return new URL(browserUrl).hostname; } catch { return '浏览器'; } })()}
                    </span>
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBrowserUrl(null);
                        setBrowserAlive(false);
                        setBrowserSourceFile(null);
                        if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
                        else if (splitFile) setSplitActiveView('file');
                      }}
                      className="ml-0.5 flex h-5 w-5 items-center justify-center rounded opacity-0 transition-opacity hover:bg-[var(--paper-inset)] group-hover:opacity-100"
                      title="关闭浏览器"
                    >
                      <span className="text-[13px] leading-none text-[var(--ink-muted)]">×</span>
                    </span>
                    {splitActiveView === 'browser' && (
                      <div className="absolute inset-x-1 -bottom-[5px] h-[2px] rounded-full bg-[var(--accent-warm)]" />
                    )}
                  </button>
                )}
              </div>
            )}

            {/* File preview view */}
            {splitFile && splitActiveView === 'file' && (
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--paper-elevated)]">
                <Suspense fallback={<div className="flex h-full items-center justify-center text-[var(--ink-muted)]"><Loader2 className="h-5 w-5 animate-spin" /></div>}>
                  <FilePreviewModal
                    name={splitFile.name}
                    content={splitFile.content}
                    size={splitFile.size}
                    path={splitFile.path}
                    onClose={() => {
                      setSplitFile(null);
                      if (browserUrl) setSplitActiveView('browser');
                      else if (terminalPinned && terminalAlive) setSplitActiveView('terminal');
                    }}
                    onSaved={() => setWorkspaceRefreshTrigger(prev => prev + 1)}
                    embedded
                    onFullscreen={(currentContent) => {
                      const file = currentContent !== undefined ? { ...splitFile!, content: currentContent } : splitFile!;
                      setSplitFile(null);
                      setFullscreenPreviewFile(file);
                    }}
                    onSwitchToBrowser={browserUrl ? handleEditorSwitchToBrowser : undefined}
                  />
                </Suspense>
              </div>
            )}

            {/* Terminal — INSIDE the right panel div (same flex column).
                Stays mounted while alive, uses `hidden` when not the active view. */}
            {terminalMounted && (
              <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'terminal' ? 'hidden' : ''}`}>
                {/* Terminal header — only when tab switcher is NOT showing (single view) */}
                {[splitFile, terminalPinned && terminalAlive, browserUrl].filter(Boolean).length < 2 && (
                  <div className="flex h-9 flex-shrink-0 items-center justify-between bg-[var(--paper)] px-3">
                    <div className="flex items-center gap-1.5">
                      <TerminalSquare className="h-3.5 w-3.5 text-[var(--ink)]" />
                      <span className="text-[12px] font-medium text-[var(--ink)]">终端</span>
                      <span className="text-[11px] text-[var(--ink-muted)]">
                        {agentDir ? `~/${agentDir.split(/[/\\]/).pop()}` : ''}
                      </span>
                    </div>
                    <Tip label="隐藏终端" position="bottom">
                      <button
                        type="button"
                        onClick={() => {
                          setTerminalPinned(false);
                          if (browserUrl) setSplitActiveView('browser');
                          else if (splitFile) setSplitActiveView('file');
                        }}
                        className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Tip>
                  </div>
                )}
                <Suspense fallback={<div className="flex h-full items-center justify-center bg-[var(--paper)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" /></div>}>
                  <LazyTerminalPanel
                    workspacePath={agentDir}
                    terminalId={terminalId}
                    sessionId={sessionId}
                    isVisible={splitPanelVisible && splitActiveView === 'terminal'}
                    onTerminalCreated={(id) => {
                      setTerminalId(id);
                      setTerminalAlive(true);
                    }}
                    onTerminalExited={() => {
                      const deadId = terminalId;
                      setTerminalAlive(false);
                      setTerminalPinned(false);
                      setTerminalId(null);
                      if (deadId) {
                        import('@tauri-apps/api/core').then(({ invoke: inv }) => {
                          inv('cmd_terminal_close', { terminalId: deadId }).catch(() => {});
                        });
                      }
                    }}
                  />
                </Suspense>
              </div>
            )}

            {/* Browser — embedded Tauri child Webview */}
            {browserUrl && (
              <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${splitActiveView !== 'browser' ? 'hidden' : ''}`}>
                <Suspense fallback={<div className="flex h-full items-center justify-center bg-[var(--paper)]"><Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" /></div>}>
                  <LazyBrowserPanel
                    tabId={tabId}
                    url={browserUrl}
                    isVisible={isActive && splitPanelVisible && splitActiveView === 'browser'}
                    isDraggingSplit={isDraggingSplit}
                    browserAlive={browserAlive}
                    sourceFile={browserSourceFile}
                    onBrowserCreated={handleBrowserCreated}
                    onCreateFailed={handleBrowserCreateFailed}
                    onClose={handleBrowserClose}
                    onSwitchToEditor={handleBrowserSwitchToEditor}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </>
      )}

      {/* Fullscreen preview from split panel */}
      {fullscreenPreviewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={fullscreenPreviewFile.name}
            content={fullscreenPreviewFile.content}
            size={fullscreenPreviewFile.size}
            path={fullscreenPreviewFile.path}
            onClose={() => setFullscreenPreviewFile(null)}
            onSaved={() => setWorkspaceRefreshTrigger(prev => prev + 1)}
          />
        </Suspense>
      )}

      {/* Workspace Config Panel */}
      {showWorkspaceConfig && (
        <WorkspaceConfigPanel
          agentDir={agentDir}
          onClose={() => {
            setShowWorkspaceConfig(false);
            setWorkspaceConfigInitialTab(undefined);
            // Refresh capabilities data in case settings were changed
            setWorkspaceRefreshTrigger(prev => prev + 1);
          }}
          refreshKey={workspaceRefreshKey}
          initialTab={workspaceConfigInitialTab}
        />
      )}

      {/* Cross-Runtime Session Confirm Dialog */}
      {pendingCrossRuntimeMessage && (
        <ConfirmDialog
          title="跨 Runtime 会话"
          message={`此会话由 ${sessionRuntime === 'codex' ? 'Codex' : sessionRuntime === 'claude-code' ? 'Claude Code' : sessionRuntime} 创建，新消息将使用内置 Runtime 新开会话。`}
          confirmText="新开会话并发送"
          cancelText="取消"
          onConfirm={confirmCrossRuntimeSend}
          onCancel={() => setPendingCrossRuntimeMessage(null)}
        />
      )}

      {/* Runtime Switch Confirm Dialog (v0.1.59) */}
      {pendingRuntimeChange && (
        <ConfirmDialog
          title="切换 Runtime"
          message={`切换到 ${pendingRuntimeChange === 'claude-code' ? 'Claude Code' : pendingRuntimeChange === 'codex' ? 'Codex' : 'PM Copilot'} 将新开一个会话。当前会话保留不变。`}
          confirmText="确认切换"
          cancelText="取消"
          onConfirm={confirmRuntimeChange}
          onCancel={() => setPendingRuntimeChange(null)}
        />
      )}

      {/* Cross-Protocol Provider Switch Confirm Dialog (#68) */}
      {pendingProviderSwitch && (
        <ConfirmDialog
          title="切换到 Claude 模型"
          message="Claude 模型会验证会话历史中的签名信息，无法继续使用其他供应商的会话记录。将为你新开一个会话。"
          confirmText="创建新会话"
          cancelText="取消"
          onConfirm={confirmProviderSwitch}
          onCancel={() => setPendingProviderSwitch(null)}
        />
      )}

      {/* Time Rewind Confirm Dialog */}
      {rewindTarget && (
        <ConfirmDialog
          title="时间回溯"
          message="您的「对话记录」与「文件修改状态」都将回溯到本次对话发生之前。"
          confirmText="确认回溯"
          cancelText="取消"
          confirmVariant="danger"
          onConfirm={handleRewindConfirm}
          onCancel={() => setRewindTarget(null)}
        />
      )}

      {/* Fork Session Confirm Dialog */}
      {forkTarget && (
        <ConfirmDialog
          title="创建分支"
          message="将从此处创建一个新的会话分支，在新标签页中打开。原会话不受影响。"
          confirmText="创建分支"
          cancelText="取消"
          confirmVariant="primary"
          onConfirm={handleForkConfirm}
          onCancel={() => setForkTarget(null)}
        />
      )}

      {/* Cron Task Settings Modal */}
      <CronTaskSettingsModal
        isOpen={showCronSettings}
        onClose={() => setShowCronSettings(false)}
        initialPrompt={cronPrompt}
        initialConfig={cronState.config}
        workspacePath={agentDir}
        onConfirm={async (config: CronSettingsResult) => {
          const providerEnv = buildProviderEnv(currentProvider);

          // Both paths: enable cron mode (shows status bar, waits for user to type and send)
          // The difference is handled at send time based on executionTarget
          const enrichedConfig = {
            ...config,
            model: selectedModel,
            permissionMode: permissionMode,
            providerEnv: providerEnv,
            executionTarget: config.executionTarget,
          };

          if (cronState.task) {
            updateRunningConfig(enrichedConfig);
          } else {
            enableCronMode(enrichedConfig);
          }

          track('cron_enable', {
            interval_minutes: config.intervalMinutes,
            run_mode: config.runMode,
            execution_target: config.executionTarget,
            has_time_limit: !!config.endConditions.deadline,
            has_count_limit: !!(config.endConditions.maxExecutions && config.endConditions.maxExecutions > 0),
            notify_enabled: config.notifyEnabled,
          });
          setShowCronSettings(false);
        }}
      />

      {/* Cron task detail panel */}
      {cronDetailTask && (
        <CronTaskDetailPanel
          task={cronDetailTask}
          onClose={() => setCronDetailTask(null)}
          onDelete={async (taskId) => {
            const { deleteCronTask } = await import('@/api/cronTaskClient');
            await deleteCronTask(taskId);
            setCronDetailTask(null);
            toastRef.current?.success('任务已删除');
          }}
          onResume={async (taskId) => {
            await startCronTaskIpc(taskId);
            await startCronScheduler(taskId);
            const { getCronTask } = await import('@/api/cronTaskClient');
            const updated = await getCronTask(taskId);
            setCronDetailTask(updated);
            toastRef.current?.success('任务已恢复');
          }}
          onStop={async (taskId) => {
            const { stopCronTask } = await import('@/api/cronTaskClient');
            await stopCronTask(taskId);
            const { getCronTask } = await import('@/api/cronTaskClient');
            const updated = await getCronTask(taskId);
            setCronDetailTask(updated);
            toastRef.current?.success('任务已停止');
          }}
          onOpenSession={handleSelectSession}
        />
      )}
    </div>
  );
}
