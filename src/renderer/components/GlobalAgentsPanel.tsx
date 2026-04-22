/**
 * GlobalAgentsPanel - User-level Sub-Agent management for Settings page
 * Follows the same pattern as GlobalSkillsPanel
 */
import { Plus, Bot, Loader2, ChevronLeft } from 'lucide-react';
import { useCallback, useEffect, useState, useRef } from 'react';

import { track } from '@/analytics';
import { apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import AgentDetailPanel from './AgentDetailPanel';
import type { AgentDetailPanelRef } from './AgentDetailPanel';
import { AgentCard } from './AgentCards';
import { CreateDialog } from './SkillDialogs';
import type { AgentItem } from '../../shared/agentTypes';
import OverlayBackdrop from '@/components/OverlayBackdrop';

type ViewState =
    | { type: 'list' }
    | { type: 'agent-detail'; name: string; isNewAgent?: boolean };

export default function GlobalAgentsPanel({ onDetailChange }: { onDetailChange?: (inDetail: boolean) => void }) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const [viewState, setViewState] = useState<ViewState>({ type: 'list' });
    const onDetailChangeRef = useRef(onDetailChange);
    onDetailChangeRef.current = onDetailChange;
    useEffect(() => { onDetailChangeRef.current?.(viewState.type !== 'list'); }, [viewState.type]);
    const [loading, setLoading] = useState(true);
    const [agents, setAgents] = useState<AgentItem[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);

    const agentDetailRef = useRef<AgentDetailPanelRef>(null);

    // Dialog states
    const [showNewDialog, setShowNewDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);

    // Sync from Claude Code state
    const [canSyncFromClaude, setCanSyncFromClaude] = useState(false);
    const [syncableCount, setSyncableCount] = useState(0);
    const [syncConflicts, setSyncConflicts] = useState<string[]>([]);
    const [showSyncConflictDialog, setShowSyncConflictDialog] = useState(false);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const isAnyEditing = useCallback(() => {
        if (viewState.type === 'agent-detail' && agentDetailRef.current?.isEditing()) {
            return true;
        }
        return false;
    }, [viewState]);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [agentsRes, syncCheckRes] = await Promise.all([
                apiGetJson<{ success: boolean; agents: AgentItem[] }>('/api/agents?scope=user'),
                apiGetJson<{ canSync: boolean; count: number; folders: string[]; conflictFolders?: string[] }>('/api/agent/sync-check')
            ]);

            if (!isMountedRef.current) return;

            if (agentsRes.success) setAgents(agentsRes.agents);
            setCanSyncFromClaude(syncCheckRes?.canSync ?? false);
            setSyncableCount(syncCheckRes?.count ?? 0);
            setSyncConflicts(syncCheckRes?.conflictFolders ?? []);
        } catch {
            if (!isMountedRef.current) return;
            toastRef.current.error('加载失败');
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const handleBackToList = useCallback(() => {
        if (isAnyEditing()) {
            toastRef.current.warning('请先保存或取消编辑');
            return;
        }
        setViewState({ type: 'list' });
    }, [isAnyEditing]);

    const handleQuickCreateAgent = useCallback(async (tempName: string) => {
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', {
                name: tempName,
                scope: 'user',
                description: ''
            });
            if (response.success) {
                track('agent_add', { scope: 'user' });
                setViewState({ type: 'agent-detail', name: response.folderName || tempName, isNewAgent: true });
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        }
    }, []);

    const doSync = useCallback(async (mode: 'skip' | 'overwrite') => {
        try {
            const response = await apiPostJson<{
                success: boolean;
                synced: number;
                failed: number;
                skipped: number;
                overwritten: number;
                errors?: string[];
            }>('/api/agent/sync-from-claude', { mode });

            if (response.success) {
                const parts: string[] = [];
                if (response.synced > 0) parts.push(`新增 ${response.synced}`);
                if (response.overwritten > 0) parts.push(`覆盖 ${response.overwritten}`);
                if (response.skipped > 0) parts.push(`跳过 ${response.skipped}`);
                if (response.failed > 0) parts.push(`失败 ${response.failed}`);

                if (response.failed > 0) {
                    toastRef.current.warning(parts.join('，'));
                } else if (parts.length > 0) {
                    toastRef.current.success(parts.join('，'));
                } else {
                    toastRef.current.info('没有可同步的 Agent');
                }
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error('同步失败');
            }
        } catch {
            toastRef.current.error('同步失败');
        }
        setShowSyncConflictDialog(false);
    }, []);

    const handleSyncFromClaude = useCallback(async () => {
        if (syncConflicts.length > 0) {
            // Has conflicts - show dialog to let user choose
            setShowSyncConflictDialog(true);
        } else {
            // No conflicts - just sync directly
            await doSync('skip');
        }
    }, [syncConflicts, doSync]);

    const handleCreateAgent = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await apiPostJson<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', {
                name: newItemName.trim(),
                scope: 'user',
                description: newItemDescription.trim()
            });
            if (response.success) {
                track('agent_add', { scope: 'user' });
                setShowNewDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                if (response.folderName) {
                    setViewState({ type: 'agent-detail', name: response.folderName, isNewAgent: true });
                }
                setRefreshKey(k => k + 1);
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription]);

    const handleItemSaved = useCallback((autoClose?: boolean) => {
        setRefreshKey(k => k + 1);
        if (autoClose) {
            setViewState({ type: 'list' });
        }
    }, []);

    const handleItemDeleted = useCallback(() => {
        setViewState({ type: 'list' });
        setRefreshKey(k => k + 1);
    }, []);

    if (loading && viewState.type === 'list') {
        return (
            <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    // Agent Detail View
    if (viewState.type === 'agent-detail') {
        return (
            <div className="space-y-4">
                <button
                    onClick={handleBackToList}
                    className="flex items-center gap-1 text-sm text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ChevronLeft className="h-4 w-4" />
                    返回列表
                </button>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] overflow-hidden" style={{ minHeight: '500px' }}>
                    <AgentDetailPanel
                        ref={agentDetailRef}
                        name={viewState.name}
                        scope="user"
                        onBack={handleBackToList}
                        onSaved={handleItemSaved}
                        onDeleted={handleItemDeleted}
                        startInEditMode={viewState.isNewAgent}
                    />
                </div>
            </div>
        );
    }

    // List View
    return (
        <div className="space-y-8">
            {/* Agents Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Bot className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">用户 Agent</h3>
                        <span className="text-xs text-[var(--ink-muted)]">({agents.length})</span>
                    </div>
                    <div className="flex items-center gap-2">
                        {canSyncFromClaude && (
                            <button
                                onClick={handleSyncFromClaude}
                                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                从 Claude Code 同步 ({syncableCount})
                            </button>
                        )}
                        <button
                            onClick={() => {
                                const tempName = `new-agent-${Date.now()}`;
                                handleQuickCreateAgent(tempName);
                            }}
                            className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                        >
                            <Plus className="h-4 w-4" />
                            新建
                        </button>
                    </div>
                </div>
                {agents.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {agents.map(agent => (
                            <AgentCard
                                key={agent.folderName}
                                agent={agent}
                                onClick={() => setViewState({ type: 'agent-detail', name: agent.folderName })}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                        <Bot className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">还没有用户 Agent</p>
                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                            Sub-Agent 可以被 AI 自主委派来处理特定任务
                        </p>
                    </div>
                )}
            </div>

            {/* Dialogs */}
            {showNewDialog && (
                <CreateDialog
                    title="新建 Agent"
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateAgent}
                    onCancel={() => { setShowNewDialog(false); setNewItemName(''); setNewItemDescription(''); }}
                    loading={creating}
                />
            )}

            {/* Sync conflict dialog */}
            {showSyncConflictDialog && (
                <OverlayBackdrop className="z-50">
                    <div className="w-[420px] rounded-xl border border-[var(--line)] bg-[var(--paper)] p-6 shadow-xl">
                        <h3 className="text-base font-semibold text-[var(--ink)]">同步冲突</h3>
                        <p className="mt-2 text-sm text-[var(--ink-muted)]">
                            以下 {syncConflicts.length} 个 Agent 已存在，请选择处理方式：
                        </p>
                        <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-[var(--paper-inset)] p-2">
                            {syncConflicts.map(name => (
                                <div key={name} className="px-2 py-1 text-xs text-[var(--ink-muted)]">{name}</div>
                            ))}
                        </div>
                        <div className="mt-4 flex justify-end gap-2">
                            <button
                                onClick={() => setShowSyncConflictDialog(false)}
                                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={() => doSync('skip')}
                                className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--paper-inset)]"
                            >
                                跳过已存在
                            </button>
                            <button
                                onClick={() => doSync('overwrite')}
                                className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                            >
                                全部覆盖
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            <p className="text-center text-xs text-[var(--ink-muted)]">
                用户 Agent 存储在 ~/.pm-copilot/agents/ 目录下，对所有项目生效
            </p>
        </div>
    );
}
