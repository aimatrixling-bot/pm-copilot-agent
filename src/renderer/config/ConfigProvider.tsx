// ConfigProvider — single source of truth for app config state
// Dual Context pattern: data (changes often) vs actions (stable references)
import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type ModelEntity,
    type Project,
    type ModelAliases,
    type Provider,
    type ProviderVerifyStatus,
    PRESET_PROVIDERS,
} from './types';
import {
    loadAppConfig,
    atomicModifyConfig,
    ensureBundledWorkspace,
    mergePresetCustomModels,
} from './services/appConfigService';
import {
    getAllProviders,
    loadApiKeys as loadApiKeysService,
    saveApiKey as saveApiKeyService,
    deleteApiKey as deleteApiKeyService,
    loadProviderVerifyStatus as loadProviderVerifyStatusService,
    saveProviderVerifyStatus as saveProviderVerifyStatusService,
    saveCustomProvider as saveCustomProviderService,
    deleteCustomProvider as deleteCustomProviderService,
    rebuildAndPersistAvailableProviders,
} from './services/providerService';
import {
    loadProjects,
    saveProjects,
    addProject as addProjectService,
    updateProject as updateProjectService,
    patchProject as patchProjectService,
    removeProject as removeProjectService,
    touchProject as touchProjectService,
} from './services/projectService';
import { migrateImBotConfigsToAgents, persistAgents, ensureAllProjectsHaveAgent, addAgentConfig } from './services/agentConfigService';
import { isTauriEnvironment } from '@/utils/browserMock';

/**
 * Normalize agents loaded from disk: ensure every agent has a `channels` array.
 * External tools (e.g., AI bots editing config.json) may produce agents without
 * the `channels` field, which would crash downstream iteration.
 * Returns true if any agent was repaired (caller should persist).
 */
function normalizeAgents(config: AppConfig): boolean {
    if (!config.agents) return false;
    let repaired = false;
    for (const agent of config.agents) {
        if (!Array.isArray(agent.channels)) {
            agent.channels = [];
            repaired = true;
        }
    }
    return repaired;
}

/**
 * Migrate old hardcoded openclawEnabledToolGroups to the full set.
 * Before v0.1.56, ChannelWizard wrote a fixed subset ['doc','chat','wiki_drive','bitable']
 * which silently hid calendar/task/sheet/search/common/im tools.
 * Expand to all known groups so everything is enabled.
 */
const LEGACY_TOOL_GROUPS = new Set(['doc', 'chat', 'wiki_drive', 'bitable']);
// Exclude sensitive groups (im, perm) from auto-migration — keep them opt-in
const ALL_KNOWN_TOOL_GROUPS = ['doc', 'chat', 'wiki_drive', 'bitable', 'calendar', 'task', 'sheet', 'search', 'common'];
function migrateToolGroups(config: AppConfig): boolean {
    if (!config.agents) return false;
    let changed = false;
    for (const agent of config.agents) {
        for (const ch of (agent.channels ?? [])) {
            const groups = ch.openclawEnabledToolGroups;
            if (!groups || groups.length === 0) continue;
            // Only expand if it's the exact old default (user didn't customize)
            if (groups.length === LEGACY_TOOL_GROUPS.size && groups.every(g => LEGACY_TOOL_GROUPS.has(g))) {
                ch.openclawEnabledToolGroups = [...ALL_KNOWN_TOOL_GROUPS];
                changed = true;
            }
        }
    }
    if (changed) {
        console.log('[ConfigProvider] Migrated legacy openclawEnabledToolGroups → all groups enabled');
    }
    return changed;
}

// ============= Context Types =============

export interface ConfigDataValue {
    config: AppConfig;
    projects: Project[];
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus: Record<string, ProviderVerifyStatus>;
    isLoading: boolean;
    error: string | null;
}

