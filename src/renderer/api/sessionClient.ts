/**
 * Frontend API client for Session management
 */

import { apiFetch, apiGetJson, apiPostJson } from './apiFetch';

export interface SessionStats {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    model?: string;
}

export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
    /** Session origin — undefined or 'desktop' for Desktop, IM sources for Telegram/Feishu */
    source?: 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';
    /** Preview of the last user message (truncated, for Task Center display) */
    lastMessagePreview?: string;
    /** How the title was set: default (first message truncation), auto (AI-generated), user (manually renamed) */
    titleSource?: 'default' | 'auto' | 'user';
}

export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    usage?: MessageUsage;
    toolCount?: number;
    durationMs?: number;
}

export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

export interface SessionDetailedStats {
    summary: SessionStats;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
    }>;
    messageDetails: Array<{
        userQuery: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        toolCount?: number;
        durationMs?: number;
    }>;
}

/**
 * Get all sessions, optionally filtered by agentDir
 */
export async function getSessions(agentDir?: string): Promise<SessionMetadata[]> {
    const endpoint = agentDir
        ? `/sessions?agentDir=${encodeURIComponent(agentDir)}`
        : '/sessions';
    const result = await apiGetJson<{ success: boolean; sessions: SessionMetadata[] }>(endpoint);
    return result.sessions ?? [];
}

/**
 * Create a new session
 */
export async function createSession(agentDir: string): Promise<SessionMetadata> {
    const result = await apiPostJson<{ success: boolean; session: SessionMetadata }>(
        '/sessions',
        { agentDir }
    );
    return result.session;
}

/**
 * Get session details with messages
 */
export async function getSessionDetails(sessionId: string): Promise<SessionData | null> {
    try {
        const result = await apiGetJson<{ success: boolean; session: SessionData }>(
            `/sessions/${sessionId}`
        );
        return result.session ?? null;
    } catch {
        return null;
    }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
    try {
        await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Update session metadata
 */
export async function updateSession(
    sessionId: string,
    updates: { title?: string; titleSource?: 'default' | 'auto' | 'user' }
): Promise<SessionMetadata | null> {
    try {
        const result = await apiFetch(`/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates),
        });
        const data = await result.json() as { success: boolean; session: SessionMetadata };
        return data.session ?? null;
    } catch {
        return null;
    }
}

/**
 * Get detailed session statistics
 */
export async function getSessionStats(sessionId: string): Promise<SessionDetailedStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: SessionDetailedStats }>(
            `/sessions/${sessionId}/stats`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}

export interface TitleRound {
    user: string;
    assistant: string;
}

/**
 * Generate a short AI-powered session title from multiple QA rounds.
 * Triggered after 3+ rounds to ensure enough context for an accurate title.
 * MUST use tab-scoped API (postJson) since session metadata lives on the Tab Sidecar.
 * Using global apiPostJson would send the request to the Global Sidecar which returns 404.
 */
export async function generateSessionTitle(
    postJson: <T>(path: string, body?: unknown) => Promise<T>,
    sessionId: string,
    rounds: TitleRound[],
    model: string,
    providerEnv?: { baseUrl?: string; apiKey?: string; authType?: string; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' },
): Promise<{ success: boolean; title?: string }> {
    try {
        return await postJson<{ success: boolean; title?: string }>(
            '/api/generate-session-title',
            { sessionId, rounds, model, providerEnv },
        );
    } catch {
        return { success: false };
    }
}

// ============= Global Stats =============

export interface GlobalStats {
    summary: {
        totalSessions: number;
        messageCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheReadTokens: number;
        totalCacheCreationTokens: number;
    };
    daily: Array<{
        date: string;
        inputTokens: number;
        outputTokens: number;
        messageCount: number;
    }>;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
    }>;
}

/**
 * Get global token usage statistics
 */
export async function getGlobalStats(range: '7d' | '30d' | '60d'): Promise<GlobalStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: GlobalStats }>(
            `/api/global-stats?range=${range}`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}
