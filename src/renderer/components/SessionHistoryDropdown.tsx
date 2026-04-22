import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BarChart2, Clock, Download, Trash2 } from 'lucide-react';

import { deleteSession, getSessionDetails, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { deactivateSession } from '@/api/tauriClient';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { getWorkspaceCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { formatTokens } from '@/utils/formatTokens';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import type { SessionTag } from '@/hooks/useTaskCenterData';

import SessionStatsModal from './SessionStatsModal';
import SessionTagBadge from './SessionTagBadge';
import Tip from './Tip';
import { useToast } from './Toast';

interface SessionHistoryDropdownProps {
    agentDir: string;
    currentSessionId: string | null;
    onSelectSession: (sessionId: string) => void;
    /** Called when the current session is deleted - should reset to "new conversation" state */
    onDeleteCurrentSession: () => void;
    isOpen: boolean;
    onClose: () => void;
}

// Track fetch state: null = not fetched, empty array = fetched but empty
type FetchState = SessionMetadata[] | null;
type CronTaskFetchState = CronTask[] | null;

export default function SessionHistoryDropdown({
    agentDir,
    currentSessionId,
    onSelectSession,
    onDeleteCurrentSession,
    isOpen,
    onClose,
}: SessionHistoryDropdownProps) {
    const toast = useToast();
    const [sessions, setSessions] = useState<FetchState>(null);
    const [cronTasks, setCronTasks] = useState<CronTaskFetchState>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    // Track pending delete to show confirmation UI
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
    // Track delete error for user feedback
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const dropdownRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    const statsSessionRef = useRef(statsSession);

    // Agent statuses for active session tagging
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);

    // Compute session tags map (same logic as useTaskCenterData)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();
        if (!sessions) return map;

        // Build IM session map from agent channel statuses
        const imSessionPlatformMap = new Map<string, string>();
        for (const agentStatus of Object.values(agentStatuses)) {
            for (const channel of agentStatus.channels) {
                if (channel.status !== 'online' && channel.status !== 'connecting') continue;
                for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                    imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
                }
            }
        }

        // Build running cron task session set (use internalSessionId when available)
        const cronSessionIds = new Set(
            (cronTasks ?? []).filter(t => t.status === 'running').map(t => t.internalSessionId || t.sessionId)
        );

        // Build background session set
        const bgSessionIds = new Set(backgroundSessionIds);

        // Assign tags to each session
        for (const session of sessions) {
            const tags: SessionTag[] = [];
            const imPlatform = imSessionPlatformMap.get(session.id);
            if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
            if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
            if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
            if (tags.length > 0) map.set(session.id, tags);
        }

        return map;
    }, [sessions, cronTasks, backgroundSessionIds, agentStatuses]);

    // Sorted sessions: tagged first, then by lastActiveAt descending within each group
    const sortedSessions = useMemo(() => {
        if (!sessions) return [];
        return [...sessions].sort((a, b) => {
            const aHasTag = sessionTagsMap.has(a.id);
            const bHasTag = sessionTagsMap.has(b.id);
            if (aHasTag !== bHasTag) return aHasTag ? -1 : 1;
            return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
        });
    }, [sessions, sessionTagsMap]);

    // Keep refs updated via effect (not during render)
    useEffect(() => {
        onCloseRef.current = onClose;
        statsSessionRef.current = statsSession;
    }, [onClose, statsSession]);

    // Load sessions and cron tasks when opened
    useEffect(() => {
        if (!isOpen || !agentDir) return;

        let cancelled = false;

        (async () => {
            // Load sessions, cron tasks, agent statuses, and background sessions in parallel
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => ({} as AgentStatusMap))
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsResult, cronTasksResult, agentStatusResult, bgSessionsResult] = await Promise.allSettled([
                getSessions(agentDir),
                getWorkspaceCronTasks(agentDir),
                agentStatusPromise,
                getBackgroundSessions().catch(() => [] as string[]),
            ]);

            if (cancelled) return;

            // Always set sessions if available (primary data)
            if (sessionsResult.status === 'fulfilled') {
                setSessions(sessionsResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load sessions:', sessionsResult.reason);
                setSessions([]); // Show empty state rather than loading forever
            }

            // Cron tasks are optional enhancement - don't block on failure
            if (cronTasksResult.status === 'fulfilled') {
                setCronTasks(cronTasksResult.value);
            } else {
                console.error('[SessionHistoryDropdown] Failed to load cron tasks:', cronTasksResult.reason);
                setCronTasks([]); // Fall back to no cron task indicators
            }

            // Agent statuses
            if (agentStatusResult.status === 'fulfilled') {
                setAgentStatuses(agentStatusResult.value);
            }

            // Background sessions
            if (bgSessionsResult.status === 'fulfilled') {
                setBackgroundSessionIds(bgSessionsResult.value);
            }
        })();

        return () => {
            cancelled = true;
            // Reset state when closing or agentDir changes
            setSessions(null);
            setCronTasks(null);
            setAgentStatuses({});
            setBackgroundSessionIds([]);
            setStatsSession(null);
            setPendingDeleteId(null);
            setDeleteError(null);
        };
    }, [isOpen, agentDir]);

    // Refetch when session title changes (auto-generated or user rename)
    useEffect(() => {
        if (!isOpen || !agentDir) return;
        const handler = () => {
            getSessions(agentDir).then(data => setSessions(data)).catch(() => {});
        };
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [isOpen, agentDir]);

    // Real-time tag updates: listen for cron/IM/agent status changes while dropdown is open
    useEffect(() => {
        if (!isOpen || !isTauriEnvironment()) return;

        let mounted = true;
        const unlisteners: (() => void)[] = [];

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            if (!mounted) return;

            // Cron task start/stop → refresh cron tasks (affects delete protection)
            const refreshCron = () => {
                getWorkspaceCronTasks(agentDir).then(tasks => { if (mounted) setCronTasks(tasks); }).catch(() => {});
            };
            const u1 = await listen('cron:task-started', refreshCron);
            const u2 = await listen('cron:task-stopped', refreshCron);
            unlisteners.push(u1, u2);

            // Agent status changes → refresh statuses
            const refreshStatuses = () => {
                import('@tauri-apps/api/core').then(({ invoke }) => {
                    invoke<AgentStatusMap>('cmd_all_agents_status')
                        .then(s => { if (mounted) setAgentStatuses(s); }).catch(() => {});
                }).catch(() => {});
            };
            const u3 = await listen('agent:status-changed', refreshStatuses);
            unlisteners.push(u3);

            // Background completion → refresh background sessions
            const u5 = await listen('session:background-complete', () => {
                getBackgroundSessions().then(ids => { if (mounted) setBackgroundSessionIds(ids); }).catch(() => {});
            });
            unlisteners.push(u5);
        })();

        return () => {
            mounted = false;
            unlisteners.forEach(fn => fn());
        };
    }, [isOpen, agentDir]);

    // Close on outside click (using stable ref to avoid re-attaching listener)
    useEffect(() => {
        if (!isOpen) return;

        const handleClickOutside = (e: MouseEvent) => {
            // Don't close dropdown when stats modal is open - modal handles its own close
            if (statsSessionRef.current) return;
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                onCloseRef.current();
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        e.preventDefault();
        setDeleteError(null); // Clear any previous error
        setPendingDeleteId(sessionId);
    };

    const handleConfirmDelete = async () => {
        if (!pendingDeleteId) return;
        const sessionId = pendingDeleteId;
        const isDeletingCurrentSession = sessionId === currentSessionId;
        setPendingDeleteId(null);
        setDeleteError(null);

        try {
            const success = await deleteSession(sessionId);
            if (success) {
                // Clean up Rust layer session activation state
                // This prevents stale entries in session_activations HashMap
                await deactivateSession(sessionId);

                setSessions((prev) => prev?.filter((s) => s.id !== sessionId) ?? null);

                // If we deleted the current session, trigger "new conversation" behavior
                // Don't close the dropdown - keep it open so user can continue browsing history
                if (isDeletingCurrentSession) {
                    onDeleteCurrentSession(); // Reset to new conversation state
                }
            } else {
                setDeleteError('删除失败，请重试');
                console.error(`[SessionHistoryDropdown] Failed to delete session ${sessionId}`);
            }
        } catch (error) {
            setDeleteError('删除失败，请重试');
            console.error(`[SessionHistoryDropdown] Error deleting session ${sessionId}:`, error);
        }
    };

    const handleCancelDelete = () => {
        setPendingDeleteId(null);
    };

    const handleShowStats = (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: session.title });
    };

    // Export session as .md file
    const [exportingId, setExportingId] = useState<string | null>(null);

    /** Extract text content from assistant message (stored as JSON array of content blocks) */
    const extractAssistantText = (content: string): string => {
        try {
            const blocks = JSON.parse(content);
            if (!Array.isArray(blocks)) return content;
            return blocks
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join('\n\n');
        } catch {
            // Plain string content (user messages or legacy format)
            return content;
        }
    };

    const handleExport = useCallback(async (e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setExportingId(session.id);
        try {
            const data = await getSessionDetails(session.id);
            if (!data || data.messages.length === 0) {
                toast.error('该对话暂无内容可导出');
                return;
            }

            // Format timestamp: YYYY-MM-DD HH:mm:ss
            const fmtTs = (iso: string) => {
                const d = new Date(iso);
                const pad2 = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
            };

            const lines: string[] = [];
            // Header
            const now = new Date();
            const pad2 = (n: number) => String(n).padStart(2, '0');
            const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
            lines.push(`<!-- Exported from PM Copilot · ${dateStr} -->`);
            lines.push(`<!-- Session: ${data.title} -->`);
            lines.push('');

            for (const msg of data.messages) {
                const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
                const ts = fmtTs(msg.timestamp);
                lines.push(`[ ${roleLabel} | ${ts} ]`);
                lines.push('');
                const text = msg.role === 'assistant'
                    ? extractAssistantText(msg.content)
                    : msg.content;
                lines.push(text);
                lines.push('');
                lines.push('---');
                lines.push('');
            }

            const markdown = lines.join('\n');

            // File name: {date}_{title}.md — sanitize title for filename
            const safeTitle = data.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
            const fileName = `${dateStr}_${safeTitle}.md`;

            // Trigger download via Blob URL (same pattern as UnifiedLogsPanel)
            const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.click();
            URL.revokeObjectURL(url);

            // Show global toast with full download path
            try {
                const { downloadDir, join: joinPath } = await import('@tauri-apps/api/path');
                const dlDir = await downloadDir();
                const fullPath = await joinPath(dlDir, fileName);
                toast.success(`已导出：${fullPath}`);
            } catch {
                // Fallback if Tauri path API unavailable (browser dev mode)
                toast.success(`已导出到下载目录：${fileName}`);
            }
        } catch {
            toast.error('导出失败，请重试');
        } finally {
            setExportingId(null);
        }
    }, [toast]);

    const formatTime = (isoString: string) => {
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
    };

    if (!isOpen) return null;

    // Derive loading state: open but sessions not yet fetched
    const isLoading = sessions === null;

    return (
        <>
            <div
                ref={dropdownRef}
                className="absolute right-0 top-full z-50 mt-1 w-96 overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg"
            >
                {/* Header */}
                <div className="border-b border-[var(--line)] px-4 py-2">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">历史记录</h3>
                </div>

                {/* Delete error toast */}
                {deleteError && (
                    <div className="border-b border-[var(--error)]/20 bg-[var(--error)]/10 px-4 py-2 text-xs text-[var(--error)]">
                        {deleteError}
                    </div>
                )}

                {/* Session list */}
                <div className="max-h-80 overflow-y-auto">
                    {isLoading ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            加载中...
                        </div>
                    ) : sessions.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                            暂无历史记录
                        </div>
                    ) : (
                        sortedSessions.map((session) => {
                            const isCurrent = session.id === currentSessionId;
                            const tags = sessionTagsMap.get(session.id) ?? [];
                            const stats = session.stats;
                            const hasStats = stats && (stats.messageCount > 0 || stats.totalInputTokens > 0);
                            const totalTokens = (stats?.totalInputTokens ?? 0) + (stats?.totalOutputTokens ?? 0);

                            return (
                                <div
                                    key={session.id}
                                    className={`group flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors ${isCurrent
                                        ? 'bg-[var(--accent)]/10'
                                        : 'hover:bg-[var(--hover-bg)]'
                                        }`}
                                    onClick={() => {
                                        if (!isCurrent) {
                                            onSelectSession(session.id);
                                            onClose();
                                        }
                                    }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            {isCurrent && (
                                                <span className="flex-shrink-0 rounded bg-[var(--accent)]/20 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                                                    当前
                                                </span>
                                            )}
                                            {tags.map((tag, i) => (
                                                <SessionTagBadge key={i} tag={tag} />
                                            ))}
                                            <span className={`truncate text-sm ${isCurrent ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                                {session.title}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                                            <span className="flex items-center gap-1">
                                                <Clock className="h-3 w-3" />
                                                {formatTime(session.lastActiveAt)}
                                            </span>
                                            {hasStats && (
                                                <>
                                                    <span>·</span>
                                                    <span>{stats.messageCount} 条消息</span>
                                                    <span>·</span>
                                                    <span>{formatTokens(totalTokens)} tokens</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex flex-shrink-0 items-center gap-1">
                                        {/* Show confirmation buttons when pending delete */}
                                        {pendingDeleteId === session.id ? (
                                            <>
                                                <button
                                                    className="flex h-6 items-center justify-center rounded bg-[var(--error)] px-2 text-xs font-medium text-white transition-colors hover:bg-[var(--error)]/80"
                                                    onClick={(e) => { e.stopPropagation(); handleConfirmDelete(); }}
                                                >
                                                    确认
                                                </button>
                                                <button
                                                    className="flex h-6 items-center justify-center rounded bg-[var(--paper-inset)] px-2 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--line)]"
                                                    onClick={(e) => { e.stopPropagation(); handleCancelDelete(); }}
                                                >
                                                    取消
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <Tip label="导出对话内容为 md 文件" position="bottom">
                                                    <button
                                                        aria-label="导出"
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100"
                                                        onClick={(e) => { void handleExport(e, session); }}
                                                        disabled={exportingId === session.id}
                                                    >
                                                        <Download className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tip>
                                                <Tip label="查看统计" position="bottom">
                                                    <button
                                                        aria-label="查看统计"
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100"
                                                        onClick={(e) => handleShowStats(e, session)}
                                                    >
                                                        <BarChart2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </Tip>
                                                {/* Disable delete for sessions with running cron tasks */}
                                                {tags.some(t => t.type === 'cron') ? (
                                                    <Tip label="请先停止循环任务后再删除" position="bottom">
                                                        <button
                                                            aria-label="删除（请先停止循环任务）"
                                                            className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-0 group-hover:opacity-40"
                                                            disabled
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    </Tip>
                                                ) : (
                                                    <Tip label="删除" position="bottom">
                                                        <button
                                                            aria-label="删除"
                                                            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
                                                            onClick={(e) => handleDeleteClick(e, session.id)}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" />
                                                        </button>
                                                    </Tip>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            </div>

            {/* Stats Modal — portal to document root to escape stacking context */}
            {statsSession && createPortal(
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />,
                document.body,
            )}
        </>
    );
}
