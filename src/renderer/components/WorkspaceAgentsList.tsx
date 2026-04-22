/**
 * WorkspaceAgentsList - Project-level agent list with enable/disable toggle
 * Used in WorkspaceConfigPanel's Agents tab
 */
import { Plus, Bot, Loader2, Trash2, X as XIcon, Link2 } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';

import { track } from '@/analytics';
import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiPutJson as globalApiPut, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { AgentItem, AgentWorkspaceConfig } from '../../shared/agentTypes';

interface WorkspaceAgentsListProps {
    scope: 'user' | 'project';
    agentDir?: string;
    onSelectAgent: (name: string, scope: 'user' | 'project', isNewAgent?: boolean) => void;
    refreshKey?: number;
    onClose?: () => void;
}

export default function WorkspaceAgentsList({
    agentDir,
    onSelectAgent,
    refreshKey = 0,
    onClose: _onClose,
}: WorkspaceAgentsListProps) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const tabState = useTabApiOptional();
    const apiGet = tabState?.apiGet;
    const apiPost = tabState?.apiPost;
    const apiPut = tabState?.apiPut;
    const apiDeleteFn = tabState?.apiDelete;

    const api = useMemo(() => {
        if (apiGet && apiPost && apiPut && apiDeleteFn) {
            return { get: apiGet, post: apiPost, put: apiPut, delete: apiDeleteFn };
        }
        return { get: globalApiGet, post: globalApiPost, put: globalApiPut, delete: globalApiDelete };
    }, [apiGet, apiPost, apiPut, apiDeleteFn]);

    const isInTabContext = !!tabState;

    const [loading, setLoading] = useState(true);
    const [localAgents, setLocalAgents] = useState<AgentItem[]>([]);
    const [globalRefAgents, setGlobalRefAgents] = useState<AgentItem[]>([]);
    const [allGlobalAgents, setAllGlobalAgents] = useState<AgentItem[]>([]);
    const [wsConfig, setWsConfig] = useState<AgentWorkspaceConfig>({ local: {}, global_refs: {} });
    const [showImportPicker, setShowImportPicker] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ name: string; type: 'local' | 'global_ref' } | null>(null);
    const [deleting, setDeleting] = useState(false);

    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const agentDirParam = (!isInTabContext && agentDir) ? `?agentDir=${encodeURIComponent(agentDir)}` : '';
            const agentDirQs = (!isInTabContext && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';

            const [projectRes, userRes, configRes] = await Promise.all([
                api.get<{ success: boolean; agents: AgentItem[] }>(`/api/agents?scope=project${agentDirQs}`),
                api.get<{ success: boolean; agents: AgentItem[] }>('/api/agents?scope=user'),
                api.get<{ success: boolean; config: AgentWorkspaceConfig }>(`/api/agents/workspace-config${agentDirParam}`),
            ]);

            if (!isMountedRef.current) return;

            if (projectRes.success) setLocalAgents(projectRes.agents);
            if (userRes.success) setAllGlobalAgents(userRes.agents);
            if (configRes.success) {
                setWsConfig(configRes.config);
                // Filter global agents to only show those referenced in workspace config
                if (userRes.success) {
                    const refNames = Object.keys(configRes.config.global_refs || {});
                    setGlobalRefAgents(userRes.agents.filter(a => refNames.includes(a.folderName)));
                }
            }
        } catch {
            if (!isMountedRef.current) return;
            toastRef.current.error('加载 Agent 列表失败');
        } finally {
            if (isMountedRef.current) setLoading(false);
        }
    }, [api, isInTabContext, agentDir]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);

    const isEnabled = useCallback((folderName: string, type: 'local' | 'global') => {
        if (type === 'local') {
            return wsConfig.local[folderName]?.enabled !== false;
        }
        return wsConfig.global_refs[folderName]?.enabled !== false;
    }, [wsConfig]);

    const updateWsConfig = useCallback(async (newConfig: AgentWorkspaceConfig) => {
        const prevConfig = wsConfig;
        setWsConfig(newConfig);
        try {
            const payload = isInTabContext
                ? { config: newConfig }
                : { config: newConfig, ...(agentDir ? { agentDir } : {}) };
            await api.put<{ success: boolean }>('/api/agents/workspace-config', payload);
        } catch {
            toastRef.current.error('保存配置失败');
            setWsConfig(prevConfig);
        }
    }, [wsConfig, api, isInTabContext, agentDir]);

    const handleToggle = useCallback(async (folderName: string, type: 'local' | 'global', currentEnabled: boolean) => {
        const newConfig = { ...wsConfig };
        if (type === 'local') {
            newConfig.local = { ...newConfig.local, [folderName]: { enabled: !currentEnabled } };
        } else {
            newConfig.global_refs = { ...newConfig.global_refs, [folderName]: { enabled: !currentEnabled } };
        }
        await updateWsConfig(newConfig);
    }, [wsConfig, updateWsConfig]);

    const handleCreateAgent = useCallback(async () => {
        const tempName = `new-agent-${Date.now()}`;
        try {
            const payload = isInTabContext
                ? { name: tempName, scope: 'project' as const, description: '' }
                : { name: tempName, scope: 'project' as const, description: '', ...(agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/agent/create', payload);
            if (response.success && response.folderName) {
                track('agent_add', { scope: 'project' });
                onSelectAgent(response.folderName, 'project', true);
                loadData();
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        }
    }, [api, isInTabContext, agentDir, onSelectAgent, loadData]);

    // Import a global agent as a reference
    const handleImportGlobal = useCallback(async (agent: AgentItem) => {
        const newConfig = {
            ...wsConfig,
            global_refs: { ...wsConfig.global_refs, [agent.folderName]: { enabled: true } },
        };
        await updateWsConfig(newConfig);
        setGlobalRefAgents(prev => [...prev, agent]);
        setShowImportPicker(false);
        toastRef.current.success(`已引入 "${agent.name}"`);
    }, [wsConfig, updateWsConfig]);

    // Remove a global reference (doesn't delete the global agent)
    const handleRemoveGlobalRef = useCallback(async (folderName: string) => {
        const newRefs = { ...wsConfig.global_refs };
        delete newRefs[folderName];
        const newConfig = { ...wsConfig, global_refs: newRefs };
        await updateWsConfig(newConfig);
        setGlobalRefAgents(prev => prev.filter(a => a.folderName !== folderName));
        toastRef.current.success('已移除引用');
        setDeleteTarget(null);
    }, [wsConfig, updateWsConfig]);

    // Delete a local agent (file deletion)
    const handleDeleteLocal = useCallback(async (folderName: string) => {
        setDeleting(true);
        try {
            const agentDirParam = (!isInTabContext && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
            const response = await api.delete<{ success: boolean; error?: string }>(
                `/api/agent/${encodeURIComponent(folderName)}?scope=project${agentDirParam}`
            );
            if (response.success) {
                // Also remove from workspace config
                const newLocal = { ...wsConfig.local };
                delete newLocal[folderName];
                const newConfig = { ...wsConfig, local: newLocal };
                await updateWsConfig(newConfig);
                setLocalAgents(prev => prev.filter(a => a.folderName !== folderName));
                toastRef.current.success('已删除');
            } else {
                toastRef.current.error(response.error || '删除失败');
            }
        } catch {
            toastRef.current.error('删除失败');
        } finally {
            setDeleting(false);
            setDeleteTarget(null);
        }
    }, [api, isInTabContext, agentDir, wsConfig, updateWsConfig]);

    // Available global agents that haven't been imported yet
    const availableForImport = useMemo(() => {
        const refNames = new Set(Object.keys(wsConfig.global_refs || {}));
        return allGlobalAgents.filter(a => !refNames.has(a.folderName));
    }, [allGlobalAgents, wsConfig]);

    if (loading) {
        return (
            <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    const hasAny = localAgents.length > 0 || globalRefAgents.length > 0;

    return (
        <div className="space-y-6 p-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Bot className="h-5 w-5 text-[var(--ink-muted)]" />
                    <h3 className="text-base font-semibold text-[var(--ink)]">Sub-Agents</h3>
                </div>
                <button
                    onClick={handleCreateAgent}
                    className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                >
                    <Plus className="h-4 w-4" />
                    新建
                </button>
            </div>

            {!hasAny && availableForImport.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8 text-center">
                    <Bot className="mx-auto h-10 w-10 text-[var(--ink-muted)]/30" />
                    <p className="mt-2 text-sm text-[var(--ink-muted)]">暂无 Agent</p>
                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                        创建 Sub-Agent 让 AI 自主委派来处理特定任务
                    </p>
                </div>
            ) : (
                <>
                    {/* Local Agents */}
                    {localAgents.length > 0 && (
                        <div>
                            <h4 className="mb-2 text-sm font-medium text-[var(--ink-muted)]">
                                本地 Agent ({localAgents.length})
                            </h4>
                            <div className="space-y-2">
                                {localAgents.map(agent => (
                                    <AgentRow
                                        key={agent.folderName}
                                        agent={agent}
                                        enabled={isEnabled(agent.folderName, 'local')}
                                        onToggle={() => handleToggle(agent.folderName, 'local', isEnabled(agent.folderName, 'local'))}
                                        onClick={() => onSelectAgent(agent.folderName, 'project')}
                                        onDelete={() => setDeleteTarget({ name: agent.folderName, type: 'local' })}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Global Reference Agents */}
                    {globalRefAgents.length > 0 && (
                        <div>
                            <h4 className="mb-2 text-sm font-medium text-[var(--ink-muted)]">
                                全局引用 Agent ({globalRefAgents.length})
                            </h4>
                            <div className="space-y-2">
                                {globalRefAgents.map(agent => (
                                    <AgentRow
                                        key={agent.folderName}
                                        agent={agent}
                                        enabled={isEnabled(agent.folderName, 'global')}
                                        onToggle={() => handleToggle(agent.folderName, 'global', isEnabled(agent.folderName, 'global'))}
                                        onClick={() => onSelectAgent(agent.folderName, 'user')}
                                        isGlobalRef
                                        onRemoveRef={() => setDeleteTarget({ name: agent.folderName, type: 'global_ref' })}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Import Global Agent Section */}
                    {availableForImport.length > 0 && (
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <h4 className="text-sm font-medium text-[var(--ink-muted)]">引入全局 Agent</h4>
                                <button
                                    onClick={() => setShowImportPicker(!showImportPicker)}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                >
                                    <Link2 className="h-3 w-3" />
                                    {showImportPicker ? '收起' : '引入'}
                                </button>
                            </div>
                            {showImportPicker && (
                                <div className="space-y-1.5 rounded-lg border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 p-3">
                                    {availableForImport.map(agent => (
                                        <div key={agent.folderName} className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-[var(--paper-elevated)]">
                                            <div className="min-w-0 flex-1">
                                                <span className="text-sm text-[var(--ink)]">{agent.name}</span>
                                                {agent.description && (
                                                    <p className="truncate text-xs text-[var(--ink-muted)]">{agent.description}</p>
                                                )}
                                            </div>
                                            <button
                                                onClick={() => handleImportGlobal(agent)}
                                                className="ml-2 shrink-0 rounded-md bg-[var(--button-primary-bg)] px-2 py-1 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                            >
                                                + 引入
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}

            {/* Delete/Remove Confirmation */}
            {deleteTarget && (
                <ConfirmDialog
                    title={deleteTarget.type === 'local' ? '删除 Agent' : '移除全局引用'}
                    message={
                        deleteTarget.type === 'local'
                            ? `确定要删除本地 Agent "${deleteTarget.name}" 吗？此操作会删除文件，不可恢复。`
                            : `确定要移除对全局 Agent "${deleteTarget.name}" 的引用吗？全局 Agent 本身不会被删除。`
                    }
                    confirmText={deleteTarget.type === 'local' ? '删除' : '移除'}
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={() => {
                        if (deleteTarget.type === 'local') {
                            handleDeleteLocal(deleteTarget.name);
                        } else {
                            handleRemoveGlobalRef(deleteTarget.name);
                        }
                    }}
                    onCancel={() => setDeleteTarget(null)}
                    loading={deleting}
                />
            )}
        </div>
    );
}

function AgentRow({
    agent,
    enabled,
    onToggle,
    onClick,
    isGlobalRef = false,
    onDelete,
    onRemoveRef,
}: {
    agent: AgentItem;
    enabled: boolean;
    onToggle: () => void;
    onClick: () => void;
    isGlobalRef?: boolean;
    onDelete?: () => void;
    onRemoveRef?: () => void;
}) {
    return (
        <div className="flex items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3">
            {/* Toggle */}
            <button
                onClick={e => { e.stopPropagation(); onToggle(); }}
                className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${
                    enabled ? 'bg-[var(--accent-warm)]' : 'bg-[var(--ink-muted)]/20'
                }`}
            >
                <span
                    className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--toggle-thumb)] transition-transform ${
                        enabled ? 'translate-x-4' : ''
                    }`}
                />
            </button>

            {/* Info */}
            <div className="min-w-0 flex-1 cursor-pointer" onClick={onClick}>
                <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-[var(--ink)]">{agent.name}</span>
                    <Bot className="h-3.5 w-3.5 shrink-0 text-violet-500" />
                    {isGlobalRef && (
                        <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                            全局
                        </span>
                    )}
                </div>
                {agent.description && (
                    <p className="mt-0.5 truncate text-xs text-[var(--ink-muted)]">{agent.description}</p>
                )}
            </div>

            {/* Action buttons */}
            {isGlobalRef && onRemoveRef && (
                <button
                    onClick={e => { e.stopPropagation(); onRemoveRef(); }}
                    className="shrink-0 rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title="移除引用"
                >
                    <XIcon className="h-3.5 w-3.5" />
                </button>
            )}
            {!isGlobalRef && onDelete && (
                <button
                    onClick={e => { e.stopPropagation(); onDelete(); }}
                    className="shrink-0 rounded-md p-1.5 text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                    title="删除"
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}
