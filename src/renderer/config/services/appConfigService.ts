// AppConfig core — load, save, atomicModify, migration, availableProviders, bundledWorkspace, selfAwareness
import { join } from '@tauri-apps/api/path';

import {
    type AppConfig,
    DEFAULT_CONFIG,
    type Project,
    type Provider,
} from '../types';
import {
    isBrowserDevMode,
    withConfigLock,
    ensureConfigDir,
    getConfigDir,
    CONFIG_FILE,
    safeLoadJson,
    safeWriteJson,
} from './configStore';
import {
    mockLoadConfig,
    mockSaveConfig,
} from '@/utils/browserMock';
import { type ImBotConfig, DEFAULT_IM_BOT_CONFIG } from '../../../shared/types/im';
// Agent migration is triggered from ConfigProvider after both config + projects are loaded
import { isDebugMode } from '@/utils/debug';

// ============= Validation =============

function isValidAppConfig(data: unknown): data is AppConfig {
    return data !== null && typeof data === 'object' && !Array.isArray(data);
}

// ============= IM Bot Migration =============

let _imBotMigrationDone = false;

export function migrateImBotConfig(config: AppConfig): AppConfig {
    if (config.imBotConfig && !config.imBotConfigs && !_imBotMigrationDone) {
        _imBotMigrationDone = true;
        const legacy = config.imBotConfig;
        const migrated: ImBotConfig = {
            ...DEFAULT_IM_BOT_CONFIG,
            ...legacy,
            id: legacy.id || crypto.randomUUID(),
            name: legacy.name || 'Telegram Bot',
            platform: legacy.platform || 'telegram',
            setupCompleted: true,
        };
        config.imBotConfigs = [migrated];
        delete config.imBotConfig;
        saveAppConfig(config).catch(err => {
            console.error('[configService] Failed to persist imBotConfig migration:', err);
        });
    }
    return config;
}

// ============= Load / Save =============

export async function loadAppConfig(): Promise<AppConfig> {
    const dynamicDefault: AppConfig = {
        ...DEFAULT_CONFIG,
        showDevTools: isDebugMode(),
    };

    if (isBrowserDevMode()) {
        console.log('[configService] Browser mode: loading from localStorage');
        const loaded = mockLoadConfig();
        return { ...dynamicDefault, ...loaded };
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const configPath = await join(dir, CONFIG_FILE);

        const loaded = await safeLoadJson<AppConfig>(configPath, isValidAppConfig);
        if (loaded) {
            const merged = { ...dynamicDefault, ...loaded };
            return migrateImBotConfig(merged);
        }
        return dynamicDefault;
    } catch (error) {
        console.error('[configService] Failed to load app config:', error);
        return dynamicDefault;
    }
}

export async function saveAppConfig(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }

    return withConfigLock(async () => {
        try {
            await _writeAppConfigLocked(config);
        } catch (error) {
            console.error('[configService] Failed to save app config:', error);
            throw error;
        }
    });
}

/**
 * Atomically read-modify-write the app config.
 */
export async function atomicModifyConfig(
    modifier: (config: AppConfig) => AppConfig,
): Promise<AppConfig> {
    if (isBrowserDevMode()) {
        const latest = await loadAppConfig();
        const modified = modifier(latest);
        mockSaveConfig(modified);
        return modified;
    }
    return withConfigLock(async () => {
        const latest = await loadAppConfig();
        const modified = modifier(latest);
        await _writeAppConfigLocked(modified);
        return modified;
    });
}

/**
 * Internal: write config to disk without acquiring withConfigLock.
 * MUST only be called from within a withConfigLock block.
 */
async function _writeAppConfigLocked(config: AppConfig): Promise<void> {
    if (isBrowserDevMode()) {
        mockSaveConfig(config);
        return;
    }
    await ensureConfigDir();
    const dir = await getConfigDir();
    const configPath = await join(dir, CONFIG_FILE);
    await safeWriteJson(configPath, config);
}

// ============= Available Providers Cache =============

// Forward declarations for circular-dependency-free import
// These are passed in from providerService via rebuildAndPersistAvailableProviders below
import type { ModelEntity } from '../types';

/**
 * Merge preset custom models into providers.
 * Shared utility used by both providerService and this module.
 */
