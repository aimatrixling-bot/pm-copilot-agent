// Provider management — custom providers, API keys, verify status, provider availability
import { exists, readDir, readTextFile, remove } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

import type { Provider, ProviderVerifyStatus } from '../types';
import { PRESET_PROVIDERS } from '../types';
import {
    isBrowserDevMode,
    ensureConfigDir,
    getConfigDir,
    PROVIDERS_DIR,
    safeWriteJson,
} from './configStore';
import {
    loadAppConfig,
    atomicModifyConfig,
    mergePresetCustomModels,
} from './appConfigService';
import { isDebugMode } from '@/utils/debug';

// Re-export mergePresetCustomModels for barrel
export { mergePresetCustomModels };

// ============= Custom Providers =============

export async function loadCustomProviders(): Promise<Provider[]> {
    if (isBrowserDevMode()) {
        return [];
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providersDir = await join(dir, PROVIDERS_DIR);

        if (!(await exists(providersDir))) {
            return [];
        }

        const entries = await readDir(providersDir);
        const providers: Provider[] = [];

        for (const entry of entries) {
            if (entry.isFile && entry.name.endsWith('.json')) {
                try {
                    const filePath = await join(providersDir, entry.name);
                    const content = await readTextFile(filePath);
                    const parsed = JSON.parse(content);
                    if (!parsed.id || !parsed.name || !parsed.config || !Array.isArray(parsed.models)) {
                        console.warn('[configService] Invalid provider file, skipping:', entry.name);
                        continue;
                    }
                    const p = parsed as Provider;
                    // 若 primaryModel 不在 models 中（如删除模型后未正确保存），自动修正并持久化
                    if (p.models.length > 0) {
                        const modelIds = p.models.map((m: { model: string }) => m.model);
                        if (!modelIds.includes(p.primaryModel)) {
                            p.primaryModel = p.models[0].model;
                            if (isDebugMode()) {
                                console.log('[configService] Fixed invalid primaryModel for provider:', p.id, '->', p.primaryModel);
                            }
                            try {
                                const providerPath = await join(providersDir, entry.name);
                                await safeWriteJson(providerPath, p);
                            } catch (e) {
                                console.warn('[configService] Failed to persist primaryModel fix:', e);
                            }
                        }
                    }
                    providers.push(p);
                } catch (parseError) {
                    console.error('[configService] Failed to parse provider file:', entry.name, parseError);
                }
            }
        }

        if (isDebugMode()) {
            console.log('[configService] Loaded custom providers:', providers.length);
        }
        return providers;
    } catch (error) {
        console.error('[configService] Failed to load custom providers:', error);
        return [];
    }
}

export async function getAllProviders(): Promise<Provider[]> {
    if (isBrowserDevMode()) {
        return PRESET_PROVIDERS;
    }

    const customProviders = await loadCustomProviders();
    return [...PRESET_PROVIDERS, ...customProviders];
}

