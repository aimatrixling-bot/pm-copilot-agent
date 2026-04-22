/**
 * useTaskCenterData - Shared hook for Task Center data fetching,
 * event listening, and tag computation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { loadAppConfig } from '@/config/configService';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { CronTask } from '@/types/cronTask';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import { CUSTOM_EVENTS } from '../../shared/constants';

// ===== Types =====

export type SessionTag =
    | { type: 'im'; platform: string }
    | { type: 'cron' }
    | { type: 'background' };

export interface TaskCenterData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
    isLoading: boolean;
    error: string | null;
    refresh: () => void;
    removeSession: (sessionId: string) => void;
}

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

// Constants
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    const [sessions, setSessions] = useState<SessionMetadata[]>([]);
    const [cronTasks, setCronTasks] = useState<CronTask[]>([]);
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>([]);
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>({});
    const [agents, setAgents] = useState<AgentConfig[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const agentRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);

    const fetchData = useCallback(async (retryCount = 0) => {
        if (retryCount === 0) setIsLoading(true);
        setError(null);

        try {
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => ({} as AgentStatusMap))
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsData, tasksData, bgSessions, agentStatusResult, appConfig] = await Promise.all([
                getSessions(),
                getAllCronTasks().catch(() => [] as CronTask[]),
                getBackgroundSessions().catch(() => [] as string[]),
                agentStatusPromise,
                loadAppConfig().catch(() => null),
            ]);

            if (!isMountedRef.current) return;

            // Sort sessions by lastActiveAt descending (spread to avoid mutating original)
            const sorted = [...sessionsData].sort(
                (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
            );
            setSessions(sorted);
            setCronTasks(tasksData);
            setBackgroundSessionIds(bgSessions);
            setAgentStatuses(agentStatusResult);
            setAgents(appConfig?.agents ?? []);
        } catch (err) {
            if (!isMountedRef.current) return;
            console.error('[useTaskCenterData] Failed to load data:', err);
            if (retryCount < MAX_AUTO_RETRIES) {
                retryTimeoutRef.current = setTimeout(() => {
                    void fetchData(retryCount + 1);
                }, RETRY_DELAY_MS);
            } else {
                setError('加载失败，请稍后重试');
            }
        } finally {
            if (isMountedRef.current) setIsLoading(false);
        }
    }, []);

    // Debounced session refresh (avoids API flooding on rapid events)
    const refreshSessionsDebounced = useCallback((delayMs = 500) => {
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
            sessionRefreshTimerRef.current = null;
            getSessions().then(data => {
                if (!isMountedRef.current) return;
                const sorted = [...data].sort(
                    (a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
                );
                setSessions(sorted);
            }).catch(() => {});
        }, delayMs);
    }, []);

    // Debounced Agent status refresh
    const refreshAgentStatusDebounced = useCallback((delayMs = 1000) => {
        if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
        agentRefreshTimerRef.current = setTimeout(() => {
            agentRefreshTimerRef.current = null;
            if (!isTauriEnvironment()) return;
            import('@tauri-apps/api/core')
                .then(({ invoke }) => {
                    invoke<AgentStatusMap>('cmd_all_agents_status')
                        .then(statuses => { if (isMountedRef.current) setAgentStatuses(statuses); })
                        .catch(() => {});
                })
                .catch(() => {});
        }, delayMs);
    }, []);

    // Initial fetch
    useEffect(() => {
        isMountedRef.current = true;
        void fetchData(0);
        return () => {
            isMountedRef.current = false;
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
        };
    }, [fetchData]);

    // Refresh on tab activation (inactive → active transition)
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;
        void fetchData(0);
    }, [isActive, fetchData]);

    // Refresh sessions when a session title changes (auto-generated or user rename)
    useEffect(() => {
        const handler = () => refreshSessionsDebounced(300);
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [refreshSessionsDebounced]);

    // Event listeners for real-time updates
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        let mounted = true;
        const unlisteners: (() => void)[] = [];

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            if (!mounted) return;

            // Background completion events
            const u1 = await listen('session:background-complete', () => {
                if (!mounted) return;
                getBackgroundSessions().then(ids => {
                    if (mounted) setBackgroundSessionIds(ids);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u1);

            // Cron task events
            const u2 = await listen('cron:task-stopped', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u2);

            const u2b = await listen('cron:task-started', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u2b);

            const u3 = await listen('cron:execution-complete', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u3);

            // Scheduler started (resume / recovery)
            const u4 = await listen('cron:scheduler-started', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
                refreshSessionsDebounced();
            });
            unlisteners.push(u4);

            // Task deleted
            const u5 = await listen('cron:task-deleted', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u5);

            // Task updated (fields edited via cmd_update_cron_task_fields)
            const u6 = await listen('cron:task-updated', () => {
                if (!mounted) return;
                getAllCronTasks().then(tasks => {
                    if (mounted) setCronTasks(tasks);
                }).catch(() => {});
            });
            unlisteners.push(u6);

            // Agent status changes (channel started/stopped, session created)
            const u7 = await listen('agent:status-changed', () => {
                if (!mounted) return;
                refreshAgentStatusDebounced();
                refreshSessionsDebounced(1000);
            });
            unlisteners.push(u7);
        })();

        return () => {
            mounted = false;
            unlisteners.forEach(fn => fn());
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
        };
    }, [refreshSessionsDebounced, refreshAgentStatusDebounced]);

    // Compute session tags (memoized)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();

        // Build IM session map: sessionId → platform display name
        const imSessionPlatformMap = new Map<string, string>();

        // From agent channel statuses
        for (const agentStatus of Object.values(agentStatuses)) {
            for (const channel of agentStatus.channels) {
                if (channel.status !== 'online' && channel.status !== 'connecting') continue;
                for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                    imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
                }
            }
        }

        // Build running cron task session set
        // Use internalSessionId (actual SDK session) when available, falling back to sessionId
        const cronSessionIds = new Set(
            cronTasks.filter(t => t.status === 'running').map(t => t.internalSessionId || t.sessionId)
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

    // Compute cron bot info map from agents[].channels[] (memoized)
    const cronBotInfoMap = useMemo(() => {
        const map = new Map<string, { name: string; platform: string }>();
        for (const agent of agents) {
            for (const channel of (agent.channels ?? [])) {
                map.set(channel.id, {
                    name: channel.name || agent.name,
                    platform: channel.type,
                });
            }
        }
        return map;
    }, [agents]);

    const refresh = useCallback(() => {
        void fetchData(0);
    }, [fetchData]);

    const removeSession = useCallback((sessionId: string) => {
        setSessions(prev => prev.filter(s => s.id !== sessionId));
    }, []);

    return {
        sessions,
        cronTasks,
        sessionTagsMap,
        cronBotInfoMap,
        isLoading,
        error,
        refresh,
        removeSession,
    };
}
