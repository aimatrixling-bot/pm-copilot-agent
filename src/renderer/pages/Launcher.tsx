/**
 * Launcher - Main entry page for PM Copilot
 * Two-column layout: Brand section (left 60%) + Workspaces (right 40%)
 * Responsive: stacks vertically below 768px
 */

import { FolderPlus, LayoutTemplate, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';

import { track } from '@/analytics';
import { type ImageAttachment } from '@/components/SimpleChatInput';
import { useToast } from '@/components/Toast';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import PathInputDialog from '@/components/PathInputDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import TaskCenterOverlay from '@/components/TaskCenterOverlay';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';
import { AddWorkspaceMenu, BrandSection, RecentTasks, TemplateLibraryDialog, WorkspaceCard, WorkspaceEditDialog } from '@/components/launcher';
import WorkspaceConfigPanel from '@/components/WorkspaceConfigPanel';
import { useConfig } from '@/hooks/useConfig';
import { type Project, type Provider, type PermissionMode, type McpServerDefinition } from '@/config/types';
import { CUSTOM_EVENTS } from '../../shared/constants';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
    resolveProvider,
} from '@/config/configService';
import { patchAgentConfig, getAgentById } from '@/config/services/agentConfigService';
import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode } from '../../shared/types/runtime';
import { CC_MODELS, CC_PERMISSION_MODES, CODEX_PERMISSION_MODES } from '../../shared/types/runtime';
import { apiGetJson } from '@/api/apiFetch';
import { deleteCronTask, stopCronTask, startCronTask, startCronScheduler } from '@/api/cronTaskClient';
import { isBrowserDevMode, pickFolderForDialog } from '@/utils/browserMock';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { InitialMessage } from '@/types/tab';

interface LauncherProps {
    onLaunchProject: (project: Project, provider: Provider, sessionId?: string, initialMessage?: InitialMessage) => void;
    isStarting?: boolean;
    startError?: string | null;
    isActive?: boolean;
}

