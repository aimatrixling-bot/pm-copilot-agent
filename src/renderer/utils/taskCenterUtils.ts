/**
 * Shared utilities for Task Center components
 * (RecentTasks, TaskCenterOverlay, CronTaskDetailPanel, SessionHistoryDropdown)
 */

import type { SessionMetadata } from '@/api/sessionClient';
import { findPromotedPlugin } from '@/components/ImSettings/promotedPlugins';

const PREVIEW_MAX_LENGTH = 35;

/**
 * Extract folder name from path (cross-platform)
 * Returns 'Workspace' for empty/invalid paths
 */
export function getFolderName(path: string): string {
    if (!path) return 'Workspace';
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || 'Workspace';
}

/**
 * Format ISO timestamp as relative time (zh-CN)
 */
export function formatTime(isoString: string): string {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return '昨天';
    } else if (diffDays < 7) {
        return `${diffDays}天前`;
    } else {
        return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
}

/**
 * Check if session source indicates IM bot origin
 */
export function isImSource(source: SessionMetadata['source']): boolean {
    if (!source) return false;
    // Built-in IM platforms + OpenClaw channels all use "<platform>_private" / "<platform>_group"
    return (source.endsWith('_private') || source.endsWith('_group')) && source !== 'desktop';
}

/**
 * Get truncated display text for a session (35 chars max).
 * AI-generated or user-set titles take priority over message previews.
 */
export function getSessionDisplayText(session: SessionMetadata): string {
    // AI/user titles are semantic — prefer them
    if (session.titleSource === 'auto' || session.titleSource === 'user') {
        const raw = session.title || '';
        return raw.length <= PREVIEW_MAX_LENGTH ? raw : raw.slice(0, PREVIEW_MAX_LENGTH) + '...';
    }
    // Fallback: message preview > default title
    const raw = session.lastMessagePreview || session.title;
    if (raw.length <= PREVIEW_MAX_LENGTH) return raw;
    return raw.slice(0, PREVIEW_MAX_LENGTH) + '...';
}

/**
 * Extract platform display name from a session key.
 * Handles both legacy (`im:{platform}:{type}:{id}`) and
 * new agent format (`agent:{agentId}:{channelType}:{sourceType}:{id}`).
 */
/**
 * Resolve any platform/plugin ID to a concise tag label.
 * Lookup chain: built-in names → promoted plugin (by pluginId or channelBrand) → capitalize.
 */
function resolveTagLabel(id: string): string {
    if (BUILTIN_PLATFORM_NAMES[id]) return BUILTIN_PLATFORM_NAMES[id];
    const promoted = findPromotedPlugin(id); // matches pluginId OR channelBrand
    if (promoted) return promoted.name;
    return id.charAt(0).toUpperCase() + id.slice(1);
}

export function extractPlatformDisplay(sessionKey: string): string {
    const parts = sessionKey.split(':');
    // New agent format: agent:{agentId}:{channelType}:{private|group}:{id}
    // channelType may contain colons (e.g. "openclaw:wecom") which split into multiple parts
    if (parts[0] === 'agent' && parts.length >= 5) {
        const channelType = parts[2] ?? 'unknown';
        if (channelType.startsWith('openclaw:')) {
            return resolveTagLabel(channelType.slice('openclaw:'.length));
        }
        if (channelType === 'openclaw' && parts[3]) {
            return resolveTagLabel(parts[3]);
        }
        return resolveTagLabel(channelType);
    }
    // Legacy format: im:{platform}:{type}:{id}
    const platform = parts[1] ?? 'unknown';
    if (platform === 'openclaw' && parts[2]) {
        return resolveTagLabel(parts[2]);
    }
    return resolveTagLabel(platform);
}

/**
 * Get a concise display label for a channel type (e.g., "飞书", "Telegram", "钉钉").
 * Handles both plain types ("telegram") and openclaw prefixed ("openclaw:openclaw-lark").
 */
export function getChannelTypeLabel(channelType: string): string {
    if (channelType.startsWith('openclaw:')) {
        return resolveTagLabel(channelType.slice(9));
    }
    return resolveTagLabel(channelType);
}

/**
 * Built-in platform display names (non-OpenClaw).
 * OpenClaw plugins are resolved via findPromotedPlugin() + getPromotedTagLabel() —
 * no need to maintain a separate dict. Adding a new promoted plugin in
 * promotedPlugins.ts (with channelBrand + tagLabel) makes all display paths work.
 */
const BUILTIN_PLATFORM_NAMES: Record<string, string> = {
    telegram: 'Telegram',
    feishu: '飞书',
    dingtalk: '钉钉',
};

/**
 * Format message count suffix (e.g., "3 条消息")
 */
export function formatMessageCount(session: SessionMetadata): string | null {
    const count = session.stats?.messageCount;
    if (!count || count <= 0) return null;
    return `${count} 条消息`;
}