export interface ConfigActionsValue {
    updateConfig: (updates: Partial<AppConfig>) => Promise<void>;
    refreshConfig: () => Promise<void>;
    reload: () => Promise<void>;
    refreshProviderData: () => Promise<void>;
    // Projects
    addProject: (path: string) => Promise<Project>;
    updateProject: (project: Project) => Promise<void>;
    patchProject: (projectId: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>;
    removeProject: (projectId: string) => Promise<void>;
    touchProject: (projectId: string) => Promise<void>;
    // Providers
    addCustomProvider: (provider: Provider) => Promise<void>;
    updateCustomProvider: (provider: Provider) => Promise<void>;
    deleteCustomProvider: (providerId: string) => Promise<void>;
    refreshProviders: () => Promise<void>;
    // Preset custom models
    savePresetCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
    removePresetCustomModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider primary model override
    savePrimaryModel: (providerId: string, modelId: string) => Promise<void>;
    // Provider model aliases (SDK sub-agent model mapping)
    saveProviderModelAliases: (providerId: string, aliases: ModelAliases) => Promise<void>;
    // API Keys
    saveApiKey: (providerId: string, apiKey: string) => Promise<void>;
    deleteApiKey: (providerId: string) => Promise<void>;
    // Verify status
    saveProviderVerifyStatus: (providerId: string, status: 'valid' | 'invalid', accountEmail?: string) => Promise<void>;
}

// ============= Contexts =============

export const ConfigDataContext = createContext<ConfigDataValue | null>(null);
export const ConfigActionsContext = createContext<ConfigActionsValue | null>(null);

// ============= Provider Component =============

export function ConfigProvider({ children }: { children: React.ReactNode }) {
    const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
    const [projects, setProjects] = useState<Project[]>([]);
    const [rawProviders, setRawProviders] = useState<Provider[]>(PRESET_PROVIDERS);
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
    const [providerVerifyStatus, setProviderVerifyStatus] = useState<Record<string, ProviderVerifyStatus>>({});
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Derived: merge preset custom models + apply user primary model overrides
    const providers = useMemo(() => {
        const merged = mergePresetCustomModels(rawProviders, config.presetCustomModels, config.presetRemovedModels);
        const overrides = config.providerPrimaryModels;
        if (!overrides || Object.keys(overrides).length === 0) return merged;
        // Apply user's primaryModel override directly on the Provider object
        // so ALL consumers see the correct value without needing getEffectivePrimaryModel()
        return merged.map(p => {
            const userPrimary = overrides[p.id];
            if (!userPrimary || !p.models?.some(m => m.model === userPrimary)) return p;
            return { ...p, primaryModel: userPrimary };
        });
    }, [rawProviders, config.presetCustomModels, config.presetRemovedModels, config.providerPrimaryModels]);

    // Mount guard
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    // ============= Load All Data =============

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);

        try {
            await ensureBundledWorkspace();
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const results = await Promise.allSettled([
                    invoke('cmd_sync_admin_agent'),
                    invoke('cmd_sync_cli'),
                ]);
                for (const r of results) {
                    if (r.status === 'rejected') {
                        console.warn('[ConfigProvider] Sync failed:', r.reason);
                    }
                }
            } catch (e) {
                console.warn('[ConfigProvider] Agent/CLI sync failed:', e);
            }

            const [rawConfig, loadedProjects, loadedProviders, loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadAppConfig(),
                loadProjects(),
                getAllProviders(),
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);

            // Migrate legacy imBotConfigs → agents (one-time, skipped if already migrated)
            const preMigrationAgentsCount = rawConfig.agents?.length ?? 0;
            const loadedConfig = migrateImBotConfigsToAgents(rawConfig, loadedProjects);
            if ((loadedConfig.agents?.length ?? 0) > preMigrationAgentsCount) {
                // Create timestamped backup before persisting migration
                try {
                    const { getConfigDir, CONFIG_FILE } = await import('./services/configStore');
                    const { copyFile, exists } = await import('@tauri-apps/plugin-fs');
                    const { join } = await import('@tauri-apps/api/path');
                    const dir = await getConfigDir();
                    const configPath = await join(dir, CONFIG_FILE);
                    if (await exists(configPath)) {
                        const ts = new Date().toISOString().replace(/[:.]/g, '-');
                        await copyFile(configPath, await join(dir, `config.json.bak.${ts}`));
                    }
                } catch (e) {
                    console.warn('[ConfigProvider] Migration backup failed:', e);
                }
                // Persist agents + project isAgent/agentId changes
                await persistAgents(loadedConfig.agents!);
                await saveProjects(loadedProjects);
            }