export default function Launcher({ onLaunchProject, isStarting, startError: _startError, isActive }: LauncherProps) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const {
        config,
        projects,
        providers,
        isLoading,
        error: _error,
        addProject,
        removeProject,
        patchProject,
        touchProject,
        apiKeys,
        providerVerifyStatus,
        refreshProviderData,
        updateConfig,
    } = useConfig();

    // Filter out internal projects (e.g. ~/.pm-copilot diagnostic workspace)
    const visibleProjects = useMemo(() => projects.filter(p => !p.internal), [projects]);

    // Poll agent statuses only when any project has proactive mode
    const hasAnyAgent = useMemo(() => visibleProjects.some(p => p.isAgent), [visibleProjects]);
    const { statuses: agentStatuses } = useAgentStatuses(hasAnyAgent);

    // Build agent lookup: project path → { agent config, runtime status }
    const agentLookup = useMemo(() => {
        const map = new Map<string, { agent: NonNullable<typeof config.agents>[number]; status?: (typeof agentStatuses)[string] }>();
        if (!config.agents) return map;
        for (const agent of config.agents) {
            const key = agent.workspacePath.replace(/\\/g, '/');
            map.set(key, { agent, status: agentStatuses[agent.id] });
        }
        return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- config.agents is the actual dependency; full config would cause unnecessary recomputes
    }, [config.agents, agentStatuses]);

    const [_addError, setAddError] = useState<string | null>(null);
    const [launchingProjectId, setLaunchingProjectId] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const [projectToRemove, setProjectToRemove] = useState<Project | null>(null);
    const [showOverlay, setShowOverlay] = useState(false);
    const [selectedCronTask, setSelectedCronTask] = useState<CronTask | null>(null);
    const [showTemplateDialog, setShowTemplateDialog] = useState(false);
    const [editingProject, setEditingProject] = useState<Project | null>(null);
    // Agent overlay — opens WorkspaceConfigPanel for agent settings or upgrade
    const [agentOverlay, setAgentOverlay] = useState<{ workspacePath: string; initialTab: 'agent' } | null>(null);

    // ===== Launcher-specific state for BrandSection =====

    // Fallback chain: defaultWorkspacePath → pm-copilot project → first project → null
    const resolveDefaultWorkspace = useCallback((projs: Project[]): Project | null => {
        if (config.defaultWorkspacePath) {
            const def = projs.find(p => p.path === config.defaultWorkspacePath);
            if (def) return def;
        }
        // Fallback: find pm-copilot project by path suffix
        const pmCopilot = projs.find(p => p.path.replace(/\\/g, '/').endsWith('/pm-copilot'));
        if (pmCopilot) return pmCopilot;
        return projs[0] ?? null;
    }, [config.defaultWorkspacePath]);

    const [selectedWorkspace, setSelectedWorkspace] = useState<Project | null>(() =>
        resolveDefaultWorkspace(visibleProjects)
    );

    // Sync selectedWorkspace when visible projects change (e.g., after first project is added,
    // or after patchProject updates a project's settings from Chat tab)
    useEffect(() => {
        setSelectedWorkspace(prev => {
            if (!prev) return resolveDefaultWorkspace(visibleProjects);
            // Always use the latest project data (not stale prev reference)
            // so that settings changed in Chat via patchProject are reflected
            const updated = visibleProjects.find(p => p.id === prev.id);
            return updated ?? resolveDefaultWorkspace(visibleProjects);
        });
    }, [visibleProjects, resolveDefaultWorkspace]);

    const [launcherPermissionMode, setLauncherPermissionMode] = useState<PermissionMode>(config.defaultPermissionMode);
    const [launcherProviderId, setLauncherProviderId] = useState<string | undefined>();
    const [launcherSelectedModel, setLauncherSelectedModel] = useState<string | undefined>();

    // Runtime state — adapts model/permission selectors when workspace uses external runtime
    const multiAgentRuntimeEnabled = !!config.multiAgentRuntime;

    // MCP state
    const [launcherMcpServers, setLauncherMcpServers] = useState<McpServerDefinition[]>([]);
    const [launcherGlobalMcpEnabled, setLauncherGlobalMcpEnabled] = useState<string[]>([]);
    const [launcherWorkspaceMcpEnabled, setLauncherWorkspaceMcpEnabled] = useState<string[]>([]);

    // Resolve AgentConfig for selected workspace (source of truth for AI settings)
    const selectedAgent = useMemo(() => {
        if (!selectedWorkspace?.agentId) return undefined;
        return getAgentById(config, selectedWorkspace.agentId);
    }, [selectedWorkspace?.agentId, config]);

    // Ref for runtimeConfig — avoids stale closure in rapid write-back handlers
    const runtimeConfigRef = useRef(selectedAgent?.runtimeConfig);
    runtimeConfigRef.current = selectedAgent?.runtimeConfig;

    // Runtime-aware model/permission lists — adapts input bar for external runtimes
    const launcherRuntime: RuntimeType = multiAgentRuntimeEnabled
        ? ((selectedAgent?.runtime as RuntimeType) || 'builtin') : 'builtin';
    const isExternalRuntime = launcherRuntime !== 'builtin';

    // Codex models are dynamic (fetched from app-server); CC models are static
    const [codexModels, setCodexModels] = useState<RuntimeModelInfo[]>([]);
    useEffect(() => {
        if (!multiAgentRuntimeEnabled || launcherRuntime !== 'codex') { setCodexModels([]); return; }
        let cancelled = false;
        apiGetJson<{ models?: RuntimeModelInfo[] }>('/api/runtime/models?type=codex')
            .then(res => { if (!cancelled && res?.models?.length) setCodexModels(res.models); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [multiAgentRuntimeEnabled, launcherRuntime]);

    const launcherRuntimeModels: RuntimeModelInfo[] | undefined = launcherRuntime === 'claude-code' ? CC_MODELS
        : launcherRuntime === 'codex' ? codexModels : undefined;
    const launcherRuntimePermissionModes: RuntimePermissionMode[] | undefined = launcherRuntime === 'claude-code'
        ? CC_PERMISSION_MODES : launcherRuntime === 'codex' ? CODEX_PERMISSION_MODES : undefined;

    // Derive provider for launcher — only select providers with valid credentials
    const launcherProvider = useMemo(() => {
        const id = launcherProviderId ?? selectedAgent?.providerId ?? selectedWorkspace?.providerId ?? config.defaultProviderId;
        return resolveProvider(id, providers, apiKeys, providerVerifyStatus);
    }, [launcherProviderId, selectedAgent, selectedWorkspace, config.defaultProviderId, providers, apiKeys, providerVerifyStatus]);

    // Load MCP servers when workspace changes
    useEffect(() => {
        const load = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
                setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace?.mcpEnabledServers ?? []);
            } catch (err) {
                console.warn('[Launcher] Failed to load MCP servers:', err);
            }
        };
        void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedWorkspace?.id]);

    // Refresh MCP local state when tab becomes active (inactive → active transition).
    // Config/projects/providers/apiKeys are shared via ConfigProvider and auto-sync.
    // MCP servers are local state, so we reload them from disk on tab activation.
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;

        void (async () => {
            try {
                const servers = await getAllMcpServers();
                const enabled = await getEnabledMcpServerIds();
                setLauncherMcpServers(servers);
                setLauncherGlobalMcpEnabled(enabled);
            } catch (err) {
                console.warn('[Launcher] Failed to reload MCP servers on activation:', err);
            }
        })();
    }, [isActive]);

    // Handle workspace MCP toggle — persist to project config via patchProject (updates disk + React state)
    const handleWorkspaceMcpToggle = useCallback((serverId: string, enabled: boolean) => {
        setLauncherWorkspaceMcpEnabled(prev => {
            const newEnabled = enabled ? [...prev, serverId] : prev.filter(id => id !== serverId);
            if (selectedWorkspace) {
                void patchProject(selectedWorkspace.id, { mcpEnabledServers: newEnabled });
                if (selectedWorkspace.agentId) {
                    void patchAgentConfig(selectedWorkspace.agentId, { mcpEnabledServers: newEnabled });
                }
            }
            return newEnabled;
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes, not on every property change
    }, [selectedWorkspace?.id, patchProject]);

    // Restore launcherLastUsed settings once config finishes loading from disk.
    // useState initializers run before async config load completes (config = DEFAULT_CONFIG
    // at that point), so we must sync saved values via effect after isLoading becomes false.
    const lastUsedAppliedRef = useRef(false);
    useEffect(() => {
        if (isLoading || lastUsedAppliedRef.current) return;
        lastUsedAppliedRef.current = true;
        const lastUsed = config.launcherLastUsed;
        if (!lastUsed) return;
        if (lastUsed.permissionMode) setLauncherPermissionMode(lastUsed.permissionMode);
        if (lastUsed.providerId) setLauncherProviderId(lastUsed.providerId);
        if (lastUsed.model) setLauncherSelectedModel(lastUsed.model);
        if (lastUsed.mcpEnabledServers) setLauncherWorkspaceMcpEnabled(lastUsed.mcpEnabledServers);
    }, [isLoading, config.launcherLastUsed]);

    // Extract runtimeConfig primitives for stable useEffect deps (avoid object reference)
    const agentRuntimeModel = (selectedAgent?.runtimeConfig as { model?: string } | undefined)?.model;
    const agentRuntimePermMode = (selectedAgent?.runtimeConfig as { permissionMode?: string } | undefined)?.permissionMode;

    // Sync launcher settings from selected workspace's per-project config.
    // Declared AFTER launcherLastUsed effect so project settings take priority on initial load.
    // Priority: project setting > global default (launcherLastUsed is global, not per-workspace)
    // Depends on individual fields (not just .id) so it re-runs when Chat's patchProject updates them.
    useEffect(() => {
        if (isLoading || !selectedWorkspace) return;
        // For external runtimes, model and permission come from runtimeConfig.
        // Branch on isExternalRuntime alone — empty runtimeConfig is valid (uses runtime defaults).
        if (isExternalRuntime) {
            setLauncherSelectedModel(agentRuntimeModel ?? undefined);
            setLauncherPermissionMode((agentRuntimePermMode as PermissionMode | undefined) ?? config.defaultPermissionMode);
        } else {
            setLauncherPermissionMode((selectedAgent?.permissionMode as PermissionMode | undefined) ?? selectedWorkspace.permissionMode ?? config.defaultPermissionMode);
            setLauncherSelectedModel(selectedAgent?.model ?? selectedWorkspace.model ?? undefined);
        }
        setLauncherProviderId(selectedAgent?.providerId ?? selectedWorkspace.providerId ?? undefined);
        setLauncherWorkspaceMcpEnabled(selectedAgent?.mcpEnabledServers ?? selectedWorkspace.mcpEnabledServers ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depend on specific agent/project fields, not object ref
    }, [isLoading, selectedWorkspace?.id, selectedAgent?.permissionMode, selectedAgent?.model, selectedAgent?.providerId, selectedAgent?.mcpEnabledServers, selectedAgent?.runtime, agentRuntimeModel, agentRuntimePermMode, selectedWorkspace?.permissionMode, selectedWorkspace?.model, selectedWorkspace?.providerId, selectedWorkspace?.mcpEnabledServers, config.defaultPermissionMode, multiAgentRuntimeEnabled, isExternalRuntime]);

    // Write-back handlers: persist Launcher setting changes to the selected project

    const handleLauncherPermissionModeChange = useCallback((mode: PermissionMode) => {
        setLauncherPermissionMode(mode);
        if (selectedWorkspace) {
            if (isExternalRuntime && selectedWorkspace.agentId) {
                // External runtime: persist to runtimeConfig via ref (avoids stale closure on rapid changes)
                void patchAgentConfig(selectedWorkspace.agentId, {
                    runtimeConfig: { ...runtimeConfigRef.current, permissionMode: mode },
                });
            } else {
                void patchProject(selectedWorkspace.id, { permissionMode: mode });
                if (selectedWorkspace.agentId) {
                    void patchAgentConfig(selectedWorkspace.agentId, { permissionMode: mode });
                }
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    const handleLauncherModelChange = useCallback((model: string | undefined) => {
        setLauncherSelectedModel(model);
        if (selectedWorkspace) {
            if (isExternalRuntime && selectedWorkspace.agentId) {
                // External runtime: persist to runtimeConfig via ref (avoids stale closure on rapid changes)
                void patchAgentConfig(selectedWorkspace.agentId, {
                    runtimeConfig: { ...runtimeConfigRef.current, model: model ?? undefined },
                });
            } else {
                void patchProject(selectedWorkspace.id, { model: model ?? null });
                if (selectedWorkspace.agentId) {
                    void patchAgentConfig(selectedWorkspace.agentId, { model: model ?? undefined });
                }
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- narrowed deps; runtimeConfigRef is a ref
    }, [selectedWorkspace?.id, patchProject, isExternalRuntime]);

    const handleLauncherProviderChange = useCallback((providerId: string | undefined, targetModel?: string) => {
        setLauncherProviderId(providerId);
        const newProvider = providerId ? providers.find(p => p.id === providerId) : undefined;
        const model = targetModel ?? newProvider?.primaryModel;
        if (model) {
            setLauncherSelectedModel(model);
        }
        if (selectedWorkspace) {
            const patch: Partial<Omit<Project, 'id'>> = { providerId: providerId ?? undefined };
            if (model) patch.model = model;
            void patchProject(selectedWorkspace.id, patch);
            if (selectedWorkspace.agentId) {
                void patchAgentConfig(selectedWorkspace.agentId, { providerId: providerId ?? undefined, model: model ?? undefined });
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-create when workspace ID changes
    }, [selectedWorkspace?.id, patchProject, providers]);

    // Navigate to Settings > Providers page
    const handleGoToSettings = useCallback(() => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
            detail: { section: 'providers' },
        }));
    }, []);

    // Handle send from BrandSection
    const handleBrandSend = useCallback(async (text: string, images?: ImageAttachment[]) => {
        if (!selectedWorkspace) {
            toastRef.current.error('请先选择工作区');
            return;
        }

        const initialMessage: InitialMessage = {
            text,
            images,
            permissionMode: launcherPermissionMode,
            model: launcherSelectedModel,
            providerId: launcherProvider?.id,
            mcpEnabledServers: launcherWorkspaceMcpEnabled.filter(id => launcherGlobalMcpEnabled.includes(id)),
        };

        // Persist launcher settings for next app launch
        updateConfig({
            launcherLastUsed: {
                providerId: launcherProvider?.id,
                model: launcherSelectedModel,
                permissionMode: launcherPermissionMode,
                mcpEnabledServers: launcherWorkspaceMcpEnabled,
            },
        }).catch(err => console.warn('[Launcher] Failed to save launcherLastUsed:', err));

        setLaunchingProjectId(selectedWorkspace.id);
        touchProject(selectedWorkspace.id).catch(() => {});
        // launcherProvider may be undefined if no provider has valid credentials —
        // fall back to the first provider in the list so the chat can still open
        // (provider selector in SimpleChatInput will show the setup guidance)
        const effectiveProvider = launcherProvider ?? providers[0];
        if (!effectiveProvider) return; // No providers at all (shouldn't happen — PRESET_PROVIDERS always exists)
        onLaunchProject(selectedWorkspace, effectiveProvider, undefined, initialMessage);
    }, [selectedWorkspace, launcherProvider, providers, launcherPermissionMode,
        launcherSelectedModel, launcherWorkspaceMcpEnabled, launcherGlobalMcpEnabled,
        touchProject, onLaunchProject, updateConfig]);

    // Path input dialog state (for browser dev mode)
    const [pathDialogOpen, setPathDialogOpen] = useState(false);
    const [pendingFolderName, setPendingFolderName] = useState('');
    const [pendingDefaultPath, setPendingDefaultPath] = useState('');

    const handleLaunch = useCallback((project: Project, sessionId?: string) => {
        setLaunchingProjectId(project.id);
        const providerId = project.providerId ?? config.defaultProviderId;
        const provider = resolveProvider(providerId, providers, apiKeys, providerVerifyStatus);
        if (!provider) {
            // No available provider — let the launch proceed anyway; Chat will show empty state
            const fallback = providers.find(p => p.id === providerId) ?? providers[0];
            if (fallback) {
                onLaunchProject(project, fallback, sessionId);
            }
            return;
        }
        // Update lastOpened timestamp (async, don't block launch)
        touchProject(project.id).catch((err) => {
            console.warn('[Launcher] Failed to update lastOpened:', err);
        });
        onLaunchProject(project, provider, sessionId);
    }, [config.defaultProviderId, providers, apiKeys, providerVerifyStatus, touchProject, onLaunchProject]);

    const handleOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleLaunch(project, session.id);
    }, [handleLaunch]);

    const handleOpenOverlay = useCallback(() => { track('task_center_open', {}); setShowOverlay(true); }, []);
    const handleCloseOverlay = useCallback(() => setShowOverlay(false), []);
    const handleOpenCronDetail = useCallback((task: CronTask) => setSelectedCronTask(task), []);
    const handleCloseCronDetail = useCallback(() => setSelectedCronTask(null), []);

    const handleCronOpenSession = useCallback((sessionId: string) => {
        const task = selectedCronTask;
        if (!task) return;
        const project = projects.find(p => p.path === task.workspacePath);
        if (project) {
            handleLaunch(project, sessionId);
        } else {
            toastRef.current.error('工作区已移除，无法打开会话');
        }
    }, [selectedCronTask, projects, handleLaunch]);

    // Derive bot info for selected cron task from agents[].channels[]
    const selectedTaskBotInfo = useMemo(() => {
        if (!selectedCronTask?.sourceBotId || !config.agents) return undefined;
        for (const agent of config.agents) {
            const channel = agent.channels?.find(ch => ch.id === selectedCronTask.sourceBotId);
            if (channel) {
                return { name: channel.name || agent.name, platform: channel.type };
            }
        }
        return undefined;
    }, [selectedCronTask?.sourceBotId, config.agents]);

    // Stable callback for overlay session open (avoids inline function in render)
    const handleOverlayOpenTask = useCallback((session: SessionMetadata, project: Project) => {
        handleOpenTask(session, project);
        handleCloseOverlay();
    }, [handleOpenTask, handleCloseOverlay]);

    const handleCronDelete = useCallback(async (taskId: string) => {
        await deleteCronTask(taskId);
        setSelectedCronTask(null);
        toastRef.current.success('定时任务已删除');
    }, []);

    const handleCronResume = useCallback(async (taskId: string) => {
        try {
            await startCronTask(taskId);
            await startCronScheduler(taskId);
            setSelectedCronTask(null);
            toastRef.current.success('任务已恢复运行');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Task was deleted elsewhere — close stale detail panel
            if (msg.includes('not found')) {
                setSelectedCronTask(null);
            }
            toastRef.current.error(`恢复失败: ${msg}`);
        }
    }, []);

    const handleCronStop = useCallback(async (taskId: string) => {
        try {
            await stopCronTask(taskId, '手动停止');
            setSelectedCronTask(null);
            toastRef.current.success('任务已停止');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not found')) {
                setSelectedCronTask(null);
            }
            toastRef.current.error(`停止失败: ${msg}`);
        }
    }, []);

    const handleAddProject = async () => {
        setAddError(null);
        console.log('[Launcher] handleAddProject called');

        try {
            if (isBrowserDevMode()) {
                const folderInfo = await pickFolderForDialog();
                if (folderInfo) {
                    setPendingFolderName(folderInfo.folderName);
                    setPendingDefaultPath(folderInfo.defaultPath);
                    setPathDialogOpen(true);
                } else {
                    console.log('[Launcher] Folder picker cancelled');
                }
            } else {
                const selected = await open({
                    directory: true,
                    multiple: false,
                    title: '选择项目文件夹',
                });
                console.log('[Launcher] Dialog result:', selected);

                if (selected && typeof selected === 'string') {
                    console.log('[Launcher] Adding project:', selected);
                    const project = await addProject(selected);
                    console.log('[Launcher] Project added:', project);
                } else {
                    console.log('[Launcher] No folder selected or dialog cancelled');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathConfirm = async (path: string) => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path confirmed:', path);

        try {
            const project = await addProject(path);
            console.log('[Launcher] Project added:', project);
            // Normalize path separators for cross-platform support
            const normalizedPath = path.replace(/\\/g, '/');
            const parentDir = normalizedPath.split('/').slice(0, -1).join('/');
            if (parentDir) {
                localStorage.setItem('pm-copilot:lastProjectDir', parentDir);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error('[Launcher] Failed to add project:', errorMsg);
            setAddError(errorMsg);
            toast.error(`添加项目失败: ${errorMsg}`);
        }
    };

    const handlePathCancel = () => {
        setPathDialogOpen(false);
        console.log('[Launcher] Path dialog cancelled');
    };

    const handleRemoveProject = (project: Project) => {
        setProjectToRemove(project);
    };

    const confirmRemoveProject = async () => {
        if (projectToRemove) {
            await removeProject(projectToRemove.id);
            setProjectToRemove(null);
        }
    };

    const handleCreateFromTemplate = useCallback(async (path: string, icon?: string, displayName?: string) => {
        const project = await addProject(path);
        track('workspace_create', { source: icon ? 'template' : 'blank' });
        const updates: { icon?: string; displayName?: string } = {};
        if (icon) updates.icon = icon;
        if (displayName) updates.displayName = displayName;
        if (Object.keys(updates).length > 0) {
            try {
                await patchProject(project.id, updates);
            } catch (err) {
                console.warn('[Launcher] Failed to patch template metadata, workspace created without icon/name:', err);
            }
        }
    }, [addProject, patchProject]);

    const handleEditProject = useCallback(async (projectId: string, updates: { displayName?: string; icon?: string }) => {
        await patchProject(projectId, updates);
    }, [patchProject]);

    const handleOpenTemplateDialog = useCallback(() => setShowTemplateDialog(true), []);
    const handleCloseTemplateDialog = useCallback(() => setShowTemplateDialog(false), []);
    const handleCloseEditDialog = useCallback(() => setEditingProject(null), []);

    // Agent overlay handlers
    const handleAgentSettings = useCallback((project: Project) => {
        setAgentOverlay({ workspacePath: project.path, initialTab: 'agent' });
    }, []);
    const handleCloseAgentOverlay = useCallback(() => setAgentOverlay(null), []);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
            {/* Path Input Dialog (browser dev mode) */}
            <PathInputDialog
                isOpen={pathDialogOpen}
                folderName={pendingFolderName}
                defaultPath={pendingDefaultPath}
                onConfirm={handlePathConfirm}
                onCancel={handlePathCancel}
            />

            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={[]}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
            />

            {/* Remove Workspace Confirm Dialog */}
            {projectToRemove && (
                <ConfirmDialog
                    title="移除工作区"
                    message={`确定要从列表中移除「${projectToRemove.name}」吗？此操作不会删除项目文件。`}
                    confirmText="移除"
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={confirmRemoveProject}
                    onCancel={() => setProjectToRemove(null)}
                />
            )}

            {/* Main Content: Two-column layout */}
            <main className="launcher-layout flex-1 overflow-hidden">
                {/* Left: Brand Section */}
                <section className="launcher-brand relative flex items-center justify-center overflow-hidden">
                    <BrandSection
                        projects={visibleProjects}
                        selectedProject={selectedWorkspace}
                        defaultWorkspacePath={config.defaultWorkspacePath}
                        onSelectWorkspace={setSelectedWorkspace}
                        onAddFolder={handleAddProject}
                        onSend={handleBrandSend}
                        isStarting={launchingProjectId === selectedWorkspace?.id && isStarting}
                        provider={launcherProvider}
                        providers={providers}
                        selectedModel={launcherSelectedModel}
                        onProviderChange={handleLauncherProviderChange}
                        onModelChange={handleLauncherModelChange}
                        permissionMode={launcherPermissionMode}
                        onPermissionModeChange={handleLauncherPermissionModeChange}
                        apiKeys={apiKeys}
                        providerVerifyStatus={providerVerifyStatus}
                        workspaceMcpEnabled={launcherWorkspaceMcpEnabled}
                        globalMcpEnabled={launcherGlobalMcpEnabled}
                        mcpServers={launcherMcpServers}
                        onWorkspaceMcpToggle={handleWorkspaceMcpToggle}
                        onRefreshProviders={refreshProviderData}
                        onGoToSettings={handleGoToSettings}
                        runtime={isExternalRuntime ? launcherRuntime : undefined}
                        runtimeModels={isExternalRuntime ? launcherRuntimeModels : undefined}
                        runtimePermissionModes={isExternalRuntime ? launcherRuntimePermissionModes : undefined}
                    />
                </section>

                {/* Right: Workspaces Section */}
                <section className="launcher-workspaces flex flex-col overflow-hidden">
                    {/* Recent Tasks */}
                    <div className="flex-shrink-0 px-6 pt-6">
                        <RecentTasks
                            projects={visibleProjects}
                            onOpenTask={handleOpenTask}
                            onOpenOverlay={handleOpenOverlay}
                            onOpenCronDetail={handleOpenCronDetail}
                            isActive={isActive}
                        />
                    </div>

                    {/* Workspaces Header */}
                    <div className="mx-6 border-t border-[var(--line)]" />
                    <div className="flex flex-shrink-0 items-center justify-between px-6 py-4">
                        <h2 className="text-[13px] font-semibold tracking-[0.04em] text-[var(--ink-muted)]">
                            Agent 工作区
                        </h2>
                        <div className="flex items-center gap-3">
                            {config.showDevTools && (
                                <button
                                    onClick={() => setShowLogs(true)}
                                    className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                                    title="查看 Rust 日志"
                                >
                                    Logs
                                </button>
                            )}
                            {visibleProjects.length > 0 && (
                                <AddWorkspaceMenu
                                    onAddFolder={handleAddProject}
                                    onCreateFromTemplate={handleOpenTemplateDialog}
                                />
                            )}
                        </div>
                    </div>

                    {/* Workspaces List */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
                        {isLoading ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]/50" />
                                <p className="mt-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</p>
                            </div>
                        ) : visibleProjects.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-16 text-center">
                                <h3 className="mb-1.5 text-[14px] font-medium text-[var(--ink)]">
                                    还没有工作区
                                </h3>
                                <p className="mb-6 max-w-[220px] text-[13px] leading-relaxed text-[var(--ink-muted)]/60">
                                    添加本地项目文件夹，或从模板快速创建
                                </p>
                                <div className="flex items-center gap-3">
                                    <button
                                        onClick={handleAddProject}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-secondary-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--button-secondary-text)] transition-all hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-sm"
                                    >
                                        <FolderPlus className="h-3.5 w-3.5" />
                                        添加文件夹
                                    </button>
                                    <button
                                        onClick={handleOpenTemplateDialog}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-4 py-2.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm"
                                    >
                                        <LayoutTemplate className="h-3.5 w-3.5" />
                                        从模板创建
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-3">
                                {visibleProjects.map((project) => {
                                    const agentData = agentLookup.get(project.path.replace(/\\/g, '/'));
                                    return (
                                        <WorkspaceCard
                                            key={project.id}
                                            project={project}
                                            agent={agentData?.agent}
                                            agentStatus={agentData?.status}
                                            onLaunch={handleLaunch}
                                            onRemove={handleRemoveProject}
                                            onAgentSettings={handleAgentSettings}
                                            isLoading={launchingProjectId === project.id && isStarting}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </section>
            </main>

            {/* Task Center Overlay */}
            {showOverlay && (
                <TaskCenterOverlay
                    projects={visibleProjects}
                    onOpenTask={handleOverlayOpenTask}
                    onOpenCronDetail={handleOpenCronDetail}
                    onClose={handleCloseOverlay}
                    isActive={isActive}
                />
            )}

            {/* Cron Task Detail Panel */}
            {selectedCronTask && (
                <CronTaskDetailPanel
                    task={selectedCronTask}
                    botInfo={selectedTaskBotInfo}
                    onClose={handleCloseCronDetail}
                    onDelete={handleCronDelete}
                    onResume={handleCronResume}
                    onStop={handleCronStop}
                    onOpenSession={handleCronOpenSession}
                />
            )}

            {/* Template Library Dialog */}
            {showTemplateDialog && (
                <TemplateLibraryDialog
                    onCreateWorkspace={handleCreateFromTemplate}
                    onClose={handleCloseTemplateDialog}
                />
            )}

            {/* Workspace Edit Dialog */}
            {editingProject && (
                <WorkspaceEditDialog
                    key={editingProject.id}
                    project={editingProject}
                    onSave={handleEditProject}
                    onClose={handleCloseEditDialog}
                />
            )}

            {/* Agent Config Overlay */}
            {agentOverlay && (
                <WorkspaceConfigPanel
                    agentDir={agentOverlay.workspacePath}
                    onClose={handleCloseAgentOverlay}
                    initialTab={agentOverlay.initialTab}
                />
            )}
        </div>
    );
}
