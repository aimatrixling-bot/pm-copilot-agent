/**
 * TabContext - React Context for per-Tab state isolation
 * 
 * Each Tab gets its own TabProvider which manages:
 * - Message history
 * - Loading state
 * - Session state
 * - Agent logs
 * - System init info
 * - SSE connection
 */

import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { ImageAttachment } from '@/components/SimpleChatInput';
import type { Message } from '@/types/chat';
import type { LogEntry } from '@/types/log';
import type { QueuedMessageInfo } from '@/types/queue';
import type { SystemInitInfo } from '../../shared/types/system';
import type { PermissionMode } from '@/config/types';
import type { PermissionRequest } from '@/components/PermissionPrompt';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest, EnterPlanModeRequest } from '../../shared/types/planMode';

export type SessionState = 'idle' | 'running' | 'stopping' | 'error';

/**
 * Tab state - all the state that belongs to a single Tab
 */
export interface TabState {
    tabId: string;
    agentDir: string;
    sessionId: string | null;

    // Chat state
    messages: Message[];           // Combined view (history + streaming) for backward compat
    historyMessages: Message[];    // Immutable during streaming — zero re-render for history
    streamingMessage: Message | null;  // Only this updates during streaming
    isLoading: boolean;
    isSessionLoading: boolean;  // true while loadSession REST API is in-flight
    sessionState: SessionState;
    sessionRuntime: string | null;  // Runtime that created this session (null = builtin)

    // Agent info
    logs: string[];
    unifiedLogs: LogEntry[];
    systemInitInfo: SystemInitInfo | null;
    agentError: string | null;
    systemStatus: string | null;  // SDK system status (e.g., 'compacting')

    // Permission prompt state
    pendingPermission: PermissionRequest | null;

    // AskUserQuestion prompt state
    pendingAskUserQuestion: AskUserQuestionRequest | null;

    // PlanMode prompt states
    pendingExitPlanMode: ExitPlanModeRequest | null;
    pendingEnterPlanMode: EnterPlanModeRequest | null;

    // File operation tool completion counter (triggers workspace refresh)
    toolCompleteCount: number;

    // Message queue state (messages waiting to be processed while AI is responding)
    queuedMessages: QueuedMessageInfo[];
}

/**
 * Tab context value - state + actions
 */
export interface TabContextValue extends TabState {
    // Message management
    setMessages: Dispatch<SetStateAction<Message[]>>;
    // NOTE: clearMessages() was removed from public API
    // Use resetSession() instead to ensure frontend/backend stay in sync

    // Loading state
    setIsLoading: Dispatch<SetStateAction<boolean>>;

    // Session state
    setSessionState: Dispatch<SetStateAction<SessionState>>;

    // Logs
    appendLog: (line: string) => void;
    appendUnifiedLog: (entry: LogEntry) => void;
    clearUnifiedLogs: () => void;

    // System info
    setSystemInitInfo: Dispatch<SetStateAction<SystemInitInfo | null>>;

    // Agent error
    setAgentError: Dispatch<SetStateAction<string | null>>;

    // SSE connection management
    isConnected: boolean;
    connectSse: () => Promise<void>;
    disconnectSse: () => void;

