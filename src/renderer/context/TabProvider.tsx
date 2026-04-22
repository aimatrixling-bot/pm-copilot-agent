/**
 * TabProvider - Provides isolated state for each Tab
 * 
 * Each TabProvider instance manages:
 * - Its own Sidecar instance (per-Tab isolation)
 * - Its own SSE connection
 * - Its own message history
 * - Its own loading/session state
 * - Its own logs and system info
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ReactNode } from 'react';

import { track } from '@/analytics';
import { generateSessionTitle } from '@/api/sessionClient';
import { createSseConnection, type SseConnection } from '@/api/SseConnection';
import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest, AskUserQuestion } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest, EnterPlanModeRequest, ExitPlanModeAllowedPrompt } from '../../shared/types/planMode';
import { CUSTOM_EVENTS, isPendingSessionId } from '../../shared/constants';
import { TabContext, TabApiContext, TabActiveContext, type SessionState, type TabContextValue, type TabApiContextValue } from './TabContext';
import type { Message, ContentBlock, ToolUseSimple, ToolInput, TaskStats, SubagentToolCall } from '@/types/chat';
import type { ToolUse } from '@/types/stream';
import type { SystemInitInfo } from '../../shared/types/system';
import type { LogEntry } from '@/types/log';
import { parsePartialJson } from '@/utils/parsePartialJson';
import { REACT_LOG_EVENT } from '@/utils/frontendLogger';
import { getTabServerUrl, proxyFetch, isTauri, getSessionActivation, getSessionPort, ensureSessionSidecar } from '@/api/tauriClient';
import type { PermissionMode } from '@/config/types';
import type { QueuedMessageInfo } from '@/types/queue';
import {
    notifyMessageComplete,
    notifyPermissionRequest,
    notifyAskUserQuestion,
    notifyPlanModeRequest,
} from '@/services/notificationService';
import { setBackgroundTaskStatus, setBackgroundTaskDescription, getBackgroundTaskDescription, clearAllBackgroundTaskStatuses } from '@/utils/backgroundTaskStatus';

/** Minimum QA rounds before triggering AI title generation */
const AUTO_TITLE_MIN_ROUNDS = 3;

/**
 * Force-complete any unclosed thinking blocks in a content array.
 * Used as a safety net at multiple points: when new content arrives (text/tool/thinking),
 * the previous thinking block must have ended. Returns the original array if no changes needed.
 */
function closeOpenThinkingBlocks(content: ContentBlock[]): ContentBlock[] {
    if (!content.some(b => b.type === 'thinking' && !b.isComplete)) return content;
    return content.map(b =>
        b.type === 'thinking' && !b.isComplete
            ? { ...b, isComplete: true, thinkingDurationMs: b.thinkingStartedAt ? Date.now() - b.thinkingStartedAt : undefined }
            : b
    );
}

// File-modifying tools that should trigger workspace refresh
// These tools can create, modify, or delete files in the workspace
const FILE_MODIFYING_TOOLS = new Set([
    'Bash',         // Shell commands can modify files
    'Edit',         // Single file edit
    'MultiEdit',    // Multiple file edits
    'Write',        // Create/overwrite files
    'NotebookEdit', // Jupyter notebook edits
]);

/**
 * Check if a content block is a tool block (either local tool_use or server_tool_use)
 * Used to unify handling of both tool types in event handlers
 */
const isToolBlock = (b: ContentBlock): boolean => b.type === 'tool_use' || b.type === 'server_tool_use';

/**
 * Helper to update subagent calls in a message's content blocks
 * Returns the updated message, or null if no matching tool block found.
 */
function applySubagentCallsUpdate(
    msg: Message,
    parentToolUseId: string,
    updater: (calls: SubagentToolCall[], tool: ToolUseSimple) => { calls: SubagentToolCall[]; stats?: TaskStats }
): Message | null {
    if (msg.role !== 'assistant' || typeof msg.content === 'string') return null;

    const contentArray = msg.content;
    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === parentToolUseId);
    if (idx === -1) return null;

    const block = contentArray[idx];
    if (block.type !== 'tool_use' || !block.tool) return null;

    const { calls, stats } = updater(block.tool.subagentCalls || [], block.tool);
    const updated = [...contentArray];
    updated[idx] = {
        ...block,
        tool: {
            ...block.tool,
            subagentCalls: calls,
            ...(stats !== undefined && { taskStats: stats })
        }
    };
    return { ...msg, content: updated };
}

interface TabProviderProps {
    children: ReactNode;
    tabId: string;
    agentDir: string;
    sessionId?: string | null;
    /** Whether this Tab is currently visible — fed into TabActiveContext for useTabActive() consumers */
    isActive?: boolean;
    /** Callback when generating state changes (for close confirmation) */
    onGeneratingChange?: (isGenerating: boolean) => void;
    /** Callback when sessionId changes (e.g., backend creates real session from pending-xxx) */
    onSessionIdChange?: (newSessionId: string) => void;
    /** Callback when session title changes (auto-generated or renamed) */
    onTitleChange?: (title: string) => void;
    /** Callback when unread state changes (message completed on non-active tab) */
    onUnreadChange?: (hasUnread: boolean) => void;
    // Note: sidecarPort prop removed - now using Session-centric Sidecar (Owner model)
    // Port is dynamically retrieved via getSessionPort(sessionId)
}

/**
 * Handle API response - check for errors and throw if not ok
 */
async function handleApiResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error((errorData as { error?: string }).error || `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
}

/**
 * Get the base URL for a Tab's Sidecar
 * With Session-centric Sidecar (Owner model), we first try to get the port from sessionId,
 * then fall back to tabId lookup for legacy compatibility.
 * @param tabId - Tab identifier
 * @param sessionId - Session identifier (optional, for Session-centric lookup)
 */
async function getBaseUrl(tabId: string, sessionId?: string | null): Promise<string> {
    // Session-centric: try to get port from sessionId first
    if (sessionId) {
        const port = await getSessionPort(sessionId);
        if (port !== null) {
            return `http://127.0.0.1:${port}`;
        }
    }
    // Fallback to Tab-based lookup (legacy compatibility)
    return getTabServerUrl(tabId);
}

/**
 * Create a Tab-scoped POST function
 * Uses Session-centric port lookup when sessionId is available
 */
function createPostJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped GET function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiGetJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url);
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped PUT function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiPutJson(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string, body?: unknown): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        return handleApiResponse<T>(response);
    };
}

/**
 * Create a Tab-scoped DELETE function
 * Uses Session-centric port lookup when sessionId is available
 */
function createApiDelete(tabId: string, sessionIdRef: React.MutableRefObject<string | null>) {
    return async <T,>(path: string): Promise<T> => {
        const baseUrl = await getBaseUrl(tabId, sessionIdRef.current);
        const url = `${baseUrl}${path}`;
        const response = await proxyFetch(url, { method: 'DELETE' });
        return handleApiResponse<T>(response);
    };
}