            // One-time cleanup: remove imBotConfigs entries whose credentials
            // now exist in agents[].channels[] (post-migration duplicates)
            // Re-read from disk in case migration cleared in-memory but didn't persist imBotConfigs
            const diskImBotConfigs = (await loadAppConfig())?.imBotConfigs ?? loadedConfig.imBotConfigs ?? [];
            if (loadedConfig.agents?.length && diskImBotConfigs.length) {
                loadedConfig.imBotConfigs = diskImBotConfigs;
                // Collect all credential fingerprints from agent channels
                const agentCredentials = new Set<string>();
                for (const agent of loadedConfig.agents) {
                    for (const ch of (agent.channels ?? [])) {
                        if (ch.feishuAppId) agentCredentials.add(`feishu:${ch.feishuAppId}`);
                        if (ch.botToken) agentCredentials.add(`botToken:${ch.botToken}`);
                        if (ch.dingtalkClientId) agentCredentials.add(`dingtalk:${ch.dingtalkClientId}`);
                        if (ch.openclawPluginConfig?.appId) agentCredentials.add(`openclaw:${ch.openclawPluginConfig.appId}`);
                    }
                }

                const remaining = loadedConfig.imBotConfigs.filter(bot => {
                    if (bot.feishuAppId && agentCredentials.has(`feishu:${bot.feishuAppId}`)) return false;
                    if (bot.botToken && agentCredentials.has(`botToken:${bot.botToken}`)) return false;
                    if (bot.dingtalkClientId && agentCredentials.has(`dingtalk:${bot.dingtalkClientId}`)) return false;
                    if (bot.openclawPluginConfig?.appId && agentCredentials.has(`openclaw:${bot.openclawPluginConfig.appId}`)) return false;
                    return true;
                });

                const removedCount = loadedConfig.imBotConfigs.length - remaining.length;
                if (removedCount > 0) {
                    console.log(`[ConfigProvider] Cleaning up ${removedCount} legacy imBotConfigs entry(ies) already migrated to agents`);
                    loadedConfig.imBotConfigs = remaining;
                    await atomicModifyConfig(c => ({ ...c, imBotConfigs: remaining }));
                }
            }

            await rebuildAndPersistAvailableProviders();

            // Normalize agents and self-heal corrupted config on disk
            if (normalizeAgents(loadedConfig) && loadedConfig.agents) {
                await persistAgents(loadedConfig.agents);
                console.log('[ConfigProvider] Repaired agents with missing channels — persisted to disk');
            }

            // Migrate old hardcoded tool groups → undefined (= all groups enabled)
            if (migrateToolGroups(loadedConfig) && loadedConfig.agents) {
                await persistAgents(loadedConfig.agents);
            }

            // Ensure every project has a linked AgentConfig (basicAgent).
            // Runs after IM migration + normalize so all existing agents are already in place.
            const basicAgentResult = ensureAllProjectsHaveAgent(loadedConfig, loadedProjects, loadedConfig.defaultPermissionMode);
            if (basicAgentResult.changed) {
                await persistAgents(loadedConfig.agents!);
                await saveProjects(loadedProjects);
                console.log('[ConfigProvider] Created basicAgent(s) for projects without AgentConfig');
            }

