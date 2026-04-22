/**
 * RecentTasks - Dual-tab mini view: Sessions | CronTasks
 * Shows 5 items per tab, with tags and "查看全部" entry to overlay
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, BarChart2, Clock, MessageSquare, Plus, RefreshCw, Timer, Trash2 } from 'lucide-react';

import { useTaskCenterData } from '@/hooks/useTaskCenterData';
import WorkspaceIcon from './WorkspaceIcon';
import { deleteSession } from '@/api/sessionClient';
import { deactivateSession } from '@/api/tauriClient';
import SessionTagBadge from '@/components/SessionTagBadge';
import SessionStatsModal from '@/components/SessionStatsModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { getFolderName, formatTime, getSessionDisplayText, formatMessageCount } from '@/utils/taskCenterUtils';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import {
    getCronStatusText,
    getCronStatusColor,
    formatNextExecution,
} from '@/types/cronTask';
import type { Project } from '@/config/types';
import TaskCreateModal from '@/components/scheduled-tasks/TaskCreateModal';

const DISPLAY_COUNT = 5;
/** Cron tab shows fewer items because the "新建" button takes one row's worth of height */
const CRON_DISPLAY_COUNT = 4;
/** Fixed min-height for 5 rows (each ~36px + 2px gap) to prevent layout shift */
const LIST_MIN_HEIGHT = 'min-h-[188px]';

interface RecentTasksProps {
    projects: Project[];
    onOpenTask: (session: SessionMetadata, project: Project) => void;
    onOpenOverlay: () => void;
    onOpenCronDetail: (task: CronTask) => void;
    isActive?: boolean;
}

type ActiveTab = 'sessions' | 'cron';