export function mergePresetCustomModels(
    providers: Provider[],
    presetCustomModels: Record<string, ModelEntity[]> | undefined,
    presetRemovedModels?: Record<string, string[]>,
): Provider[] {
    const hasCustom = presetCustomModels && Object.keys(presetCustomModels).length > 0;
    const hasRemoved = presetRemovedModels && Object.keys(presetRemovedModels).length > 0;
    if (!hasCustom && !hasRemoved) return providers;

    return providers.map(provider => {
        if (!provider.isBuiltin) return provider;
        const customModels = presetCustomModels?.[provider.id];
        const removedIds = presetRemovedModels?.[provider.id];
        if (!customModels?.length && !removedIds?.length) return provider;

        const removedSet = new Set(removedIds ?? []);

        // 1. 预设模型：排除用户删除的，从 discovered 补充元数据
        const presetIds = new Set(provider.models.map(m => m.model));
        const enrichedPresets = provider.models
            .filter(m => !removedSet.has(m.model))
            .map(preset => {
                const extra = customModels?.find(c => c.model === preset.model);
                if (!extra) return preset;
                return {
                    ...preset,
                    contextLength: preset.contextLength ?? extra.contextLength,
                    maxOutputTokens: preset.maxOutputTokens ?? extra.maxOutputTokens,
                    inputModalities: preset.inputModalities ?? extra.inputModalities,
                    outputModalities: preset.outputModalities ?? extra.outputModalities,
                };
            });
        // 2. 用户添加的新模型（不在预设中的）
        const newModels = customModels?.filter(c => !presetIds.has(c.model)) ?? [];

        return {
            ...provider,
            models: [...enrichedPresets, ...newModels],
        };
    });
}

// ============= Bundled Workspace =============

let _bundledWorkspaceChecked = false;

export async function ensureBundledWorkspace(): Promise<boolean> {
    if (_bundledWorkspaceChecked) return false;
    _bundledWorkspaceChecked = true;

    if (isBrowserDevMode()) return false;

    try {
        // Lazy import to break circular dep (addProject is in projectService)
        const { addProject } = await import('./projectService');
        const { loadProjects } = await import('./projectService');

        const { invoke } = await import('@tauri-apps/api/core');
        const result = await invoke<{ path: string; is_new: boolean }>('cmd_initialize_bundled_workspace');

        if (result.is_new) {
            const project = await addProject(result.path);
            // Set Mino icon and display name for the bundled workspace
            const { patchProject } = await import('./projectService');
            try {
                await patchProject(project.id, { icon: 'lightning', displayName: 'Coco' });
            } catch (e) {
                console.warn('[configService] Failed to set bundled workspace icon:', e);
            }
            await withConfigLock(async () => {
                const config = await loadAppConfig();
                if (!config.defaultWorkspacePath) {
                    await _writeAppConfigLocked({ ...config, defaultWorkspacePath: result.path });
                }
            });
            console.log('[configService] Bundled workspace initialized:', result.path);
            return true;
        }

        const projects = await loadProjects();
        const normalizedResult = result.path.replace(/\\/g, '/');
        const found = projects.some(p => p.path.replace(/\\/g, '/') === normalizedResult);
        if (!found) {
            const project = await addProject(result.path);
            const { patchProject } = await import('./projectService');
            try {
                await patchProject(project.id, { icon: 'lightning', displayName: 'Coco' });
            } catch (e) {
                console.warn('[configService] Failed to set recovered workspace icon:', e);
            }
            console.log('[configService] Bundled workspace recovered into projects:', result.path);
            return true;
        }

        return false;
    } catch (err) {
        console.warn('[configService] ensureBundledWorkspace failed:', err);
        return false;
    }
}

// ============= Self-Awareness Workspace (Bug Report) =============

/**
 * Ensure ~/.pm-copilot is registered as an internal project. Called on-demand when user triggers bug report.
 *
 * Accepts ConfigProvider's wrapped actions (addProject/patchProject) so that both disk AND React state
 * are updated. Calling projectService directly would only write to disk, leaving ConfigProvider stale.
 */
export async function ensureSelfAwarenessWorkspace(
    projects: Project[],
    addProject: (path: string) => Promise<Project>,
    patchProject: (id: string, updates: Partial<Omit<Project, 'id'>>) => Promise<void>,
): Promise<Project | null> {
    if (isBrowserDevMode()) return null;
    try {
        const dir = await getConfigDir();
        const normalizedDir = dir.replace(/\\/g, '/');
        let project = projects.find(p => p.path.replace(/\\/g, '/') === normalizedDir);
        if (!project) {
            project = await addProject(dir);
        }
        if (project && !project.internal) {
            await patchProject(project.id, { internal: true, name: 'PM Copilot 诊断' });
            // patchProject updates both disk and React state; use the patched fields locally
            project = { ...project, internal: true, name: 'PM Copilot 诊断' };
        }
        return project ?? null;
    } catch (err) {
        console.warn('[configService] ensureSelfAwarenessWorkspace failed:', err);
        return null;
    }
}
