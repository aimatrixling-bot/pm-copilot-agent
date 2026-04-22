import { randomUUID } from 'crypto';
import type { RuntimeType } from '../../shared/types/runtime';

/**
 * Session statistics for tracking usage
 */
export interface SessionStats {
    messageCount: number;        // Number of user messages (queries)
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

/**
 * Session metadata stored in sessions.json
 */
export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    /** @deprecated 统一后新 session 的 sdkSessionId === id，保留用于旧 session 兼容 */
    sdkSessionId?: string;
    /** 统一后创建的 session 标记。为 true 时 id 即 SDK session ID */
    unifiedSession?: boolean;
    /** Session statistics */
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
    /** Session origin — undefined or 'desktop' for Desktop, IM sources for Telegram */
    source?: 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';
    /** Preview of the last user message (truncated, for Task Center display) */
    lastMessagePreview?: string;
    /** How the title was set: default (first message truncation), auto (AI-generated), user (manually renamed) */
    titleSource?: 'default' | 'auto' | 'user';
    /** Fork source info — consumed on first session startup, then cleared */
    forkFrom?: {
        sourceSessionId: string;  // Source session's SDK session ID (for resume)
        messageUuid: string;      // Fork point: assistant message's sdkUuid (for resumeSessionAt)
    };
    /** Which runtime created this session. Absent = 'builtin' (backward compatible) */
    runtime?: RuntimeType;
    /** Runtime's own session/thread ID (Codex: threadId, CC: session_id from hook).
     *  Different from our session `id` — used for resume across Sidecar restarts. */
    runtimeSessionId?: string;
}

/**
 * Full session data including messages
 */
export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

/**
 * Attachment info for messages
 */
export interface MessageAttachment {
    id: string;
    name: string;
    mimeType: string;
    path: string; // Relative path in attachments directory
}

/**
 * Per-model usage breakdown
 */
export interface ModelUsageEntry {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

/**
 * Usage information for assistant messages
 */
export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    /** Primary model (for backwards compatibility and simple display) */
    model?: string;
    /** Per-model breakdown (for detailed statistics) */
    modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * Message source metadata (IM integration)
 */
export interface MessageSourceMetadata {
    source: 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';
    sourceId?: string;
    senderName?: string;
}

/**
 * Simplified message format for storage
 */
export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sdkUuid?: string;  // SDK 分配的 UUID，用于 resumeSessionAt / rewindFiles
    attachments?: MessageAttachment[];
    /** Usage info (only for assistant messages) */
    usage?: MessageUsage;
    /** Tool call count in this response */
    toolCount?: number;
    /** Response duration in milliseconds */
    durationMs?: number;
    /** Message source metadata (IM integration) */
    metadata?: MessageSourceMetadata;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate session title from first user message
 */
export function generateSessionTitle(message: string): string {
    const maxLength = 20;
    const trimmed = message.trim();
    if (!trimmed) {
        return 'New Chat';
    }
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return trimmed.slice(0, maxLength) + '...';
}

/**
 * Create a new session metadata object
 */
export function createSessionMetadata(agentDir: string): SessionMetadata {
    const now = new Date().toISOString();
    return {
        id: randomUUID(),
        agentDir,
        title: 'New Chat',
        createdAt: now,
        lastActiveAt: now,
        unifiedSession: true,
    };
}