export default function TabProvider({
    children,
    tabId,
    agentDir,
    sessionId = null,
    isActive,
    onGeneratingChange,
    onSessionIdChange,
    onTitleChange,
    onUnreadChange,
}: TabProviderProps) {
    // Core state
    // currentSessionId tracks the actual loaded session (starts from prop, updated by loadSession)
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId);
    // Ref to track currentSessionId in SSE event handlers and API functions (avoid stale closure)
    const currentSessionIdRef = useRef<string | null>(currentSessionId);
    currentSessionIdRef.current = currentSessionId;

    // Create Tab-scoped API functions
    // Uses Session-centric port lookup via currentSessionIdRef
    const postJson = useMemo(() => createPostJson(tabId, currentSessionIdRef), [tabId]);
    const apiGetJson = useMemo(() => createApiGetJson(tabId, currentSessionIdRef), [tabId]);
    const apiPutJson = useMemo(() => createApiPutJson(tabId, currentSessionIdRef), [tabId]);
    const apiDeleteJson = useMemo(() => createApiDelete(tabId, currentSessionIdRef), [tabId]);

    // ── Split message state: history (stable during streaming) + streaming (updates on every SSE event)
    const [historyMessages, setHistoryMessages] = useState<Message[]>([]);
    const [streamingMessage, rawSetStreamingMessage] = useState<Message | null>(null);
    const streamingMessageRef = useRef<Message | null>(null);

    // Wrapper setter that keeps ref in sync (functional updates read latest via ref)
    const setStreamingMessage = useCallback((action: React.SetStateAction<Message | null>) => {
        rawSetStreamingMessage(prev => {
            const next = typeof action === 'function' ? action(prev) : action;
            streamingMessageRef.current = next;
            return next;
        });
    }, []);

    // Mid-turn injection: user messages yielded to SDK during active streaming.
    // Combined view for backward compat (used by Chat.tsx messagesRef, rewind, error handling)
    // Mid-turn injected user messages are inserted into historyMessages via the mid-turn break
    // mechanism (queue:started with midTurnBreak=true splits the streaming message).
    const messages = useMemo<Message[]>(() => {
        return streamingMessage
            ? [...historyMessages, streamingMessage]
            : historyMessages;
    }, [historyMessages, streamingMessage]);

    // Compat wrapper: setMessages operates on combined array, drains streaming into history.
    // Note: The functional-update path has side effects (clearing streamingMessage) inside
    // setHistoryMessages updater — technically impure, but safe because: (1) StrictMode is off,
    // (2) callers (rewind, error) only invoke this when NOT streaming (streamingMessage is already null).
    const setMessages = useCallback((action: React.SetStateAction<Message[]>) => {
        if (typeof action === 'function') {
            setHistoryMessages(prevHistory => {
                const combined = streamingMessageRef.current
                    ? [...prevHistory, streamingMessageRef.current]
                    : prevHistory;
                const next = action(combined);
                streamingMessageRef.current = null;
                rawSetStreamingMessage(null);
                return next;
            });
        } else {
            streamingMessageRef.current = null;
            rawSetStreamingMessage(null);
            setHistoryMessages(action);
        }
    }, []);

    const [isLoading, setIsLoading] = useState(false);
    const [isSessionLoading, setIsSessionLoading] = useState(false);
    const [sessionState, setSessionState] = useState<SessionState>('idle');
    const [sessionRuntime, setSessionRuntime] = useState<string | null>(null);
    const [logs, setLogs] = useState<string[]>([]);
    const [unifiedLogs, setUnifiedLogs] = useState<LogEntry[]>([]);
    const [systemInitInfo, setSystemInitInfo] = useState<SystemInitInfo | null>(null);
    const [agentError, setAgentError] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<string | null>(null);  // e.g., 'compacting'
    const [isConnected, setIsConnected] = useState(false);
    const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
    const [pendingAskUserQuestion, setPendingAskUserQuestion] = useState<AskUserQuestionRequest | null>(null);
    const [pendingExitPlanMode, setPendingExitPlanMode] = useState<ExitPlanModeRequest | null>(null);
    const [pendingEnterPlanMode, setPendingEnterPlanMode] = useState<EnterPlanModeRequest | null>(null);
    const [toolCompleteCount, setToolCompleteCount] = useState(0);
    const [queuedMessages, setQueuedMessages] = useState<QueuedMessageInfo[]>([]);
    const queuedMessagesRef = useRef<QueuedMessageInfo[]>([]);
    queuedMessagesRef.current = queuedMessages;

    // Track started queueIds to prevent sendMessage .then() from re-adding them
    const startedQueueIdsRef = useRef(new Set<string>());

    // Sync currentSessionId when prop changes (e.g., from parent re-initializing)
    useEffect(() => {
        setCurrentSessionId(sessionId);
    }, [sessionId]);

    // Store callbacks in refs to avoid triggering effects on every render
    const onGeneratingChangeRef = useRef(onGeneratingChange);
    onGeneratingChangeRef.current = onGeneratingChange;
    const onSessionIdChangeRef = useRef(onSessionIdChange);
    onSessionIdChangeRef.current = onSessionIdChange;
    const onTitleChangeRef = useRef(onTitleChange);
    onTitleChangeRef.current = onTitleChange;
    const onUnreadChangeRef = useRef(onUnreadChange);
    onUnreadChangeRef.current = onUnreadChange;
    // Ref for isActive to avoid stale closures in SSE event handlers
    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;

    // Auto-title generation refs
    // Collect QA rounds; trigger AI title after 3+ rounds for sufficient context.
    // For 1-2 rounds, the default truncated user query is shown instead.
    const autoTitleAttemptedRef = useRef(false);
    const titleRoundsRef = useRef<Array<{ user: string; assistant: string }>>([]);
    // FIFO queue: supports queued sends where user sends B before A completes.
    // Each send pushes to the queue; each message-complete shifts from it.
    const pendingUserMessagesRef = useRef<string[]>([]);
    const lastCompletedTextRef = useRef('');
    const lastProviderEnvRef = useRef<{ baseUrl?: string; apiKey?: string; authType?: string; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { sonnet?: string; opus?: string; haiku?: string } } | undefined>(undefined);
    const lastModelRef = useRef<string | undefined>(undefined);

    // Notify parent when generating state changes (for close confirmation)
    useEffect(() => {
        onGeneratingChangeRef.current?.(isLoading);
    }, [isLoading]);

    // Refs for SSE handling
    const sseRef = useRef<SseConnection | null>(null);
    const isStreamingRef = useRef(false);
    // Ref for stop timeout cleanup
    const stopTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const seenIdsRef = useRef<Set<string>>(new Set());
    // Flag to skip message-replay after user clicks "new session"
    const isNewSessionRef = useRef(false);
    // Flag to skip SSE replays while loadSession REST API is in-flight.
    // Without this, SSE replays race with loadSession and create intermediate
    // render states (3→46→249) causing visible scroll jumps on session entry.
    const isLoadingSessionRef = useRef(false);
    // Ref for cron task exit handler (set by useCronTask hook via context)
    const onCronTaskExitRequestedRef = useRef<((taskId: string, reason: string) => void) | null>(null);
    // Synchronous map: toolUseId → toolName. Updated outside React state updaters
    // to avoid React 18 automatic batching timing issues (state updaters run during
    // render, not during setState call — so reading a local variable set inside an
    // updater is unreliable). This ref is always synchronously up-to-date.
    const toolNameMapRef = useRef<Map<string, string>>(new Map());
    // Pending attachments to merge with next user message from SSE replay
    const pendingAttachmentsRef = useRef<{
        id: string;
        name: string;
        size: number;
        mimeType: string;
        previewUrl: string;
        isImage: boolean;
    }[] | null>(null);

    /**
     * Reset session for "新对话" functionality
     * This synchronizes frontend AND backend state:
     * - Stops any ongoing AI response
     * - Clears all messages on both sides
     * - Generates new session ID on backend
     * - Clears logs and permissions
     */

    // Shared cleanup for all session boundary transitions (reset, load, SSE init).
    // Single source of truth — add new interactive states here to avoid leaking across sessions.
    const clearInteractiveState = useCallback(() => {
        setPendingPermission(null);
        setPendingAskUserQuestion(null);
        setPendingExitPlanMode(null);
        setPendingEnterPlanMode(null);
        setQueuedMessages([]);
        startedQueueIdsRef.current.clear();
        clearAllBackgroundTaskStatuses();
    }, []);

    const resetSession = useCallback(async (): Promise<boolean> => {
        console.log(`[TabProvider ${tabId}] resetSession: starting...`);

        // 1. Clear frontend state immediately for responsive UI
        setHistoryMessages([]);
        setStreamingMessage(null);
        seenIdsRef.current.clear();
        isNewSessionRef.current = true;
        isStreamingRef.current = false;
        toolNameMapRef.current.clear();
        setIsLoading(false);
        setSessionState('idle');  // Reset session state for new conversation
        setSystemStatus(null);
        setAgentError(null);
        setUnifiedLogs([]);
        setLogs([]);
        clearInteractiveState();
        // Reset auto-title state for new conversation
        autoTitleAttemptedRef.current = false;
        titleRoundsRef.current = [];
        pendingUserMessagesRef.current = [];
        lastCompletedTextRef.current = '';
        lastProviderEnvRef.current = undefined;
        lastModelRef.current = undefined;
        // NOTE: Do NOT clear currentSessionId here. The old session ID is the only way
        // to find the still-running sidecar via getSessionPort(). Setting it to null
        // causes all subsequent API calls to fail ("No running sidecar for tab") because
        // getBaseUrl skips session-centric lookup when sessionId is null, and the tab-based
        // fallback also fails. The history dropdown naturally shows no selection when the
        // old session is deleted from the list, so no UI impact.
        // The session ID will be upgraded to the new value when chat:system-init arrives.

        // Reset tab title so SortableTabItem falls back to folder name
        onTitleChangeRef.current?.('New Chat');

        // 2. Tell backend to reset (this will also broadcast chat:init)
        try {
            const response = await postJson<{ success: boolean; error?: string }>('/chat/reset');
            if (!response.success) {
                console.error(`[TabProvider ${tabId}] resetSession failed:`, response.error);
                return false;
            }
            console.log(`[TabProvider ${tabId}] resetSession complete`);

            // Track session_new event
            track('session_new');

            return true;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] resetSession error:`, error);
            return false;
        }
    }, [tabId, postJson, setStreamingMessage, clearInteractiveState]);

    // Append log
    const appendLog = useCallback((line: string) => {
        setLogs(prev => {
            const next = [...prev, line];
            if (next.length > 2000) {
                return next.slice(-2000);
            }
            return next;
        });
    }, []);

    // Append unified log entry (from SSE chat:log events) - keep max 3000
    const appendUnifiedLog = useCallback((entry: LogEntry) => {
        setUnifiedLogs(prev => {
            const next = [...prev, entry];
            if (next.length > 3000) {
                return next.slice(-3000);
            }
            return next;
        });
    }, []);

    // Clear all unified logs
    const clearUnifiedLogs = useCallback(() => {
        setUnifiedLogs([]);
        setLogs([]);
    }, []);

    // Listen for React frontend logs
    useEffect(() => {
        const handleReactLog = (event: Event) => {
            const customEvent = event as CustomEvent<LogEntry>;
            appendUnifiedLog(customEvent.detail);
        };

        window.addEventListener(REACT_LOG_EVENT, handleReactLog);
        return () => {
            window.removeEventListener(REACT_LOG_EVENT, handleReactLog);
        };
    }, [appendUnifiedLog]);

    // Listen for Rust logs via Tauri events (unified with React/Bun logs)
    // Note: Rust logs are only displayed in UI, NOT persisted via frontend API
    // This avoids a log loop: Rust log → API call → Rust proxy logs the call → new Rust log → ...
    useEffect(() => {
        if (!isTauri()) return;

        let unlisten: (() => void) | undefined;

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            unlisten = await listen<LogEntry>('log:rust', (event) => {
                const entry = event.payload;
                // Add to unified logs for UI display only
                // Do NOT call queueLogsForPersistence - that would cause infinite loop
                appendUnifiedLog(entry);
            });
        })();

        return () => {
            unlisten?.();
        };
    }, [appendUnifiedLog]);

    /**
     * Move the current streaming message into history, marking incomplete blocks as finished.
     * Replaces the old markIncompleteBlocksAsFinished — does everything in one atomic step.
     */
    const moveStreamingToHistory = useCallback((status: 'completed' | 'stopped' | 'failed') => {
        // CRITICAL: Use rawSetStreamingMessage updater to read the LATEST streaming message.
        // Reading streamingMessageRef.current directly would race with pending setStreamingMessage
        // updates (React 18 batching delays updater execution), causing the last few text chunks
        // to be lost when chat:message-chunk and chat:message-complete arrive in the same batch.
        // The updater's `prev` parameter is guaranteed by React to include all pending updates.
        rawSetStreamingMessage(prev => {
            if (!prev) {
                isStreamingRef.current = false;
                streamingMessageRef.current = null;
                return null;
            }

            let finalMsg = prev;
            if (prev.role === 'assistant' && Array.isArray(prev.content)) {
                const statusFlags = status === 'stopped' ? { isStopped: true }
                    : status === 'failed' ? { isFailed: true }
                        : {};
                const hasIncomplete = prev.content.some(b =>
                    (b.type === 'thinking' && !b.isComplete) ||
                    (b.type === 'tool_use' && b.tool?.isLoading)
                );
                if (hasIncomplete) {
                    finalMsg = {
                        ...prev,
                        content: prev.content.map(block => {
                            if (block.type === 'thinking' && !block.isComplete) {
                                return {
                                    ...block,
                                    isComplete: true,
                                    ...statusFlags,
                                    thinkingDurationMs: block.thinkingStartedAt
                                        ? Date.now() - block.thinkingStartedAt
                                        : undefined
                                };
                            }
                            if (block.type === 'tool_use' && block.tool?.isLoading) {
                                return {
                                    ...block,
                                    tool: { ...block.tool, isLoading: false, ...statusFlags }
                                };
                            }
                            return block;
                        }),
                    };
                }
            }

            // Capture completed text for auto-title generation (skip if already attempted)
            if (!autoTitleAttemptedRef.current && status === 'completed' && finalMsg.role === 'assistant' && Array.isArray(finalMsg.content)) {
                const textParts = finalMsg.content
                    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
                    .map(b => b.text)
                    .join('');
                lastCompletedTextRef.current = textParts;
            }

            // Side effect inside updater — technically impure, but safe because:
            // (1) StrictMode is off (no double invocation), (2) same pattern as setMessages (line 243).
            setHistoryMessages(prevHistory => [...prevHistory, finalMsg]);
            // Set isStreamingRef inside the updater so pending message-chunk updaters
            // (which check isStreamingRef.current) still see true and correctly append
            // rather than creating a new message. Must NOT be set before this updater runs.
            isStreamingRef.current = false;
            streamingMessageRef.current = null;
            return null;
        });
    }, []);

    const recoverStreamingUi = useCallback((status: 'stopped' | 'failed') => {
        moveStreamingToHistory(status);
        flushSync(() => {
            isStreamingRef.current = false;
            setIsLoading(false);
            setSessionState('idle');
            setSystemStatus(null);
        });
    }, [moveStreamingToHistory]);

    // Handle SSE events
    const handleSseEvent = useCallback((eventName: string, data: unknown) => {
        switch (eventName) {
            case 'chat:init': {
                // chat:init is sent on SSE connect/reconnect
                // If user just started a new session, we've already cleared state - skip
                // This prevents race conditions where backend's init arrives after frontend reset
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping chat:init (new session in progress)');
                    break;
                }

                // When loadSession REST API is in-flight, skip the message clear —
                // loadSession will overwrite historyMessages with the full batch.
                // Still sync sessionState below so isLoading stays correct.
                if (!isLoadingSessionRef.current) {
                    seenIdsRef.current.clear();
                    setHistoryMessages([]);
                    setStreamingMessage(null);
                    setAgentError(null);
                    clearInteractiveState();
                }

                // Sync isLoading with backend state on SSE connect/reconnect
                // When backend reports 'idle', unconditionally reset frontend loading state.
                // This catches: (1) message-complete lost during connection issues,
                // (2) Tab joining a sidecar whose query already finished (no streaming ref set).
                const initPayload = data as { sessionState?: SessionState } | null;
                if (initPayload?.sessionState) {
                    setSessionState(initPayload.sessionState);
                    if (initPayload.sessionState === 'idle') {
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSystemStatus(null);
                    }
                }
                break;
            }

            case 'chat:message-replay': {
                // Skip replay if user started a new session or loadSession is in-flight.
                // During loadSession, SSE replays race with REST and create intermediate
                // render batches (3→46→249) causing visible scroll jumps.
                if (isNewSessionRef.current || isLoadingSessionRef.current) {
                    break;
                }
                const payload = data as { message: { id: string; role: 'user' | 'assistant'; content: string | ContentBlock[]; timestamp: string; sdkUuid?: string; metadata?: { source: 'desktop' | 'telegram_private' | 'telegram_group'; sourceId?: string; senderName?: string } } } | null;
                if (!payload?.message) break;
                const msg = payload.message;
                if (seenIdsRef.current.has(msg.id)) break;
                seenIdsRef.current.add(msg.id);

                // Merge pending attachments with user messages
                let attachments = undefined;
                if (msg.role === 'user' && pendingAttachmentsRef.current) {
                    attachments = pendingAttachmentsRef.current;
                    pendingAttachmentsRef.current = null; // Clear after use
                }

                // Replayed assistant messages are completed — mark thinking blocks as isComplete
                // so the UI doesn't show a spinner on them.
                let replayContent = msg.content;
                if (msg.role === 'assistant' && Array.isArray(replayContent)) {
                    const needsPatch = replayContent.some(b => b.type === 'thinking' && !b.isComplete);
                    if (needsPatch) {
                        replayContent = replayContent.map(b =>
                            b.type === 'thinking' && !b.isComplete ? { ...b, isComplete: true } : b
                        );
                    }
                }

                setHistoryMessages(prev => [...prev, {
                    ...msg,
                    content: replayContent,
                    timestamp: new Date(msg.timestamp),
                    attachments,
                }]);
                break;
            }

            case 'chat:message-sdk-uuid': {
                // Backend assigns sdkUuid after SDK echoes messages — update React state.
                // SDK may emit multiple UUIDs per turn (thinking → text); always accept the
                // LATEST one so resumeSessionAt / fork use the final assistant message UUID.
                const payload = data as { messageId: string; sdkUuid: string } | null;
                if (payload?.messageId && payload?.sdkUuid) {
                    if (streamingMessageRef.current?.id === payload.messageId) {
                        setStreamingMessage(prev => prev ? { ...prev, sdkUuid: payload.sdkUuid } : prev);
                    } else {
                        setHistoryMessages(prev => {
                            const idx = prev.findIndex(m => m.id === payload.messageId);
                            if (idx < 0) return prev;
                            if (prev[idx].sdkUuid === payload.sdkUuid) return prev; // no-op
                            const updated = [...prev];
                            updated[idx] = { ...updated[idx], sdkUuid: payload.sdkUuid };
                            return updated;
                        });
                    }
                }
                break;
            }

            case 'chat:status': {
                const payload = data as { sessionState: SessionState } | null;
                if (payload?.sessionState) {
                    setSessionState(payload.sessionState);
                    if (payload.sessionState === 'idle') {
                        // When backend reports 'idle', unconditionally reset frontend loading state.
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSystemStatus(null);
                    } else if (payload.sessionState === 'running' && !isStreamingRef.current) {
                        // Session is running but we haven't received any streaming events yet.
                        // This happens when a Tab connects mid-flight (e.g., IM session in progress)
                        // and receives a replayed chat:status → "running" from the SSE last-value cache.
                        // Set isLoading so the UI shows the loading state instead of action buttons.
                        setIsLoading(true);
                    }
                }
                break;
            }

            case 'chat:system-status': {
                // System status from SDK (e.g., 'compacting' for context compression)
                const payload = data as { status: string | null } | null;
                setSystemStatus(payload?.status ?? null);
                break;
            }

            case 'chat:permission-mode-changed': {
                // Backend permission mode changed (e.g., ExitPlanMode restored auto).
                // Dispatch to Chat.tsx so it can sync the UI toggle.
                // Include tabId for cross-tab isolation (SSE is tab-scoped but DOM events are global).
                const payload = data as { permissionMode: string } | null;
                if (payload?.permissionMode) {
                    window.dispatchEvent(new CustomEvent('permission-mode-sync', {
                        detail: { permissionMode: payload.permissionMode, tabId }
                    }));
                }
                break;
            }

            case 'chat:api-retry': {
                // SDK is retrying API call (rate limit or transient error)
                // null payload = retry resolved, streaming resumed — clear status
                const payload = data as { attempt?: number; maxRetries?: number; delayMs?: number } | null;
                if (payload) {
                    const retryKey = `api_retry:${payload.attempt ?? 1}:${payload.maxRetries ?? '?'}`;
                    setSystemStatus(retryKey);
                } else {
                    setSystemStatus(null);
                }
                break;
            }

            case 'chat:message-chunk': {
                // Skip stale chunks if user started a new session
                // (old stream may still be sending events before fully disconnecting)
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping message-chunk (new session, stale event)');
                    break;
                }

                const chunk = data as string;
                setStreamingMessage(prev => {
                    if (prev?.role === 'assistant' && isStreamingRef.current) {
                        if (typeof prev.content === 'string') {
                            return { ...prev, content: prev.content + chunk };
                        }
                        const contentArray = closeOpenThinkingBlocks(prev.content);
                        const lastBlock = contentArray[contentArray.length - 1];
                        if (lastBlock?.type === 'text') {
                            return {
                                ...prev,
                                content: [...contentArray.slice(0, -1), { type: 'text', text: (lastBlock.text || '') + chunk }]
                            };
                        }
                        return {
                            ...prev,
                            content: [...contentArray, { type: 'text', text: chunk }]
                        };
                    }
                    // First chunk - create new streaming message
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return {
                        id: Date.now().toString(),
                        role: 'assistant',
                        content: chunk,
                        timestamp: new Date()
                    };
                });
                break;
            }

            case 'chat:thinking-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping thinking-start (new session, stale event)');
                    break;
                }
                const { index } = data as { index: number };
                setStreamingMessage(prev => {
                    const thinkingBlock: ContentBlock = {
                        type: 'thinking',
                        thinking: '',
                        thinkingStreamIndex: index,
                        thinkingStartedAt: Date.now()
                    };
                    if (prev?.role === 'assistant') {
                        // Implicit close FIRST: force-complete any unclosed thinking blocks.
                        // Must run before dedup check — a stale orphaned block with the same
                        // reused index should be closed, not block the new block from being added.
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        // Deduplicate: skip only if an ACTIVE (incomplete) thinking block with this index exists
                        if (content.some(b => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete)) {
                            return prev;
                        }
                        return { ...prev, content: [...content, thinkingBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [thinkingBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:thinking-chunk': {
                const { index, delta } = data as { index: number; delta: string };
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    const idx = contentArray.findIndex(b => b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'thinking') return prev;
                    const updated = [...contentArray];
                    updated[idx] = { ...block, thinking: (block.thinking || '') + delta };
                    return { ...prev, content: updated };
                });
                break;
            }

            case 'chat:tool-use-start': {
                // Skip stale events if user started a new session
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping tool-use-start (new session, stale event)');
                    break;
                }
                const tool = data as ToolUse;

                // Track tool_use event
                track('tool_use', { tool: tool.name });

                // Synchronously record toolUseId → toolName for file-modifying tool detection.
                // This map is read in chat:tool-result-complete to trigger directory refresh.
                toolNameMapRef.current.set(tool.id, tool.name);

                // For Task tool, add taskStartTime and initial taskStats
                const toolSimple: ToolUseSimple = (tool.name === 'Task' || tool.name === 'Agent')
                    ? { ...tool, inputJson: '', isLoading: true, taskStartTime: Date.now(), taskStats: { toolCount: 0, inputTokens: 0, outputTokens: 0 } }
                    : { ...tool, inputJson: '', isLoading: true };
                setStreamingMessage(prev => {
                    const toolBlock: ContentBlock = {
                        type: 'tool_use',
                        tool: toolSimple
                    };
                    if (prev?.role === 'assistant') {
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        return { ...prev, content: [...content, toolBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [toolBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:server-tool-use-start': {
                // Server-side tool use (e.g., 智谱 GLM-4.7's webReader, analyze_image)
                // These are executed by the API provider, not locally
                if (isNewSessionRef.current) {
                    console.log('[TabProvider] Skipping server-tool-use-start (new session, stale event)');
                    break;
                }
                const tool = data as ToolUse;

                // Track tool_use event (server-side tools)
                track('tool_use', { tool: tool.name });

                // Server tools come with complete input, no streaming
                const toolSimple: ToolUseSimple = {
                    ...tool,
                    inputJson: JSON.stringify(tool.input, null, 2),
                    parsedInput: tool.input as unknown as ToolInput,
                    isLoading: true
                };
                setStreamingMessage(prev => {
                    const toolBlock: ContentBlock = {
                        type: 'server_tool_use',
                        tool: toolSimple
                    };
                    if (prev?.role === 'assistant') {
                        const content = closeOpenThinkingBlocks(
                            typeof prev.content === 'string'
                                ? [{ type: 'text' as const, text: prev.content }]
                                : prev.content
                        );
                        return { ...prev, content: [...content, toolBlock] };
                    }
                    isStreamingRef.current = true;
                    setIsLoading(true);
                    return { id: Date.now().toString(), role: 'assistant', content: [toolBlock], timestamp: new Date() };
                });
                break;
            }

            case 'chat:tool-input-delta': {
                // Note: Only handle tool_use, NOT server_tool_use
                // server_tool_use comes with complete input, no streaming delta needed
                const { toolId, delta } = data as { index: number; toolId: string; delta: string };
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    const idx = contentArray.findIndex(b => b.type === 'tool_use' && b.tool?.id === toolId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (block.type !== 'tool_use' || !block.tool) return prev;
                    const newInputJson = (block.tool.inputJson || '') + delta;
                    const parsedInput = parsePartialJson<ToolInput>(newInputJson);
                    const updated = [...contentArray];
                    updated[idx] = {
                        ...block,
                        tool: { ...block.tool, inputJson: newInputJson, parsedInput: parsedInput || block.tool.parsedInput }
                    };
                    return { ...prev, content: updated };
                });
                break;
            }

            case 'chat:content-block-stop': {
                const { index, toolId } = data as { index: number; toolId?: string };
                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;

                    // Check thinking block
                    const thinkingIdx = contentArray.findIndex(b =>
                        b.type === 'thinking' && b.thinkingStreamIndex === index && !b.isComplete
                    );
                    if (thinkingIdx !== -1) {
                        const block = contentArray[thinkingIdx];
                        if (block.type === 'thinking') {
                            const updated = [...contentArray];
                            updated[thinkingIdx] = {
                                ...block,
                                isComplete: true,
                                thinkingDurationMs: block.thinkingStartedAt ? Date.now() - block.thinkingStartedAt : undefined
                            };
                            return { ...prev, content: updated };
                        }
                    }

                    // Check tool block (both tool_use and server_tool_use)
                    const toolIdx = toolId
                        ? contentArray.findIndex(b => isToolBlock(b) && b.tool?.id === toolId)
                        : contentArray.findIndex(b => isToolBlock(b) && b.tool?.streamIndex === index);
                    if (toolIdx !== -1) {
                        const block = contentArray[toolIdx];
                        if (isToolBlock(block) && block.tool?.inputJson) {
                            let parsedInput: ToolInput | undefined;
                            try {
                                parsedInput = JSON.parse(block.tool.inputJson);
                            } catch {
                                parsedInput = parsePartialJson<ToolInput>(block.tool.inputJson) ?? undefined;
                            }
                            const updated = [...contentArray];
                            updated[toolIdx] = { ...block, tool: { ...block.tool, parsedInput } };
                            return { ...prev, content: updated };
                        }
                    }
                    return prev;
                });
                break;
            }

            case 'chat:tool-result-start':
            case 'chat:tool-result-delta':
            case 'chat:tool-result-complete': {
                const payload = data as { toolUseId: string; content?: string; delta?: string; isError?: boolean };

                setStreamingMessage(prev => {
                    if (!prev || prev.role !== 'assistant' || typeof prev.content === 'string') return prev;
                    const contentArray = prev.content;
                    // Find tool block (both tool_use and server_tool_use)
                    const idx = contentArray.findIndex(b => isToolBlock(b) && b.tool?.id === payload.toolUseId);
                    if (idx === -1) return prev;
                    const block = contentArray[idx];
                    if (!isToolBlock(block) || !block.tool) return prev;

                    const updated = [...contentArray];
                    if (eventName === 'chat:tool-result-delta') {
                        updated[idx] = {
                            ...block,
                            tool: { ...block.tool, result: (block.tool.result || '') + (payload.delta ?? ''), isLoading: true }
                        };
                    } else {
                        updated[idx] = {
                            ...block,
                            tool: {
                                ...block.tool,
                                result: payload.content ?? block.tool.result,
                                isError: payload.isError,
                                isLoading: eventName !== 'chat:tool-result-complete'
                            }
                        };
                    }

                    return { ...prev, content: updated };
                });

                // Fast-path: trigger workspace refresh for file-modifying tools.
                // Uses synchronous toolNameMapRef (NOT inside state updater) to avoid
                // React 18 automatic batching timing bug — state updaters run during
                // render, so a local variable set inside an updater would always be
                // false when checked outside.
                if (eventName === 'chat:tool-result-complete') {
                    const toolName = toolNameMapRef.current.get(payload.toolUseId);
                    if (toolName && FILE_MODIFYING_TOOLS.has(toolName)) {
                        console.log(`[TabProvider] File-modifying tool completed: ${toolName}, triggering workspace refresh`);
                        setToolCompleteCount(c => c + 1);
                    }
                    toolNameMapRef.current.delete(payload.toolUseId);
                }
                break;
            }

            case 'chat:message-complete': {
                console.log(`[TabProvider ${tabId}] message-complete received`);
                // NOTE: isStreamingRef.current is set to false inside moveStreamingToHistory's
                // updater, NOT here. Setting it here would cause pending message-chunk updaters
                // (queued by React 18 batching) to see false and create a new message instead
                // of appending, losing the accumulated content.
                moveStreamingToHistory('completed');
                // Use flushSync to immediately update UI, bypassing React batching
                // This prevents UI from getting stuck in loading state during rapid event streams
                flushSync(() => {
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle
                    setSystemStatus(null);  // Clear system status (e.g., 'compacting') when message completes
                });

                // Send system notification if user is not focused on the app
                notifyMessageComplete(tabId);

                // Mark tab as unread if user is viewing a different tab
                if (!isActiveRef.current) {
                    onUnreadChangeRef.current?.(true);
                }

                // Track message_complete event with usage data
                const completePayload = data as {
                    model?: string;
                    input_tokens?: number;
                    output_tokens?: number;
                    cache_read_tokens?: number;
                    cache_creation_tokens?: number;
                    tool_count?: number;
                    duration_ms?: number;
                    assistant_sdk_uuid?: string;
                    assistant_message_id?: string;
                } | null;

                // Apply backend's real message ID + sdkUuid to the just-moved history message.
                // Streaming messages use Date.now() IDs that don't match backend's messageSequence IDs.
                // Without this, fork/rewind pass the wrong ID to the backend.
                if (completePayload?.assistant_sdk_uuid || completePayload?.assistant_message_id) {
                    const uuid = completePayload.assistant_sdk_uuid;
                    const realId = completePayload.assistant_message_id;
                    setHistoryMessages(prev => {
                        if (prev.length === 0) return prev;
                        const last = prev[prev.length - 1];
                        if (last.role !== 'assistant') return prev;
                        const needsUuid = uuid && last.sdkUuid !== uuid;
                        const needsId = realId && last.id !== realId;
                        if (!needsUuid && !needsId) return prev;
                        return [...prev.slice(0, -1), {
                            ...last,
                            ...(needsId ? { id: realId } : {}),
                            ...(needsUuid ? { sdkUuid: uuid } : {}),
                        }];
                    });
                }
                // Always track message_complete, use defaults if payload is missing
                track('message_complete', {
                    model: completePayload?.model,
                    input_tokens: completePayload?.input_tokens ?? 0,
                    output_tokens: completePayload?.output_tokens ?? 0,
                    cache_read_tokens: completePayload?.cache_read_tokens ?? 0,
                    cache_creation_tokens: completePayload?.cache_creation_tokens ?? 0,
                    tool_count: completePayload?.tool_count ?? 0,
                    duration_ms: completePayload?.duration_ms ?? 0,
                });

                // Auto-title: collect QA round, fire after 3+ rounds
                // Shift from FIFO queue to correctly pair sends with completions (handles queued sends)
                const completedUserText = pendingUserMessagesRef.current.shift();
                if (!autoTitleAttemptedRef.current && currentSessionIdRef.current && completedUserText) {
                    // Record this completed QA round (truncate both sides to 200 chars)
                    titleRoundsRef.current.push({
                        user: completedUserText.slice(0, 200),
                        assistant: lastCompletedTextRef.current.slice(0, 200),
                    });

                    // Trigger AI title generation once we have enough rounds
                    if (titleRoundsRef.current.length >= AUTO_TITLE_MIN_ROUNDS) {
                        autoTitleAttemptedRef.current = true;
                        const sid = currentSessionIdRef.current;
                        const rounds = [...titleRoundsRef.current];
                        const model = completePayload?.model || lastModelRef.current || '';
                        const pEnv = lastProviderEnvRef.current;
                        // Fire-and-forget — guard against session switch during async call
                        generateSessionTitle(postJson, sid, rounds, model, pEnv)
                            .then(r => {
                                if (r?.success && r.title && currentSessionIdRef.current === sid) {
                                    onTitleChangeRef.current?.(r.title);
                                    // Backend already persisted — notify history/task center to refetch
                                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
                                }
                            })
                            .catch(() => {});
                    }
                }

                break;
            }

            case 'chat:message-stopped': {
                console.log(`[TabProvider ${tabId}] message-stopped received`);
                // isStreamingRef.current set inside moveStreamingToHistory's updater
                moveStreamingToHistory('stopped');
                // Use flushSync to immediately update UI
                flushSync(() => {
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle
                    setSystemStatus(null);  // Clear system status when user stops response
                });
                // Discard incomplete round from title tracking — stopped response is not a valid QA pair
                pendingUserMessagesRef.current.shift();
                // Clear stop timeout since we received confirmation
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }

                // Track message_stop event
                track('message_stop');
                break;
            }

            case 'chat:message-error': {
                console.log(`[TabProvider ${tabId}] message-error received`);
                // isStreamingRef.current set inside moveStreamingToHistory's updater
                moveStreamingToHistory('failed');
                // Use flushSync to immediately update UI
                flushSync(() => {
                    setIsLoading(false);
                    setSessionState('idle');  // Reset session state to idle on error
                    setSystemStatus(null);  // Clear system status on error
                });
                // Discard incomplete round from title tracking — errored response is not a valid QA pair
                pendingUserMessagesRef.current.shift();
                // Clear stop timeout on error too
                if (stopTimeoutRef.current) {
                    clearTimeout(stopTimeoutRef.current);
                    stopTimeoutRef.current = null;
                }

                // Track message_error event (don't include actual error message for privacy)
                track('message_error');
                break;
            }

            case 'chat:system-init': {
                const payload = data as { info: SystemInitInfo; sessionId?: string } | null;
                if (payload?.info) {
                    setSystemInitInfo(payload.info);

                    // CRITICAL: Mark session as active immediately when system-init arrives
                    // This happens BEFORE message-chunk, so we must set isStreamingRef here
                    // to prevent loadSession from aborting an active cron task during sessionId upgrade
                    isStreamingRef.current = true;
                    setIsLoading(true);

                    // Auto-sync sessionId when a new session is created (e.g., first message in empty session)
                    // This ensures currentSessionId stays in sync with the actual session
                    // Use our sessionId (for SessionStore matching) not SDK's session_id
                    const newSessionId = payload.sessionId;
                    if (newSessionId && currentSessionIdRef.current !== newSessionId) {
                        console.log(`[TabProvider ${tabId}] Auto-syncing sessionId from system_init: ${newSessionId}`);
                        setCurrentSessionId(newSessionId);
                        // Notify parent (App.tsx) to update Tab.sessionId for Session singleton constraint
                        // This ensures history dropdown can detect if this session is already open
                        onSessionIdChangeRef.current?.(newSessionId);
                    }
                }
                break;
            }

            case 'chat:logs': {
                const payload = data as { lines: string[] } | null;
                if (payload?.lines) {
                    setLogs(payload.lines);
                }
                break;
            }

            case 'chat:log': {
                // Handle both legacy string format and new LogEntry format
                if (typeof data === 'string') {
                    // Legacy format: plain string
                    appendLog(data);
                } else if (data && typeof data === 'object' && 'source' in data && 'message' in data) {
                    // New unified logger format: LogEntry
                    appendUnifiedLog(data as LogEntry);
                }
                break;
            }

            case 'chat:agent-error': {
                const payload = data as { message: string } | null;
                if (payload?.message) {
                    setAgentError(payload.message);
                }
                break;
            }

            // Cron task exit requested by AI via exit_cron_task tool
            case 'cron:task-exit-requested': {
                const payload = data as { taskId: string; reason: string; timestamp: string } | null;
                if (payload?.taskId && payload?.reason) {
                    console.log(`[TabProvider ${tabId}] Cron task exit requested: taskId=${payload.taskId}, reason=${payload.reason}`);
                    // Call the handler if registered by useCronTask
                    if (onCronTaskExitRequestedRef.current) {
                        onCronTaskExitRequestedRef.current(payload.taskId, payload.reason);
                    }
                }
                break;
            }

            // Subagent event handling for nested tool calls (Task tool)
            case 'chat:subagent-tool-use': {
                const payload = data as { parentToolUseId: string; tool: ToolUse; usage?: { input_tokens?: number; output_tokens?: number } };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls, tool) => {
                        const inputJson = JSON.stringify(payload.tool.input ?? {}, null, 2);
                        const existingIdx = calls.findIndex(c => c.id === payload.tool.id);

                        const updatedCalls: SubagentToolCall[] = existingIdx !== -1
                            ? calls.map(c => c.id === payload.tool.id
                                ? { ...c, name: payload.tool.name, input: payload.tool.input ?? {}, inputJson, isLoading: true }
                                : c)
                            : [...calls, { id: payload.tool.id, name: payload.tool.name, input: payload.tool.input ?? {}, inputJson, isLoading: true }];

                        // Update taskStats with new tool count and token usage
                        const prevStats = tool.taskStats || { toolCount: 0, inputTokens: 0, outputTokens: 0 };
                        const newStats: TaskStats = {
                            toolCount: updatedCalls.length,
                            inputTokens: prevStats.inputTokens + (payload.usage?.input_tokens || 0),
                            outputTokens: prevStats.outputTokens + (payload.usage?.output_tokens || 0)
                        };

                        return { calls: updatedCalls, stats: newStats };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-input-delta': {
                const payload = data as { parentToolUseId: string; toolId: string; delta: string };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call => {
                            if (call.id !== payload.toolId) return call;
                            const nextInputJson = (call.inputJson || '') + payload.delta;
                            const parsedInput = parsePartialJson<ToolInput>(nextInputJson);
                            return { ...call, inputJson: nextInputJson, parsedInput: parsedInput || call.parsedInput };
                        });
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-result-start': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError: boolean };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call =>
                            call.id === payload.toolUseId
                                ? { ...call, result: payload.content, isError: payload.isError, isLoading: true }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-result-delta': {
                const payload = data as { parentToolUseId: string; toolUseId: string; delta: string };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call =>
                            call.id === payload.toolUseId
                                ? { ...call, result: (call.result || '') + payload.delta, isLoading: true }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'chat:subagent-tool-result-complete': {
                const payload = data as { parentToolUseId: string; toolUseId: string; content: string; isError?: boolean };
                setStreamingMessage(prev => {
                    if (!prev) return prev;
                    return applySubagentCallsUpdate(prev, payload.parentToolUseId, (calls) => {
                        const updatedCalls = calls.map(call =>
                            call.id === payload.toolUseId
                                ? { ...call, result: payload.content, isError: payload.isError, isLoading: false }
                                : call
                        );
                        return { calls: updatedCalls };
                    }) ?? prev;
                });
                break;
            }

            case 'permission:request': {
                // Agent is requesting permission to use a tool
                const payload = data as { requestId: string; toolName: string; input: string } | null;
                console.log(`[TabProvider] permission:request received:`, payload);
                if (payload?.requestId) {
                    console.log(`[TabProvider] Setting pendingPermission for: ${payload.toolName}`);
                    setPendingPermission({
                        requestId: payload.requestId,
                        toolName: payload.toolName,
                        input: payload.input || '',
                    });
                    // Send system notification if user is not focused on the app
                    notifyPermissionRequest(payload.toolName);
                }
                break;
            }

            case 'ask-user-question:request': {
                // Agent is asking user structured questions
                const payload = data as { requestId: string; questions: AskUserQuestion[]; previewFormat?: 'html' | 'markdown' } | null;
                console.log(`[TabProvider] ask-user-question:request received:`, payload);
                if (payload?.requestId && payload.questions?.length > 0) {
                    console.log(`[TabProvider] Setting pendingAskUserQuestion with ${payload.questions.length} questions`);
                    setPendingAskUserQuestion({
                        requestId: payload.requestId,
                        questions: payload.questions,
                        previewFormat: payload.previewFormat,
                    });
                    // Send system notification if user is not focused on the app
                    notifyAskUserQuestion();
                }
                break;
            }

            case 'exit-plan-mode:request': {
                const payload = data as { requestId: string; plan?: string; allowedPrompts?: ExitPlanModeAllowedPrompt[] } | null;
                if (payload?.requestId) {
                    setPendingExitPlanMode({
                        requestId: payload.requestId,
                        plan: payload.plan,
                        allowedPrompts: payload.allowedPrompts,
                    });
                    notifyPlanModeRequest();
                }
                break;
            }

            case 'enter-plan-mode:request': {
                const payload = data as { requestId: string; autoApproved?: boolean } | null;
                if (payload?.requestId) {
                    // Always auto-approve EnterPlanMode (no user card needed).
                    // For SDK-auto path, backend already proceeded; just update UI state.
                    // For canUseTool path, backend is waiting — notify it to proceed.
                    setPendingEnterPlanMode({ requestId: payload.requestId, autoApproved: true, resolved: 'approved' });
                    if (!payload.autoApproved) {
                        void postJson('/api/enter-plan-mode/respond', { requestId: payload.requestId, approved: true });
                    }
                }
                break;
            }

            // Background task lifecycle (SDK Task tool)
            case 'chat:task-started': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const startPayload = data as { taskId?: string; description?: string };
                if (startPayload.taskId && startPayload.description) {
                    setBackgroundTaskDescription(startPayload.taskId, startPayload.description);
                }
                break;
            }
            case 'chat:task-notification': {
                console.log(`[TabProvider ${tabId}] ${eventName}:`, data);
                const payload = data as { taskId?: string; status?: string; summary?: string };
                if (payload.taskId && payload.status) {
                    setBackgroundTaskStatus(payload.taskId, payload.status);
                    // Inject a visible notification message into the chat so the user
                    // understands why AI continues responding (prevents "AI talking to itself" UX).
                    const description = getBackgroundTaskDescription(payload.taskId);
                    const notificationData = JSON.stringify({
                        taskId: payload.taskId,
                        status: payload.status,
                        summary: payload.summary ?? '',
                        description: description ?? '',
                    });
                    const notificationMsg: Message = {
                        id: `task-notification-${payload.taskId}`,
                        role: 'user',
                        content: `<task-notification>${notificationData}</task-notification>`,
                        timestamp: new Date(),
                    };
                    setHistoryMessages(prev => [...prev, notificationMsg]);
                }
                break;
            }

            // Queue events
            case 'queue:added': {
                // A message was queued — add to frontend queue state for UI rendering.
                // Deduplication: sendMessage's .then() may also add the same queueId,
                // and optimistic entries (opt-*) may already exist from sendMessage.
                const payload = data as { queueId: string; messageText: string } | null;
                if (payload?.queueId) {
                    console.log(`[TabProvider] queue:added queueId=${payload.queueId}`);
                    setQueuedMessages(prev => {
                        // Exact queueId match — already added by .then()
                        if (prev.some(q => q.queueId === payload.queueId)) return prev;
                        // Optimistic entry exists — .then() will reconcile with real queueId
                        if (prev.some(q => q.queueId.startsWith('opt-'))) return prev;
                        return [...prev, {
                            queueId: payload.queueId,
                            text: payload.messageText,
                            timestamp: Date.now(),
                        }];
                    });
                }
                break;
            }

            case 'queue:started': {
                // A queued message started executing:
                // 1. Add user message to chat
                // 2. Remove from frontend queue
                // For mid-turn breaks (midTurnBreak=true): split the streaming message at the
                // injection point so the user message appears at the correct chronological position.
                const payload = data as {
                    queueId: string;
                    midTurnBreak?: boolean;
                    userMessage?: {
                        id: string;
                        role: 'user';
                        content: string;
                        timestamp: string;
                        attachments?: Array<{ id: string; name: string; size: number; mimeType: string; previewUrl?: string; isImage?: boolean }>;
                    };
                } | null;
                if (payload?.queueId) {
                    // Track started IDs to prevent sendMessage .then() from re-adding
                    startedQueueIdsRef.current.add(payload.queueId);
                    console.log(`[TabProvider] queue:started queueId=${payload.queueId} midTurnBreak=${!!payload.midTurnBreak} streaming=${isStreamingRef.current}`);

                    // Build the user message
                    if (payload.userMessage) {
                        const msgId = payload.userMessage.id;
                        if (!seenIdsRef.current.has(msgId)) {
                            seenIdsRef.current.add(msgId);

                            // Merge backend attachments (authoritative path/size) with frontend preview URLs.
                            // Backend savedAttachments have relativePath but no previewUrl;
                            // frontend queuedMessages have the original data URL previews.
                            let attachments = payload.userMessage.attachments;
                            // Look up queued message by real queueId first;
                            // fall back to first opt-* entry when queue:started arrives
                            // before .then() replaces the optimistic ID (known race).
                            const queuedMsg = queuedMessagesRef.current?.find(
                                q => q.queueId === payload.queueId
                            ) ?? queuedMessagesRef.current?.find(
                                q => q.queueId.startsWith('opt-') && q.images?.length
                            );
                            if (attachments?.length && queuedMsg?.images?.length) {
                                // Merge: enrich server attachments with frontend previewUrl
                                attachments = attachments.map(att => {
                                    const match = queuedMsg.images!.find(img => img.name === att.name);
                                    return match?.preview ? { ...att, previewUrl: match.preview } : att;
                                });
                            } else if (!attachments?.length && queuedMsg?.images?.length) {
                                // Fallback: server sent no attachments, use frontend snapshot
                                attachments = queuedMsg.images.map(img => ({
                                    id: img.id,
                                    name: img.name,
                                    size: 0,
                                    mimeType: 'image/png',
                                    previewUrl: img.preview,
                                    isImage: true,
                                }));
                            }

                            const userMsg: Message = {
                                id: msgId,
                                role: 'user' as const,
                                content: payload.userMessage!.content,
                                timestamp: new Date(payload.userMessage!.timestamp),
                                attachments: attachments && attachments.length > 0 ? attachments : undefined,
                            };

                            if (payload.midTurnBreak && isStreamingRef.current) {
                                // Mid-turn break: AI consumed the injected message and started new content.
                                // Split the streaming: snapshot current streaming → history, insert user message.
                                // New streaming events will create a fresh streaming message automatically.
                                rawSetStreamingMessage(prev => {
                                    if (prev) {
                                        setHistoryMessages(prevHistory => [...prevHistory, prev, userMsg]);
                                    } else {
                                        setHistoryMessages(prevHistory => [...prevHistory, userMsg]);
                                    }
                                    streamingMessageRef.current = null;
                                    return null;
                                });
                            } else {
                                // Normal turn start: render immediately
                                setHistoryMessages(prev => [...prev, userMsg]);
                            }
                        }
                    }

                    setQueuedMessages(prev => {
                        const filtered = prev.filter(q => q.queueId !== payload.queueId);
                        // If exact match didn't remove anything, try first optimistic entry (FIFO).
                        // This happens when queue:started fires before .then() replaces opt- with real queueId.
                        if (filtered.length === prev.length) {
                            const optIdx = filtered.findIndex(q => q.queueId.startsWith('opt-'));
                            if (optIdx !== -1) {
                                return [...filtered.slice(0, optIdx), ...filtered.slice(optIdx + 1)];
                            }
                        }
                        return filtered;
                    });

                    // Eagerly clean up: if .then() already ran, the ref entry is stale.
                    // If .then() hasn't run yet, it will find & delete the entry itself.
                    // Either way, schedule removal to prevent unbounded growth.
                    setTimeout(() => startedQueueIdsRef.current.delete(payload.queueId), 5000);
                }
                break;
            }

            case 'queue:cancelled': {
                // A queued message was cancelled — remove from frontend queue
                const payload = data as { queueId: string } | null;
                if (payload?.queueId) {
                    console.log(`[TabProvider] queue:cancelled queueId=${payload.queueId}`);
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== payload.queueId));
                }
                break;
            }

            case 'config:changed': {
                // Admin CLI modified config — notify global ConfigProvider to refresh
                console.log('[TabProvider] config:changed via Admin CLI', data);
                window.dispatchEvent(new CustomEvent('pm-copilot:config-changed', { detail: data }));
                break;
            }

            case 'workspace:files-changed': {
                // File watcher detected workspace file changes — trigger directory tree refresh.
                // This is the authoritative catch-all: covers sub-agent tools, external editors,
                // terminal operations, and any other source of filesystem change.
                setToolCompleteCount(c => c + 1);
                break;
            }

            default: {
                // Log unhandled events for debugging
                if (!eventName.startsWith('chat:')) {
                    console.log(`[TabProvider] Unhandled SSE event: ${eventName}`);
                }
            }
        }
    }, [appendLog, appendUnifiedLog, tabId, moveStreamingToHistory, setStreamingMessage, postJson, clearInteractiveState]);

    // Recovery guard — prevents concurrent recovery from both SSE failed + session-sidecar:restarted
    const recoveryInFlightRef = useRef(false);
    const recoveryAttemptsRef = useRef(0);
    const MAX_RECOVERY_ATTEMPTS = 3;
    // Stable ref for connectSse (avoids circular dependency: recoverSessionSidecar → connectSse → recoverSessionSidecar)
    const connectSseRef = useRef<() => Promise<void>>(() => Promise.resolve());
    // Unmount guard for async recovery
    const isMountedRef = useRef(true);
    useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

    // Recover a dead Session Sidecar: re-ensure + reconnect SSE.
    // Called when SSE retries exhaust OR when Rust health monitor restarts the sidecar.
    const recoverSessionSidecar = useCallback(async () => {
        if (recoveryInFlightRef.current) return; // Deduplicate concurrent calls
        if (sseRef.current?.isConnected()) return; // Already recovered
        if (recoveryAttemptsRef.current >= MAX_RECOVERY_ATTEMPTS) {
            console.error(`[TabProvider ${tabId}] Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) reached, giving up`);
            return;
        }
        const sid = currentSessionIdRef.current;
        if (!sid) return;
        recoveryInFlightRef.current = true;
        recoveryAttemptsRef.current++;
        try {
            console.log(`[TabProvider ${tabId}] Recovering Session Sidecar for ${sid} (attempt ${recoveryAttemptsRef.current}/${MAX_RECOVERY_ATTEMPTS})...`);
            // ensureSessionSidecar includes health check — sidecar is ready when it returns
            await ensureSessionSidecar(sid, agentDir, 'tab', tabId);
            if (!isMountedRef.current) return;
            // Disconnect old SSE and reconnect with fresh port
            if (sseRef.current) {
                await sseRef.current.disconnect();
                sseRef.current = null;
            }
            if (!isMountedRef.current) return;
            await connectSseRef.current();
            if (!isMountedRef.current) return;
            console.log(`[TabProvider ${tabId}] Session Sidecar recovered successfully`);
            recoveryAttemptsRef.current = 0; // Reset on success
        } catch (err) {
            console.error(`[TabProvider ${tabId}] Session Sidecar recovery failed:`, err);
        } finally {
            recoveryInFlightRef.current = false;
        }
    }, [tabId, agentDir]);

    // Connect SSE
    // Uses Session-centric port lookup via currentSessionIdRef
    const connectSse = useCallback(async () => {
        if (sseRef.current?.isConnected()) return;

        const sse = createSseConnection(tabId, currentSessionIdRef);
        sse.setEventHandler(handleSseEvent);
        sse.setStatusHandler((status) => {
            if (status === 'disconnected' || status === 'failed') {
                setIsConnected(false);
                setIsLoading(false);
            }
            // When SSE retries exhaust (failed), trigger sidecar recovery as fallback.
            // Primary recovery is via session-sidecar:restarted event from Rust health monitor,
            // but this catches cases where the monitor hasn't run yet or missed the death.
            if (status === 'failed') {
                console.warn(`[TabProvider ${tabId}] SSE failed — triggering sidecar recovery`);
                void recoverSessionSidecar();
            }
        });
        sseRef.current = sse;

        try {
            await sse.connect();
            setIsConnected(true);
            // Note: Log server URL is set once in App.tsx using global sidecar
            // Tab sidecars should not override it to avoid URL switching issues
        } catch (error) {
            console.error(`[TabProvider ${tabId}] SSE connect failed:`, error);
            throw error;
        }
    }, [tabId, handleSseEvent, recoverSessionSidecar]);
    connectSseRef.current = connectSse;

    // Disconnect SSE
    const disconnectSse = useCallback(() => {
        if (sseRef.current) {
            void sseRef.current.disconnect();
            sseRef.current = null;
            setIsConnected(false);
        }
    }, []);

    // Cleanup on unmount - disconnect SSE and clear pending timers
    // NOTE: Sidecar lifecycle is now managed by App.tsx performCloseTab(),
    // which checks for active cron tasks before stopping.
    // Do NOT call stopTabSidecar here - it would bypass cron task protection.
    useEffect(() => {
        return () => {
            if (sseRef.current) {
                void sseRef.current.disconnect();
                sseRef.current = null;  // Allow garbage collection
            }
            if (stopTimeoutRef.current) {
                clearTimeout(stopTimeoutRef.current);
                stopTimeoutRef.current = null;
            }
            // Sidecar stop is handled by App.tsx performCloseTab()
            // which properly checks for active cron tasks before stopping
        };
    }, [tabId]);

    // Listen for Rust health monitor restarting our Session Sidecar.
    // Mirrors the Global Sidecar pattern (App.tsx global-sidecar:restarted).
    // When Rust detects a dead Session Sidecar and restarts it on a new port,
    // we need to reconnect SSE to the new port.
    useEffect(() => {
        if (!isTauri()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            if (cancelled) return; // Unmounted before listen resolved
            unlisten = await listen<{ sessionId: string; port: number }>('session-sidecar:restarted', (event) => {
                if (cancelled) return; // Stale listener after unmount
                const { sessionId: restartedSid, port } = event.payload;
                if (restartedSid === currentSessionIdRef.current) {
                    console.log(`[TabProvider ${tabId}] Session Sidecar restarted on port ${port}, reconnecting SSE`);
                    void recoverSessionSidecar();
                }
            });
        })();
        return () => { cancelled = true; if (unlisten) unlisten(); };
    }, [tabId, recoverSessionSidecar]);

    // Send message with optional images, permission mode, and model
    // Returns true immediately (optimistic) to clear the input without waiting for HTTP response.
    // The actual API call runs in the background — backend may take time for provider changes,
    // session startup, etc. but the user shouldn't be blocked.
    const sendMessage = useCallback(async (
        text: string,
        images?: ImageAttachment[],
        permissionMode?: PermissionMode,
        model?: string,
        providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses'; modelAliases?: { sonnet?: string; opus?: string; haiku?: string } },
        isCron?: boolean
    ): Promise<boolean> => {
        const trimmed = text.trim();
        if (!trimmed && (!images || images.length === 0)) return false;

        // Detect skill/slash command: /command at start of message (for analytics)
        const skillMatch = trimmed.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)/);
        const skill = skillMatch ? skillMatch[1] : null;
        const hasImages = !!(images && images.length > 0);

        // Reset new session flag BEFORE sending - allow message replay to show user's message
        isNewSessionRef.current = false;

        // Capture user message for auto-title generation (FIFO queue for queued sends)
        if (!autoTitleAttemptedRef.current) {
            pendingUserMessagesRef.current.push(trimmed);
        }
        lastModelRef.current = model;
        lastProviderEnvRef.current = providerEnv ? { baseUrl: providerEnv.baseUrl, apiKey: providerEnv.apiKey, authType: providerEnv.authType, apiProtocol: providerEnv.apiProtocol, maxOutputTokens: providerEnv.maxOutputTokens, maxOutputTokensParamName: providerEnv.maxOutputTokensParamName, upstreamFormat: providerEnv.upstreamFormat, modelAliases: providerEnv.modelAliases } : undefined;

        // Store attachments for merging with SSE replay
        if (hasImages) {
            pendingAttachmentsRef.current = images.map((img) => ({
                id: img.id,
                name: img.file.name,
                size: img.file.size,
                mimeType: img.file.type,
                previewUrl: img.preview,
                isImage: true,
            }));
        }

        // Prepare image data for backend
        const imageData = images?.map((img) => ({
            name: img.file.name,
            mimeType: img.file.type,
            // Extract base64 data from data URL (remove "data:image/xxx;base64," prefix)
            data: img.preview.split(',')[1],
        }));

        // Optimistic queue: immediately show badge when AI is streaming.
        // We don't know the real queueId yet (backend assigns it), so use a local ID.
        // .then() will reconcile: replace opt- with real queueId, or clean up if already started.
        const localQueueId = isStreamingRef.current ? `opt-${crypto.randomUUID()}` : null;
        if (localQueueId) {
            setQueuedMessages(prev => [...prev, {
                queueId: localQueueId,
                text: trimmed,
                images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })),
                timestamp: Date.now(),
            }]);
        }

        // Fire-and-forget: send to backend without blocking the UI.
        // The HTTP response may be delayed by provider changes or session startup,
        // but the input should clear immediately for a responsive experience.
        // Desktop is the ONLY caller that should trigger provider switches per-message.
        // When no providerEnv is given (subscription mode), send 'subscription' explicitly
        // so enqueueUserMessage knows this is an intentional switch, not "I don't know".
        // IM/Cron callers omit the field entirely (undefined = "keep current provider").
        postJson<{ success: boolean; error?: string; queued?: boolean; queueId?: string }>('/chat/send', {
            text: trimmed,
            images: imageData,
            permissionMode: permissionMode ?? 'auto',
            model,
            providerEnv: providerEnv ?? 'subscription',
        }).then((response) => {
            if (response.success) {
                track('message_send', {
                    mode: permissionMode ?? 'auto',
                    model: model ?? 'default',
                    skill,
                    has_image: hasImages,
                    has_file: false,
                    is_cron: isCron ?? false,
                });

                if (response.queued && response.queueId) {
                    const realQueueId = response.queueId;
                    if (startedQueueIdsRef.current.has(realQueueId)) {
                        // Already started (mid-turn injection) — clean up optimistic entry
                        startedQueueIdsRef.current.delete(realQueueId);
                        if (localQueueId) {
                            setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                        }
                    } else if (localQueueId) {
                        // Replace optimistic entry with real queueId + enrich with image data
                        setQueuedMessages(prev => prev.map(q =>
                            q.queueId === localQueueId
                                ? { ...q, queueId: realQueueId, images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })) }
                                : q
                        ));
                    } else {
                        // Non-optimistic path (wasn't streaming when sent)
                        setQueuedMessages(prev => {
                            if (prev.some(q => q.queueId === realQueueId)) {
                                // SSE already added it — enrich with image data if available
                                if (!images?.length) return prev;
                                return prev.map(q => q.queueId === realQueueId
                                    ? { ...q, images: images.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })) }
                                    : q
                                );
                            }
                            return [...prev, {
                                queueId: realQueueId,
                                text: trimmed,
                                images: images?.map(img => ({ id: img.id, name: img.file.name, preview: img.preview })),
                                timestamp: Date.now(),
                            }];
                        });
                    }
                } else if (localQueueId) {
                    // Message wasn't queued (went through immediately) — remove optimistic entry
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                }
            } else {
                // Backend rejected: queue full, validation error, etc.
                console.error(`[TabProvider ${tabId}] Send rejected:`, response.error);
                if (localQueueId) {
                    setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
                }
                setAgentError(response.error ?? '发送失败');
                pendingAttachmentsRef.current = null;
            }
        }).catch((error) => {
            console.error(`[TabProvider ${tabId}] Send message failed:`, error);
            if (localQueueId) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== localQueueId));
            }
            const msg = error instanceof Error ? error.message : '网络错误';
            setAgentError(msg === 'Failed to fetch' ? '网络连接中断，请重试' : msg);
            pendingAttachmentsRef.current = null;
        });

        // Return true immediately — input clears without waiting for HTTP response
        return true;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Stop response with timeout fallback
    const stopResponse = useCallback(async (): Promise<boolean> => {
        // Clear any existing stop timeout
        if (stopTimeoutRef.current) {
            clearTimeout(stopTimeoutRef.current);
            stopTimeoutRef.current = null;
        }

        // Immediately show "stopping" state for instant user feedback
        setSessionState('stopping');

        try {
            const response = await postJson<{ success: boolean; alreadyStopped?: boolean; error?: string }>('/chat/stop');
            if (response.success) {
                // Nothing was active — restore UI immediately, no need to wait for SSE.
                // Also reset isLoading: the backend may have drained orphaned queued messages
                // (queue:cancelled events will clean up queuedMessages), and the UI was stuck
                // with isLoading=true because no chat:message-complete ever arrived.
                if (response.alreadyStopped) {
                    flushSync(() => {
                        isStreamingRef.current = false;
                        setIsLoading(false);
                        setSessionState(prev => prev === 'stopping' ? 'idle' : prev);
                    });
                    return true;
                }
                // 设置 5 秒超时，如果没有收到 SSE 事件确认则强制恢复 UI
                stopTimeoutRef.current = setTimeout(() => {
                    if (isStreamingRef.current) {
                        console.warn(`[TabProvider ${tabId}] Stop timeout - forcing UI recovery`);
                        recoverStreamingUi('stopped');
                    }
                    // Also recover from 'stopping' state if SSE confirmation never arrived
                    setSessionState(prev => prev === 'stopping' ? 'idle' : prev);
                    stopTimeoutRef.current = null;
                }, 5000);
                return true;
            }
            // POST failed (success=false), recover UI
            recoverStreamingUi('stopped');
            return false;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Stop response failed:`, error);
            // 请求失败也强制恢复 UI
            recoverStreamingUi('failed');
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [recoverStreamingUi, tabId]);

    // Load session from history
    // Options:
    // - skipLoadingReset: If true, don't reset isLoading to false. Useful when caller
    //   knows an operation is in progress (e.g., cron task execution) and will manage
    //   the loading state separately.
    //
    // Note: This option is currently available for future use cases but not actively used.
    // Chat.tsx manages loading state through pendingCronLoadingRef pattern instead of
    // calling loadSession directly, to avoid duplicate loadSession calls with TabProvider's
    // session loading effect.
    const loadSession = useCallback(async (
        targetSessionId: string,
        options?: { skipLoadingReset?: boolean }
    ): Promise<boolean> => {
        try {
            console.log(`[TabProvider ${tabId}] Loading session: ${targetSessionId}`);
            isLoadingSessionRef.current = true;
            setIsSessionLoading(true);

            // Check if session is already activated by another Tab or CronTask (Session singleton constraint)
            const activation = await getSessionActivation(targetSessionId);
            if (activation) {
                // Case 1: Session is open in another Tab - jump to that Tab
                if (activation.tab_id && activation.tab_id !== tabId) {
                    console.log(`[TabProvider ${tabId}] Session ${targetSessionId} is already activated by tab ${activation.tab_id}, requesting jump`);
                    window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.JUMP_TO_TAB, {
                        detail: { targetTabId: activation.tab_id, sessionId: targetSessionId }
                    }));
                    isLoadingSessionRef.current = false;
                    setIsSessionLoading(false);
                    return false;
                }

                // Case 2: Session is used by a CronTask without Tab - jump to show cron task UI
                // This happens when cron task is running in background (tab was closed)
                if (activation.is_cron_task && !activation.tab_id) {
                    console.log(`[TabProvider ${tabId}] Session ${targetSessionId} is used by background cron task, will connect to it`);
                    // Don't block - let the session load, Chat.tsx will restore cron task UI
                    // The session switch will update the activation's tab_id
                }
            }

            const response = await apiGetJson<{ success: boolean; session?: { title?: string; titleSource?: string; runtime?: string; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: string; sdkUuid?: string; attachments?: Array<{ id: string; name: string; mimeType: string; path: string; previewUrl?: string }>; metadata?: { source: 'desktop' | 'telegram_private' | 'telegram_group'; sourceId?: string; senderName?: string } }> } }>(`/sessions/${targetSessionId}`);

            if (!response.success || !response.session) {
                // Session not found is not necessarily an error - it may have been deleted
                // or be a newly created empty session. Log as info, not error.
                console.log(`[TabProvider ${tabId}] Session ${targetSessionId} not found in storage (may be deleted or empty)`);
                isLoadingSessionRef.current = false;
                setIsSessionLoading(false);
                return false;
            }

            // Convert session messages to Message format
            const loadedMessages: Message[] = response.session.messages.map((msg) => {
                // Parse content - it may be JSON stringified ContentBlock[] or plain text
                let parsedContent: string | ContentBlock[] = msg.content ?? '';

                // Only try to parse if content is a non-empty string starting with '['
                if (typeof msg.content === 'string' && msg.content.length > 0 && msg.content.startsWith('[') && msg.content.includes('"type"')) {
                    try {
                        parsedContent = JSON.parse(msg.content) as ContentBlock[];
                    } catch {
                        // Keep as string if parse fails
                        parsedContent = msg.content;
                    }
                }

                return {
                    id: msg.id,
                    role: msg.role,
                    content: parsedContent,
                    timestamp: new Date(msg.timestamp),
                    sdkUuid: msg.sdkUuid,
                    attachments: msg.attachments?.map((att: { id: string; name: string; mimeType: string; path: string; previewUrl?: string }) => ({
                        id: att.id,
                        name: att.name,
                        size: 0,
                        mimeType: att.mimeType,
                        savedPath: att.path,
                        relativePath: att.path,
                        previewUrl: att.previewUrl,
                        isImage: att.mimeType.startsWith('image/'),
                    })),
                    metadata: msg.metadata,
                };
            });

            // Reset auto-title state when switching sessions
            // Skip auto-title only if already has an AI-generated or user-renamed title
            autoTitleAttemptedRef.current = response.session.titleSource === 'auto'
                || response.session.titleSource === 'user';
            pendingUserMessagesRef.current = [];
            lastCompletedTextRef.current = '';
            lastProviderEnvRef.current = undefined;
            lastModelRef.current = undefined;

            // Reconstruct completed QA rounds from loaded history so new messages
            // continue the count. A session with 2 loaded rounds + 1 new round = 3 → triggers title.
            if (!autoTitleAttemptedRef.current) {
                const rounds: Array<{ user: string; assistant: string }> = [];
                for (let i = 0; i < loadedMessages.length - 1; i++) {
                    const msg = loadedMessages[i];
                    const next = loadedMessages[i + 1];
                    if (msg.role === 'user' && next.role === 'assistant') {
                        const userText = typeof msg.content === 'string' ? msg.content
                            : msg.content.filter(b => b.type === 'text').map(b => (b as { text?: string }).text || '').join('');
                        // Skip system-injected messages
                        if (userText.includes('<HEARTBEAT>') || userText.includes('<MEMORY_UPDATE>') || userText.startsWith('<system-reminder>')) {
                            i++;
                            continue;
                        }
                        const assistantText = typeof next.content === 'string' ? next.content
                            : next.content.filter(b => b.type === 'text').map(b => (b as { text?: string }).text || '').join('');
                        rounds.push({ user: userText.slice(0, 200), assistant: assistantText.slice(0, 200) });
                        i++; // skip the assistant message
                    }
                }
                titleRoundsRef.current = rounds;
                // If loaded history already has enough rounds, trigger immediately
                if (rounds.length >= AUTO_TITLE_MIN_ROUNDS) {
                    autoTitleAttemptedRef.current = true;
                    const sid = targetSessionId;
                    const model = lastModelRef.current || '';
                    const pEnv = lastProviderEnvRef.current;
                    generateSessionTitle(postJson, sid, [...rounds], model, pEnv)
                        .then(r => {
                            if (r?.success && r.title && currentSessionIdRef.current === sid) {
                                onTitleChangeRef.current?.(r.title);
                                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SESSION_TITLE_CHANGED));
                            }
                        })
                        .catch(() => {});
                }
            } else {
                titleRoundsRef.current = [];
            }

            // Clear current state and load new messages
            seenIdsRef.current.clear();
            isNewSessionRef.current = false; // Allow SSE replays again
            isStreamingRef.current = false;  // Stop any streaming state
            isLoadingSessionRef.current = false;
            setIsSessionLoading(false);
            setHistoryMessages(loadedMessages);
            setStreamingMessage(null);
            setSessionRuntime(response.session.runtime ?? null);
            // Only reset loading state if not explicitly skipped
            // (caller may be managing loading state for an in-progress operation like cron task)
            if (!options?.skipLoadingReset) {
                setIsLoading(false);
                setSessionState('idle');  // Reset session state when loading historical session
            }
            setSystemStatus(null);
            setAgentError(null);
            clearInteractiveState();
            // Update current session ID to reflect the loaded session
            setCurrentSessionId(targetSessionId);

            // Update tab title from session metadata (fixes title not showing after session switch)
            if (response.session.title) {
                onTitleChangeRef.current?.(response.session.title);
            }

            // Notify backend about session switch (fire-and-forget — UI is already updated)
            void postJson('/sessions/switch', { sessionId: targetSessionId });

            console.log(`[TabProvider ${tabId}] Loaded ${loadedMessages.length} messages from session`);
            return true;
        } catch (error) {
            isLoadingSessionRef.current = false;
            setIsSessionLoading(false);
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorStack = error instanceof Error ? error.stack : undefined;
            console.error(`[TabProvider ${tabId}] Load session failed:`, errorMessage);
            if (errorStack) {
                console.error(errorStack);
            }
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- apiGetJson and postJson are stable
    }, [tabId, clearInteractiveState]);

    // Auto-refresh session when a cron task completes and writes data to the session
    // we're currently viewing. This handles the case where a Tab opens a cron session
    // during/after execution on a different Sidecar — the Tab won't get SSE streaming,
    // so we reload from disk when cron:execution-complete fires.
    const loadSessionRef = useRef(loadSession);
    loadSessionRef.current = loadSession;

    useEffect(() => {
        if (!isTauri()) return;

        let unlisten: (() => void) | undefined;

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            unlisten = await listen<{ taskId: string; success: boolean; executionCount: number; internalSessionId?: string }>(
                'cron:execution-complete',
                (event) => {
                    const { internalSessionId } = event.payload;
                    const currentSid = currentSessionIdRef.current;

                    // If this Tab is viewing the cron task's internal session, reload to show AI response
                    if (internalSessionId && currentSid && internalSessionId === currentSid) {
                        console.log(`[TabProvider ${tabId}] Cron execution complete for viewed session ${internalSessionId}, reloading`);
                        loadSessionRef.current(internalSessionId);
                    }
                }
            );
        })();

        return () => {
            unlisten?.();
        };
    }, [tabId]);

    // Track whether initial session has been loaded
    const initialSessionLoadedRef = useRef(false);
    // Track previous sessionId to detect changes (must be before the effect that uses it)
    const prevSessionIdRef = useRef<string | null | undefined>(sessionId);

    // Unified session loading effect - handles both initial load and session changes
    useEffect(() => {
        const prevSessionId = prevSessionIdRef.current;
        prevSessionIdRef.current = sessionId;

        // No sessionId - reset flag and return
        if (!sessionId) {
            initialSessionLoadedRef.current = false;
            return;
        }

        // Not connected yet - wait
        if (!isConnected) {
            return;
        }

        const isPendingSession = isPendingSessionId(sessionId);
        const wasPendingSession = isPendingSessionId(prevSessionId);

        // Case 1: Current sessionId is pending - skip (doesn't exist in backend yet)
        if (isPendingSession) {
            console.log(`[TabProvider ${tabId}] Session is pending (${sessionId}), skipping load`);
            return;
        }

        // Case 2: Upgraded from pending to real session
        // This happens when backend creates the real session after first message (including cron task)
        if (wasPendingSession) {
            // Case 2a: Already have data (normal message flow) - skip
            if (initialSessionLoadedRef.current) {
                console.log(`[TabProvider ${tabId}] SessionId upgraded from pending to ${sessionId}, already in session`);
                return;
            }

            // Case 2b: Session is currently running (e.g., cron task executing) - skip
            // CRITICAL: Do NOT call loadSession while AI is responding, as it would abort the current session!
            // The messages will come through SSE stream naturally.
            // Use isStreamingRef (ref) to get the latest value, avoiding stale closure issues
            if (isStreamingRef.current) {
                console.log(`[TabProvider ${tabId}] SessionId upgraded from pending to ${sessionId}, session is streaming, skipping loadSession`);
                initialSessionLoadedRef.current = true;  // Mark as loaded to prevent future attempts
                return;
            }

            // Case 2c: Switching from an unused pending session to a real session - need to load data
            // This happens when user selects a history session while current tab has unused pending session
            console.log(`[TabProvider ${tabId}] Switching from unused pending to ${sessionId}, loading session`);
            initialSessionLoadedRef.current = true;
            void loadSession(sessionId);
            return;
        }

        // Case 3: Already loaded this session - skip
        if (initialSessionLoadedRef.current && prevSessionId === sessionId) {
            return;
        }

        // Case 4: Need to load session (initial load or session switch)
        // Exception 1: if resetSession was just called (isNewSessionRef=true), the session
        // upgrade (old→new) arrives via system:init. Messages are already streaming via SSE,
        // so calling loadSession would flash isLoading=false. Skip and let SSE handle it.
        if (isNewSessionRef.current) {
            console.log(`[TabProvider ${tabId}] SessionId upgraded to ${sessionId} after resetSession, skipping loadSession (messages arriving via SSE)`);
            initialSessionLoadedRef.current = true;
            return;
        }
        // Exception 2: session is actively streaming (session ID upgrade during first message).
        // This happens when: resetSession → sendMessage (clears isNewSessionRef) → chat:system-init
        // assigns real sessionId → parent re-renders with new prop → useEffect fires.
        // At this point isNewSessionRef is false but the session is actively processing.
        // loadSession would reset isLoading/sessionState, causing stop button to briefly disappear.
        if (isStreamingRef.current) {
            console.log(`[TabProvider ${tabId}] SessionId changed to ${sessionId} while streaming, skipping loadSession`);
            initialSessionLoadedRef.current = true;
            return;
        }
        if (prevSessionId !== sessionId) {
            console.log(`[TabProvider ${tabId}] SessionId changed from ${prevSessionId} to ${sessionId}, loading session`);
        } else {
            console.log(`[TabProvider ${tabId}] Initial session load: ${sessionId}`);
        }
        initialSessionLoadedRef.current = true;
        void loadSession(sessionId);
    }, [sessionId, isConnected, tabId, loadSession]);

    // Cancel a queued message — returns the original text (for restoring to input)
    const cancelQueuedMessage = useCallback(async (queueId: string): Promise<string | null> => {
        try {
            const response = await postJson<{ success: boolean; cancelledText?: string }>('/chat/queue/cancel', { queueId });
            if (response.success) {
                setQueuedMessages(prev => prev.filter(q => q.queueId !== queueId));
                return response.cancelledText ?? null;
            }
            return null;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Cancel queue item failed:`, error);
            return null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Force-execute a queued message (interrupt current + run immediately)
    // Does NOT optimistically remove from queue — queue:started SSE is the single source of truth
    const forceExecuteQueuedMessage = useCallback(async (queueId: string): Promise<boolean> => {
        try {
            const response = await postJson<{ success: boolean }>('/chat/queue/force', { queueId });
            return response.success;
        } catch (error) {
            console.error(`[TabProvider ${tabId}] Force execute queue item failed:`, error);
            return false;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- postJson is stable
    }, [tabId]);

    // Respond to permission request
    const respondPermission = useCallback(async (decision: 'deny' | 'allow_once' | 'always_allow') => {
        if (!pendingPermission) return;

        const requestId = pendingPermission.requestId;
        const toolName = pendingPermission.toolName;
        console.log(`[TabProvider] Permission response: ${decision} for ${toolName}`);

        // Track permission decision
        if (decision === 'deny') {
            track('permission_deny', { tool: toolName });
        } else {
            track('permission_grant', { tool: toolName, type: decision });
        }

        // Clear pending permission immediately for UI responsiveness
        setPendingPermission(null);

        // Send response to backend
        try {
            await postJson('/api/permission/respond', { requestId, decision });
        } catch (error) {
            console.error('[TabProvider] Failed to send permission response:', error);
        }
    }, [pendingPermission, postJson]);

    // Respond to AskUserQuestion request
    const respondAskUserQuestion = useCallback(async (answers: Record<string, string> | null) => {
        if (!pendingAskUserQuestion) return;

        const requestId = pendingAskUserQuestion.requestId;
        console.log(`[TabProvider] AskUserQuestion response: ${answers ? 'submitted' : 'cancelled'}`);

        // Clear pending question immediately for UI responsiveness
        setPendingAskUserQuestion(null);

        // Send response to backend
        try {
            await postJson('/api/ask-user-question/respond', { requestId, answers });
        } catch (error) {
            console.error('[TabProvider] Failed to send AskUserQuestion response:', error);
        }
    }, [pendingAskUserQuestion, postJson]);

    // Respond to ExitPlanMode request (keep card visible with resolved status)
    const respondExitPlanMode = useCallback(async (approved: boolean) => {
        if (!pendingExitPlanMode) return;
        const requestId = pendingExitPlanMode.requestId;
        setPendingExitPlanMode(prev => prev ? { ...prev, resolved: approved ? 'approved' : 'rejected' } : null);
        try {
            await postJson('/api/exit-plan-mode/respond', { requestId, approved });
        } catch (error) {
            console.error('[TabProvider] Failed to send ExitPlanMode response:', error);
        }
    }, [pendingExitPlanMode, postJson]);

    // Context value - use currentSessionId (which tracks the actually loaded session)
    const contextValue: TabContextValue = useMemo(() => ({
        tabId,
        agentDir,
        sessionId: currentSessionId,
        messages,
        historyMessages,
        streamingMessage,
        isLoading,
        isSessionLoading,
        sessionState,
        sessionRuntime,
        logs,
        unifiedLogs,
        systemInitInfo,
        agentError,
        systemStatus,
        pendingPermission,
        pendingAskUserQuestion,
        pendingExitPlanMode,
        pendingEnterPlanMode,
        toolCompleteCount,
        queuedMessages,
        isConnected,
        setMessages,
        setIsLoading,
        setSessionState,
        appendLog,
        appendUnifiedLog,
        clearUnifiedLogs,
        setSystemInitInfo,
        setAgentError,
        connectSse,
        disconnectSse,
        sendMessage,
        stopResponse,
        loadSession,
        resetSession,
        // Tab-scoped API functions
        apiGet: apiGetJson,
        apiPost: postJson,
        apiPut: apiPutJson,
        apiDelete: apiDeleteJson,
        respondPermission,
        respondAskUserQuestion,
        respondExitPlanMode,
        cancelQueuedMessage,
        forceExecuteQueuedMessage,
        // Cron task exit handler ref (mutable, no need in deps)
        onCronTaskExitRequested: onCronTaskExitRequestedRef,
    }), [
        tabId, agentDir, currentSessionId, messages, historyMessages, streamingMessage, isLoading, isSessionLoading, sessionState, sessionRuntime,
        logs, unifiedLogs, systemInitInfo, agentError, systemStatus, pendingPermission, pendingAskUserQuestion, pendingExitPlanMode, pendingEnterPlanMode, toolCompleteCount, queuedMessages, isConnected,
        setMessages, appendLog, appendUnifiedLog, clearUnifiedLogs, connectSse, disconnectSse, sendMessage, stopResponse, loadSession, resetSession,
        apiGetJson, postJson, apiPutJson, apiDeleteJson, respondPermission, respondAskUserQuestion, respondExitPlanMode, cancelQueuedMessage, forceExecuteQueuedMessage
    ]);

    // Lightweight API-only context value — deps are all stable (created once per tabId),
    // so this never rebuilds during streaming, protecting 11+ consumer components.
    const apiContextValue: TabApiContextValue = useMemo(() => ({
        tabId,
        agentDir,
        apiGet: apiGetJson,
        apiPost: postJson,
        apiPut: apiPutJson,
        apiDelete: apiDeleteJson,
    }), [tabId, agentDir, apiGetJson, postJson, apiPutJson, apiDeleteJson]);

    const isActiveValue = isActive ?? false;

    return (
        <TabActiveContext.Provider value={isActiveValue}>
            <TabApiContext.Provider value={apiContextValue}>
                <TabContext.Provider value={contextValue}>
                    {children}
                </TabContext.Provider>
            </TabApiContext.Provider>
        </TabActiveContext.Provider>
    );
}