            if (!isMountedRef.current) return;
            setConfig(loadedConfig);
            setProjects(loadedProjects);
            setRawProviders(loadedProviders);
            setApiKeys(loadedApiKeys);
            setProviderVerifyStatus(loadedVerifyStatus);
        } catch (err) {
            console.error('Failed to load config:', err);
            if (isMountedRef.current) {
                setError(err instanceof Error ? err.message : 'Failed to load configuration');
            }
        } finally {
            if (isMountedRef.current) {
                setIsLoading(false);
            }
        }
    }, []);

    // Initial load
    useEffect(() => {
        void load();
    }, [load]);

    // ============= Listen for im:bot-config-changed =============

    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlistenIm: (() => void) | undefined;
        let unlistenAgent: (() => void) | undefined;

        const refreshOnEvent = () => {
            if (!isMountedRef.current) return;
            loadAppConfig().then(latest => {
                normalizeAgents(latest);
                if (isMountedRef.current) setConfig(latest);
            }).catch(err => {
                console.error('[ConfigProvider] Failed to refresh config after config-changed:', err);
            });
        };

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string }>('im:bot-config-changed', refreshOnEvent).then(fn => {
                if (cancelled) fn();
                else unlistenIm = fn;
            });
            listen('agent:config-changed', refreshOnEvent).then(fn => {
                if (cancelled) fn();
                else unlistenAgent = fn;
            });
        });

        return () => {
            cancelled = true;
            unlistenIm?.();
            unlistenAgent?.();
        };
    }, []);

    // ============= Listen for Admin CLI config changes (via SSE → window event) =============

    useEffect(() => {
        const handler = () => {
            if (!isMountedRef.current) return;
            loadAppConfig().then(latest => {
                normalizeAgents(latest);
                if (isMountedRef.current) setConfig(latest);
            }).catch(err => {
                console.error('[ConfigProvider] Failed to refresh config after admin CLI change:', err);
            });
        };
        window.addEventListener('pm-copilot:config-changed', handler);
        return () => window.removeEventListener('pm-copilot:config-changed', handler);
    }, []);

    // ============= Actions =============

    const updateConfig = useCallback(async (updates: Partial<AppConfig>) => {
        const newConfig = await atomicModifyConfig(c => ({ ...c, ...updates }));
        setConfig(newConfig);
        // No more CONFIG_CHANGED event — all consumers share this Context
    }, []);

    const refreshConfig = useCallback(async () => {
        try {
            const latest = await loadAppConfig();
            normalizeAgents(latest);
            if (isMountedRef.current) setConfig(latest);
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh config:', err);
        }
    }, []);

    const refreshProviderData = useCallback(async () => {
        try {
            const [loadedApiKeys, loadedVerifyStatus] = await Promise.all([
                loadApiKeysService(),
                loadProviderVerifyStatusService(),
            ]);
            if (isMountedRef.current) {
                setApiKeys(loadedApiKeys);
                setProviderVerifyStatus(loadedVerifyStatus);
            }
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh provider data:', err);
        }
    }, []);

    const refreshProviders = useCallback(async () => {
        try {
            const loadedProviders = await getAllProviders();
            if (isMountedRef.current) setRawProviders(loadedProviders);
        } catch (err) {
            console.error('[ConfigProvider] Failed to refresh providers:', err);
        }
    }, []);

    // --- Projects ---

    const addProject = useCallback(async (path: string) => {
        const project = await addProjectService(path);

        // Auto-create basicAgent for new projects (or re-opened projects without agentId)
        if (!project.agentId) {
            const agentId = crypto.randomUUID();
            const basicAgent = {
                id: agentId,
                name: project.name,
                workspacePath: project.path,
                enabled: false,
                channels: [] as import('../../shared/types/agent').ChannelConfig[],
                permissionMode: config.defaultPermissionMode || 'plan',
                providerId: project.providerId ?? undefined,
                model: project.model ?? undefined,
                mcpEnabledServers: project.mcpEnabledServers,
            } as import('../../shared/types/agent').AgentConfig;
            await addAgentConfig(basicAgent);
            await patchProjectService(project.id, { agentId });
            project.agentId = agentId;
            // Update config state so agent is immediately available
            setConfig(prev => ({ ...prev, agents: [...(prev.agents ?? []), basicAgent] }));
        }

        setProjects((prev) => {
            const filtered = prev.filter((p) => p.id !== project.id);
            return [project, ...filtered];
        });
        return project;
    }, [config.defaultPermissionMode]);

    const updateProject = useCallback(async (project: Project) => {
        await updateProjectService(project);
        setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
    }, []);

    const patchProject = useCallback(async (projectId: string, updates: Partial<Omit<Project, 'id'>>) => {
        const updated = await patchProjectService(projectId, updates);
        if (updated) {
            setProjects((prev) => prev.map((p) => (p.id === projectId ? updated : p)));
        }
    }, []);

    const removeProject = useCallback(async (projectId: string) => {
        await removeProjectService(projectId);
        setProjects((prev) => prev.filter((p) => p.id !== projectId));
    }, []);

    const touchProject = useCallback(async (projectId: string) => {
        const updated = await touchProjectService(projectId);
        if (updated) {
            setProjects((prev) => {
                const filtered = prev.filter((p) => p.id !== projectId);
                return [updated, ...filtered];
            });
        }
    }, []);

    // --- API Keys ---

    const saveApiKey = useCallback(async (providerId: string, apiKey: string) => {
        await saveApiKeyService(providerId, apiKey);
        setApiKeys((prev) => ({ ...prev, [providerId]: apiKey }));
        await rebuildAndPersistAvailableProviders();
    }, []);

    const deleteApiKey = useCallback(async (providerId: string) => {
        await deleteApiKeyService(providerId);
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        await rebuildAndPersistAvailableProviders();
    }, []);

    // --- Verify Status ---

    const saveProviderVerifyStatus = useCallback(async (
        providerId: string,
        status: 'valid' | 'invalid',
        accountEmail?: string
    ) => {
        await saveProviderVerifyStatusService(providerId, status, accountEmail);
        setProviderVerifyStatus((prev) => ({
            ...prev,
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
            },
        }));
        // Rebuild availableProvidersJson so IM /provider command sees the updated status.
        // Without this, subscription verification changes don't propagate to the on-disk
        // cache until some other action (API key change, provider add) triggers a rebuild.
        await rebuildAndPersistAvailableProviders();
    }, []);

    // --- Custom Providers ---

    const addCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    const updateCustomProvider = useCallback(async (provider: Provider) => {
        await saveCustomProviderService(provider);
        await refreshProviders();
    }, [refreshProviders]);

    const deleteCustomProvider = useCallback(async (providerId: string) => {
        await deleteCustomProviderService(providerId);
        await deleteApiKeyService(providerId);
        await refreshProviders();
        setApiKeys((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        setProviderVerifyStatus((prev) => {
            const next = { ...prev };
            delete next[providerId];
            return next;
        });
        await rebuildAndPersistAvailableProviders();
    }, [refreshProviders]);

    // --- Preset Custom Models ---

    const savePresetCustomModels = useCallback(async (providerId: string, models: ModelEntity[]) => {
        const newConfig = await atomicModifyConfig(c => {
            const newPresetCustomModels = {
                ...c.presetCustomModels,
                [providerId]: models,
            };
            if (models.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    const removePresetCustomModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => {
            const currentModels = c.presetCustomModels?.[providerId] ?? [];
            const newModels = currentModels.filter(m => m.model !== modelId);
            const newPresetCustomModels = { ...c.presetCustomModels, [providerId]: newModels };
            if (newModels.length === 0) {
                delete newPresetCustomModels[providerId];
            }
            return { ...c, presetCustomModels: newPresetCustomModels };
        });
        setConfig(newConfig);
    }, []);

    const savePrimaryModel = useCallback(async (providerId: string, modelId: string) => {
        const newConfig = await atomicModifyConfig(c => ({
            ...c,
            providerPrimaryModels: { ...c.providerPrimaryModels, [providerId]: modelId },
        }));
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    const saveProviderModelAliases = useCallback(async (providerId: string, aliases: ModelAliases) => {
        // Strip empty strings — prevent sending model: "" upstream
        const cleaned: ModelAliases = {};
        if (aliases.sonnet) cleaned.sonnet = aliases.sonnet;
        if (aliases.opus) cleaned.opus = aliases.opus;
        if (aliases.haiku) cleaned.haiku = aliases.haiku;
        const newConfig = await atomicModifyConfig(c => {
            const newAliases = { ...c.providerModelAliases, [providerId]: cleaned };
            return { ...c, providerModelAliases: newAliases };
        });
        setConfig(newConfig);
        await rebuildAndPersistAvailableProviders();
    }, []);

    // ============= Memoized Context Values =============

    const data = useMemo<ConfigDataValue>(() => ({
        config, projects, providers, apiKeys, providerVerifyStatus, isLoading, error,
    }), [config, projects, providers, apiKeys, providerVerifyStatus, isLoading, error]);

    const actions = useMemo<ConfigActionsValue>(() => ({
        updateConfig, refreshConfig, reload: load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
    }), [
        updateConfig, refreshConfig, load, refreshProviderData,
        addProject, updateProject, patchProject, removeProject, touchProject,
        addCustomProvider, updateCustomProvider, deleteCustomProvider, refreshProviders,
        savePresetCustomModels, removePresetCustomModel, savePrimaryModel, saveProviderModelAliases,
        saveApiKey, deleteApiKey,
        saveProviderVerifyStatus,
    ]);

    return (
        <ConfigActionsContext.Provider value={actions}>
            <ConfigDataContext.Provider value={data}>
                {children}
            </ConfigDataContext.Provider>
        </ConfigActionsContext.Provider>
    );
}