    // Chat actions
    sendMessage: (text: string, images?: ImageAttachment[], permissionMode?: PermissionMode, model?: string, providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' }, isCron?: boolean) => Promise<boolean>;
    stopResponse: () => Promise<boolean>;
    loadSession: (sessionId: string, options?: { skipLoadingReset?: boolean }) => Promise<boolean>;
    resetSession: () => Promise<boolean>;

    // Tab-scoped API functions (use this Tab's Sidecar)
    apiGet: <T>(path: string) => Promise<T>;
    apiPost: <T>(path: string, body?: unknown) => Promise<T>;
    apiPut: <T>(path: string, body?: unknown) => Promise<T>;
    apiDelete: <T>(path: string) => Promise<T>;

    // Permission handling
    respondPermission: (decision: 'deny' | 'allow_once' | 'always_allow') => Promise<void>;

    // AskUserQuestion handling
    respondAskUserQuestion: (answers: Record<string, string> | null) => Promise<void>;

    // PlanMode handling
    respondExitPlanMode: (approved: boolean) => Promise<void>;

    // Queue actions
    cancelQueuedMessage: (queueId: string) => Promise<string | null>;
    forceExecuteQueuedMessage: (queueId: string) => Promise<boolean>;

    // Cron task exit event handler (set by useCronTask hook)
    onCronTaskExitRequested: React.MutableRefObject<((taskId: string, reason: string) => void) | null>;
}

/**
 * Default context value (should never be used - TabProvider required)
 */
const defaultContextValue: TabContextValue = {
    tabId: '',
    agentDir: '',
    sessionId: null,
    messages: [],
    historyMessages: [],
    streamingMessage: null,
    isLoading: false,
    isSessionLoading: false,
    sessionState: 'idle',
    sessionRuntime: null,
    logs: [],
    unifiedLogs: [],
    systemInitInfo: null,
    agentError: null,
    systemStatus: null,
    pendingPermission: null,
    pendingAskUserQuestion: null,
    pendingExitPlanMode: null,
    pendingEnterPlanMode: null,
    toolCompleteCount: 0,
    queuedMessages: [],
    isConnected: false,
    setMessages: () => { },
    setIsLoading: () => { },
    setSessionState: () => { },
    appendLog: () => { },
    appendUnifiedLog: () => { },
    clearUnifiedLogs: () => { },
    setSystemInitInfo: () => { },
    setAgentError: () => { },
    connectSse: async () => { },
    disconnectSse: () => { },
    sendMessage: async () => false,
    stopResponse: async () => false,
    loadSession: async () => false,
    resetSession: async () => false,
    apiGet: async () => { throw new Error('Not in TabProvider'); },
    apiPost: async () => { throw new Error('Not in TabProvider'); },
    apiPut: async () => { throw new Error('Not in TabProvider'); },
    apiDelete: async () => { throw new Error('Not in TabProvider'); },
    respondPermission: async () => { },
    respondAskUserQuestion: async () => { },
    respondExitPlanMode: async () => { },
    cancelQueuedMessage: async () => null,
    forceExecuteQueuedMessage: async () => false,
    onCronTaskExitRequested: { current: null },
};

/**
 * TabContext - must be used within a TabProvider
 */
export const TabContext = createContext<TabContextValue>(defaultContextValue);

// ─── TabApiContext (lightweight, stable during streaming) ───

/**
 * Lightweight context containing only tabId, agentDir, and API functions.
 * This context does NOT include `messages` or other frequently-changing state,
 * so consumers subscribed to it won't re-render on every SSE chunk.
 */
export interface TabApiContextValue {
    tabId: string;
    agentDir: string;
    apiGet: <T>(path: string) => Promise<T>;
    apiPost: <T>(path: string, body?: unknown) => Promise<T>;
    apiPut: <T>(path: string, body?: unknown) => Promise<T>;
    apiDelete: <T>(path: string) => Promise<T>;
}

const defaultApiContextValue: TabApiContextValue = {
    tabId: '',
    agentDir: '',
    apiGet: async () => { throw new Error('Not in TabProvider'); },
    apiPost: async () => { throw new Error('Not in TabProvider'); },
    apiPut: async () => { throw new Error('Not in TabProvider'); },
    apiDelete: async () => { throw new Error('Not in TabProvider'); },
};

export const TabApiContext = createContext<TabApiContextValue>(defaultApiContextValue);

// ─── TabActiveContext (isolated from main context to prevent re-render cascade) ───

/**
 * Separate context for Tab active state.
 * isActive changes on every Tab switch. If it were in the main TabContext,
 * switching tabs would rebuild the entire context object and force ALL
 * useTabState() consumers (Chat, MessageList, SimpleChatInput…) to re-render.
 * Isolating it means only useTabActive() subscribers re-render on tab switch.
 */
export const TabActiveContext = createContext<boolean>(false);

// ─── Hooks ───

/**
 * Hook to access Tab state - throws if used outside TabProvider
 */
export function useTabState(): TabContextValue {
    const context = useContext(TabContext);
    if (!context.tabId) {
        throw new Error('useTabState must be used within a TabProvider');
    }
    return context;
}

/**
 * Hook to check if inside a TabProvider (safe version)
 *
 * Returns the TabContext value if inside a TabProvider, null otherwise.
 * Use this in components that may or may not be rendered within a Tab context.
 */
export function useTabStateOptional(): TabContextValue | null {
    const context = useContext(TabContext);
    return context.tabId ? context : null;
}

/**
 * Hook to access only Tab API functions (lightweight, stable during streaming).
 * Use this in components that only need tabId + API functions to avoid
 * unnecessary re-renders when messages/loading state changes.
 * Throws if used outside TabProvider.
 */
export function useTabApi(): TabApiContextValue {
    const context = useContext(TabApiContext);
    if (!context.tabId) {
        throw new Error('useTabApi must be used within a TabProvider');
    }
    return context;
}

/**
 * Safe version of useTabApi - returns null if outside TabProvider.
 * Use this in components that may or may not be rendered within a Tab context.
 */
export function useTabApiOptional(): TabApiContextValue | null {
    const context = useContext(TabApiContext);
    return context.tabId ? context : null;
}

/**
 * Hook to access Tab active state (whether this Tab is currently visible).
 * Isolated from main context so Tab switches don't trigger re-renders
 * in all useTabState() consumers.
 */
export function useTabActive(): boolean {
    return useContext(TabActiveContext);
}