export default memo(function RecentTasks({
    projects,
    onOpenTask,
    onOpenOverlay,
    onOpenCronDetail,
    isActive,
}: RecentTasksProps) {
    const { sessions, cronTasks, sessionTagsMap, cronBotInfoMap, isLoading, error, refresh, removeSession } =
        useTaskCenterData({ isActive });
    const toast = useToast();

    const [activeTab, setActiveTab] = useState<ActiveTab>('sessions');
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);

    // Top 5 sessions — filter to those with a matching visible project first, then slice
    const displaySessions = useMemo(() => {
        const projectPaths = new Set(projects.map(p => p.path));
        return sessions.filter(s => projectPaths.has(s.agentDir)).slice(0, DISPLAY_COUNT);
    }, [sessions, projects]);

    // Sorted cron tasks: running first (by nextExecutionAt ASC), then stopped (by updatedAt DESC), take 5
    const displayCronTasks = useMemo(() => {
        return [...cronTasks]
            .sort((a, b) => {
                if (a.status === 'running' && b.status !== 'running') return -1;
                if (a.status !== 'running' && b.status === 'running') return 1;
                if (a.status === 'running') {
                    if (a.nextExecutionAt && b.nextExecutionAt) {
                        return new Date(a.nextExecutionAt).getTime() - new Date(b.nextExecutionAt).getTime();
                    }
                    return 0;
                }
                const aTime = new Date(a.updatedAt || a.createdAt).getTime();
                const bTime = new Date(b.updatedAt || b.createdAt).getTime();
                return bTime - aTime;
            })
            .slice(0, CRON_DISPLAY_COUNT);
    }, [cronTasks]);

    const getProjectForSession = useCallback(
        (session: SessionMetadata): Project | undefined =>
            projects.find(p => p.path === session.agentDir),
        [projects]
    );

    const cronProtectedSessionIds = useMemo(
        () => new Set(cronTasks.filter(t => t.status === 'running').map(t => t.sessionId)),
        [cronTasks]
    );

    const handleDeleteClick = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setPendingDeleteSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const success = await deleteSession(id);
            if (success) {
                await deactivateSession(id);
                removeSession(id);
                toast.success('已删除');
            } else {
                toast.error('删除失败，请重试');
            }
        } catch (err) {
            console.error('[RecentTasks] Delete session failed:', err);
            toast.error('删除失败');
        }
    }, [pendingDeleteSession, removeSession, toast]);

    const handleShowStats = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    if (isLoading) {
        return (
            <div className="mb-8">
                <TabHeader activeTab={activeTab} onTabChange={setActiveTab} />
                <div className={`${LIST_MIN_HEIGHT} flex items-center`}>
                    <div className="py-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="mb-8">
                <TabHeader activeTab={activeTab} onTabChange={setActiveTab} />
                <div className={`${LIST_MIN_HEIGHT} flex items-center justify-center`}>
                    <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                        <AlertCircle className="mx-auto mb-2 h-4 w-4 text-amber-500/70" />
                        <p className="mb-2 text-[13px] text-[var(--ink-muted)]">{error}</p>
                        <button
                            onClick={refresh}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            重试
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mb-8">
            <TabHeader activeTab={activeTab} onTabChange={setActiveTab} />

            {/* Sessions tab */}
            {activeTab === 'sessions' && (
                <div className={LIST_MIN_HEIGHT}>
                    {displaySessions.length === 0 ? (
                        <div className={`${LIST_MIN_HEIGHT} flex items-center justify-center`}>
                            <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                                <MessageSquare className="mx-auto mb-2 h-4 w-4 text-[var(--ink-muted)]/50" />
                                <p className="text-[13px] text-[var(--ink-muted)]/70">暂无对话记录</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {displaySessions.map(session => {
                                const project = getProjectForSession(session);
                                if (!project) return null;
                                const tags = sessionTagsMap.get(session.id) ?? [];
                                const displayText = getSessionDisplayText(session);
                                const msgCount = formatMessageCount(session);

                                const isCronProtected = cronProtectedSessionIds.has(session.id);
                                return (
                                    <div
                                        key={session.id}
                                        role="button"
                                        onClick={() => onOpenTask(session, project)}
                                        className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                    >
                                        <div className="flex w-14 shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]/50">
                                            <Clock className="h-2.5 w-2.5" />
                                            <span>{formatTime(session.lastActiveAt)}</span>
                                        </div>
                                        {tags.map((tag, i) => (
                                            <SessionTagBadge key={i} tag={tag} />
                                        ))}
                                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                            {displayText}
                                            {msgCount && (
                                                <span className="ml-1.5 text-[11px] text-[var(--ink-muted)]/40">
                                                    {msgCount}
                                                </span>
                                            )}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--ink-muted)]/45">
                                            <WorkspaceIcon icon={project.icon} size={14} />
                                            <span className="max-w-[80px] truncate">
                                                {getFolderName(project.path)}
                                            </span>
                                        </div>

                                        {/* Hover actions overlay */}
                                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                                            <div className="h-full w-10 bg-gradient-to-r from-transparent to-[var(--paper-inset)]" />
                                            <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                                                <button
                                                    onClick={e => handleShowStats(e, session)}
                                                    title="查看统计"
                                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                >
                                                    <BarChart2 className="h-3.5 w-3.5" />
                                                </button>
                                                {isCronProtected ? (
                                                    <button
                                                        disabled
                                                        title="请先停止定时任务后再删除"
                                                        className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-40"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                ) : (
                                                    <button
                                                        onClick={e => handleDeleteClick(e, session)}
                                                        title="删除"
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* CronTasks tab */}
            {activeTab === 'cron' && (
                <div className={LIST_MIN_HEIGHT}>
                    {/* Create button */}
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--line)] py-2 text-[13px] font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        新建定时任务
                    </button>
                    {displayCronTasks.length === 0 ? (
                        <div className={`flex items-center justify-center py-6`}>
                            <div className="text-center">
                                <Timer className="mx-auto mb-2 h-4 w-4 text-[var(--ink-muted)]/50" />
                                <p className="text-[13px] text-[var(--ink-muted)]/70">暂无定时任务</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {displayCronTasks.map(task => {
                                const botInfo = task.sourceBotId
                                    ? cronBotInfoMap.get(task.sourceBotId)
                                    : undefined;
                                const displayName =
                                    task.name ||
                                    task.prompt.slice(0, 30) + (task.prompt.length > 30 ? '...' : '');

                                return (
                                    <button
                                        key={task.id}
                                        onClick={() => onOpenCronDetail(task)}
                                        className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                    >
                                        <span
                                            className={`w-14 shrink-0 text-[11px] font-medium ${getCronStatusColor(task.status)}`}
                                        >
                                            {getCronStatusText(task.status)}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                            {displayName}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--ink-muted)]/45">
                                            <span className="max-w-[100px] truncate">
                                                {botInfo ? `${botInfo.name}` : getFolderName(task.workspacePath)}
                                            </span>
                                            {task.status === 'running' && (
                                                <span className="text-[10px]">
                                                    {formatNextExecution(task.nextExecutionAt, task.status)}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Bottom: "查看全部" */}
            <div className="mt-2 flex justify-center">
                <button
                    onClick={onOpenOverlay}
                    className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] text-[var(--ink-muted)]/60 transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink-muted)]"
                >
                    查看全部
                    <ArrowRight className="h-3 w-3" />
                </button>
            </div>

            {pendingDeleteSession && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定要删除「${pendingDeleteSession.title}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDeleteSession(null)}
                />
            )}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
            {showCreateModal && (
                <TaskCreateModal
                    onClose={() => setShowCreateModal(false)}
                    onCreated={refresh}
                />
            )}
        </div>
    );
});

// Tab header sub-component
function TabHeader({
    activeTab,
    onTabChange,
}: {
    activeTab: ActiveTab;
    onTabChange: (tab: ActiveTab) => void;
}) {
    return (
        <div className="mb-3 flex items-center gap-4">
            <button
                onClick={() => onTabChange('sessions')}
                className={`relative text-[13px] font-semibold tracking-[0.04em] transition-colors ${
                    activeTab === 'sessions'
                        ? 'text-[var(--ink-muted)]'
                        : 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                }`}
            >
                最近任务
                {activeTab === 'sessions' && (
                    <div className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-[var(--accent)]" />
                )}
            </button>
            <button
                onClick={() => onTabChange('cron')}
                className={`relative text-[13px] font-semibold tracking-[0.04em] transition-colors ${
                    activeTab === 'cron'
                        ? 'text-[var(--ink-muted)]'
                        : 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                }`}
            >
                定时任务
                {activeTab === 'cron' && (
                    <div className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-[var(--accent)]" />
                )}
            </button>
        </div>
    );
}