export async function saveCustomProvider(provider: Provider): Promise<void> {
    if (isBrowserDevMode()) {
        console.warn('[configService] Custom providers not supported in browser mode');
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${provider.id}.json`);
        await safeWriteJson(providerPath, provider);
        if (isDebugMode()) {
            console.log('[configService] Saved custom provider:', provider.id);
        }
    } catch (error) {
        console.error('[configService] Failed to save custom provider:', error);
        throw error;
    }
}

export async function deleteCustomProvider(providerId: string): Promise<void> {
    if (isBrowserDevMode()) {
        return;
    }

    try {
        await ensureConfigDir();
        const dir = await getConfigDir();
        const providerPath = await join(dir, PROVIDERS_DIR, `${providerId}.json`);

        if (await exists(providerPath)) {
            await remove(providerPath);
            if (isDebugMode()) {
                console.log('[configService] Deleted custom provider:', providerId);
            }
        }
    } catch (error) {
        console.error('[configService] Failed to delete custom provider:', error);
        throw error;
    }
}

// ============= API Keys =============

export async function saveApiKey(providerId: string, apiKey: string): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        providerApiKeys: { ...(c.providerApiKeys ?? {}), [providerId]: apiKey },
    }));
    console.log('[configService] Saved API key for provider:', providerId);
}

export async function loadApiKeys(): Promise<Record<string, string>> {
    const config = await loadAppConfig();
    return config.providerApiKeys ?? {};
}

export async function deleteApiKey(providerId: string): Promise<void> {
    await atomicModifyConfig(c => {
        const apiKeys = { ...c.providerApiKeys };
        delete apiKeys[providerId];
        const verifyStatus = { ...c.providerVerifyStatus };
        delete verifyStatus[providerId];
        return { ...c, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus };
    });
    console.log('[configService] Deleted API key for provider:', providerId);
}

// ============= Provider Verify Status =============

export async function saveProviderVerifyStatus(
    providerId: string,
    status: 'valid' | 'invalid',
    accountEmail?: string
): Promise<void> {
    await atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
            ...(c.providerVerifyStatus ?? {}),
            [providerId]: {
                status,
                verifiedAt: new Date().toISOString(),
                accountEmail,
            },
        },
    }));
    console.log('[configService] Saved verify status for provider:', providerId, status);
}

export async function loadProviderVerifyStatus(): Promise<Record<string, ProviderVerifyStatus>> {
    const config = await loadAppConfig();
    return config.providerVerifyStatus ?? {};
}

export async function deleteProviderVerifyStatus(providerId: string): Promise<void> {
    await atomicModifyConfig(c => {
        const verifyStatus = { ...c.providerVerifyStatus };
        delete verifyStatus[providerId];
        return { ...c, providerVerifyStatus: verifyStatus };
    });
    console.log('[configService] Deleted verify status for provider:', providerId);
}

// ============= Available Providers Cache =============

export async function rebuildAndPersistAvailableProviders(): Promise<void> {
    try {
        const [allProviders, apiKeys, config] = await Promise.all([
            getAllProviders(),
            loadApiKeys(),
            loadAppConfig(),
        ]);
        const verifyStatus = config.providerVerifyStatus ?? {};

        const mergedProviders = mergePresetCustomModels(allProviders, config.presetCustomModels, config.presetRemovedModels as Record<string, string[]> | undefined);
        // Apply user primary model overrides
        const primaryOverrides = config.providerPrimaryModels as Record<string, string> | undefined;
        // Only include providers with valid credentials:
        // - Subscription: must have verified status + accountEmail (same as isProviderAvailable)
        // - API: must have a non-empty API key
        const availableProviders = mergedProviders
            .filter(p => isProviderAvailable(p, apiKeys, verifyStatus))
            .map(p => {
                const userPrimary = primaryOverrides?.[p.id];
                const effectivePrimary = (userPrimary && p.models?.some(m => m.model === userPrimary))
                    ? userPrimary : p.primaryModel;
                return {
                id: p.id, name: p.name, primaryModel: effectivePrimary,
                baseUrl: p.config.baseUrl, authType: p.authType,
                apiProtocol: p.apiProtocol,
                apiKey: p.type !== 'subscription' ? apiKeys[p.id] : undefined,
                models: p.models.map(m => ({ model: m.model, modelName: m.modelName })),
            };
            });

        const json = availableProviders.length > 0 ? JSON.stringify(availableProviders) : undefined;
        await atomicModifyConfig(c => ({ ...c, availableProvidersJson: json }));
    } catch (err) {
        console.warn('[configService] Failed to rebuild availableProvidersJson:', err);
    }
}

// ===== Provider Availability (shared logic — used by Chat, Launcher, SimpleChatInput, etc.) =====

/**
 * Check if a provider has valid credentials (subscription verified or API key present).
 * Subscription providers need verifyStatus.status === 'valid' AND accountEmail.
 * API providers just need a non-empty API key.
 */
export function isProviderAvailable(
    provider: Provider,
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): boolean {
    if (provider.type === 'subscription') {
        const result = verifyStatus[provider.id];
        return result?.status === 'valid' && !!result?.accountEmail;
    }
    return !!apiKeys[provider.id];
}

/**
 * Find the first available provider from the list (one with valid credentials).
 * Returns undefined if no providers are available — caller should show empty state.
 */
export function getFirstAvailableProvider(
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): Provider | undefined {
    return providers.find(p => isProviderAvailable(p, apiKeys, verifyStatus));
}

/**
 * Resolve provider by ID, with fallback to first available.
 * Returns undefined if requested provider not found AND no available provider exists.
 */
export function resolveProvider(
    providerId: string | undefined,
    providers: Provider[],
    apiKeys: Record<string, string>,
    verifyStatus: Record<string, ProviderVerifyStatus>,
): Provider | undefined {
    if (providerId) {
        const exact = providers.find(p => p.id === providerId);
        if (exact && isProviderAvailable(exact, apiKeys, verifyStatus)) return exact;
    }
    return getFirstAvailableProvider(providers, apiKeys, verifyStatus);
}
