import { Check, ChevronDown, Download, FolderOpen, KeyRound, Link, Loader2, Plus, RefreshCw, Square, Trash2, Unlink, X, AlertCircle, Globe, ExternalLink as ExternalLinkIcon, Settings2 } from 'lucide-react';
import { ExternalLink } from '@/components/ExternalLink';
import logoImage from '@/assets/logo.png';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir, join } from '@tauri-apps/api/path';

import { track } from '@/analytics';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { apiFetch, apiGetJson, apiPostJson } from '@/api/apiFetch';
import { useToast } from '@/components/Toast';
import CustomSelect from '@/components/CustomSelect';
import { UnifiedLogsPanel } from '@/components/UnifiedLogsPanel';
import GlobalSkillsPanel from '@/components/GlobalSkillsPanel';
import GlobalAgentsPanel from '@/components/GlobalAgentsPanel';
import CronTaskDebugPanel from '@/components/dev/CronTaskDebugPanel';
import { BotPlatformRegistry } from '@/components/ImSettings';
import { WorkspaceSelectDialog } from '@/components/AgentSettings';
import WorkspaceConfigPanel from '@/components/WorkspaceConfigPanel';
import ModelManagementPanel from '@/components/ModelManagementPanel';
import UsageStatsPanel from '@/components/UsageStatsPanel';
import {
    getEffectiveModelAliases,
    type ModelAliases,
    type Provider,
    type ProviderAuthType,
    type ApiProtocol,
    type McpServerDefinition,
    type McpServerType,
    type McpEnableError,
    MCP_DISCOVERY_LINKS,
    isVerifyExpired,
    SUBSCRIPTION_PROVIDER_ID,
    PROXY_DEFAULTS,
    isValidProxyHost,
    getPresetMcpServer,
} from '@/config/types';
import {
    getAllMcpServers,
    getEnabledMcpServerIds,
    toggleMcpServerEnabled,
    addCustomMcpServer,
    deleteCustomMcpServer,
    saveMcpServerArgs,
    getMcpServerArgs,
    getMcpServerEnv,
    atomicModifyConfig,
    isProviderAvailable,
} from '@/config/configService';
import { useConfig } from '@/hooks/useConfig';
import { useAutostart } from '@/hooks/useAutostart';
import { getBuildVersions } from '@/utils/debug';
import {
    isDeveloperSectionUnlocked,
    unlockDeveloperSection,
    UNLOCK_CONFIG,
} from '@/utils/developerMode';
import { REACT_LOG_EVENT } from '@/utils/frontendLogger';
import { CUSTOM_EVENTS } from '../../shared/constants';
import { isTauriEnvironment } from '@/utils/browserMock';
import { getPlatform } from '@/analytics/device';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import type { LogEntry } from '@/types/log';
import BugReportOverlay from '@/components/BugReportOverlay';

/** Parse a string as a positive integer, returning undefined for invalid/non-positive values */
function parsePositiveInt(value: string): number | undefined {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n <= 0 ? undefined : n;
}

// Settings sub-sections
type SettingsSection = 'general' | 'providers' | 'mcp' | 'skills' | 'sub-agents' | 'agent' | 'usage-stats' | 'about';

import type { SubscriptionStatusWithVerify } from '@/types/subscription';

// Verification status for each provider
type _VerifyStatus = 'idle' | 'loading' | 'valid' | 'invalid';

// Use shared type with verification state
type SubscriptionStatus = SubscriptionStatusWithVerify;

// Custom provider form data
interface CustomProviderForm {
    name: string;
    cloudProvider: string;  // 服务商标签
    apiProtocol: ApiProtocol;  // API 协议
    baseUrl: string;
    authType: Extract<ProviderAuthType, 'auth_token' | 'api_key'>;
    models: string[];  // 支持多个模型 ID
    newModelInput: string;  // 用于输入新模型的临时值
    apiKey: string;
    maxOutputTokens: string;  // 最大输出 token（字符串便于输入，空串=不限制）
    maxOutputTokensParamName: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';  // token limit 参数名
    upstreamFormat: 'chat_completions' | 'responses';  // 上游 API 格式
}

// isProviderAvailable imported from configService (shared across Chat, Launcher, Settings, SimpleChatInput)

const EMPTY_CUSTOM_FORM: CustomProviderForm = {
    name: '',
    cloudProvider: '',
    apiProtocol: 'anthropic',
    baseUrl: '',
    authType: 'auth_token',
    models: [],
    newModelInput: '',
    apiKey: '',
    maxOutputTokens: '',
    maxOutputTokensParamName: 'max_tokens',
    upstreamFormat: 'chat_completions',
};

// Provider edit form data (for managing existing providers)
interface ProviderEditForm {
    provider: Provider;
    customModels: string[];  // 用户添加的自定义模型
    removedModels: string[]; // 用户标记删除的已保存模型（model ID）
    newModelInput: string;
    // 自定义供应商编辑字段
    editName?: string;
    editCloudProvider?: string;
    editApiProtocol?: ApiProtocol;
    editBaseUrl?: string;
    editAuthType?: Extract<ProviderAuthType, 'auth_token' | 'api_key'>;
    editMaxOutputTokens?: string;
    editMaxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    editUpstreamFormat?: 'chat_completions' | 'responses';
    // Model alias mapping (sub-agent model redirection)
    editModelAliases?: ModelAliases;
    showAdvanced?: boolean;
}

interface SettingsProps {
    /** Initial section to display (e.g., 'providers') */
    initialSection?: string;
    /** MCP server ID to auto-open config dialog for */
    initialMcpId?: string;
    /** Callback when section changes (to clear initialSection) */
    onSectionChange?: () => void;
    /** Whether this tab is currently active/visible */
    isActive?: boolean;
    /** Whether an update is ready to install (from useUpdater) */
    updateReady?: boolean;
    /** Version ready to install (from useUpdater) */
    updateVersion?: string | null;
    /** Whether a manual check is in progress (from useUpdater) */
    updateChecking?: boolean;
    /** Whether an update is being downloaded (from useUpdater) */
    updateDownloading?: boolean;
    /** Trigger manual update check. Returns result for toast feedback. */
    onCheckForUpdate?: () => Promise<'up-to-date' | 'downloading' | 'error'>;
    /** Restart and install update (from useUpdater) */
    onRestartAndUpdate?: () => void;
}

const VALID_SECTIONS: SettingsSection[] = ['general', 'providers', 'mcp', 'skills', 'sub-agents', 'agent', 'usage-stats', 'about'];

// Memoized component for model tag list to avoid recreating presetModelIds on every render
/** Default args for Playwright MCP: persistent profile mode (preserves login state, single-session) */
async function getPlaywrightDefaultArgs(): Promise<string[]> {
    const home = await homeDir();
    const profilePath = await join(home, '.playwright-mcp-profile');
    return [`--user-data-dir=${profilePath}`];
}

/** Playwright device presets shared between parser and UI */
const PLAYWRIGHT_DEVICE_PRESETS = ['iPhone 15 Pro', 'iPhone 15', 'iPhone SE', 'iPad Pro 11', 'Pixel 7', 'Galaxy S23'];

export default function Settings({ initialSection, initialMcpId, onSectionChange, isActive, updateReady: propUpdateReady, updateVersion: propUpdateVersion, updateChecking, updateDownloading, onCheckForUpdate, onRestartAndUpdate }: SettingsProps) {
    const {
        apiKeys,
        saveApiKey,
        deleteApiKey: _deleteApiKeyService,
        providerVerifyStatus,
        saveProviderVerifyStatus,
        config,
        updateConfig,
        providers,
        projects,
        addProject,
        updateProject,
        addCustomProvider,
        updateCustomProvider,
        deleteCustomProvider: deleteCustomProviderService,
        refreshProviders,
        savePresetCustomModels,
        removePresetCustomModel: _removePresetCustomModel,
        savePrimaryModel,
        saveProviderModelAliases,
        refreshConfig,
    } = useConfig();
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Autostart hook for managing launch on startup
    const { isEnabled: autostartEnabled, isLoading: autostartLoading, setAutostart } = useAutostart();

    // Determine initial section: use initialSection if valid, otherwise default to 'providers'
    const getInitialSection = (): SettingsSection => {
        if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
            return initialSection as SettingsSection;
        }
        return 'providers';
    };

    const [activeSection, setActiveSection] = useState<SettingsSection>(getInitialSection);
    // Track whether Skills/Agents panels are in detail view (to hide the other panel)
    const [skillsInDetail, setSkillsInDetail] = useState(false);
    const [agentsInDetail, setAgentsInDetail] = useState(false);
    // Agent overlay state for viewing agent config from Settings card list
    const [overlayAgent, setOverlayAgent] = useState<{ agentId?: string; workspacePath: string } | null>(null);

    const [showWorkspaceSelect, setShowWorkspaceSelect] = useState(false);
    const [kbRootPath, setKbRootPath] = useState<string>('');
    const [modelInfo, setModelInfo] = useState<{ provider: string; model: string }>({ provider: '', model: '' });

    // Download progress — listen directly for Tauri events to avoid re-render blast radius
    // through the MemoizedTabContent tree (only Settings needs this value)
    const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        const promise = listen<{ percent: number | null }>('updater:download-progress', (event) => {
            if (!cancelled) setDownloadProgress(event.payload.percent);
        });
        return () => {
            cancelled = true;
            // If listen() already resolved, call the unlisten function; if still pending, clean up on resolve
            void promise.then(unlisten => unlisten());
        };
    }, []);
    // Reset progress when download completes (updateReady becomes true)
    useEffect(() => {
        if (propUpdateReady) setDownloadProgress(null);
    }, [propUpdateReady]);

    // Load KB root path and model info on mount
    useEffect(() => {
        apiGetJson<{ success: boolean; kbRootPath: string }>('/api/kb-path')
            .then(res => { if (res.success) setKbRootPath(res.kbRootPath); })
            .catch(() => { /* ignore */ });
        apiGetJson<{ provider: string; model: string }>('/api/model-info')
            .then(res => { if (res.provider || res.model) setModelInfo(res); })
            .catch(() => { /* ignore */ });
    }, []);

    const handleWorkspaceSelected = useCallback((project: import('@/config/types').Project) => {
        setShowWorkspaceSelect(false);
        setOverlayAgent({ workspacePath: project.path });
    }, []);

    // Stable callback ref for onSectionChange (avoids unnecessary effect triggers)
    const onSectionChangeRef = useRef(onSectionChange);
    onSectionChangeRef.current = onSectionChange;

    // Handle initial section from props (for deep linking)
    useEffect(() => {
        if (initialSection && VALID_SECTIONS.includes(initialSection as SettingsSection)) {
            setActiveSection(initialSection as SettingsSection);
            onSectionChangeRef.current?.();
        }
    }, [initialSection]);

    // Propagate proxy config changes to all running Sidecars
    const prevProxyRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        const key = JSON.stringify(config.proxySettings ?? null);
        if (prevProxyRef.current === undefined) {
            prevProxyRef.current = key; // First mount — don't trigger
            return;
        }
        if (prevProxyRef.current === key) return;
        prevProxyRef.current = key;

        invoke('cmd_propagate_proxy').catch(err =>
            console.error('[Settings] Proxy propagation failed:', err)
        );
    }, [config.proxySettings]);

    const [showCustomForm, setShowCustomForm] = useState(false);
    const [customForm, setCustomForm] = useState<CustomProviderForm>(EMPTY_CUSTOM_FORM);
    const customModelInputRef = useRef<HTMLInputElement>(null);
    const addCustomModelFromInput = () => {
        const val = customModelInputRef.current?.value.trim();
        if (val && !customForm.models.includes(val)) {
            setCustomForm((p) => ({ ...p, models: [...p.models, val] }));
            if (customModelInputRef.current) customModelInputRef.current.value = '';
        }
    };
    // Provider edit/manage panel state
    const [editingProvider, setEditingProvider] = useState<ProviderEditForm | null>(null);
    // 删除确认弹窗状态
    const [deleteConfirmProvider, setDeleteConfirmProvider] = useState<Provider | null>(null);
    // 模型管理面板状态 — 存 ID 而非 Provider 对象，从 providers 派生最新引用
    const [managingProviderId, setManagingProviderId] = useState<string | null>(null);
    const managingProvider = useMemo(
        () => managingProviderId ? providers.find(p => p.id === managingProviderId) ?? null : null,
        [managingProviderId, providers],
    );
    // UI-only loading state (not persisted)
    const [verifyLoading, setVerifyLoading] = useState<Record<string, boolean>>({});
    const [verifyError, setVerifyError] = useState<Record<string, { error: string; detail?: string }>>({});
    const [errorDetailOpenId, setErrorDetailOpenId] = useState<string | null>(null);

    // Dev-only: Logs panel
    const [showLogs, setShowLogs] = useState(false);
    const [sseLogs, setSseLogs] = useState<LogEntry[]>([]);

    // App version from Tauri
    const [appVersion, setAppVersion] = useState<string>('');
    useEffect(() => {
        if (!isTauriEnvironment()) {
            setAppVersion('dev');
            return;
        }
        getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));
    }, []);

    // QR code URL for user community section
    // Tauri: Downloads on first launch and caches locally, CDN in browser
    const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
    const [qrCodeLoading, setQrCodeLoading] = useState(false);
    const [logExporting, setLogExporting] = useState(false);
    const [showBugReport, setShowBugReport] = useState(false);

    // Load QR code when entering about section
    useEffect(() => {
        if (activeSection !== 'about') return;

        let cancelled = false;
        setQrCodeLoading(true);

        if (isTauriEnvironment()) {
            // Tauri mode: Call backend API to download & cache QR code
            // The API downloads from CDN on first call, then serves from cache
            apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
                .then(result => {
                    if (cancelled) return;
                    if (result.success && result.dataUrl) {
                        setQrCodeDataUrl(result.dataUrl);
                    }
                })
                .catch((error) => {
                    if (cancelled) return;
                    console.error('[Settings] Failed to load QR code:', error);
                    // Silently fail - QR code section will remain hidden
                })
                .finally(() => {
                    if (!cancelled) setQrCodeLoading(false);
                });
        } else {
            // Browser mode: Direct CDN URL
            setQrCodeDataUrl('https://download.pm-copilot.io/assets/feedback_qr_code.png');
            setQrCodeLoading(false);
        }

        return () => {
            cancelled = true;
            setQrCodeDataUrl(null); // 统一清理，避免内存泄漏
            setQrCodeLoading(false);
        };
    }, [activeSection]);


    // Collect React and Rust logs for Settings page (since we don't have TabProvider)
    // Limit to 3000 logs to prevent memory issues (matches UnifiedLogsPanel MAX_DISPLAY_LOGS)
    const MAX_LOGS = 3000;
    useEffect(() => {
        const handleReactLog = (event: Event) => {
            const customEvent = event as CustomEvent<LogEntry>;
            setSseLogs(prev => {
                const next = [...prev, customEvent.detail];
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
            });
        };
        window.addEventListener(REACT_LOG_EVENT, handleReactLog);
        return () => {
            window.removeEventListener(REACT_LOG_EVENT, handleReactLog);
        };
    }, []);

    // Listen for Rust logs (Tauri only)
    useEffect(() => {
        if (!isTauriEnvironment()) return;

        let isMounted = true;
        let unlisten: (() => void) | null = null;

        (async () => {
            const { listen } = await import('@tauri-apps/api/event');
            // 防止组件卸载后设置监听器（竞态条件）
            if (!isMounted) return;
            unlisten = await listen<LogEntry>('log:rust', (event) => {
                setSseLogs(prev => {
                    const next = [...prev, event.payload];
                    return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
                });
            });
        })();

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, []);

    const clearLogs = useCallback(() => {
        setSseLogs([]);
    }, []);

    // Developer section unlock state
    const [devSectionVisible, setDevSectionVisible] = useState(isDeveloperSectionUnlocked);
    const [showCronDebugPanel, setShowCronDebugPanel] = useState(false);
    const logoTapCountRef = useRef(0);
    const logoTapTimerRef = useRef<NodeJS.Timeout | null>(null);

    // Handle logo tap to unlock developer section
    const handleLogoTap = useCallback(() => {
        if (devSectionVisible) return; // Already unlocked

        logoTapCountRef.current += 1;

        // Clear existing timer and start new one
        if (logoTapTimerRef.current) {
            clearTimeout(logoTapTimerRef.current);
        }

        // Check if unlock threshold reached
        if (logoTapCountRef.current >= UNLOCK_CONFIG.requiredTaps) {
            unlockDeveloperSection();
            setDevSectionVisible(true);
            logoTapCountRef.current = 0;
            return;
        }

        // Reset counter after time window expires
        logoTapTimerRef.current = setTimeout(() => {
            logoTapCountRef.current = 0;
        }, UNLOCK_CONFIG.timeWindowMs);
    }, [devSectionVisible]);

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (logoTapTimerRef.current) {
                clearTimeout(logoTapTimerRef.current);
            }
        };
    }, []);

    // Anthropic subscription status
    const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null);
    const [subscriptionVerifying, setSubscriptionVerifying] = useState(false);

    // Ref for verify timeout cleanup
    const verifyTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});
    // Per-provider generation counter to prevent stale verify results from overwriting newer ones
    const verifyGenRef = useRef<Record<string, number>>({});

    // MCP state
    const [mcpServers, setMcpServersState] = useState<McpServerDefinition[]>([]);
    const [mcpEnabledIds, setMcpEnabledIds] = useState<string[]>([]);
    const [mcpEnabling, setMcpEnabling] = useState<Record<string, boolean>>({}); // Loading state for enable toggle
    const [showMcpForm, setShowMcpForm] = useState(false);
    const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
    // Dialog state for runtime not found
    const [runtimeDialog, setRuntimeDialog] = useState<{
        show: boolean;
        runtimeName?: string;
        downloadUrl?: string;
        command?: string;
    }>({ show: false });

    // Whether any provider is available (for "PM 助手安装" button)
    const showAiInstallButton = useMemo(
        () => providers.some(p => p.models.length > 0 && isProviderAvailable(p, apiKeys, providerVerifyStatus)),
        [providers, apiKeys, providerVerifyStatus],
    );

    const handleAiInstallRuntime = useCallback(() => {
        const { runtimeName, command, downloadUrl } = runtimeDialog;
        setRuntimeDialog({ show: false });

        const platform = getPlatform();
        const osName = platform.startsWith('darwin') ? 'macOS'
            : platform.startsWith('windows') ? 'Windows'
            : platform.startsWith('linux') ? 'Linux'
            : platform;

        const prompt = [
            `## 依赖安装请求`,
            ``,
            `用户尝试启用一个 MCP 服务，但系统缺少必要的运行环境。`,
            ``,
            `- **缺少的运行环境**: ${runtimeName || command || '未知'}`,
            `- **缺少的命令**: \`${command || '未知'}\``,
            ...(downloadUrl ? [`- **官方下载地址**: ${downloadUrl}`] : []),
            `- **操作系统**: ${osName}`,
            ``,
            `请帮助用户安装 \`${command}\`，安装完成后告知用户回到设置页面重新启用 MCP 服务。`,
        ].join('\n');

        const availableProvider = providers.find(p => p.models.length > 0 && isProviderAvailable(p, apiKeys, providerVerifyStatus));

        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
            detail: { description: prompt, providerId: availableProvider?.id, appVersion },
        }));
    }, [runtimeDialog, appVersion, providers, apiKeys, providerVerifyStatus]);

    // Track which MCP servers need configuration (missing required fields)
    const [mcpNeedsConfig, setMcpNeedsConfig] = useState<Record<string, boolean>>({});

    // Builtin MCP settings dialog state
    const [builtinMcpSettings, setBuiltinMcpSettings] = useState<{
        server: McpServerDefinition;
        extraArgs: string[];
        newArg: string;
        env: Record<string, string>;
        newEnvKey: string;
        newEnvValue: string;
    } | null>(null);

    // Gemini Image MCP custom settings dialog
    const [geminiImageSettings, setGeminiImageSettings] = useState<{
        apiKey: string;
        baseUrl: string;
        model: string;
        aspectRatio: string;
        imageSize: string;
        thinkingLevel: string;
        searchGrounding: boolean;
        maxContextTurns: number;
    } | null>(null);

    // Edge TTS slider styling (custom range input with accent-colored thumb)
    const ttsSliderClass = 'w-full h-1.5 rounded-full appearance-none cursor-pointer bg-[var(--line)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-110';

    // Edge TTS MCP custom settings dialog
    const [edgeTtsSettings, setEdgeTtsSettings] = useState<{
        defaultVoice: string;
        defaultRate: number;
        defaultVolume: number;
        defaultPitch: number;
        defaultOutputFormat: string;
    } | null>(null);
    const [ttsPreviewText, setTtsPreviewText] = useState('你好，这是一段语音合成测试。Hello, this is a text-to-speech test.');
    const [ttsPreviewLoading, setTtsPreviewLoading] = useState(false);
    const [ttsPreviewPlaying, setTtsPreviewPlaying] = useState(false);
    const ttsAudioRef = useRef<HTMLAudioElement | null>(null);

    // Playwright MCP custom settings dialog
    const [playwrightSettings, setPlaywrightSettings] = useState<{
        mode: 'persistent' | 'isolated';
        headless: boolean;
        browser: string;
        device: string;
        customDevice: string;
        userDataDir: string;
        extraArgs: string[];
        newArg: string;
    } | null>(null);

    // Storage state info for Playwright browser settings UI (isolated mode)
    const [storageStateInfo, setStorageStateInfo] = useState<{
        exists: boolean;
        cookieCount: number;
        domains: string[];
        lastModified: string | null;
        cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean }>;
    } | null>(null);

    // Cookie add/edit form (null = closed, object = open)
    const [cookieForm, setCookieForm] = useState<{
        editIndex: number | null; // null = adding new, number = editing existing
        domain: string;
        name: string;
        value: string;
        path: string;
    } | null>(null);

    // Shared helper: reload storage state info from ~/.pm-copilot/browser-storage-state.json
    const reloadStorageStateInfo = async () => {
        try {
            const home = await homeDir();
            const ssPath = await join(home, '.pm-copilot', 'browser-storage-state.json');
            const { exists: fileExists, readTextFile, stat: fsStat } = await import('@tauri-apps/plugin-fs');
            if (await fileExists(ssPath)) {
                const content = await readTextFile(ssPath);
                const parsed = JSON.parse(content);
                const rawCookies = (parsed.cookies ?? []) as Array<{ name: string; value: string; domain: string; path: string; secure?: boolean; httpOnly?: boolean }>;
                const cookies = rawCookies.map(c => ({
                    name: String(c.name ?? ''), value: String(c.value ?? ''), domain: String(c.domain ?? ''),
                    path: String(c.path ?? '/'), secure: !!c.secure, httpOnly: !!c.httpOnly,
                }));
                const domains = [...new Set(cookies.map(c => c.domain.replace(/^\./, '')))].sort() as string[];
                const fileStat = await fsStat(ssPath).catch(() => null);
                setStorageStateInfo({
                    exists: true, cookieCount: cookies.length, domains, cookies,
                    lastModified: fileStat?.mtime ? new Date(fileStat.mtime).toLocaleString() : null,
                });
            } else {
                setStorageStateInfo({ exists: false, cookieCount: 0, domains: [], cookies: [], lastModified: null });
            }
        } catch {
            setStorageStateInfo({ exists: false, cookieCount: 0, domains: [], cookies: [], lastModified: null });
        }
    };

    const [mcpFormMode, setMcpFormMode] = useState<'form' | 'json'>('form');
    const [mcpJsonInput, setMcpJsonInput] = useState('');
    const [mcpJsonError, setMcpJsonError] = useState('');

    // OAuth state for MCP servers
    const [mcpOAuthStatus, setMcpOAuthStatus] = useState<Record<string, 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error'>>({});
    const [mcpOAuthConnecting, setMcpOAuthConnecting] = useState<string | null>(null);
    const [mcpOAuthProbe, setMcpOAuthProbe] = useState<Record<string, { required: boolean; supportsDynamicRegistration?: boolean; scopes?: string[] }>>({});

    const [mcpForm, setMcpForm] = useState<{
        id: string;
        name: string;
        type: McpServerType;
        command: string;
        args: string[];
        newArg: string;
        url: string;
        env: Record<string, string>;
        newEnvKey: string;
        newEnvValue: string;
        headers: Record<string, string>;
        newHeaderKey: string;
        newHeaderValue: string;
        // OAuth fields (manual mode fallback)
        oauthClientId: string;
        oauthClientSecret: string;
        oauthScopes: string;
        oauthCallbackPort: string;
        oauthAuthUrl: string;
        oauthTokenUrl: string;
    }>({
        id: '',
        name: '',
        type: 'stdio',
        command: '',
        args: [],
        newArg: '',
        url: '',
        env: {},
        newEnvKey: '',
        newEnvValue: '',
        headers: {},
        newHeaderKey: '',
        newHeaderValue: '',
        oauthClientId: '',
        oauthClientSecret: '',
        oauthScopes: '',
        oauthCallbackPort: '',
        oauthAuthUrl: '',
        oauthTokenUrl: '',
    });
    const [mcpHeadersExpanded, setMcpHeadersExpanded] = useState(false);
    const [mcpOAuthExpanded, setMcpOAuthExpanded] = useState(false);

    // Cmd+W dismissal for all inline Settings overlays (z-50 / z-[60]).
    // Checks from highest z-index down; first truthy state gets closed.
    useCloseLayer(() => {
        // z-[60]: delete confirmation (highest)
        if (deleteConfirmProvider) { setDeleteConfirmProvider(null); return true; }
        // z-50: all other inline overlays
        if (runtimeDialog.show) { setRuntimeDialog(prev => ({ ...prev, show: false })); return true; }
        if (editingProvider) { setEditingProvider(null); return true; }
        if (showCustomForm) { setShowCustomForm(false); return true; }
        if (showMcpForm) { setShowMcpForm(false); setEditingMcpId(null); return true; }
        if (builtinMcpSettings) { setBuiltinMcpSettings(null); return true; }
        if (geminiImageSettings) { setGeminiImageSettings(null); return true; }
        if (playwrightSettings) { setPlaywrightSettings(null); return true; }
        if (edgeTtsSettings) { setEdgeTtsSettings(null); return true; }
        return false;
    }, 50);

    // Check which MCP servers need configuration (missing required fields)
    const checkMcpConfigStatus = async (servers: McpServerDefinition[]) => {
        const needs: Record<string, boolean> = {};
        for (const server of servers) {
            if (server.requiresConfig && server.requiresConfig.length > 0) {
                const savedEnv = await getMcpServerEnv(server.id);
                const missing = server.requiresConfig.some(key => !savedEnv?.[key]?.trim());
                if (missing) needs[server.id] = true;
            }
        }
        setMcpNeedsConfig(needs);
    };

    // Load MCP config on mount
    useEffect(() => {
        const loadMcp = async () => {
            try {
                const servers = await getAllMcpServers();
                const enabledIds = await getEnabledMcpServerIds();
                setMcpServersState(servers);
                setMcpEnabledIds(enabledIds);
                await checkMcpConfigStatus(servers);
            } catch (err) {
                console.error('[Settings] Failed to load MCP config:', err);
            }
        };
        loadMcp();
    }, []);

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
                const enabledIds = await getEnabledMcpServerIds();
                setMcpServersState(servers);
                setMcpEnabledIds(enabledIds);
                await checkMcpConfigStatus(servers);
            } catch (err) {
                console.warn('[Settings] Failed to reload MCP servers on activation:', err);
            }
        })();
    }, [isActive]);

    // Toggle MCP server enabled status
    // For preset MCP (npx): warmup bun cache
    // For custom MCP: check if command exists
    const handleMcpToggle = async (server: McpServerDefinition, enabled: boolean) => {
        if (!enabled) {
            // Just disable
            await toggleMcpServerEnabled(server.id, false);
            setMcpEnabledIds(prev => prev.filter(id => id !== server.id));
            toast.success('MCP 已禁用');
            return;
        }

        // Validate required config before enabling (e.g., API keys)
        if (server.requiresConfig && server.requiresConfig.length > 0) {
            const savedEnv = await getMcpServerEnv(server.id);
            const missingKeys = server.requiresConfig.filter(key => !savedEnv?.[key]?.trim());
            if (missingKeys.length > 0) {
                toast.error(`请先配置 ${server.name}（点击 ⚙️ 设置）`);
                // Auto-open settings dialog for convenience
                handleEditBuiltinMcp(server);
                return;
            }
        }

        // Set loading state
        setMcpEnabling(prev => ({ ...prev, [server.id]: true }));

        try {
            // Call enable API to validate/warmup
            const result = await apiPostJson<{
                success: boolean;
                error?: McpEnableError;
            }>('/api/mcp/enable', { server });

            if (result.success) {
                // Enable the MCP
                await toggleMcpServerEnabled(server.id, true);
                setMcpEnabledIds(prev => [...prev, server.id]);

                // Auto-init default args for Playwright on first enable
                if (server.id === 'playwright') {
                    const existingArgs = await getMcpServerArgs('playwright');
                    if (existingArgs === undefined) {
                        try {
                            const defaultArgs = await getPlaywrightDefaultArgs();
                            await saveMcpServerArgs('playwright', defaultArgs);
                            const servers = await getAllMcpServers();
                            setMcpServersState(servers);
                        } catch (e) {
                            console.warn('[Settings] Failed to init default Playwright args:', e);
                        }
                    }
                }

                toast.success('MCP 已启用');
            } else if (result.error) {
                // Handle different error types
                if (result.error.type === 'command_not_found' && result.error.downloadUrl) {
                    // Show dialog for runtime not found
                    setRuntimeDialog({
                        show: true,
                        runtimeName: result.error.runtimeName,
                        downloadUrl: result.error.downloadUrl,
                        command: result.error.command,
                    });
                } else {
                    // Show toast for other errors
                    toast.error(result.error.message || '启用失败');
                }
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : '启用失败';
            toast.error(errorMsg);
        } finally {
            setMcpEnabling(prev => ({ ...prev, [server.id]: false }));
        }
    };

    const resetMcpForm = () => {
        setEditingMcpId(null);
        setMcpFormMode('form');
        setMcpJsonInput('');
        setMcpJsonError('');
        setMcpForm({
            id: '', name: '', type: 'stdio', command: '', args: [], newArg: '', url: '',
            env: {}, newEnvKey: '', newEnvValue: '', headers: {}, newHeaderKey: '', newHeaderValue: '',
            oauthClientId: '', oauthClientSecret: '', oauthScopes: '', oauthCallbackPort: '', oauthAuthUrl: '', oauthTokenUrl: '',
        });
        setMcpHeadersExpanded(false);
        setMcpOAuthExpanded(false);
    };

    // Edit builtin MCP server settings (extra args + env)
    const handleEditBuiltinMcp = async (server: McpServerDefinition) => {
        // Edge TTS: open custom config dialog
        if (server.id === 'edge-tts') {
            const savedEnv = await getMcpServerEnv(server.id);
            const parseRate = (s?: string) => parseInt((s || '0%').replace('%', ''), 10) || 0;
            const parsePitch = (s?: string) => parseInt((s || '+0Hz').replace('Hz', '').replace('+', ''), 10) || 0;
            setEdgeTtsSettings({
                defaultVoice: savedEnv?.EDGE_TTS_DEFAULT_VOICE || 'zh-CN-XiaoxiaoNeural',
                defaultRate: parseRate(savedEnv?.EDGE_TTS_DEFAULT_RATE),
                defaultVolume: parseRate(savedEnv?.EDGE_TTS_DEFAULT_VOLUME),
                defaultPitch: parsePitch(savedEnv?.EDGE_TTS_DEFAULT_PITCH),
                defaultOutputFormat: savedEnv?.EDGE_TTS_DEFAULT_FORMAT || 'audio-24khz-48kbitrate-mono-mp3',
            });
            stopTtsPreview();
            return;
        }

        // Gemini Image: open custom config dialog
        if (server.id === 'gemini-image') {
            const savedEnv = await getMcpServerEnv(server.id);
            setGeminiImageSettings({
                apiKey: savedEnv?.GEMINI_API_KEY || '',
                baseUrl: savedEnv?.GEMINI_BASE_URL || '',
                model: savedEnv?.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
                aspectRatio: savedEnv?.GEMINI_DEFAULT_ASPECT_RATIO || 'auto',
                imageSize: savedEnv?.GEMINI_DEFAULT_IMAGE_SIZE || 'auto',
                thinkingLevel: savedEnv?.GEMINI_THINKING_LEVEL || 'auto',
                searchGrounding: savedEnv?.GEMINI_SEARCH_GROUNDING === 'true',
                maxContextTurns: parseInt(savedEnv?.MAX_CONTEXT_TURNS || '20', 10),
            });
            return;
        }

        // Playwright: open custom config dialog
        if (server.id === 'playwright') {
            const savedArgs = await getMcpServerArgs(server.id);
            let rawArgs: string[];
            if (savedArgs !== undefined) {
                rawArgs = savedArgs;
            } else {
                try { rawArgs = await getPlaywrightDefaultArgs(); } catch { rawArgs = []; }
            }

            let headless = false;
            let browser = '';
            let device = '';
            let customDevice = '';
            let userDataDir = '';
            let mode: 'persistent' | 'isolated' = 'persistent'; // default
            const extraArgs: string[] = [];

            for (const arg of rawArgs) {
                if (arg === '--headless') {
                    headless = true;
                } else if (arg === '--isolated') {
                    mode = 'isolated';
                } else if (arg.startsWith('--browser=')) {
                    browser = arg.slice('--browser='.length);
                } else if (arg.startsWith('--device=')) {
                    const val = arg.slice('--device='.length);
                    if (PLAYWRIGHT_DEVICE_PRESETS.includes(val)) {
                        device = val;
                    } else {
                        device = '__custom__';
                        customDevice = val;
                    }
                } else if (arg.startsWith('--user-data-dir=')) {
                    userDataDir = arg.slice('--user-data-dir='.length);
                } else if (arg.startsWith('--storage-state=')) {
                    // Skip: dynamically injected by backend
                } else {
                    extraArgs.push(arg);
                }
            }

            // Load storage state info for isolated mode display
            await reloadStorageStateInfo();

            setCookieForm(null); // Reset cookie form from previous session
            setPlaywrightSettings({ mode, headless, browser, device, customDevice, userDataDir, extraArgs, newArg: '' });
            return;
        }

        const savedArgs = await getMcpServerArgs(server.id);
        const savedEnv = await getMcpServerEnv(server.id);

        const extraArgs = savedArgs ?? [];

        // Pre-populate required config fields so they show in the dialog
        const env: Record<string, string> = { ...savedEnv };
        for (const key of server.requiresConfig ?? []) {
            if (!(key in env)) env[key] = '';
        }

        setBuiltinMcpSettings({
            server,
            extraArgs,
            newArg: '',
            env,
            newEnvKey: '',
            newEnvValue: '',
        });
    };

    const handleSaveBuiltinMcp = async () => {
        if (!builtinMcpSettings) return;
        const { server, extraArgs, env } = builtinMcpSettings;
        try {
            await atomicModifyConfig(config => ({
                ...config,
                mcpServerArgs: { ...(config.mcpServerArgs ?? {}), [server.id]: extraArgs },
                mcpServerEnv: { ...(config.mcpServerEnv ?? {}), [server.id]: env },
            }));
            const servers = await getAllMcpServers();
            setMcpServersState(servers);
            setBuiltinMcpSettings(null);
            toast.success('设置已保存');
        } catch {
            toast.error('保存失败');
        }
    };

    const handleSaveGeminiImage = async () => {
        if (!geminiImageSettings) return;
        try {
            const env: Record<string, string> = {
                GEMINI_API_KEY: geminiImageSettings.apiKey,
                GEMINI_BASE_URL: geminiImageSettings.baseUrl,
                GEMINI_IMAGE_MODEL: geminiImageSettings.model,
                GEMINI_DEFAULT_ASPECT_RATIO: geminiImageSettings.aspectRatio,
                GEMINI_DEFAULT_IMAGE_SIZE: geminiImageSettings.imageSize,
                GEMINI_THINKING_LEVEL: geminiImageSettings.thinkingLevel,
                GEMINI_SEARCH_GROUNDING: geminiImageSettings.searchGrounding ? 'true' : 'false',
                MAX_CONTEXT_TURNS: String(geminiImageSettings.maxContextTurns),
            };
            await atomicModifyConfig(config => ({
                ...config,
                mcpServerEnv: { ...(config.mcpServerEnv ?? {}), 'gemini-image': env },
            }));
            const servers = await getAllMcpServers();
            setMcpServersState(servers);
            await checkMcpConfigStatus(servers);
            setGeminiImageSettings(null);
            toast.success('Gemini 图片生成设置已保存');
        } catch {
            toast.error('保存失败');
        }
    };

    // Save cookie to storage-state JSON file
    const handleSaveCookie = async () => {
        if (!cookieForm) return;
        const { editIndex, domain, name, value, path } = cookieForm;
        if (!domain.trim() || !name.trim() || !value.trim()) {
            toast.error('域名、名称和值不能为空');
            return;
        }
        try {
            const home = await homeDir();
            const ssPath = await join(home, '.pm-copilot', 'browser-storage-state.json');
            const { exists: fileExists, readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');

            // Load existing or create new
            let storageState: { cookies: Array<Record<string, unknown>>; origins: Array<Record<string, unknown>> } = { cookies: [], origins: [] };
            if (await fileExists(ssPath)) {
                try {
                    storageState = JSON.parse(await readTextFile(ssPath));
                } catch { /* corrupt file, start fresh */ }
            }

            const domainVal = domain.trim().startsWith('.') ? domain.trim() : `.${domain.trim()}`;
            const pathVal = path.trim() || '/';

            if (editIndex !== null && editIndex < storageState.cookies.length) {
                // Preserve original metadata (expires, httpOnly, secure, sameSite) when editing
                const existing = storageState.cookies[editIndex];
                storageState.cookies[editIndex] = {
                    ...existing,
                    name: name.trim(),
                    value: value.trim(),
                    domain: domainVal,
                    path: pathVal,
                };
            } else {
                // New cookie: use sensible defaults
                storageState.cookies.push({
                    name: name.trim(),
                    value: value.trim(),
                    domain: domainVal,
                    path: pathVal,
                    expires: -1,
                    httpOnly: false,
                    secure: true,
                    sameSite: 'Lax',
                });
            }

            // Ensure ~/.pm-copilot/ exists (writeTextFile may fail if dir missing)
            const pmCopilotDir = await join(home, '.pm-copilot');
            const { mkdir } = await import('@tauri-apps/plugin-fs');
            await mkdir(pmCopilotDir, { recursive: true }).catch(() => {});
            await writeTextFile(ssPath, JSON.stringify(storageState, null, 2));

            setCookieForm(null);
            toast.success(editIndex !== null ? 'Cookie 已更新' : 'Cookie 已添加');
            await reloadStorageStateInfo();
        } catch {
            toast.error('保存失败');
        }
    };

    // Delete a cookie from storage-state JSON
    const handleDeleteCookie = async (idx: number) => {
        try {
            const home = await homeDir();
            const ssPath = await join(home, '.pm-copilot', 'browser-storage-state.json');
            const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
            const storageState = JSON.parse(await readTextFile(ssPath));
            storageState.cookies.splice(idx, 1);
            await writeTextFile(ssPath, JSON.stringify(storageState, null, 2));
            toast.success('Cookie 已删除');
            await reloadStorageStateInfo();
        } catch {
            toast.error('删除失败');
        }
    };

    const handleSavePlaywright = async () => {
        if (!playwrightSettings) return;
        try {
            const args: string[] = [];

            const home = await homeDir();

            // Mode-specific args
            if (playwrightSettings.mode === 'isolated') {
                args.push('--isolated');
                // Merge 'storage' capability into any existing --caps= from extra args
                const existingCapsIdx = playwrightSettings.extraArgs.findIndex(a => a.startsWith('--caps='));
                if (existingCapsIdx !== -1) {
                    const existingCaps = playwrightSettings.extraArgs[existingCapsIdx].slice('--caps='.length);
                    const capsSet = new Set(existingCaps.split(',').map(c => c.trim()).filter(Boolean));
                    capsSet.add('storage');
                    // Replace in extraArgs copy (don't mutate state)
                    const extraArgsCopy = [...playwrightSettings.extraArgs];
                    extraArgsCopy[existingCapsIdx] = `--caps=${[...capsSet].join(',')}`;
                    args.push(...extraArgsCopy.filter(a => !a.startsWith('--caps=')));
                    args.push(extraArgsCopy[existingCapsIdx]);
                } else {
                    args.push('--caps=storage');
                }
            } else {
                // Persistent mode: use user-data-dir
                let dir = playwrightSettings.userDataDir.trim();
                // Expand ~ to home directory (tilde is a shell feature, not resolved by argv)
                if (dir.startsWith('~/') || dir === '~') {
                    dir = await join(home, dir.slice(2));
                }
                if (dir) {
                    args.push(`--user-data-dir=${dir}`);
                } else {
                    const defaultProfile = await join(home, '.playwright-mcp-profile');
                    args.push(`--user-data-dir=${defaultProfile}`);
                }
            }

            if (playwrightSettings.headless) {
                args.push('--headless');
            }
            if (playwrightSettings.browser) {
                args.push(`--browser=${playwrightSettings.browser}`);
            }
            if (playwrightSettings.device) {
                const deviceName = playwrightSettings.device === '__custom__'
                    ? playwrightSettings.customDevice.trim()
                    : playwrightSettings.device;
                if (deviceName) {
                    args.push(`--device=${deviceName}`);
                }
            }
            // Add extra args (skip --caps= in isolated mode — already merged above)
            const filteredExtraArgs = playwrightSettings.mode === 'isolated'
                ? playwrightSettings.extraArgs.filter(a => !a.startsWith('--caps='))
                : playwrightSettings.extraArgs;
            args.push(...filteredExtraArgs);

            await atomicModifyConfig(config => ({
                ...config,
                mcpServerArgs: { ...(config.mcpServerArgs ?? {}), playwright: args },
            }));
            const servers = await getAllMcpServers();
            setMcpServersState(servers);
            setPlaywrightSettings(null);
            toast.success('Playwright 设置已保存');
        } catch {
            toast.error('保存失败');
        }
    };

    const fmtTtsRate = (v: number) => v >= 0 ? `+${v}%` : `${v}%`;
    const fmtTtsPitch = (v: number) => v >= 0 ? `+${v}Hz` : `${v}Hz`;

    const handleSaveEdgeTts = async () => {
        if (!edgeTtsSettings) return;
        try {
            const env: Record<string, string> = {
                EDGE_TTS_DEFAULT_VOICE: edgeTtsSettings.defaultVoice,
                EDGE_TTS_DEFAULT_RATE: fmtTtsRate(edgeTtsSettings.defaultRate),
                EDGE_TTS_DEFAULT_VOLUME: fmtTtsRate(edgeTtsSettings.defaultVolume),
                EDGE_TTS_DEFAULT_PITCH: fmtTtsPitch(edgeTtsSettings.defaultPitch),
                EDGE_TTS_DEFAULT_FORMAT: edgeTtsSettings.defaultOutputFormat,
            };
            await atomicModifyConfig(config => ({
                ...config,
                mcpServerEnv: { ...(config.mcpServerEnv ?? {}), 'edge-tts': env },
            }));
            const servers = await getAllMcpServers();
            setMcpServersState(servers);
            await checkMcpConfigStatus(servers);
            setEdgeTtsSettings(null);
            toast.success('Edge TTS 设置已保存');
        } catch {
            toast.error('保存失败');
        }
    };

    const stopTtsPreview = useCallback(() => {
        if (ttsAudioRef.current) {
            const src = ttsAudioRef.current.src;
            ttsAudioRef.current.pause();
            ttsAudioRef.current.onended = null;
            ttsAudioRef.current.onerror = null;
            ttsAudioRef.current = null;
            if (src.startsWith('blob:')) URL.revokeObjectURL(src);
        }
        setTtsPreviewPlaying(false);
    }, []);

    // Stop audio when dialog closes or component unmounts
    useEffect(() => {
        if (!edgeTtsSettings) stopTtsPreview();
        return () => { stopTtsPreview(); };
    }, [edgeTtsSettings, stopTtsPreview]);

    const handlePreviewTts = async () => {
        if (!edgeTtsSettings) return;

        // If currently playing, stop
        if (ttsPreviewPlaying) {
            stopTtsPreview();
            return;
        }

        setTtsPreviewLoading(true);
        try {
            const result = await apiPostJson<{ success: boolean; audioBase64?: string; mimeType?: string; error?: string }>('/api/edge-tts/preview', {
                text: ttsPreviewText,
                voice: edgeTtsSettings.defaultVoice,
                rate: fmtTtsRate(edgeTtsSettings.defaultRate),
                volume: fmtTtsRate(edgeTtsSettings.defaultVolume),
                pitch: fmtTtsPitch(edgeTtsSettings.defaultPitch),
                outputFormat: edgeTtsSettings.defaultOutputFormat,
            });
            if (result.success && result.audioBase64) {
                // Decode base64 → Blob URL (data URIs don't work for audio in WKWebView)
                const bin = atob(result.audioBase64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                const blob = new Blob([bytes], { type: result.mimeType || 'audio/mpeg' });
                const blobUrl = URL.createObjectURL(blob);

                const audio = new Audio(blobUrl);
                ttsAudioRef.current = audio;
                audio.onended = () => {
                    URL.revokeObjectURL(blobUrl);
                    setTtsPreviewPlaying(false);
                    ttsAudioRef.current = null;
                };
                audio.onerror = () => {
                    URL.revokeObjectURL(blobUrl);
                    toast.error('音频播放失败');
                    setTtsPreviewPlaying(false);
                    ttsAudioRef.current = null;
                };
                await audio.play();
                setTtsPreviewPlaying(true);
            } else {
                toast.error(result.error || '试听失败');
            }
        } catch {
            // Clean up blob URL on play() rejection to avoid memory leak
            if (ttsAudioRef.current) {
                const src = ttsAudioRef.current.src;
                ttsAudioRef.current.onended = null;
                ttsAudioRef.current.onerror = null;
                ttsAudioRef.current = null;
                if (src.startsWith('blob:')) URL.revokeObjectURL(src);
            }
            toast.error('试听请求失败');
        } finally {
            setTtsPreviewLoading(false);
        }
    };

    // OAuth: probe MCP server for OAuth requirements (returns probe result for chaining)
    const handleMcpOAuthProbe = async (serverId: string, mcpUrl: string): Promise<{ supportsDynamicRegistration?: boolean } | null> => {
        if (!mcpUrl) return null;
        try {
            const result = await apiPostJson<{ success: boolean; required?: boolean; supportsDynamicRegistration?: boolean; scopes?: string[] }>('/api/mcp/oauth/discover', {
                serverId, mcpUrl,
            });
            if (result.success && result.required) {
                setMcpOAuthProbe(prev => ({ ...prev, [serverId]: { required: true, supportsDynamicRegistration: result.supportsDynamicRegistration, scopes: result.scopes } }));
                return { supportsDynamicRegistration: result.supportsDynamicRegistration };
            }
            setMcpOAuthProbe(prev => ({ ...prev, [serverId]: { required: false } }));
            return null;
        } catch { return null; }
    };

    // OAuth: start OAuth flow (auto mode = no clientId, manual mode = with clientId)
    const handleMcpOAuthConnect = async (serverId: string, serverUrl: string, manual?: boolean) => {
        if (manual && !mcpForm.oauthClientId) {
            toast.error('请填写 Client ID');
            return;
        }
        setMcpOAuthConnecting(serverId);
        try {
            const payload: Record<string, unknown> = {
                serverId,
                serverUrl: serverUrl || mcpForm.url,
            };
            // Manual mode: include user-provided credentials
            if (manual && mcpForm.oauthClientId) {
                payload.clientId = mcpForm.oauthClientId;
                payload.clientSecret = mcpForm.oauthClientSecret || undefined;
                payload.scopes = mcpForm.oauthScopes ? mcpForm.oauthScopes.split(/[\s,]+/).filter(Boolean) : undefined;
                payload.callbackPort = mcpForm.oauthCallbackPort ? parseInt(mcpForm.oauthCallbackPort, 10) : undefined;
                payload.authorizationUrl = mcpForm.oauthAuthUrl || undefined;
                payload.tokenUrl = mcpForm.oauthTokenUrl || undefined;
            }

            const result = await apiPostJson<{ success: boolean; authUrl?: string; error?: string }>('/api/mcp/oauth/start', payload);
            if (result.success && result.authUrl) {
                const { openExternal } = await import('@/utils/openExternal');
                await openExternal(result.authUrl);
                toast.success('已在浏览器中打开授权页面，请完成授权');
                setMcpOAuthStatus(prev => ({ ...prev, [serverId]: 'connecting' }));
                // Poll for token status
                const pollInterval = setInterval(async () => {
                    try {
                        const status = await apiGetJson<{ success: boolean; status: string }>(`/api/mcp/oauth/status/${encodeURIComponent(serverId)}`);
                        if (status.success && status.status === 'connected') {
                            clearInterval(pollInterval);
                            setMcpOAuthStatus(prev => ({ ...prev, [serverId]: 'connected' }));
                            setMcpOAuthConnecting(null);
                            toast.success('OAuth 授权成功');
                        } else if (status.success && status.status === 'disconnected') {
                            setMcpOAuthConnecting(prev => {
                                if (prev === serverId) {
                                    clearInterval(pollInterval);
                                    setMcpOAuthStatus(p => ({ ...p, [serverId]: 'disconnected' }));
                                    return null;
                                }
                                return prev;
                            });
                        }
                    } catch { /* ignore poll errors */ }
                }, 2000);
                setTimeout(() => {
                    clearInterval(pollInterval);
                    setMcpOAuthConnecting(null);
                }, 5 * 60 * 1000);
            } else {
                toast.error(result.error || 'OAuth 启动失败');
                setMcpOAuthConnecting(null);
            }
        } catch (err) {
            toast.error(`OAuth 错误: ${err instanceof Error ? err.message : String(err)}`);
            setMcpOAuthConnecting(null);
        }
    };

    // OAuth: disconnect (revoke token)
    const handleMcpOAuthDisconnect = async (serverId: string) => {
        try {
            const response = await apiFetch('/api/mcp/oauth/token', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverId }),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            setMcpOAuthStatus(prev => ({ ...prev, [serverId]: 'disconnected' }));
            toast.success('OAuth 连接已断开');
        } catch {
            toast.error('断开 OAuth 失败');
        }
    };

    // Edit custom MCP server - populate form and open modal
    const handleEditMcp = (server: McpServerDefinition) => {
        setMcpForm({
            id: server.id,
            name: server.name,
            type: server.type || 'stdio',
            command: server.command || '',
            args: server.args || [],
            newArg: '',
            url: server.url || '',
            env: server.env ? { ...server.env } : {},
            newEnvKey: '',
            newEnvValue: '',
            headers: server.headers ? { ...server.headers } : {},
            newHeaderKey: '',
            newHeaderValue: '',
            oauthClientId: '',
            oauthClientSecret: '',
            oauthScopes: '',
            oauthCallbackPort: '',
            oauthAuthUrl: '',
            oauthTokenUrl: '',
        });
        // Auto-expand sections if they have existing data
        const hasHeaders = server.headers && Object.keys(server.headers).length > 0;
        setMcpHeadersExpanded(!!hasHeaders);
        setMcpOAuthExpanded(false);
        // Fetch OAuth status for this server
        if (server.type === 'sse' || server.type === 'http') {
            apiGetJson<{ success: boolean; status: string }>(`/api/mcp/oauth/status/${encodeURIComponent(server.id)}`)
                .then(res => {
                    if (res.success) {
                        setMcpOAuthStatus(prev => ({ ...prev, [server.id]: res.status as 'connected' | 'disconnected' | 'expired' }));
                        // Auto-expand OAuth section if connected/expired
                        if (res.status === 'connected' || res.status === 'expired') {
                            setMcpOAuthExpanded(true);
                        }
                    }
                }).catch(() => { /* ignore */ });
        }
        setEditingMcpId(server.id);
        setShowMcpForm(true);
    };

    // Auto-open MCP config dialog when initialMcpId is provided (from Chat tool popup)
    useEffect(() => {
        if (!initialMcpId || mcpServers.length === 0) return;
        const server = mcpServers.find(s => s.id === initialMcpId);
        if (server) {
            if (server.isBuiltin) {
                void handleEditBuiltinMcp(server);
            } else {
                handleEditMcp(server);
            }
        }
        // Clear parent state so the same ID can be dispatched again
        onSectionChangeRef.current?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only triggers on initialMcpId change
    }, [initialMcpId, mcpServers]);

    // Add custom MCP server - auto-install after adding
    const handleAddMcp = async () => {
        // Validate based on transport type
        if (!mcpForm.id || !mcpForm.name) return;
        if (mcpForm.type === 'stdio' && !mcpForm.command) return;
        if ((mcpForm.type === 'http' || mcpForm.type === 'sse') && !mcpForm.url) return;

        const newServer: McpServerDefinition = {
            id: mcpForm.id,
            name: mcpForm.name,
            type: mcpForm.type,
            isBuiltin: false,
            // stdio fields
            ...(mcpForm.type === 'stdio' && {
                command: mcpForm.command,
                args: mcpForm.args.length > 0 ? mcpForm.args : undefined,
                env: Object.keys(mcpForm.env).length > 0 ? mcpForm.env : undefined,
            }),
            // http/sse fields
            ...((mcpForm.type === 'http' || mcpForm.type === 'sse') && {
                url: mcpForm.url,
                headers: Object.keys(mcpForm.headers).length > 0 ? mcpForm.headers : undefined,
            }),
        };
        try {
            await addCustomMcpServer(newServer);
            if (editingMcpId) {
                setMcpServersState(prev => prev.map(s => s.id === editingMcpId ? newServer : s));
            } else {
                setMcpServersState(prev => [...prev, newServer]);
            }
            resetMcpForm();
            setShowMcpForm(false);

            // Track mcp_add event
            if (!editingMcpId) track('mcp_add', { type: mcpForm.type });

            toast.success(editingMcpId ? 'MCP 服务器已保存' : 'MCP 服务器已添加');

            // Auto-probe OAuth for HTTP/SSE servers after adding/saving
            if ((mcpForm.type === 'http' || mcpForm.type === 'sse') && mcpForm.url) {
                const savedId = newServer.id;
                const savedUrl = mcpForm.url;
                // Run in background — don't block form close
                handleMcpOAuthProbe(savedId, savedUrl).then(probe => {
                    if (!probe) return; // Server doesn't require OAuth
                    if (probe.supportsDynamicRegistration !== false) {
                        // Auto-mode supported — start OAuth flow automatically
                        handleMcpOAuthConnect(savedId, savedUrl);
                    } else {
                        // Manual config needed — inform user
                        toast.info('此 MCP 需要 OAuth 授权，请在设置中配置 OAuth 参数');
                    }
                }).catch(() => { /* probe failed — server may not need OAuth */ });
            }
        } catch {
            toast.error(editingMcpId ? '保存失败' : '添加失败');
        }
    };

    // Add MCP servers from JSON (batch import)
    const handleAddMcpFromJson = async () => {
        setMcpJsonError('');
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(mcpJsonInput);
        } catch {
            setMcpJsonError('JSON 格式错误，请检查语法');
            return;
        }

        // Support { mcpServers: { ... } } or direct { serverName: { ... } }
        const serversObj = (parsed.mcpServers ?? parsed) as Record<string, unknown>;

        const entries = Object.entries(serversObj).filter(
            ([, v]) => v && typeof v === 'object' && !Array.isArray(v)
        );
        if (entries.length === 0) {
            setMcpJsonError('未找到有效的 MCP 服务器配置');
            return;
        }

        const added: string[] = [];
        const skipped: string[] = [];
        const existingIds = new Set(mcpServers.map(s => s.id));

        for (const [name, rawConfig] of entries) {
            const config = rawConfig as Record<string, unknown>;
            const id = name.toLowerCase().replace(/\s+/g, '-');

            if (existingIds.has(id)) {
                skipped.push(id);
                continue;
            }

            const hasCommand = typeof config.command === 'string';
            const hasUrl = typeof config.url === 'string';
            let type: McpServerType = 'stdio';
            if (!hasCommand && hasUrl) {
                type = (config.transportType === 'sse' || config.type === 'sse') ? 'sse' : 'http';
            }

            const newServer: McpServerDefinition = {
                id,
                name,
                type,
                isBuiltin: false,
                ...(type === 'stdio' && {
                    command: config.command as string,
                    args: Array.isArray(config.args) ? config.args as string[] : undefined,
                    env: config.env && typeof config.env === 'object' ? config.env as Record<string, string> : undefined,
                }),
                ...((type === 'http' || type === 'sse') && {
                    url: config.url as string,
                    headers: config.headers && typeof config.headers === 'object' ? config.headers as Record<string, string> : undefined,
                }),
            };

            try {
                await addCustomMcpServer(newServer);
                added.push(id);
                existingIds.add(id);
            } catch {
                // Single failure doesn't block the rest
            }
        }

        if (added.length > 0) {
            const servers = await getAllMcpServers();
            setMcpServersState(servers);
            track('mcp_add', { type: 'json_import', count: added.length });
        }

        if (added.length > 0 && skipped.length === 0) {
            toast.success(`已添加 ${added.length} 个 MCP 服务器`);
            resetMcpForm();
            setShowMcpForm(false);
        } else if (added.length > 0 && skipped.length > 0) {
            toast.success(`已添加 ${added.length} 个，跳过 ${skipped.length} 个已存在的（${skipped.join(', ')}）`);
            resetMcpForm();
            setShowMcpForm(false);
        } else if (skipped.length > 0) {
            setMcpJsonError(`所有服务器均已存在：${skipped.join(', ')}`);
        }
    };

    // Delete custom MCP server
    const handleDeleteMcp = async (serverId: string) => {
        try {
            await deleteCustomMcpServer(serverId);
            setMcpServersState(prev => prev.filter(s => s.id !== serverId));
            setMcpEnabledIds(prev => prev.filter(id => id !== serverId));

            // Track mcp_remove event
            track('mcp_remove');

            toast.success('已删除');
        } catch {
            toast.error('删除失败');
        }
    };

    // Use refs to avoid useEffect dependency issues (P1 fix)
    const providerVerifyStatusRef = useRef(providerVerifyStatus);
    providerVerifyStatusRef.current = providerVerifyStatus;
    const saveProviderVerifyStatusRef = useRef(saveProviderVerifyStatus);
    saveProviderVerifyStatusRef.current = saveProviderVerifyStatus;

    // Check subscription status on mount (with retry for sidecar startup)
    // Uses cached verification result if valid and not expired (30 days)
    useEffect(() => {
        let isMounted = true;
        let retryCount = 0;
        const maxRetries = 3;
        const retryDelay = 1500; // 1.5s between retries

        const verifySubscriptionCredentials = async (status: SubscriptionStatus, forceVerify = false) => {
            // Only verify if oauthAccount exists
            if (!status.available || !status.info) {
                return;
            }

            const currentEmail = status.info.email;
            const cached = providerVerifyStatusRef.current[SUBSCRIPTION_PROVIDER_ID];

            // Only use cache for successful verifications (valid status)
            // Failed verifications are always retried
            if (!forceVerify && cached && cached.status === 'valid') {
                const isExpired = isVerifyExpired(cached.verifiedAt);
                const isSameAccount = cached.accountEmail === currentEmail;

                if (!isExpired && isSameAccount) {
                    // Use cached successful result
                    console.log('[Settings] Using cached subscription verification (valid)');
                    if (isMounted) {
                        setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                            ...prev,
                            verifyStatus: 'valid',
                        } : prev);
                    }
                    return;
                }

                // Log reason for re-verification
                if (isExpired) {
                    console.log('[Settings] Subscription verification expired, re-verifying...');
                } else if (!isSameAccount) {
                    console.log('[Settings] Subscription account changed, re-verifying...');
                }
            } else if (cached && cached.status === 'invalid') {
                console.log('[Settings] Previous verification failed, retrying...');
            }

            // Set loading state
            if (isMounted) {
                setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? { ...prev, verifyStatus: 'loading' } : prev);
            }

            try {
                const result = await apiPostJson<{ success: boolean; error?: string; detail?: string }>('/api/subscription/verify', {});
                const newStatus = result.success ? 'valid' : 'invalid';

                if (result.success) {
                    // Only cache successful verifications
                    await saveProviderVerifyStatusRef.current(SUBSCRIPTION_PROVIDER_ID, 'valid', currentEmail);
                }
                // Don't cache failures - they will be retried next time

                if (isMounted) {
                    // Include detail for diagnosis if available and different from error
                    const errorMsg = result.error && result.detail && result.detail !== result.error
                        ? `${result.error} (${result.detail.slice(0, 100)})`
                        : result.error;
                    setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                        ...prev,
                        verifyStatus: newStatus,
                        verifyError: errorMsg
                    } : prev);
                }
            } catch (err) {
                console.error('[Settings] Subscription verify failed:', err);
                // Don't cache failures - they will be retried next time

                if (isMounted) {
                    setSubscriptionStatus((prev: SubscriptionStatus | null) => prev ? {
                        ...prev,
                        verifyStatus: 'invalid',
                        verifyError: err instanceof Error ? err.message : '验证失败'
                    } : prev);
                }
            }
        };

        const checkSubscription = () => {
            apiGetJson<SubscriptionStatus>('/api/subscription/status')
                .then((status) => {
                    if (!isMounted) return;
                    setSubscriptionStatus({ ...status, verifyStatus: 'idle' });
                    // Auto-verify if oauthAccount exists
                    if (status.available && status.info) {
                        verifySubscriptionCredentials(status);
                    }
                })
                .catch((err) => {
                    if (!isMounted) return;
                    // Retry if sidecar not ready
                    if (retryCount < maxRetries && err.message?.includes('sidecar')) {
                        retryCount++;
                        console.log(`[Settings] Subscription check retry ${retryCount}/${maxRetries}...`);
                        setTimeout(checkSubscription, retryDelay);
                    } else {
                        console.error('[Settings] Failed to check subscription:', err);
                        setSubscriptionStatus({ available: false });
                    }
                });
        };

        // Initial delay to let sidecar start
        const timer = setTimeout(checkSubscription, 500);
        return () => {
            isMounted = false;
            clearTimeout(timer);
        };
    }, []); // Only run on mount - refs handle the latest values

    // Force re-verify subscription (called from UI button)
    const handleReVerifySubscription = useCallback(async () => {
        if (!subscriptionStatus?.available || !subscriptionStatus?.info?.email) {
            return;
        }

        const currentEmail = subscriptionStatus.info.email;
        setSubscriptionVerifying(true);
        setSubscriptionStatus(prev => prev ? { ...prev, verifyStatus: 'loading', verifyError: undefined } : prev);

        try {
            console.log('[Settings] Force re-verifying subscription...');
            const result = await apiPostJson<{ success: boolean; error?: string }>('/api/subscription/verify', {});
            const newStatus = result.success ? 'valid' : 'invalid';

            if (result.success) {
                // Only cache successful verifications
                await saveProviderVerifyStatus(SUBSCRIPTION_PROVIDER_ID, 'valid', currentEmail);
                toast.success('验证成功');
            } else {
                // Don't cache failures - they will be retried next time
                toast.error(result.error || '验证失败');
            }

            setSubscriptionStatus(prev => prev ? {
                ...prev,
                verifyStatus: newStatus,
                verifyError: result.error
            } : prev);
        } catch (err) {
            console.error('[Settings] Subscription re-verify failed:', err);
            // Don't cache failures - they will be retried next time

            setSubscriptionStatus(prev => prev ? {
                ...prev,
                verifyStatus: 'invalid',
                verifyError: err instanceof Error ? err.message : '验证失败'
            } : prev);
            toast.error('验证失败');
        } finally {
            setSubscriptionVerifying(false);
        }
    }, [subscriptionStatus, saveProviderVerifyStatus, toast]);

    // Verify API key for a provider
    const verifyProvider = useCallback(async (provider: Provider, apiKey: string) => {
        if (!apiKey || !provider.config.baseUrl) {
            console.warn('[verifyProvider] Missing apiKey or baseUrl');
            return;
        }

        // Bump generation counter — any in-flight verify for this provider becomes stale
        const gen = (verifyGenRef.current[provider.id] ?? 0) + 1;
        verifyGenRef.current[provider.id] = gen;

        console.log('[verifyProvider] ========================');
        console.log('[verifyProvider] Provider:', provider.id, provider.name, `(gen=${gen})`);
        console.log('[verifyProvider] baseUrl:', provider.config.baseUrl);
        console.log('[verifyProvider] model:', provider.primaryModel);
        console.log('[verifyProvider] apiKey:', apiKey.slice(0, 10) + '...');

        setVerifyLoading((prev) => ({ ...prev, [provider.id]: true }));
        setVerifyError((prev) => { const next = { ...prev }; delete next[provider.id]; return next; });

        try {
            const result = await apiPostJson<{ success: boolean; error?: string; detail?: string }>('/api/provider/verify', {
                baseUrl: provider.config.baseUrl,
                apiKey,
                model: provider.primaryModel,
                authType: provider.authType,
                apiProtocol: provider.apiProtocol,
                maxOutputTokens: provider.maxOutputTokens,
                maxOutputTokensParamName: provider.maxOutputTokensParamName,
                upstreamFormat: provider.upstreamFormat,
            });

            // Stale check: if a newer verify was triggered while we were waiting, discard this result
            if (verifyGenRef.current[provider.id] !== gen) {
                console.log(`[verifyProvider] Discarding stale result (gen=${gen}, current=${verifyGenRef.current[provider.id]})`);
                return;
            }

            console.log('[verifyProvider] Result:', JSON.stringify(result, null, 2));
            console.log('[verifyProvider] ========================');

            if (result.success) {
                await saveProviderVerifyStatus(provider.id, 'valid');
            } else {
                await saveProviderVerifyStatus(provider.id, 'invalid');
                const errorMsg = result.error || '验证失败';
                setVerifyError((prev) => ({ ...prev, [provider.id]: { error: errorMsg, detail: result.detail } }));
                toastRef.current.error(`${provider.name}: ${errorMsg}`);
            }
        } catch (err) {
            // Stale check on error path too
            if (verifyGenRef.current[provider.id] !== gen) return;

            console.error('[verifyProvider] Exception:', err);
            await saveProviderVerifyStatus(provider.id, 'invalid');
            const errorMsg = err instanceof Error ? err.message : '验证失败';
            setVerifyError((prev) => ({ ...prev, [provider.id]: { error: errorMsg } }));
            toastRef.current.error(`${provider.name}: ${errorMsg}`);
        } finally {
            // Only clear loading if this is still the latest generation
            if (verifyGenRef.current[provider.id] === gen) {
                setVerifyLoading((prev) => ({ ...prev, [provider.id]: false }));
            }
        }
    }, [saveProviderVerifyStatus]);

    // Auto-verify when API key changes (with debounce)
    const handleSaveApiKey = useCallback(async (provider: Provider, key: string) => {
        await saveApiKey(provider.id, key);

        // Clear previous timeout for this provider
        if (verifyTimeoutRef.current[provider.id]) {
            clearTimeout(verifyTimeoutRef.current[provider.id]);
        }

        // Clear stale error and popover immediately on any key change
        setVerifyError((prev) => { const next = { ...prev }; delete next[provider.id]; return next; });
        if (errorDetailOpenId === provider.id) setErrorDetailOpenId(null);

        // Clear verification status when key changes - will re-verify
        if (key) {
            // Debounce verification
            verifyTimeoutRef.current[provider.id] = setTimeout(() => {
                verifyProvider(provider, key);
            }, 500);
        }
    }, [saveApiKey, verifyProvider, errorDetailOpenId]);

    // Cleanup timeouts on unmount
    useEffect(() => {
        const timeouts = verifyTimeoutRef.current;
        return () => {
            Object.values(timeouts).forEach(clearTimeout);
        };
    }, []);

    const handleAddCustomProvider = async (): Promise<Provider | null> => {
        if (!customForm.name || !customForm.baseUrl) {
            return null;
        }
        if (customForm.models.length === 0) {
            toast.error('请添加至少一个模型 ID');
            return null;
        }
        const newProvider: Provider = {
            id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
            name: customForm.name,
            vendor: 'Custom',  // 内部保留但不在 UI 显示
            cloudProvider: customForm.cloudProvider || '自定义',
            type: 'api',
            primaryModel: customForm.models[0] ?? '',
            isBuiltin: false,
            authType: customForm.authType,
            apiProtocol: customForm.apiProtocol === 'openai' ? 'openai' : undefined,
            ...(customForm.apiProtocol === 'openai' && customForm.maxOutputTokens ? { maxOutputTokens: parsePositiveInt(customForm.maxOutputTokens) } : {}),
            ...(customForm.apiProtocol === 'openai' && customForm.maxOutputTokensParamName !== 'max_tokens' ? { maxOutputTokensParamName: customForm.maxOutputTokensParamName } : {}),
            ...(customForm.apiProtocol === 'openai' && customForm.upstreamFormat !== 'chat_completions' ? { upstreamFormat: customForm.upstreamFormat } : {}),
            config: {
                baseUrl: customForm.baseUrl,
            },
            models: customForm.models.map((m) => ({
                model: m,
                modelName: m,
                modelSeries: 'custom',
            })),
        };

        try {
            // Save API key FIRST so that addCustomProvider's rebuildAndPersistAvailableProviders()
            // already sees the key and includes this provider in the available list.
            // This fixes the bug where entering API key during creation always failed verification:
            // the old flow saved the provider first (rebuild without key) then saved the key
            // (rebuild with key), but the debounced verification could fire between the two rebuilds.
            if (customForm.apiKey) {
                await saveApiKey(newProvider.id, customForm.apiKey);
            }
            // Persist provider to disk and refresh providers list
            await addCustomProvider(newProvider);
            // Set as default only when no valid default exists (avoid overriding user's existing choice)
            const currentDefault = config.defaultProviderId;
            const defaultStillExists = currentDefault && providers.some(p => p.id === currentDefault);
            if (!defaultStillExists) {
                await updateConfig({ defaultProviderId: newProvider.id });
            }
            // Trigger verification directly (no debounce — unlike handleSaveApiKey which
            // debounces for keystroke input, creation is a one-shot operation)
            if (customForm.apiKey) {
                verifyProvider(newProvider, customForm.apiKey);
            }
            toast.success('服务商添加成功');
        } catch (error) {
            console.error('[Settings] Failed to add custom provider:', error);
            toast.error('添加服务商失败');
            return null;
        }

        setCustomForm(EMPTY_CUSTOM_FORM);
        setShowCustomForm(false);
        return newProvider;
    };

    // 确认删除自定义供应商
    const confirmDeleteCustomProvider = async () => {
        if (!deleteConfirmProvider) return;
        const providerId = deleteConfirmProvider.id;

        try {
            // 检查是否有项目正在使用该供应商，如果有则切换到其他供应商
            const affectedProjects = projects.filter(p => p.providerId === providerId);
            if (affectedProjects.length > 0) {
                // 找到第一个可用的其他供应商
                const alternativeProvider = providers.find(p => p.id !== providerId);
                if (alternativeProvider) {
                    // 更新所有受影响的项目
                    for (const project of affectedProjects) {
                        await updateProject({
                            ...project,
                            providerId: alternativeProvider.id,
                        });
                    }
                    console.log(`[Settings] Switched ${affectedProjects.length} project(s) to ${alternativeProvider.name}`);
                }
            }

            // Delete from disk, remove API key, and refresh providers list
            await deleteCustomProviderService(providerId);
            toast.success('服务商已删除');
        } catch (error) {
            console.error('[Settings] Failed to delete custom provider:', error);
            toast.error('删除服务商失败');
        }
        setDeleteConfirmProvider(null);
        setEditingProvider(null);
    };

    // Open provider management panel
    const openProviderManage = (provider: Provider) => {
        // For preset providers, we allow adding custom models
        // For custom providers, we can edit all fields
        const effectiveAliases = getEffectiveModelAliases(provider, config.providerModelAliases);
        setEditingProvider({
            provider,
            customModels: [],  // TODO: Load from persisted custom models if any
            removedModels: [], // 标记要删除的已保存模型
            newModelInput: '',
            editModelAliases: effectiveAliases ? { ...effectiveAliases } : { sonnet: '', opus: '', haiku: '' },
            showAdvanced: false,
            // 为自定义供应商初始化编辑字段
            ...(provider.isBuiltin ? {} : {
                editName: provider.name,
                editCloudProvider: provider.cloudProvider,
                editApiProtocol: provider.apiProtocol ?? 'anthropic',
                editBaseUrl: provider.config.baseUrl || '',
                editAuthType: provider.authType === 'api_key' ? 'api_key' : 'auth_token',
                editMaxOutputTokens: provider.maxOutputTokens ? String(provider.maxOutputTokens) : '',
                editMaxOutputTokensParamName: provider.maxOutputTokensParamName ?? 'max_tokens',
                editUpstreamFormat: provider.upstreamFormat ?? 'chat_completions',
            }),
        });
    };

    // Save provider edits
    const saveProviderEdits = async () => {
        if (!editingProvider) return;
        const { provider, customModels, removedModels, editName, editCloudProvider, editApiProtocol, editBaseUrl, editAuthType, editModelAliases } = editingProvider;

        // Save model aliases for preset providers (custom providers store aliases on the Provider object itself)
        if (provider.isBuiltin && editModelAliases && provider.id !== 'anthropic-sub' && provider.id !== 'anthropic-api') {
            try {
                await saveProviderModelAliases(provider.id, editModelAliases);
            } catch (error) {
                console.error('[Settings] Failed to save model aliases:', error);
            }
        }

        if (provider.isBuiltin) {
            // For preset providers: save user-added custom models
            // 1. Get existing user-added models (from config.presetCustomModels)
            const existingCustomModels = config.presetCustomModels?.[provider.id] ?? [];
            // 2. Filter out removed models
            const remainingCustomModels = existingCustomModels.filter(m => !removedModels.includes(m.model));
            // 3. Add newly added models
            const newCustomModels = customModels.map(m => ({
                model: m,
                modelName: m,
                modelSeries: 'custom' as const,
            }));
            const finalCustomModels = [...remainingCustomModels, ...newCustomModels];
            // 4. Save
            try {
                await savePresetCustomModels(provider.id, finalCustomModels);
                if (customModels.length > 0 || removedModels.length > 0) {
                    toast.success('模型配置已更新');
                }
            } catch (error) {
                console.error('[Settings] Failed to save preset custom models:', error);
                toast.error('保存失败');
                return;
            }
        } else {
            // 验证必填字段
            if (!editName?.trim() || !editBaseUrl?.trim()) {
                toast.error('名称和 Base URL 不能为空');
                return;
            }
            // 验证 Base URL 格式
            const trimmedUrl = editBaseUrl.trim();
            if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
                toast.error('Base URL 必须以 http:// 或 https:// 开头');
                return;
            }
            // Filter out removed models from existing list, then add new custom models
            const remainingModels = provider.models.filter(m => !removedModels.includes(m.model));
            // Validate: at least one model must remain
            if (remainingModels.length === 0 && customModels.length === 0) {
                toast.error('供应商至少需要保留一个模型');
                return;
            }
            const finalModels = [
                ...remainingModels,
                ...customModels.map((m) => ({
                    model: m,
                    modelName: m,
                    modelSeries: 'custom' as const,
                })),
            ];
            // 若 primaryModel 已被删除，改用第一个可用模型
            const validPrimary = finalModels.some(m => m.model === provider.primaryModel)
                ? provider.primaryModel
                : finalModels[0].model;
            // For custom providers, update the provider and persist to disk
            const updatedProvider: Provider = {
                ...provider,
                name: editName.trim(),
                cloudProvider: editCloudProvider?.trim() || '自定义',
                primaryModel: validPrimary,
                authType: editAuthType ?? provider.authType ?? 'auth_token',
                apiProtocol: editApiProtocol === 'openai' ? 'openai' : undefined,
                maxOutputTokens: editApiProtocol === 'openai' && editingProvider?.editMaxOutputTokens ? parsePositiveInt(editingProvider.editMaxOutputTokens) : undefined,
                maxOutputTokensParamName: editApiProtocol === 'openai' && editingProvider?.editMaxOutputTokensParamName && editingProvider.editMaxOutputTokensParamName !== 'max_tokens' ? editingProvider.editMaxOutputTokensParamName : undefined,
                upstreamFormat: editApiProtocol === 'openai' && editingProvider?.editUpstreamFormat !== 'chat_completions' ? editingProvider?.editUpstreamFormat : undefined,
                modelAliases: editModelAliases
                    ? Object.fromEntries(Object.entries(editModelAliases).filter(([, v]) => v)) as ModelAliases
                    : undefined,
                config: {
                    ...provider.config,
                    baseUrl: editBaseUrl.trim(),
                },
                models: finalModels,
            };
            try {
                await updateCustomProvider(updatedProvider);
                toast.success('服务商已更新');
            } catch (error) {
                console.error('[Settings] Failed to update custom provider:', error);
                toast.error('更新服务商失败');
            }
        }
        setEditingProvider(null);
    };

    // providers from useConfig includes both preset and custom providers
    const allProviders = providers;

    // Refs for API Key expiry check (P2 fix - avoid stale closures)
    const allProvidersRef = useRef(allProviders);
    allProvidersRef.current = allProviders;
    const apiKeysRef = useRef(apiKeys);
    apiKeysRef.current = apiKeys;
    const verifyProviderRef = useRef(verifyProvider);
    verifyProviderRef.current = verifyProvider;

    // Check for expired API Key verifications on mount (30-day expiry)
    useEffect(() => {
        // Delay to let component stabilize
        const timer = setTimeout(() => {
            allProvidersRef.current.forEach((provider: Provider) => {
                // Skip subscription type (handled separately)
                if (provider.type === 'subscription') return;

                const apiKey = apiKeysRef.current[provider.id];
                const cached = providerVerifyStatusRef.current[provider.id];

                // Only check if has API key and has cached verification
                if (apiKey && cached?.verifiedAt) {
                    if (isVerifyExpired(cached.verifiedAt)) {
                        console.log(`[Settings] Provider ${provider.id} verification expired, re-verifying...`);
                        verifyProviderRef.current(provider, apiKey);
                    }
                }
            });
        }, 1000); // 1s delay to avoid race conditions

        return () => clearTimeout(timer);
    }, []); // Only run on mount - refs handle the latest values

    // Error detail popover ref (state is declared near verifyError)
    const errorDetailPopoverRef = useRef<HTMLDivElement>(null);

    // Close error detail popover on outside click or when the error is cleared
    useEffect(() => {
        if (!errorDetailOpenId) return;
        // If the error for the open popover has been cleared, close the popover
        if (!verifyError[errorDetailOpenId]) {
            setErrorDetailOpenId(null);
            return;
        }
        const handleClick = (e: MouseEvent) => {
            if (errorDetailPopoverRef.current && !errorDetailPopoverRef.current.contains(e.target as Node)) {
                setErrorDetailOpenId(null);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [errorDetailOpenId, verifyError]);

    // Render verification status indicator (icon row)
    const renderVerifyStatus = (provider: Provider) => {
        const isLoading = verifyLoading[provider.id];
        const cached = providerVerifyStatus[provider.id];
        const verifyStatus = cached?.status; // 'valid' | 'invalid' | undefined
        const hasKey = !!apiKeys[provider.id];

        if (!hasKey) {
            return null;
        }

        return (
            <div className="flex items-center gap-1">
                {isLoading && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--info-bg)]">
                        <Loader2 className="h-4 w-4 animate-spin text-[var(--info)]" />
                    </div>
                )}
                {!isLoading && verifyStatus === 'valid' && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--success-bg)]">
                        <Check className="h-4 w-4 text-[var(--success)]" />
                    </div>
                )}
                {!isLoading && verifyStatus === 'invalid' && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--error-bg)]">
                        <AlertCircle className="h-4 w-4 text-[var(--error)]" />
                    </div>
                )}
                {!isLoading && !verifyStatus && (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--warning-bg)]" title="待验证">
                        <AlertCircle className="h-4 w-4 text-[var(--warning)]" />
                    </div>
                )}
                {/* Refresh button for re-verification - hide if already valid */}
                {verifyStatus !== 'valid' && (
                    <button
                        type="button"
                        onClick={() => verifyProvider(provider, apiKeys[provider.id])}
                        disabled={isLoading}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                        title="重新验证"
                    >
                        <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>
                )}
            </div>
        );
    };

    // Render inline error line below the API key input row
    const renderVerifyError = (provider: Provider) => {
        const errObj = verifyError[provider.id];
        if (!errObj) return null;

        return (
            <div className="flex items-start gap-1.5 pt-1.5 text-xs text-[var(--error)]">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">{errObj.error}</span>
                {errObj.detail && errObj.detail !== errObj.error && (
                    <div className="relative shrink-0">
                        <button
                            type="button"
                            onClick={() => setErrorDetailOpenId(
                                errorDetailOpenId === provider.id ? null : provider.id
                            )}
                            className="whitespace-nowrap text-[var(--ink-muted)] underline decoration-dotted transition-colors hover:text-[var(--ink)]"
                        >
                            详情
                        </button>
                        {errorDetailOpenId === provider.id && (
                            <div
                                ref={errorDetailPopoverRef}
                                className="absolute right-0 top-6 z-50 w-80 max-w-[90vw] rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3 shadow-lg"
                            >
                                <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--ink-muted)]">错误详情</p>
                                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--ink-secondary)]">{errObj.detail}</pre>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="flex h-full bg-[var(--paper)]">
            {/* Logs Panel */}
            <UnifiedLogsPanel
                sseLogs={sseLogs}
                isVisible={showLogs}
                onClose={() => setShowLogs(false)}
                onClearAll={clearLogs}
            />

            {/* Left sidebar */}
            <div className="settings-sidebar w-52 shrink-0 p-6">
                <div className="mb-6 flex items-center justify-between">
                    <h1 className="text-xl font-semibold text-[var(--ink)]">设置</h1>
                    {config.showDevTools && (
                        <button
                            onClick={() => setShowLogs(true)}
                            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            title="查看 Rust 日志"
                        >
                            Logs
                        </button>
                    )}
                </div>

                <nav className="space-y-1">
                    <button
                        onClick={() => setActiveSection('providers')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'providers'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        模型供应商
                    </button>
                    <button
                        onClick={() => setActiveSection('skills')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'skills' || activeSection === 'sub-agents'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        技能 Skills
                    </button>
                    <button
                        onClick={() => setActiveSection('mcp')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'mcp'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        工具 MCP
                    </button>
                    <button
                        onClick={() => setActiveSection('agent')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'agent'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        远程操控 Bot
                    </button>
                    <button
                        onClick={() => setActiveSection('usage-stats')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'usage-stats'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        使用统计
                    </button>
                    <button
                        onClick={() => setActiveSection('general')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'general'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        通用设置
                    </button>
                    <button
                        onClick={() => setActiveSection('about')}
                        className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${activeSection === 'about'
                            ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                    >
                        关于&反馈
                    </button>
                </nav>
            </div>

            {/* Right content area — h-full ensures height is explicit for WebKit scroll */}
            <div className="h-full flex-1 overflow-y-auto overscroll-contain">
                {/* Skills + Sub-Agents section uses wider layout */}
                {(activeSection === 'skills' || activeSection === 'sub-agents') && (
                    <div className="mx-auto max-w-4xl px-8 py-8 space-y-10">
                        {!agentsInDetail && <GlobalSkillsPanel onDetailChange={setSkillsInDetail} />}
                        {!skillsInDetail && <GlobalAgentsPanel onDetailChange={setAgentsInDetail} />}
                    </div>
                )}

                {/* Bot Platform Registry (formerly Agent / IM Bot) */}
                {activeSection === 'agent' && (
                    <div className="mx-auto max-w-4xl px-8 py-8">
                        <BotPlatformRegistry />
                    </div>
                )}

                {/* Usage Stats section */}
                {activeSection === 'usage-stats' && (
                    <div className="mx-auto max-w-4xl px-8 py-8">
                        <UsageStatsPanel />
                    </div>
                )}

                {/* Providers section uses wider layout */}
                {activeSection === 'providers' && (
                    <div className="mx-auto max-w-4xl px-8 py-8">
                        <div className="mb-8 flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-[var(--ink)]">模型供应商</h2>
                            <button
                                onClick={() => setShowCustomForm(true)}
                                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                添加
                            </button>
                        </div>

                        <p className="mb-6 text-sm text-[var(--ink-muted)]">
                            配置 API 密钥以使用不同的模型供应商
                        </p>

                        {/* Provider list */}
                        <div className="grid grid-cols-2 gap-4">
                            {allProviders.map((provider) => (
                                <div
                                    key={provider.id}
                                    className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
                                >
                                    {/* Provider header */}
                                    <div className="mb-4 flex items-start justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2">
                                                <h3 className="truncate font-semibold text-[var(--ink)]">{provider.name}</h3>
                                                <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                                                    {provider.cloudProvider}
                                                </span>
                                                {provider.apiProtocol === 'openai' && (
                                                    <span className="shrink-0 rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                                                        OpenAI 协议
                                                    </span>
                                                )}
                                            </div>
                                            <p className="mt-1 truncate text-xs text-[var(--ink-muted)]">
                                                {provider.models.length > 0
                                                    ? provider.models.map(m => m.modelName || m.model).join(', ')
                                                    : '暂无模型'}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            {provider.websiteUrl && (
                                                <ExternalLink
                                                    href={provider.websiteUrl}
                                                    className="rounded-lg px-1.5 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                                >
                                                    去官网
                                                </ExternalLink>
                                            )}
                                            <button
                                                onClick={() => openProviderManage(provider)}
                                                className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                                title="管理"
                                            >
                                                <Settings2 className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>

                                    {/* API Key input */}
                                    {provider.type === 'api' && (
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <div className="relative flex-1">
                                                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                                                    <input
                                                        type="password"
                                                        placeholder="输入 API Key"
                                                        value={apiKeys[provider.id] || ''}
                                                        onChange={(e) => handleSaveApiKey(provider, e.target.value)}
                                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] py-2.5 pl-10 pr-4 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)] transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                    />
                                                </div>
                                                {renderVerifyStatus(provider)}
                                            </div>
                                            {renderVerifyError(provider)}
                                        </div>
                                    )}

                                    {/* Subscription type - show status */}
                                    {provider.type === 'subscription' && (
                                        <div className="space-y-2">
                                            <p className="text-sm text-[var(--ink-muted)]">
                                                使用 Anthropic 订阅账户，无需 API Key
                                            </p>
                                            {/* Subscription status display */}
                                            <div className="flex items-center gap-2 text-xs flex-wrap">
                                                {subscriptionStatus?.available ? (
                                                    <>
                                                        {/* Email display first */}
                                                        <span className="text-[var(--ink-muted)] font-mono text-[10px]">
                                                            {subscriptionStatus.info?.email}
                                                        </span>
                                                        {/* Verification status after email */}
                                                        {subscriptionStatus.verifyStatus === 'loading' && (
                                                            <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                                <span>验证中...</span>
                                                            </div>
                                                        )}
                                                        {subscriptionStatus.verifyStatus === 'valid' && (
                                                            <div className="flex items-center gap-1.5 text-[var(--success)]">
                                                                <Check className="h-3.5 w-3.5" />
                                                                <span className="font-medium">已验证</span>
                                                                <button
                                                                    type="button"
                                                                    onClick={handleReVerifySubscription}
                                                                    disabled={subscriptionVerifying}
                                                                    className="ml-1 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                                                                    title="重新验证"
                                                                >
                                                                    <RefreshCw className={`h-3 w-3 ${subscriptionVerifying ? 'animate-spin' : ''}`} />
                                                                </button>
                                                            </div>
                                                        )}
                                                        {subscriptionStatus.verifyStatus === 'invalid' && (
                                                            <div className="flex items-center gap-1.5 text-[var(--error)]">
                                                                <AlertCircle className="h-3.5 w-3.5" />
                                                                <span className="font-medium">验证失败</span>
                                                                <button
                                                                    type="button"
                                                                    onClick={handleReVerifySubscription}
                                                                    disabled={subscriptionVerifying}
                                                                    className="ml-1 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                                                                    title="重新验证"
                                                                >
                                                                    <RefreshCw className={`h-3 w-3 ${subscriptionVerifying ? 'animate-spin' : ''}`} />
                                                                </button>
                                                            </div>
                                                        )}
                                                        {subscriptionStatus.verifyStatus === 'idle' && (
                                                            <div className="flex items-center gap-1.5 text-[var(--ink-muted)]">
                                                                <span>检测中...</span>
                                                            </div>
                                                        )}
                                                        {/* Error message */}
                                                        {subscriptionStatus.verifyStatus === 'invalid' && subscriptionStatus.verifyError && (
                                                            <span className="text-[var(--error)] text-[10px] w-full mt-1">
                                                                {subscriptionStatus.verifyError}
                                                            </span>
                                                        )}
                                                    </>
                                                ) : (
                                                    <span className="text-[var(--ink-muted)]">
                                                        未登录，请先使用 Claude Code CLI 登录 (claude --login)
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* MCP section uses wider layout */}
                {activeSection === 'mcp' && (
                    <div className="mx-auto max-w-4xl px-8 py-8">
                        <div className="mb-8 flex items-center justify-between">
                            <h2 className="text-lg font-semibold text-[var(--ink)]">工具 MCP</h2>
                            <button
                                onClick={() => { resetMcpForm(); setShowMcpForm(true); }}
                                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                            >
                                <Plus className="h-3.5 w-3.5" />
                                添加
                            </button>
                        </div>

                        <p className="mb-6 text-sm text-[var(--ink-muted)]">
                            MCP (Model Context Protocol) 扩展能力让 Agent 可以使用更多工具
                        </p>

                        {/* MCP Server list */}
                        <div className="grid grid-cols-2 gap-4">
                            {mcpServers.map((server) => {
                                const isEnabled = mcpEnabledIds.includes(server.id);
                                const isEnabling = mcpEnabling[server.id] ?? false;
                                return (
                                    <div
                                        key={server.id}
                                        className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2">
                                                    <Globe className="h-4 w-4 shrink-0 text-[var(--accent-warm)]/70" />
                                                    <h3 className="truncate font-semibold text-[var(--ink)]" title={server.name}>{server.name}</h3>
                                                    {server.isBuiltin && (
                                                        <span className="shrink-0 rounded-full border border-[var(--info)]/20 bg-[var(--info-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--info)]">
                                                            预设
                                                        </span>
                                                    )}
                                                    {server.isFree && (
                                                        <span className="shrink-0 rounded-full border border-[var(--success)]/20 bg-[var(--success-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--success)]">
                                                            免费
                                                        </span>
                                                    )}
                                                    {/* Status indicator */}
                                                    {isEnabling && (
                                                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--info)]" />
                                                    )}
                                                </div>
                                                {server.description && (
                                                    <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={server.description}>
                                                        {server.description}
                                                    </p>
                                                )}
                                                {mcpNeedsConfig[server.id] && (
                                                    <p className="mt-1 text-xs text-[var(--warning)]">
                                                        ⚠️ 需要配置 API Key
                                                    </p>
                                                )}
                                                {server.command !== '__builtin__' && (
                                                    <p className="mt-2 truncate font-mono text-[10px] text-[var(--ink-muted)]" title={`${server.command} ${server.args?.join(' ') ?? ''}`}>
                                                        {server.command} {server.args?.join(' ')}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2">
                                                <button
                                                    onClick={() => server.isBuiltin ? handleEditBuiltinMcp(server) : handleEditMcp(server)}
                                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                                    title="设置"
                                                >
                                                    <Settings2 className="h-4 w-4" />
                                                </button>
                                                <button
                                                    onClick={() => handleMcpToggle(server, !isEnabled)}
                                                    disabled={isEnabling}
                                                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${isEnabling
                                                        ? 'bg-[var(--info)]/60 cursor-wait'
                                                        : isEnabled
                                                            ? 'cursor-pointer bg-[var(--accent)]'
                                                            : 'cursor-pointer bg-[var(--line-strong)]'
                                                        }`}
                                                    title={isEnabling ? '启用中...' : isEnabled ? '已启用' : '点击启用'}
                                                >
                                                    <span
                                                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${isEnabled ? 'translate-x-5' : 'translate-x-0'}`}
                                                    />
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Discovery links */}
                        <div className="mt-8 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                            <p className="text-sm text-[var(--ink-muted)]">
                                更多 MCP 可以在以下网站寻找：
                            </p>
                            <div className="mt-2 flex flex-wrap gap-3">
                                {MCP_DISCOVERY_LINKS.map((link) => (
                                    <ExternalLink
                                        key={link.url}
                                        href={link.url}
                                        className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--paper-elevated)] px-3 py-1.5 text-sm font-medium text-[var(--ink)] shadow-sm transition-colors hover:bg-[var(--info-bg)] hover:text-[var(--info)]"
                                    >
                                        {link.name}
                                        <ExternalLinkIcon className="h-3 w-3" />
                                    </ExternalLink>
                                ))}
                            </div>
                        </div>
                    </div>
                )}

                {/* Other sections use narrower layout */}
                <div className={`mx-auto max-w-xl px-8 py-8 ${['skills', 'agents', 'providers', 'mcp'].includes(activeSection) ? 'hidden' : ''}`}>

                    {activeSection === 'general' && (
                        <div className="space-y-6">
                            <div>
                                <h2 className="text-lg font-semibold text-[var(--ink)]">通用设置</h2>
                                <p className="mt-1 text-sm text-[var(--ink-muted)]">
                                    配置应用程序的通用行为
                                </p>
                            </div>

                            {/* Startup Settings */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">启动设置</h3>

                                {/* Auto Start */}
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">开机启动</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            系统启动时自动运行 PM Copilot
                                        </p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            const success = await setAutostart(!autostartEnabled);
                                            if (success) {
                                                toast.success(autostartEnabled ? '已关闭开机启动' : '已开启开机启动');
                                            } else {
                                                toast.error('设置失败，请重试');
                                            }
                                        }}
                                        disabled={autostartLoading}
                                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                                            autostartLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                                        } ${
                                            autostartEnabled
                                                ? 'bg-[var(--accent)]'
                                                : 'bg-[var(--line-strong)]'
                                        }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                                autostartEnabled ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>

                                {/* Minimize to Tray */}
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">最小化到托盘</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            关闭窗口时最小化到系统托盘而非退出应用
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => {
                                            updateConfig({ minimizeToTray: !config.minimizeToTray });
                                            toast.success(config.minimizeToTray ? '已关闭最小化到托盘' : '已开启最小化到托盘');
                                        }}
                                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                            config.minimizeToTray
                                                ? 'bg-[var(--accent)]'
                                                : 'bg-[var(--line-strong)]'
                                        }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                                config.minimizeToTray ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>

                                {/* 主题 */}
                                <div className="mt-6 flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-[var(--ink)]">主题</p>
                                        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">设置应用外观模式</p>
                                    </div>
                                    <div className="flex gap-0.5 rounded-full bg-[var(--paper-inset)] p-0.5">
                                        {(['system', 'light', 'dark'] as const).map((mode) => (
                                            <button
                                                key={mode}
                                                onClick={() => updateConfig({ theme: mode })}
                                                className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                                                    config.theme === mode
                                                        ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-sm'
                                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
                                                }`}
                                            >
                                                {mode === 'system' ? '跟随系统' : mode === 'light' ? '日间模式' : '夜间模式'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            {/* Default Workspace */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">默认工作区</h3>
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">启动时打开的工作区</p>
                                        <p className="text-xs text-[var(--ink-muted)]">启动页默认使用的工作区路径</p>
                                    </div>
                                    <CustomSelect
                                        value={config.defaultWorkspacePath ?? ''}
                                        options={[
                                            { value: '', label: '无' },
                                            ...projects.map(p => ({
                                                value: p.path,
                                                label: shortenPathForDisplay(p.path),
                                                icon: <FolderOpen className="h-3.5 w-3.5" />,
                                            })),
                                        ]}
                                        onChange={async (val) => {
                                            if (val === '') {
                                                await updateConfig({ defaultWorkspacePath: undefined });
                                            } else {
                                                await updateConfig({ defaultWorkspacePath: val });
                                                toast.success('已设置默认工作区');
                                            }
                                        }}
                                        placeholder="无"
                                        triggerIcon={<FolderOpen className="h-3.5 w-3.5" />}
                                        className="w-[240px]"
                                        footerAction={{
                                            label: '选择文件夹...',
                                            icon: <Plus className="h-3.5 w-3.5" />,
                                            onClick: async () => {
                                                try {
                                                    const { open } = await import('@tauri-apps/plugin-dialog');
                                                    const selected = await open({ directory: true, multiple: false, title: '选择默认工作区' });
                                                    if (selected && typeof selected === 'string') {
                                                        if (!projects.find(p => p.path === selected)) {
                                                            await addProject(selected);
                                                        }
                                                        await updateConfig({ defaultWorkspacePath: selected });
                                                        toast.success('已设置默认工作区');
                                                    }
                                                } catch (err) {
                                                    console.error('[Settings] Browse folder failed:', err);
                                                }
                                            },
                                        }}
                                    />
                                </div>
                            </div>

                            {/* Knowledge Base Path */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">知识库路径</h3>
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">PM 方法论知识库根目录</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            配置后 Agent 可读取知识库中的方法论和模板
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="max-w-[200px] truncate text-sm text-[var(--ink-muted)]">
                                            {kbRootPath || '未配置'}
                                        </span>
                                        <button
                                            onClick={async () => {
                                                try {
                                                    const { open } = await import('@tauri-apps/plugin-dialog');
                                                    const selected = await open({ directory: true, multiple: false, title: '选择知识库根目录' });
                                                    if (selected && typeof selected === 'string') {
                                                        await apiPostJson('/api/kb-path', { kbRootPath: selected });
                                                        setKbRootPath(selected);
                                                        toast.success('已设置知识库路径');
                                                    }
                                                } catch (err) {
                                                    console.error('[Settings] Browse KB folder failed:', err);
                                                }
                                            }}
                                            className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                                            title="选择目录"
                                        >
                                            <FolderOpen className="h-4 w-4" />
                                        </button>
                                        {kbRootPath && (
                                            <button
                                                onClick={async () => {
                                                    try {
                                                        await apiPostJson('/api/kb-path', { kbRootPath: '' });
                                                        setKbRootPath('');
                                                        toast.success('已清除知识库路径');
                                                    } catch (err) {
                                                        console.error('[Settings] Clear KB path failed:', err);
                                                    }
                                                }}
                                                className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                                                title="清除"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Current Model Info */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">当前 AI 模型</h3>
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm text-[var(--ink-muted)]">
                                            供应商：{modelInfo.provider || '未配置'}
                                        </p>
                                        <p className="text-sm text-[var(--ink-muted)]">
                                            模型：{modelInfo.model || '未配置'}
                                        </p>
                                    </div>
                                    <button
                                        onClick={async () => {
                                            try {
                                                const res = await apiGetJson<{ provider: string; model: string }>('/api/model-info');
                                                setModelInfo(res);
                                            } catch (err) {
                                                console.error('[Settings] Refresh model info failed:', err);
                                            }
                                        }}
                                        className="rounded-lg border border-[var(--line)] p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                                        title="刷新"
                                    >
                                        <RefreshCw className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>

                            {/* Notification Settings */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">任务消息通知</h3>

                                {/* Task Notifications */}
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">启用通知</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            AI 完成任务或需要用户确认时通知提醒
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => {
                                            updateConfig({ cronNotifications: !config.cronNotifications });
                                            toast.success(config.cronNotifications ? '已关闭任务通知' : '已开启任务通知');
                                        }}
                                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                            config.cronNotifications
                                                ? 'bg-[var(--accent)]'
                                                : 'bg-[var(--line-strong)]'
                                        }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                                config.cronNotifications ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>
                            </div>

                            {/* Network Proxy Settings */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">网络代理</h3>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                    配置 HTTP/SOCKS5 代理，用于外部 API 请求（如 Clash、V2Ray 等）
                                </p>

                                {/* Enable toggle */}
                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">启用代理</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            开启后所有 API 请求将通过代理服务器转发
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => {
                                            const current = config.proxySettings;
                                            updateConfig({
                                                proxySettings: {
                                                    enabled: !current?.enabled,
                                                    protocol: current?.protocol || PROXY_DEFAULTS.protocol,
                                                    host: current?.host || PROXY_DEFAULTS.host,
                                                    port: current?.port || PROXY_DEFAULTS.port,
                                                }
                                            });
                                        }}
                                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                            config.proxySettings?.enabled
                                                ? 'bg-[var(--accent)]'
                                                : 'bg-[var(--line-strong)]'
                                        }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                                config.proxySettings?.enabled ? 'translate-x-5' : 'translate-x-0'
                                            }`}
                                        />
                                    </button>
                                </div>

                                {/* Proxy settings form (shown when enabled) */}
                                {config.proxySettings?.enabled && (
                                    <div className="mt-4 space-y-3 border-t border-[var(--line)] pt-4">
                                        {/* Protocol */}
                                        <div className="flex items-center gap-3">
                                            <label className="w-16 text-xs text-[var(--ink-muted)]">协议</label>
                                            <CustomSelect
                                                value={config.proxySettings?.protocol || PROXY_DEFAULTS.protocol}
                                                options={[
                                                    { value: 'http', label: 'HTTP' },
                                                    { value: 'socks5', label: 'SOCKS5' },
                                                ]}
                                                onChange={(val) => {
                                                    updateConfig({
                                                        proxySettings: {
                                                            ...config.proxySettings!,
                                                            protocol: val as 'http' | 'socks5',
                                                        }
                                                    });
                                                }}
                                                className="flex-1"
                                            />
                                        </div>

                                        {/* Host */}
                                        <div className="flex items-center gap-3">
                                            <label className="w-16 text-xs text-[var(--ink-muted)]">服务器</label>
                                            <input
                                                type="text"
                                                value={config.proxySettings?.host || PROXY_DEFAULTS.host}
                                                onChange={(e) => {
                                                    const host = e.target.value.trim();
                                                    if (host === '' || isValidProxyHost(host)) {
                                                        updateConfig({
                                                            proxySettings: {
                                                                ...config.proxySettings!,
                                                                host: host || PROXY_DEFAULTS.host,
                                                            }
                                                        });
                                                    }
                                                }}
                                                placeholder={PROXY_DEFAULTS.host}
                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                        </div>

                                        {/* Port */}
                                        <div className="flex items-center gap-3">
                                            <label className="w-16 text-xs text-[var(--ink-muted)]">端口</label>
                                            <input
                                                type="number"
                                                min={1}
                                                max={65535}
                                                value={config.proxySettings?.port || PROXY_DEFAULTS.port}
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    if (value === '') {
                                                        updateConfig({
                                                            proxySettings: {
                                                                ...config.proxySettings!,
                                                                port: PROXY_DEFAULTS.port,
                                                            }
                                                        });
                                                        return;
                                                    }
                                                    const port = parseInt(value, 10);
                                                    if (!isNaN(port) && port >= 1 && port <= 65535) {
                                                        updateConfig({
                                                            proxySettings: {
                                                                ...config.proxySettings!,
                                                                port,
                                                            }
                                                        });
                                                    }
                                                }}
                                                placeholder={String(PROXY_DEFAULTS.port)}
                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                        </div>

                                        {/* Preview */}
                                        <div className="mt-2 rounded-lg bg-[var(--paper-inset)] px-3 py-2">
                                            <span className="text-xs text-[var(--ink-muted)]">代理地址: </span>
                                            <code className="text-xs font-mono text-[var(--ink)]">
                                                {config.proxySettings?.protocol || PROXY_DEFAULTS.protocol}://{config.proxySettings?.host || PROXY_DEFAULTS.host}:{config.proxySettings?.port || PROXY_DEFAULTS.port}
                                            </code>
                                        </div>

                                        <p className="text-[10px] text-[var(--ink-faint)]">
                                            注意：修改后需要重启应用或切换标签页才能生效
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Log Export */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-base font-medium text-[var(--ink)]">运行日志</h3>
                                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                            支持导出近 3 天运行日志排查问题
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={async () => {
                                            setLogExporting(true);
                                            try {
                                                const result = await apiGetJson<{ success: boolean; path?: string; error?: string }>('/api/logs/export');
                                                if (result.success && result.path) {
                                                    toast.success(`已导出至 ${result.path}`);
                                                } else {
                                                    toast.error(result.error || '导出失败');
                                                }
                                            } catch {
                                                toast.error('导出失败，请重试');
                                            } finally {
                                                setLogExporting(false);
                                            }
                                        }}
                                        disabled={logExporting}
                                        className="flex items-center gap-1.5 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-elevated)] disabled:opacity-50"
                                    >
                                        {logExporting ? (
                                            <>
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                导出中...
                                            </>
                                        ) : (
                                            <>
                                                <Download className="h-3.5 w-3.5" />
                                                导出
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>

                        </div>
                    )}

                    {activeSection === 'about' && (
                        <div className="space-y-6">
                            {/* Brand Header */}
                            <div className="rounded-2xl border border-[var(--line)] bg-gradient-to-br from-[var(--paper-inset)] to-[var(--paper)] p-8">
                                <div className="flex flex-col items-center text-center">
                                    <img
                                        src={logoImage}
                                        alt="PM Copilot"
                                        className="mb-4 h-20 w-20"
                                        draggable={false}
                                    />
                                    <h1
                                        className="brand-title text-[3rem] text-[var(--ink)] cursor-default select-none"
                                        onClick={handleLogoTap}
                                    >
                                        PM Copilot
                                    </h1>
                                    <div className="mt-1 flex items-center gap-2">
                                        <p className="text-sm font-medium text-[var(--ink-muted)]">
                                            Version {appVersion || '...'}
                                        </p>
                                        {!propUpdateReady && !updateDownloading && (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    if (!onCheckForUpdate) {
                                                        toast.error('此功能仅在桌面应用中可用');
                                                        return;
                                                    }
                                                    const result = await onCheckForUpdate();
                                                    if (result === 'up-to-date') {
                                                        toast.info('当前已是最新版本');
                                                    } else if (result === 'downloading') {
                                                        toast.info('发现新版本，正在下载...');
                                                    } else if (result === 'error') {
                                                        toast.error('检查更新失败，请稍后重试');
                                                    }
                                                }}
                                                disabled={updateChecking}
                                                className="rounded-lg bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-elevated)] disabled:opacity-50"
                                            >
                                                {updateChecking ? (
                                                    <span className="flex items-center gap-1">
                                                        <Loader2 className="h-3 w-3 animate-spin" />
                                                        检查中...
                                                    </span>
                                                ) : '检查更新'}
                                            </button>
                                        )}
                                    </div>
                                    <p className="mt-3 text-base text-[var(--ink-secondary)]">
                                        从问题定义到产品交付，你的全栈 PM 合伙人
                                    </p>
                                    {updateDownloading && propUpdateVersion && (
                                        <div className="mt-3 space-y-2">
                                            <div className="flex items-center gap-2 text-sm text-[var(--ink-secondary)]">
                                                <Loader2 className="h-4 w-4 animate-spin text-[var(--accent)]" />
                                                <span>
                                                    发现新版本 v{propUpdateVersion}，正在下载
                                                    {downloadProgress != null ? `… ${downloadProgress}%` : '…'}
                                                </span>
                                            </div>
                                            {downloadProgress != null && (
                                                <div className="h-1.5 w-48 overflow-hidden rounded-full bg-[var(--paper-inset)]">
                                                    <div
                                                        className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                                                        style={{ width: `${downloadProgress}%` }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {propUpdateReady && propUpdateVersion && (
                                        <div className="mt-3 flex items-center gap-2">
                                            <span className="text-sm text-[var(--success)]">发现新版本 v{propUpdateVersion}</span>
                                            <button
                                                type="button"
                                                onClick={onRestartAndUpdate}
                                                className="rounded-lg bg-[var(--success)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-90"
                                            >
                                                重启安装
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Product Description — Developer Letter */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-7 py-6">
                                <p className="text-xs font-medium uppercase tracking-widest text-[var(--ink-muted)]/50">From the Developer</p>
                                <div className="mt-4 space-y-5 text-[13px] leading-[1.9] text-[var(--ink-secondary)]">
                                    <p>
                                        <span className="font-semibold text-[var(--ink)]">PM Copilot</span> 不是一个更聪明的聊天框，不是一个插件集合，而是一个拥有产品经理思维、方法论记忆、质量底线和全栈执行力的常驻伙伴。它住在你的电脑里，记住你的项目、偏好和决策历史，和你一起完成从需求分析到原型交付的全流程。
                                    </p>
                                    <p>
                                        不同于每次对话都要重新自我介绍的通用 AI 工具，PM Copilot 内置了 PM 方法论知识库（Working Backwards、RICE 优先级、竞品分析框架等 29 个领域 Skill），通过质量门控和反合理化机制确保每一次产出都达到专业水准。数据始终留在你的电脑里，零外部依赖。
                                    </p>
                                    <p>
                                        我们相信，AI 时代最好的产品经理不是被 AI 替代的人，而是善于与 AI 协作的人。PM Copilot 的使命，就是成为你身边那个懂产品、能执行、有底线的搭档。
                                    </p>
                                </div>
                            </div>

                            {/* 实验室 */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-base font-medium text-[var(--ink)]">实验室</h3>

                                <div className="mt-4 flex items-center justify-between">
                                    <div className="flex-1 pr-4">
                                        <p className="text-sm font-medium text-[var(--ink)]">更多 Agent Runtime</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            启用后可在输入框和Agent设置中选择外部 Runtime 例如 Claude Code CLI、Codex CLI。若关闭，则恢复使用内置 Runtime。
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => updateConfig({ multiAgentRuntime: !config.multiAgentRuntime })}
                                        className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${config.multiAgentRuntime ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                            }`}
                                    >
                                        <span
                                            className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${config.multiAgentRuntime ? 'translate-x-5' : 'translate-x-0'
                                                }`}
                                        />
                                    </button>
                                </div>
                            </div>

                            {/* AI Feedback */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-base font-medium text-[var(--ink)]">PM 助手</h3>
                                        <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                            分析本地日志，帮你排查问题、提交反馈或功能建议
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => setShowBugReport(true)}
                                        className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-elevated)]"
                                    >
                                        反馈问题
                                    </button>
                                </div>
                            </div>

                            {/* User Community QR Code - Show loading state, then image when ready */}
                            {(qrCodeLoading || qrCodeDataUrl) && (
                                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                    <div className="flex flex-col items-center text-center">
                                        <p className="text-sm font-medium text-[var(--ink)]">加入用户交流群</p>
                                        <p className="mt-1 text-xs text-[var(--ink-muted)]">扫码加入，与其他用户交流使用心得</p>
                                        {qrCodeLoading ? (
                                            <div className="mt-4 h-36 w-36 flex items-center justify-center">
                                                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                                            </div>
                                        ) : (
                                            <img
                                                src={qrCodeDataUrl!}
                                                alt="用户交流群二维码"
                                                className="mt-4 h-36 w-36 rounded-lg"
                                            />
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Contact & Links */}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Developer</p>
                                        <p className="mt-1 text-[var(--ink)]">AIMatrix</p>
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Website</p>
                                        <ExternalLink
                                            href="https://ai-matrix.site"
                                            className="mt-1 block text-[var(--accent)] hover:underline"
                                        >
                                            ai-matrix.site
                                        </ExternalLink>
                                    </div>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-muted)]">Contact</p>
                                        <ExternalLink
                                            href="mailto:aimatrixling@gmail.com"
                                            className="mt-1 block text-[var(--accent)] hover:underline"
                                        >
                                            aimatrixling@gmail.com
                                        </ExternalLink>
                                    </div>
                                </div>
                            </div>

                            {/* Copyright */}
                            <p className="text-center text-xs text-[var(--ink-muted)]">
                                © 2026 AIMatrix. All rights reserved.
                            </p>

                            {/* Developer Section - Hidden by default, unlocked by tapping logo 5 times */}
                            {devSectionVisible && (
                                <div>
                                    <h2 className="mb-4 text-base font-medium text-[var(--ink-muted)]">开发者</h2>
                                    <div className="space-y-4">
                                        {/* Developer Mode Toggle */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <h3 className="text-sm font-medium text-[var(--ink)]">开发者模式</h3>
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                        显示页面上的日志入口按钮（如 Logs、System Info 等）。
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={() => updateConfig({ showDevTools: !config.showDevTools })}
                                                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${config.showDevTools ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                                        }`}
                                                >
                                                    <span
                                                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${config.showDevTools ? 'translate-x-5' : 'translate-x-0'
                                                            }`}
                                                    />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Split View Toggle */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <h3 className="text-sm font-medium text-[var(--ink)]">分屏预览（实验性）</h3>
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                        点击文件在右侧分屏打开预览，而非弹窗。
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={() => updateConfig({ experimentalSplitView: !(config.experimentalSplitView ?? true) })}
                                                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${(config.experimentalSplitView ?? true) ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                                        }`}
                                                >
                                                    <span
                                                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${(config.experimentalSplitView ?? true) ? 'translate-x-5' : 'translate-x-0'
                                                            }`}
                                                    />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Build Versions */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                            <h3 className="mb-3 text-sm font-medium text-[var(--ink)]">构建信息</h3>
                                            <div className="space-y-2 text-xs">
                                                {(() => {
                                                    const versions = getBuildVersions();
                                                    return (
                                                        <>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Claude Agent SDK</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.claudeAgentSdk}</span>
                                                            </div>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Bun Runtime</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.bun}</span>
                                                            </div>
                                                            <div className="flex justify-between">
                                                                <span className="text-[var(--ink-muted)]">Tauri</span>
                                                                <span className="font-mono text-[var(--ink)]">{versions.tauri}</span>
                                                            </div>
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                        </div>

                                        {/* Cron Task Debug Panel */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                            <div className="flex items-center justify-between">
                                                <div>
                                                    <h3 className="text-sm font-medium text-[var(--ink)]">循环任务</h3>
                                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                        查看和管理运行中的循环任务（开发调试用）
                                                    </p>
                                                </div>
                                                <button
                                                    onClick={() => setShowCronDebugPanel(true)}
                                                    className="rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-elevated)]"
                                                >
                                                    打开面板
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Cron Task Debug Panel Modal */}
                            <CronTaskDebugPanel
                                isOpen={showCronDebugPanel}
                                onClose={() => setShowCronDebugPanel(false)}
                            />
                        </div>
                    )}

                </div>
            </div>

            {/* Builtin MCP Settings Modal */}
            {builtinMcpSettings && (
                <OverlayBackdrop className="z-50">
                    <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                            <div className="min-w-0 flex-1">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">{builtinMcpSettings.server.name} 设置</h2>
                                {builtinMcpSettings.server.description && (
                                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{builtinMcpSettings.server.description}</p>
                                )}
                            </div>
                            <button onClick={() => setBuiltinMcpSettings(null)} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                            {/* Preset command/URL (read-only) */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">
                                    {builtinMcpSettings.server.type === 'stdio' ? '预设命令' : '服务地址'}
                                </label>
                                <div className="rounded-lg bg-[var(--paper-inset)] px-3 py-2 font-mono text-xs text-[var(--ink-muted)]">
                                    {builtinMcpSettings.server.type === 'stdio'
                                        ? `${builtinMcpSettings.server.command} ${(getPresetMcpServer(builtinMcpSettings.server.id)?.args ?? []).join(' ')}`
                                        : (builtinMcpSettings.server.url?.replace(/\{\{\w+\}\}/g, '***') ?? '')}
                                </div>
                            </div>

                            {/* Extra Args (stdio only) */}
                            {builtinMcpSettings.server.type === 'stdio' && <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">额外参数</label>
                                <p className="text-xs text-[var(--ink-muted)] mb-2">以下参数将追加到预设命令之后</p>
                                <div className="space-y-2">
                                    {builtinMcpSettings.extraArgs.map((arg, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="flex-1 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 font-mono text-xs text-[var(--ink)] break-all">
                                                {arg}
                                            </span>
                                            <button
                                                onClick={() => setBuiltinMcpSettings(prev => prev ? {
                                                    ...prev,
                                                    extraArgs: prev.extraArgs.filter((_, i) => i !== idx),
                                                } : null)}
                                                className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={builtinMcpSettings.newArg}
                                            onChange={e => setBuiltinMcpSettings(prev => prev ? { ...prev, newArg: e.target.value } : null)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && builtinMcpSettings.newArg.trim()) {
                                                    setBuiltinMcpSettings(prev => prev ? {
                                                        ...prev,
                                                        extraArgs: [...prev.extraArgs, prev.newArg.trim()],
                                                        newArg: '',
                                                    } : null);
                                                }
                                            }}
                                            placeholder="输入参数，如 --headless"
                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                                        />
                                        <button
                                            onClick={() => {
                                                if (builtinMcpSettings.newArg.trim()) {
                                                    setBuiltinMcpSettings(prev => prev ? {
                                                        ...prev,
                                                        extraArgs: [...prev.extraArgs, prev.newArg.trim()],
                                                        newArg: '',
                                                    } : null);
                                                }
                                            }}
                                            disabled={!builtinMcpSettings.newArg.trim()}
                                            className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>}

                            {/* Config hint + website link */}
                            {(builtinMcpSettings.server.configHint || builtinMcpSettings.server.websiteUrl) && (
                                <div className="flex items-center gap-2 rounded-lg bg-[var(--accent-bg)] px-3 py-2 text-xs text-[var(--ink-secondary)]">
                                    <Globe className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                                    <span>{builtinMcpSettings.server.configHint}</span>
                                    {builtinMcpSettings.server.websiteUrl && (
                                        <ExternalLink
                                            href={builtinMcpSettings.server.websiteUrl}
                                            className="ml-auto shrink-0 font-medium text-[var(--accent)] hover:underline"
                                        >
                                            去注册
                                        </ExternalLink>
                                    )}
                                </div>
                            )}

                            {/* Environment Variables */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">环境变量</label>
                                <div className="space-y-2">
                                    {Object.entries(builtinMcpSettings.env).map(([key, value]) => (
                                        <div key={key} className="flex items-center gap-2">
                                            <span className="shrink-0 rounded bg-[var(--paper-inset)] px-2 py-1 font-mono text-[10px] text-[var(--ink)]">
                                                {key}
                                            </span>
                                            <input
                                                type="text"
                                                value={value}
                                                onChange={e => setBuiltinMcpSettings(prev => prev ? {
                                                    ...prev,
                                                    env: { ...prev.env, [key]: e.target.value },
                                                } : null)}
                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1 font-mono text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                                            />
                                            <button
                                                onClick={() => setBuiltinMcpSettings(prev => {
                                                    if (!prev) return null;
                                                    const newEnv = { ...prev.env };
                                                    delete newEnv[key];
                                                    return { ...prev, env: newEnv };
                                                })}
                                                className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={builtinMcpSettings.newEnvKey}
                                            onChange={e => setBuiltinMcpSettings(prev => prev ? { ...prev, newEnvKey: e.target.value } : null)}
                                            placeholder="变量名"
                                            className="w-1/3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 font-mono text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                                        />
                                        <input
                                            type="text"
                                            value={builtinMcpSettings.newEnvValue}
                                            onChange={e => setBuiltinMcpSettings(prev => prev ? { ...prev, newEnvValue: e.target.value } : null)}
                                            placeholder="值"
                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 font-mono text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    const key = builtinMcpSettings.newEnvKey.trim();
                                                    if (key && !(key in builtinMcpSettings.env)) {
                                                        setBuiltinMcpSettings(prev => prev ? {
                                                            ...prev,
                                                            env: { ...prev.env, [key]: prev.newEnvValue },
                                                            newEnvKey: '',
                                                            newEnvValue: '',
                                                        } : null);
                                                    }
                                                }
                                            }}
                                        />
                                        <button
                                            onClick={() => {
                                                const key = builtinMcpSettings.newEnvKey.trim();
                                                if (key && !(key in builtinMcpSettings.env)) {
                                                    setBuiltinMcpSettings(prev => prev ? {
                                                        ...prev,
                                                        env: { ...prev.env, [key]: prev.newEnvValue },
                                                        newEnvKey: '',
                                                        newEnvValue: '',
                                                    } : null);
                                                }
                                            }}
                                            disabled={!builtinMcpSettings.newEnvKey.trim() || builtinMcpSettings.newEnvKey.trim() in builtinMcpSettings.env}
                                            className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                            <button
                                onClick={() => setBuiltinMcpSettings(null)}
                                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleSaveBuiltinMcp}
                                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Gemini Image Settings Modal */}
            {geminiImageSettings && (
                <OverlayBackdrop className="z-50">
                    <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                            <div className="min-w-0 flex-1">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">Gemini 图片生成 设置</h2>
                                {getPresetMcpServer('gemini-image')?.description && (
                                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{getPresetMcpServer('gemini-image')?.description}</p>
                                )}
                            </div>
                            <button onClick={() => setGeminiImageSettings(null)} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                            {/* API Key */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">API Key *</label>
                                <input
                                    type="password"
                                    value={geminiImageSettings.apiKey}
                                    onChange={e => setGeminiImageSettings(prev => prev ? { ...prev, apiKey: e.target.value } : null)}
                                    placeholder="AIzaSy..."
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                />
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                    从 <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">aistudio.google.com</a> 免费获取
                                </p>
                            </div>

                            {/* Base URL */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">API Base URL</label>
                                <input
                                    type="text"
                                    value={geminiImageSettings.baseUrl}
                                    onChange={e => setGeminiImageSettings(prev => prev ? { ...prev, baseUrl: e.target.value } : null)}
                                    placeholder="留空使用官方端点"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                />
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">留空使用官方端点。支持兼容 Gemini 原生协议的第三方中转</p>
                            </div>

                            {/* Model */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">模型</label>
                                <div className="flex flex-wrap gap-2">
                                    {[
                                        { id: 'gemini-2.5-flash-image', label: 'Nano Banana', desc: 'Stable · 速度快 · 免费额度多' },
                                        { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', desc: 'Preview · 质量最高 · 文字渲染最佳' },
                                        { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2', desc: 'Preview · 速度+质量平衡（推荐）' },
                                    ].map(m => (
                                        <button
                                            key={m.id}
                                            onClick={() => setGeminiImageSettings(prev => prev ? { ...prev, model: m.id } : null)}
                                            className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                                                geminiImageSettings.model === m.id
                                                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                                                    : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-muted)]'
                                            }`}
                                        >
                                            <div className="font-medium">{m.label}</div>
                                            <div className="text-[10px] opacity-70">{m.desc}</div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Aspect Ratio */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">默认宽高比</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {['auto', '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '4:5', '5:4', '21:9'].map(r => (
                                        <button
                                            key={r}
                                            onClick={() => setGeminiImageSettings(prev => prev ? { ...prev, aspectRatio: r } : null)}
                                            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${r !== 'auto' ? 'font-mono' : ''} ${
                                                geminiImageSettings.aspectRatio === r
                                                    ? 'bg-[var(--accent)] text-white'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                            }`}
                                        >
                                            {r === 'auto' ? '自动' : r}
                                        </button>
                                    ))}
                                </div>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">自动 = 不传参数，由模型决定（默认 1:1）</p>
                            </div>

                            {/* Resolution */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">默认分辨率</label>
                                <div className="flex gap-2">
                                    {['auto', '1K', '2K', '4K'].map(s => (
                                        <button
                                            key={s}
                                            onClick={() => setGeminiImageSettings(prev => prev ? { ...prev, imageSize: s } : null)}
                                            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                                                geminiImageSettings.imageSize === s
                                                    ? 'bg-[var(--accent)] text-white'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                            }`}
                                        >
                                            {s === 'auto' ? '自动' : s}
                                        </button>
                                    ))}
                                </div>
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">自动 = 不传参数，由模型决定（默认 1K）</p>
                            </div>

                            {/* Advanced Section Divider */}
                            <div className="border-t border-[var(--line)] pt-4">
                                <span className="text-sm font-medium text-[var(--ink-muted)]">高级设置</span>
                            </div>

                            {/* Thinking Level */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">推理深度</label>
                                <div className="flex gap-2">
                                    {[
                                        { id: 'auto', label: '自动', desc: '不传参数 · 由模型决定' },
                                        { id: 'minimal', label: '快速', desc: '速度优先（模型默认值）' },
                                        { id: 'high', label: '高质量', desc: '推理更深 · 生成更精细但更慢' },
                                    ].map(t => (
                                        <button
                                            key={t.id}
                                            onClick={() => setGeminiImageSettings(prev => prev ? { ...prev, thinkingLevel: t.id } : null)}
                                            className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                                                geminiImageSettings.thinkingLevel === t.id
                                                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                                                    : 'border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--ink-muted)]'
                                            }`}
                                        >
                                            {t.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Search Grounding */}
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-sm font-medium text-[var(--ink)]">搜索增强</div>
                                    <div className="text-xs text-[var(--ink-muted)]">生成前搜索 Google 获取实时信息（人物、事件、天气等）</div>
                                </div>
                                <button
                                    onClick={() => setGeminiImageSettings(prev => prev ? { ...prev, searchGrounding: !prev.searchGrounding } : null)}
                                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                        geminiImageSettings.searchGrounding ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                    }`}
                                >
                                    <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                        geminiImageSettings.searchGrounding ? 'translate-x-5' : 'translate-x-0'
                                    }`} />
                                </button>
                            </div>

                            {/* Max Context Turns */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">单次图片会话最大编辑轮次</label>
                                <input
                                    type="number"
                                    min={2}
                                    max={50}
                                    value={geminiImageSettings.maxContextTurns}
                                    onChange={e => setGeminiImageSettings(prev => prev ? { ...prev, maxContextTurns: parseInt(e.target.value, 10) || 20 } : null)}
                                    className="w-20 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]"
                                />
                                <p className="mt-1 text-xs text-[var(--ink-muted)]">超过后自动开始新会话（防止请求体过大）</p>
                            </div>

                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                            <button
                                onClick={() => setGeminiImageSettings(null)}
                                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleSaveGeminiImage}
                                disabled={!geminiImageSettings.apiKey.trim()}
                                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90 disabled:opacity-40"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Playwright Settings Modal */}
            {playwrightSettings && (
                <OverlayBackdrop className="z-50">
                    <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                            <div className="min-w-0 flex-1">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">Playwright 浏览器设置</h2>
                                {getPresetMcpServer('playwright')?.description && (
                                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{getPresetMcpServer('playwright')?.description}</p>
                                )}
                            </div>
                            <button onClick={() => setPlaywrightSettings(null)} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                            {/* Headless Mode */}
                            <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-sm font-medium text-[var(--ink)]">无头模式</div>
                                    <div className="text-xs text-[var(--ink-muted)]">后台运行，不弹出浏览器窗口</div>
                                </div>
                                <button
                                    onClick={() => setPlaywrightSettings(prev => prev ? { ...prev, headless: !prev.headless } : null)}
                                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                        playwrightSettings.headless ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                    }`}
                                >
                                    <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                        playwrightSettings.headless ? 'translate-x-5' : 'translate-x-0'
                                    }`} />
                                </button>
                            </div>

                            {/* Browser */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">浏览器</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {(() => {
                                        const knownBrowsers = [
                                            { id: '', label: '默认 (Chromium)' },
                                            { id: 'chrome', label: 'Chrome' },
                                            { id: 'firefox', label: 'Firefox' },
                                            { id: 'webkit', label: 'WebKit' },
                                            { id: 'msedge', label: 'Edge' },
                                        ];
                                        const isKnown = knownBrowsers.some(b => b.id === playwrightSettings.browser);
                                        const items = isKnown ? knownBrowsers : [...knownBrowsers, { id: playwrightSettings.browser, label: playwrightSettings.browser }];
                                        return items.map(b => (
                                            <button
                                                key={b.id}
                                                onClick={() => setPlaywrightSettings(prev => prev ? { ...prev, browser: b.id } : null)}
                                                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                                                    playwrightSettings.browser === b.id
                                                        ? 'bg-[var(--accent)] text-white'
                                                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                }`}
                                            >
                                                {b.label}
                                            </button>
                                        ));
                                    })()}
                                </div>
                            </div>

                            {/* Device Emulation */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">设备模拟</label>
                                <div className="flex flex-wrap gap-1.5">
                                    {[
                                        { id: '', label: '不模拟' },
                                        ...PLAYWRIGHT_DEVICE_PRESETS.map(name => ({ id: name, label: name })),
                                        { id: '__custom__', label: '自定义' },
                                    ].map(d => (
                                        <button
                                            key={d.id}
                                            onClick={() => setPlaywrightSettings(prev => prev ? { ...prev, device: d.id } : null)}
                                            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                                                playwrightSettings.device === d.id
                                                    ? 'bg-[var(--accent)] text-white'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                            }`}
                                        >
                                            {d.label}
                                        </button>
                                    ))}
                                </div>
                                {playwrightSettings.device === '__custom__' && (
                                    <input
                                        type="text"
                                        value={playwrightSettings.customDevice}
                                        onChange={e => setPlaywrightSettings(prev => prev ? { ...prev, customDevice: e.target.value } : null)}
                                        placeholder="输入设备名称，如 Galaxy S24"
                                        className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                                    />
                                )}
                            </div>

                            {/* Browser Mode Selector */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">浏览器模式</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button
                                        onClick={() => setPlaywrightSettings(prev => prev ? { ...prev, mode: 'persistent' } : null)}
                                        className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                            playwrightSettings.mode === 'persistent'
                                                ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                                                : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                                        }`}
                                    >
                                        <div className={`text-xs font-medium ${playwrightSettings.mode === 'persistent' ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                            持久化模式
                                        </div>
                                        <div className="text-[10px] text-[var(--ink-muted)] mt-0.5 leading-tight">
                                            登录态完整保留，同一时间仅一个对话可使用
                                        </div>
                                    </button>
                                    <button
                                        onClick={() => setPlaywrightSettings(prev => prev ? { ...prev, mode: 'isolated' } : null)}
                                        className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                                            playwrightSettings.mode === 'isolated'
                                                ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                                                : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                                        }`}
                                    >
                                        <div className={`text-xs font-medium ${playwrightSettings.mode === 'isolated' ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                                            独立模式
                                        </div>
                                        <div className="text-[10px] text-[var(--ink-muted)] mt-0.5 leading-tight">
                                            多对话可同时使用，登录态通过快照共享
                                        </div>
                                    </button>
                                </div>
                            </div>

                            {/* Persistent Mode: user-data-dir + warning */}
                            {playwrightSettings.mode === 'persistent' && (
                                <div>
                                    <label className="block text-sm font-medium text-[var(--ink)] mb-1">浏览器数据目录</label>
                                    <input
                                        type="text"
                                        value={playwrightSettings.userDataDir}
                                        onChange={e => setPlaywrightSettings(prev => prev ? { ...prev, userDataDir: e.target.value } : null)}
                                        placeholder="~/.playwright-mcp-profile"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                    />
                                    <div className="mt-2 rounded-lg bg-[var(--warning-bg)] px-3 py-2 text-xs text-[var(--warning)]">
                                        持久化模式下，同一时间只能有一个对话使用浏览器，其他对话需等待
                                    </div>
                                </div>
                            )}

                            {/* Isolated Mode: storage state + cookie management */}
                            {playwrightSettings.mode === 'isolated' && (
                                <div className="space-y-3">
                                    <div>
                                        <div className="flex items-center justify-between mb-1.5">
                                            <label className="text-sm font-medium text-[var(--ink)]">登录态管理</label>
                                            <button
                                                onClick={() => setCookieForm({ editIndex: null, domain: '', name: '', value: '', path: '/' })}
                                                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent)]/10 transition-colors"
                                            >
                                                <Plus className="h-3 w-3" />
                                                添加 Cookie
                                            </button>
                                        </div>
                                        <p className="text-xs text-[var(--ink-muted)] mb-2">
                                            每个对话使用独立浏览器，登录状态通过 Cookie 快照跨对话共享
                                        </p>
                                    </div>

                                    {/* Cookie List */}
                                    {storageStateInfo && storageStateInfo.cookies.length > 0 ? (
                                        <div className="rounded-lg border border-[var(--line)] overflow-hidden">
                                            {storageStateInfo.cookies.map((cookie, idx) => (
                                                <div key={idx} className={`flex items-center justify-between px-3 py-2 ${idx > 0 ? 'border-t border-[var(--line)]' : ''}`}>
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-xs font-medium text-[var(--ink)] truncate">{cookie.name}</span>
                                                            <span className="text-[10px] text-[var(--ink-muted)]">{cookie.domain}</span>
                                                        </div>
                                                        <div className="text-[10px] text-[var(--ink-muted)] truncate mt-0.5 font-mono max-w-[280px]">{cookie.value}</div>
                                                    </div>
                                                    <div className="flex items-center gap-1 shrink-0 ml-2">
                                                        <button
                                                            onClick={() => setCookieForm({
                                                                editIndex: idx,
                                                                domain: cookie.domain,
                                                                name: cookie.name,
                                                                value: cookie.value,
                                                                path: cookie.path,
                                                            })}
                                                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                                        >
                                                            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                                        </button>
                                                        <button
                                                            onClick={() => handleDeleteCookie(idx)}
                                                            className="rounded p-1 text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                        >
                                                            <X className="h-3 w-3" />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="rounded-lg border border-dashed border-[var(--line)] bg-[var(--paper-inset)] px-3 py-4 text-center">
                                            <div className="text-xs text-[var(--ink-muted)]">
                                                暂无已保存的 Cookie
                                            </div>
                                            <div className="text-[10px] text-[var(--ink-muted)] mt-0.5">
                                                AI 使用浏览器登录后会自动保存，也可手动添加
                                            </div>
                                        </div>
                                    )}

                                    {/* Cookie Add/Edit Form (inline) */}
                                    {cookieForm && (
                                        <div className="rounded-lg border border-[var(--accent)]/30 bg-[var(--paper)] p-3 space-y-2.5">
                                            <div className="text-xs font-medium text-[var(--ink)]">
                                                {cookieForm.editIndex !== null ? '编辑 Cookie' : '添加 Cookie'}
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                <div>
                                                    <label className="block text-[10px] text-[var(--ink-muted)] mb-0.5">域名 *</label>
                                                    <input
                                                        type="text"
                                                        value={cookieForm.domain}
                                                        onChange={e => setCookieForm(prev => prev ? { ...prev, domain: e.target.value } : null)}
                                                        placeholder="example.com"
                                                        className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                                    />
                                                </div>
                                                <div>
                                                    <label className="block text-[10px] text-[var(--ink-muted)] mb-0.5">路径</label>
                                                    <input
                                                        type="text"
                                                        value={cookieForm.path}
                                                        onChange={e => setCookieForm(prev => prev ? { ...prev, path: e.target.value } : null)}
                                                        placeholder="/"
                                                        className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                                    />
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-[10px] text-[var(--ink-muted)] mb-0.5">名称 *</label>
                                                <input
                                                    type="text"
                                                    value={cookieForm.name}
                                                    onChange={e => setCookieForm(prev => prev ? { ...prev, name: e.target.value } : null)}
                                                    placeholder="session_id"
                                                    className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[10px] text-[var(--ink-muted)] mb-0.5">值 *</label>
                                                <input
                                                    type="text"
                                                    value={cookieForm.value}
                                                    onChange={e => setCookieForm(prev => prev ? { ...prev, value: e.target.value } : null)}
                                                    placeholder="abc123..."
                                                    className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 text-xs text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                                />
                                            </div>
                                            <div className="flex justify-end gap-2 pt-1">
                                                <button
                                                    onClick={() => setCookieForm(null)}
                                                    className="rounded-md px-3 py-1.5 text-xs text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                                                >
                                                    取消
                                                </button>
                                                <button
                                                    onClick={handleSaveCookie}
                                                    disabled={!cookieForm.domain.trim() || !cookieForm.name.trim() || !cookieForm.value.trim()}
                                                    className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                                                >
                                                    {cookieForm.editIndex !== null ? '更新' : '添加'}
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Advanced Section Divider */}
                            <div className="border-t border-[var(--line)] pt-4">
                                <span className="text-sm font-medium text-[var(--ink-muted)]">高级设置</span>
                            </div>

                            {/* Extra Args */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">额外参数</label>
                                <p className="text-xs text-[var(--ink-muted)] mb-2">如 --proxy-server=... 等（独立模式下 --caps= 会自动合并 storage）</p>
                                <div className="space-y-2">
                                    {playwrightSettings.extraArgs.map((arg, idx) => (
                                        <div key={idx} className="flex items-center gap-2">
                                            <span className="flex-1 rounded-lg bg-[var(--paper-inset)] px-3 py-1.5 font-mono text-xs text-[var(--ink)] break-all">
                                                {arg}
                                            </span>
                                            <button
                                                onClick={() => setPlaywrightSettings(prev => prev ? {
                                                    ...prev,
                                                    extraArgs: prev.extraArgs.filter((_, i) => i !== idx),
                                                } : null)}
                                                className="shrink-0 rounded p-1 text-[var(--error)] hover:bg-[var(--error-bg)]"
                                            >
                                                <X className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={playwrightSettings.newArg}
                                            onChange={e => setPlaywrightSettings(prev => prev ? { ...prev, newArg: e.target.value } : null)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter' && playwrightSettings.newArg.trim()) {
                                                    setPlaywrightSettings(prev => prev ? {
                                                        ...prev,
                                                        extraArgs: [...prev.extraArgs, prev.newArg.trim()],
                                                        newArg: '',
                                                    } : null);
                                                }
                                            }}
                                            placeholder="输入参数，如 --proxy-server=http://..."
                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)]"
                                        />
                                        <button
                                            onClick={() => {
                                                if (playwrightSettings.newArg.trim()) {
                                                    setPlaywrightSettings(prev => prev ? {
                                                        ...prev,
                                                        extraArgs: [...prev.extraArgs, prev.newArg.trim()],
                                                        newArg: '',
                                                    } : null);
                                                }
                                            }}
                                            disabled={!playwrightSettings.newArg.trim()}
                                            className="shrink-0 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                            <button
                                onClick={() => setPlaywrightSettings(null)}
                                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleSavePlaywright}
                                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Edge TTS Settings Modal */}
            {edgeTtsSettings && (
                <OverlayBackdrop className="z-50">
                    <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                            <div className="min-w-0 flex-1">
                                <h2 className="text-lg font-semibold text-[var(--ink)]">Edge TTS 语音合成 设置</h2>
                                {getPresetMcpServer('edge-tts')?.description && (
                                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{getPresetMcpServer('edge-tts')?.description}</p>
                                )}
                            </div>
                            <button onClick={() => setEdgeTtsSettings(null)} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
                            {/* Free service notice */}
                            <div className="rounded-lg bg-[var(--success-bg)] border border-[var(--success)]/20 px-3 py-2">
                                <div className="flex items-center gap-2 text-xs text-[var(--success)]">
                                    <Check className="h-3.5 w-3.5" />
                                    免费服务，无需 API Key，开箱即用
                                </div>
                            </div>

                            {/* Default Voice */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-1">默认语音</label>
                                <input
                                    type="text"
                                    value={edgeTtsSettings.defaultVoice}
                                    onChange={e => setEdgeTtsSettings(prev => prev ? { ...prev, defaultVoice: e.target.value } : null)}
                                    placeholder="zh-CN-XiaoxiaoNeural"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] font-mono"
                                />
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {[
                                        { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 甜美女声' },
                                        { id: 'zh-CN-YunxiNeural', label: '云希 · 叙事男声' },
                                        { id: 'zh-CN-XiaomoNeural', label: '晓墨 · 温柔女声' },
                                        { id: 'zh-CN-YunjianNeural', label: '云健 · 新闻男声' },
                                        { id: 'en-US-JennyNeural', label: 'Jenny · English' },
                                        { id: 'en-US-GuyNeural', label: 'Guy · English' },
                                    ].map(v => (
                                        <button
                                            key={v.id}
                                            onClick={() => setEdgeTtsSettings(prev => prev ? { ...prev, defaultVoice: v.id } : null)}
                                            className={`rounded-md px-2 py-1 text-xs transition-colors ${
                                                edgeTtsSettings.defaultVoice === v.id
                                                    ? 'bg-[var(--accent)] text-white'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                            }`}
                                        >
                                            {v.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Output Format */}
                            <div>
                                <label className="block text-sm font-medium text-[var(--ink)] mb-2">输出格式</label>
                                <div className="flex gap-2">
                                    {[
                                        { id: 'audio-24khz-48kbitrate-mono-mp3', label: 'MP3（推荐）' },
                                        { id: 'webm-24khz-16bit-mono-opus', label: 'WebM' },
                                        { id: 'ogg-24khz-16bit-mono-opus', label: 'OGG' },
                                    ].map(f => (
                                        <button
                                            key={f.id}
                                            onClick={() => setEdgeTtsSettings(prev => prev ? { ...prev, defaultOutputFormat: f.id } : null)}
                                            className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                                                edgeTtsSettings.defaultOutputFormat === f.id
                                                    ? 'bg-[var(--accent)] text-white'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                            }`}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Voice Parameters Divider */}
                            <div className="border-t border-[var(--line)] pt-4">
                                <span className="text-sm font-medium text-[var(--ink-muted)]">语音参数</span>
                            </div>

                            {/* Rate Slider */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium text-[var(--ink-muted)]">语速</label>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-mono text-[var(--ink)]">{edgeTtsSettings.defaultRate >= 0 ? '+' : ''}{edgeTtsSettings.defaultRate}%</span>
                                        {edgeTtsSettings.defaultRate !== 0 && (
                                            <button
                                                onClick={() => setEdgeTtsSettings(prev => prev ? { ...prev, defaultRate: 0 } : null)}
                                                className="text-[10px] text-[var(--ink-muted)] hover:text-[var(--accent)]"
                                            >
                                                重置
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <input
                                    type="range"
                                    min={-100}
                                    max={200}
                                    step={10}
                                    value={edgeTtsSettings.defaultRate}
                                    onChange={e => setEdgeTtsSettings(prev => prev ? { ...prev, defaultRate: parseInt(e.target.value, 10) } : null)}
                                    className={ttsSliderClass}
                                />
                                <div className="flex justify-between text-[10px] text-[var(--ink-muted)] opacity-50">
                                    <span>-100%</span>
                                    <span>+200%</span>
                                </div>
                            </div>

                            {/* Volume Slider */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium text-[var(--ink-muted)]">音量</label>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-mono text-[var(--ink)]">{edgeTtsSettings.defaultVolume >= 0 ? '+' : ''}{edgeTtsSettings.defaultVolume}%</span>
                                        {edgeTtsSettings.defaultVolume !== 0 && (
                                            <button
                                                onClick={() => setEdgeTtsSettings(prev => prev ? { ...prev, defaultVolume: 0 } : null)}
                                                className="text-[10px] text-[var(--ink-muted)] hover:text-[var(--accent)]"
                                            >
                                                重置
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <input
                                    type="range"
                                    min={-100}
                                    max={100}
                                    step={10}
                                    value={edgeTtsSettings.defaultVolume}
                                    onChange={e => setEdgeTtsSettings(prev => prev ? { ...prev, defaultVolume: parseInt(e.target.value, 10) } : null)}
                                    className={ttsSliderClass}
                                />
                                <div className="flex justify-between text-[10px] text-[var(--ink-muted)] opacity-50">
                                    <span>-100%</span>
                                    <span>+100%</span>
                                </div>
                            </div>

                            {/* Pitch Slider */}
                            <div>
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-sm font-medium text-[var(--ink-muted)]">音调</label>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-mono text-[var(--ink)]">{edgeTtsSettings.defaultPitch >= 0 ? '+' : ''}{edgeTtsSettings.defaultPitch}Hz</span>
                                        {edgeTtsSettings.defaultPitch !== 0 && (
                                            <button
                                                onClick={() => setEdgeTtsSettings(prev => prev ? { ...prev, defaultPitch: 0 } : null)}
                                                className="text-[10px] text-[var(--ink-muted)] hover:text-[var(--accent)]"
                                            >
                                                重置
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <input
                                    type="range"
                                    min={-100}
                                    max={100}
                                    step={10}
                                    value={edgeTtsSettings.defaultPitch}
                                    onChange={e => setEdgeTtsSettings(prev => prev ? { ...prev, defaultPitch: parseInt(e.target.value, 10) } : null)}
                                    className={ttsSliderClass}
                                />
                                <div className="flex justify-between text-[10px] text-[var(--ink-muted)] opacity-50">
                                    <span>-100Hz</span>
                                    <span>+100Hz</span>
                                </div>
                            </div>

                            {/* Preview Section Divider */}
                            <div className="border-t border-[var(--line)] pt-4">
                                <span className="text-sm font-medium text-[var(--ink-muted)]">试听</span>
                            </div>

                            {/* Preview */}
                            <div>
                                <div className="flex gap-2">
                                    <textarea
                                        value={ttsPreviewText}
                                        onChange={e => setTtsPreviewText(e.target.value)}
                                        rows={2}
                                        placeholder="输入试听文本..."
                                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-muted)]/50 outline-none focus:border-[var(--accent)] resize-none"
                                    />
                                    <button
                                        onClick={handlePreviewTts}
                                        disabled={ttsPreviewLoading || !ttsPreviewText.trim()}
                                        className="shrink-0 h-10 w-10 rounded-full bg-[var(--accent)] text-white flex items-center justify-center hover:bg-[var(--accent)]/90 disabled:opacity-40 transition-colors self-center"
                                        title={ttsPreviewPlaying ? '停止' : '试听'}
                                    >
                                        {ttsPreviewLoading ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : ttsPreviewPlaying ? (
                                            <Square className="h-3.5 w-3.5" fill="currentColor" />
                                        ) : (
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 ml-0.5">
                                                <path d="M8 5v14l11-7z" />
                                            </svg>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex justify-end gap-3 border-t border-[var(--line)] px-6 py-4">
                            <button
                                onClick={() => setEdgeTtsSettings(null)}
                                className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleSaveEdgeTts}
                                className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--accent)]/90"
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Add MCP Modal */}
            {showMcpForm && (
                <OverlayBackdrop className="z-50">
                    <div className="mx-4 w-full max-w-lg rounded-2xl bg-[var(--paper-elevated)] shadow-xl max-h-[85vh] flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--line)]">
                            <h3 className="text-lg font-semibold text-[var(--ink)]">{editingMcpId ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</h3>
                            <div className="flex items-center gap-2">
                                {!editingMcpId && (
                                    <button
                                        onClick={() => {
                                            setMcpFormMode(m => m === 'form' ? 'json' : 'form');
                                            setMcpJsonError('');
                                        }}
                                        className="text-sm text-[var(--accent)] hover:underline"
                                    >
                                        {mcpFormMode === 'form' ? '切换为 JSON 配置' : '切换为添加面板'}
                                    </button>
                                )}
                                <button
                                    onClick={() => { setShowMcpForm(false); resetMcpForm(); }}
                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        </div>

                        {/* Content - Scrollable */}
                        <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
                          {mcpFormMode === 'json' ? (
                            <div className="space-y-3">
                              <textarea
                                value={mcpJsonInput}
                                onChange={e => { setMcpJsonInput(e.target.value); setMcpJsonError(''); }}
                                placeholder={'请粘贴完整的 JSON 配置，例如：\n{\n  "mcpServers": {\n    "ddg-search": {\n      "command": "uvx",\n      "args": ["duckduckgo-mcp-server"]\n    }\n  }\n}'}
                                className="w-full h-64 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 font-mono text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)]/50 focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)] resize-none"
                                spellCheck={false}
                              />
                              {mcpJsonError && (
                                <p className="text-sm text-[var(--error)]">{mcpJsonError}</p>
                              )}
                            </div>
                          ) : (
                          <>
                            {/* Transport Type Selector */}
                            <div className="mb-5">
                                <label className="mb-2 block text-sm font-medium text-[var(--ink-muted)]">传输协议</label>
                                <div className="grid grid-cols-3 gap-2">
                                    {[
                                        { type: 'stdio' as const, icon: '💻', name: 'STDIO', desc: '本地命令行' },
                                        { type: 'http' as const, icon: '🌐', name: 'Streamable HTTP', desc: '远程服务器' },
                                        { type: 'sse' as const, icon: '📡', name: 'SSE', desc: 'Server-Sent Events' },
                                    ].map((t) => (
                                        <button
                                            key={t.type}
                                            onClick={() => setMcpForm((p) => ({ ...p, type: t.type }))}
                                            className={`flex flex-col items-center rounded-xl border p-3 transition-all ${mcpForm.type === t.type
                                                ? 'border-[var(--ink)] bg-[var(--paper-inset)]'
                                                : 'border-[var(--line)] hover:border-[var(--ink-muted)]'
                                                }`}
                                        >
                                            <span className="text-xl mb-1">{t.icon}</span>
                                            <span className={`text-sm font-medium ${mcpForm.type === t.type ? 'text-[var(--ink)]' : 'text-[var(--ink-muted)]'}`}>
                                                {t.name}
                                            </span>
                                            <span className="text-xs text-[var(--ink-muted)]">{t.desc}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="space-y-4">
                                {/* ID - Common */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                        <span className="font-mono">ID</span> <span className="text-[var(--error)]">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={mcpForm.id}
                                        onChange={(e) => setMcpForm((p) => ({ ...p, id: e.target.value.toLowerCase().replace(/\s/g, '-') }))}
                                        placeholder="例如: my-mcp-server"
                                        disabled={!!editingMcpId}
                                        className={`w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none ${editingMcpId ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    />
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">唯一标识符，用于在配置中引用</p>
                                </div>

                                {/* Name - Common */}
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                        名称 <span className="font-mono text-[var(--ink-muted)]">name</span> <span className="text-[var(--error)]">*</span>
                                    </label>
                                    <input
                                        type="text"
                                        value={mcpForm.name}
                                        onChange={(e) => setMcpForm((p) => ({ ...p, name: e.target.value }))}
                                        placeholder="例如: 我的 MCP 服务器"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                    />
                                </div>

                                {/* STDIO Fields */}
                                {mcpForm.type === 'stdio' && (
                                    <>
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                命令 <span className="font-mono text-[var(--ink-muted)]">command</span> <span className="text-[var(--error)]">*</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={mcpForm.command}
                                                onChange={(e) => setMcpForm((p) => ({ ...p, command: e.target.value }))}
                                                placeholder="例如: npx, uvx, node, python"
                                                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                            <p className="mt-1 text-xs text-[var(--ink-muted)]">启动服务器的命令</p>
                                        </div>

                                        {/* Args - array input */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                            <label className="mb-3 block text-sm font-medium text-[var(--ink)]">
                                                参数 <span className="font-mono text-[var(--ink-muted)]">args</span>
                                            </label>

                                            {/* Existing args */}
                                            {mcpForm.args.length > 0 && (
                                                <div className="mb-3 flex flex-wrap gap-2">
                                                    {mcpForm.args.map((arg, index) => (
                                                        <div key={index} className="flex items-center gap-1 rounded-lg bg-[var(--paper-elevated)] px-2.5 py-1.5 text-xs font-mono text-[var(--ink)]">
                                                            <span>{arg}</span>
                                                            <button
                                                                onClick={() => {
                                                                    setMcpForm((p) => ({
                                                                        ...p,
                                                                        args: p.args.filter((_, i) => i !== index)
                                                                    }));
                                                                }}
                                                                className="ml-1 text-[var(--ink-muted)] hover:text-[var(--error)]"
                                                            >
                                                                <X className="h-3 w-3" />
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {/* Add new arg */}
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={mcpForm.newArg}
                                                    onChange={(e) => setMcpForm((p) => ({ ...p, newArg: e.target.value }))}
                                                    placeholder="例如: @playwright/mcp@latest"
                                                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            if (mcpForm.newArg.trim()) {
                                                                setMcpForm((p) => ({
                                                                    ...p,
                                                                    args: [...p.args, p.newArg.trim()],
                                                                    newArg: ''
                                                                }));
                                                            }
                                                        }
                                                    }}
                                                />
                                                <button
                                                    onClick={() => {
                                                        if (mcpForm.newArg.trim()) {
                                                            setMcpForm((p) => ({
                                                                ...p,
                                                                args: [...p.args, p.newArg.trim()],
                                                                newArg: ''
                                                            }));
                                                        }
                                                    }}
                                                    disabled={!mcpForm.newArg.trim()}
                                                    className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                                >
                                                    <Plus className="h-4 w-4" />
                                                    添加
                                                </button>
                                            </div>
                                            <p className="mt-2 text-xs text-[var(--ink-muted)]">一次填写一个参数，按 Enter 或点击添加</p>
                                        </div>

                                        {/* Environment Variables */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                            <label className="mb-3 flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                                                <span>🔐</span> 环境变量 <span className="font-mono text-[var(--ink-muted)]">env</span>（可选）
                                            </label>

                                            {/* Existing env vars */}
                                            {Object.entries(mcpForm.env).map(([key, value]) => (
                                                <div key={key} className="mb-2 flex items-center gap-2">
                                                    <span className="min-w-[100px] text-xs font-mono text-[var(--success)]">{key}</span>
                                                    <input
                                                        type="text"
                                                        value={value}
                                                        onChange={(e) => setMcpForm((p) => ({
                                                            ...p,
                                                            env: { ...p.env, [key]: e.target.value }
                                                        }))}
                                                        placeholder="值"
                                                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                    />
                                                    <button
                                                        onClick={() => {
                                                            const newEnv = { ...mcpForm.env };
                                                            delete newEnv[key];
                                                            setMcpForm((p) => ({ ...p, env: newEnv }));
                                                        }}
                                                        className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            ))}

                                            {/* Add new env var (key + value) */}
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="text"
                                                    value={mcpForm.newEnvKey}
                                                    onChange={(e) => setMcpForm((p) => ({ ...p, newEnvKey: e.target.value.toUpperCase().replace(/\s/g, '_') }))}
                                                    placeholder="变量名"
                                                    className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                />
                                                <input
                                                    type="text"
                                                    value={mcpForm.newEnvValue}
                                                    onChange={(e) => setMcpForm((p) => ({ ...p, newEnvValue: e.target.value }))}
                                                    placeholder="值"
                                                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') {
                                                            e.preventDefault();
                                                            const key = mcpForm.newEnvKey.trim();
                                                            if (key && !(key in mcpForm.env)) {
                                                                setMcpForm((p) => ({
                                                                    ...p,
                                                                    env: { ...p.env, [key]: p.newEnvValue },
                                                                    newEnvKey: '',
                                                                    newEnvValue: '',
                                                                }));
                                                            }
                                                        }
                                                    }}
                                                />
                                                <button
                                                    onClick={() => {
                                                        const key = mcpForm.newEnvKey.trim();
                                                        if (key && !(key in mcpForm.env)) {
                                                            setMcpForm((p) => ({
                                                                ...p,
                                                                env: { ...p.env, [key]: p.newEnvValue },
                                                                newEnvKey: '',
                                                                newEnvValue: '',
                                                            }));
                                                        }
                                                    }}
                                                    disabled={!mcpForm.newEnvKey.trim() || mcpForm.newEnvKey.trim() in mcpForm.env}
                                                    className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                                >
                                                    <Plus className="h-4 w-4" />
                                                    添加
                                                </button>
                                            </div>
                                        </div>
                                    </>
                                )}

                                {/* HTTP/SSE Fields */}
                                {(mcpForm.type === 'http' || mcpForm.type === 'sse') && (
                                    <>
                                        <div>
                                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                服务器 <span className="font-mono text-[var(--ink-muted)]">url</span> <span className="text-[var(--error)]">*</span>
                                            </label>
                                            <input
                                                type="url"
                                                value={mcpForm.url}
                                                onChange={(e) => setMcpForm((p) => ({ ...p, url: e.target.value }))}
                                                placeholder={mcpForm.type === 'sse' ? "例如: https://example.com/sse" : "例如: https://example.com/mcp"}
                                                className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                            <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                                {mcpForm.type === 'sse' ? 'SSE 事件流端点地址' : 'MCP 服务器的 HTTP 端点地址'}
                                            </p>
                                        </div>

                                        {/* HTTP Headers — collapsible */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                            <button
                                                type="button"
                                                onClick={() => setMcpHeadersExpanded(v => !v)}
                                                className="flex w-full items-center justify-between p-4 text-sm font-medium text-[var(--ink)]"
                                            >
                                                <span className="flex items-center gap-2">
                                                    <KeyRound className="h-4 w-4" /> 请求头 <span className="font-mono text-[var(--ink-muted)]">headers</span>
                                                    {Object.keys(mcpForm.headers).length > 0 && (
                                                        <span className="rounded-full bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs text-[var(--accent)]">{Object.keys(mcpForm.headers).length}</span>
                                                    )}
                                                </span>
                                                <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${mcpHeadersExpanded ? '' : '-rotate-90'}`} />
                                            </button>
                                            {mcpHeadersExpanded && (
                                                <div className="border-t border-[var(--line)] px-4 pb-4 pt-3">
                                                    {/* Existing headers — key:value inline */}
                                                    {Object.entries(mcpForm.headers).map(([key, value]) => (
                                                        <div key={key} className="mb-2 flex items-center gap-2">
                                                            <input
                                                                type="text"
                                                                value={key}
                                                                readOnly
                                                                className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm font-mono text-[var(--success)] focus:outline-none"
                                                            />
                                                            <input
                                                                type="text"
                                                                value={value}
                                                                onChange={(e) => setMcpForm((p) => ({
                                                                    ...p,
                                                                    headers: { ...p.headers, [key]: e.target.value }
                                                                }))}
                                                                placeholder="值"
                                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                            />
                                                            <button
                                                                onClick={() => {
                                                                    const newHeaders = { ...mcpForm.headers };
                                                                    delete newHeaders[key];
                                                                    setMcpForm((p) => ({ ...p, headers: newHeaders }));
                                                                }}
                                                                className="rounded-lg p-2 text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                                            >
                                                                <Trash2 className="h-4 w-4" />
                                                            </button>
                                                        </div>
                                                    ))}

                                                    {/* Add new header — key + value inline */}
                                                    <div className="flex items-center gap-2">
                                                        <input
                                                            type="text"
                                                            value={mcpForm.newHeaderKey}
                                                            onChange={(e) => setMcpForm((p) => ({ ...p, newHeaderKey: e.target.value }))}
                                                            placeholder="名称"
                                                            className="w-[140px] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                        />
                                                        <input
                                                            type="text"
                                                            value={mcpForm.newHeaderValue}
                                                            onChange={(e) => setMcpForm((p) => ({ ...p, newHeaderValue: e.target.value }))}
                                                            placeholder="值"
                                                            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    if (mcpForm.newHeaderKey) {
                                                                        setMcpForm((p) => ({
                                                                            ...p,
                                                                            headers: { ...p.headers, [p.newHeaderKey]: p.newHeaderValue },
                                                                            newHeaderKey: '',
                                                                            newHeaderValue: '',
                                                                        }));
                                                                    }
                                                                }
                                                            }}
                                                        />
                                                        <button
                                                            onClick={() => {
                                                                if (mcpForm.newHeaderKey) {
                                                                    setMcpForm((p) => ({
                                                                        ...p,
                                                                        headers: { ...p.headers, [p.newHeaderKey]: p.newHeaderValue },
                                                                        newHeaderKey: '',
                                                                        newHeaderValue: '',
                                                                    }));
                                                                }
                                                            }}
                                                            disabled={!mcpForm.newHeaderKey}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:opacity-50"
                                                        >
                                                            <Plus className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                    <p className="mt-2 text-xs text-[var(--ink-muted)]">用于认证的 HTTP 请求头，如 Authorization: Bearer token</p>
                                                </div>
                                            )}
                                        </div>

                                        {/* OAuth 2.0 Section — auto-discover + one-click authorize */}
                                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                            <div className="p-4">
                                                <div className="flex items-center justify-between">
                                                    <span className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]">
                                                        <Link className="h-4 w-4" /> OAuth 2.0 授权
                                                    </span>
                                                    <span className="flex items-center gap-2">
                                                        {mcpOAuthStatus[mcpForm.id] === 'connected' && (
                                                            <span className="flex items-center gap-1 rounded-full bg-[var(--success)]/10 px-2 py-0.5 text-xs text-[var(--success)]">
                                                                <Check className="h-3 w-3" /> 已授权
                                                            </span>
                                                        )}
                                                        {mcpOAuthStatus[mcpForm.id] === 'expired' && (
                                                            <span className="flex items-center gap-1 rounded-full bg-[var(--warning)]/10 px-2 py-0.5 text-xs text-[var(--warning)]">
                                                                <AlertCircle className="h-3 w-3" /> 已过期
                                                            </span>
                                                        )}
                                                    </span>
                                                </div>

                                                {/* Connected state */}
                                                {mcpOAuthStatus[mcpForm.id] === 'connected' && (
                                                    <div className="mt-3">
                                                        <button
                                                            onClick={() => handleMcpOAuthDisconnect(mcpForm.id)}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--error)] px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                                        >
                                                            <Unlink className="h-4 w-4" /> 撤销授权
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Expired state */}
                                                {mcpOAuthStatus[mcpForm.id] === 'expired' && (
                                                    <div className="mt-3">
                                                        <button
                                                            onClick={() => handleMcpOAuthConnect(mcpForm.id, mcpForm.url)}
                                                            disabled={mcpOAuthConnecting === mcpForm.id}
                                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--warning)] px-3 py-2 text-sm font-medium text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/10 disabled:opacity-50"
                                                        >
                                                            {mcpOAuthConnecting === mcpForm.id ? (
                                                                <><Loader2 className="h-4 w-4 animate-spin" /> 等待授权...</>
                                                            ) : (
                                                                <><Link className="h-4 w-4" /> 重新授权</>
                                                            )}
                                                        </button>
                                                    </div>
                                                )}

                                                {/* Not connected — show authorize flow */}
                                                {mcpOAuthStatus[mcpForm.id] !== 'connected' && mcpOAuthStatus[mcpForm.id] !== 'expired' && (
                                                    <div className="mt-3 space-y-3">
                                                        {/* Auto mode: one-click authorize (when probe detected dynamic registration) */}
                                                        {(!mcpOAuthProbe[mcpForm.id] || mcpOAuthProbe[mcpForm.id]?.supportsDynamicRegistration !== false) && (
                                                            <div className="flex items-center gap-3">
                                                                <button
                                                                    onClick={async () => {
                                                                        if (!mcpOAuthProbe[mcpForm.id]) {
                                                                            const probe = await handleMcpOAuthProbe(mcpForm.id, mcpForm.url);
                                                                            if (probe?.supportsDynamicRegistration === false) {
                                                                                // No dynamic registration — expand manual config instead of auto-connect
                                                                                setMcpOAuthExpanded(true);
                                                                                return;
                                                                            }
                                                                        }
                                                                        handleMcpOAuthConnect(mcpForm.id, mcpForm.url);
                                                                    }}
                                                                    disabled={mcpOAuthConnecting === mcpForm.id || !mcpForm.url}
                                                                    className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
                                                                >
                                                                    {mcpOAuthConnecting === mcpForm.id ? (
                                                                        <><Loader2 className="h-4 w-4 animate-spin" /> 等待授权...</>
                                                                    ) : (
                                                                        <><Link className="h-4 w-4" /> 授权登录</>
                                                                    )}
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setMcpOAuthExpanded(v => !v)}
                                                                    className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] transition-colors"
                                                                >
                                                                    {mcpOAuthExpanded ? '收起高级选项' : '手动配置 (高级)'}
                                                                </button>
                                                            </div>
                                                        )}

                                                        {/* Manual fallback note (when probe says no dynamic registration) */}
                                                        {mcpOAuthProbe[mcpForm.id]?.supportsDynamicRegistration === false && !mcpOAuthExpanded && (
                                                            <div>
                                                                <p className="mb-2 text-xs text-[var(--ink-muted)]">
                                                                    该服务不支持自动注册，请手动配置 OAuth 凭证。
                                                                </p>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => setMcpOAuthExpanded(true)}
                                                                    className="text-xs text-[var(--accent)] hover:underline"
                                                                >
                                                                    展开手动配置
                                                                </button>
                                                            </div>
                                                        )}

                                                        {/* Manual config form (advanced) */}
                                                        {mcpOAuthExpanded && (
                                                            <div className="border-t border-[var(--line)] pt-3 space-y-2">
                                                                <input
                                                                    type="text"
                                                                    value={mcpForm.oauthClientId}
                                                                    onChange={(e) => setMcpForm(p => ({ ...p, oauthClientId: e.target.value }))}
                                                                    placeholder="Client ID *"
                                                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                />
                                                                <input
                                                                    type="password"
                                                                    value={mcpForm.oauthClientSecret}
                                                                    onChange={(e) => setMcpForm(p => ({ ...p, oauthClientSecret: e.target.value }))}
                                                                    placeholder="Client Secret（可选）"
                                                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                />
                                                                <div className="grid grid-cols-2 gap-2">
                                                                    <input
                                                                        type="text"
                                                                        value={mcpForm.oauthScopes}
                                                                        onChange={(e) => setMcpForm(p => ({ ...p, oauthScopes: e.target.value }))}
                                                                        placeholder="Scopes（空格分隔）"
                                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                    />
                                                                    <input
                                                                        type="text"
                                                                        value={mcpForm.oauthCallbackPort}
                                                                        onChange={(e) => setMcpForm(p => ({ ...p, oauthCallbackPort: e.target.value.replace(/\D/g, '') }))}
                                                                        placeholder="回调端口（留空随机）"
                                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                    />
                                                                </div>
                                                                <div className="grid grid-cols-2 gap-2">
                                                                    <input
                                                                        type="url"
                                                                        value={mcpForm.oauthAuthUrl}
                                                                        onChange={(e) => setMcpForm(p => ({ ...p, oauthAuthUrl: e.target.value }))}
                                                                        placeholder="Authorization URL（留空自动发现）"
                                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                    />
                                                                    <input
                                                                        type="url"
                                                                        value={mcpForm.oauthTokenUrl}
                                                                        onChange={(e) => setMcpForm(p => ({ ...p, oauthTokenUrl: e.target.value }))}
                                                                        placeholder="Token URL（留空自动发现）"
                                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                                                    />
                                                                </div>
                                                                <button
                                                                    onClick={() => handleMcpOAuthConnect(mcpForm.id, mcpForm.url, true)}
                                                                    disabled={!mcpForm.oauthClientId || mcpOAuthConnecting === mcpForm.id}
                                                                    className="flex items-center gap-1.5 rounded-lg border border-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50"
                                                                >
                                                                    {mcpOAuthConnecting === mcpForm.id ? (
                                                                        <><Loader2 className="h-4 w-4 animate-spin" /> 等待授权...</>
                                                                    ) : (
                                                                        <><Link className="h-4 w-4" /> 手动连接</>
                                                                    )}
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>
                          </>
                          )}
                        </div>

                        {/* Footer */}
                        {mcpFormMode === 'json' ? (
                        <div className="flex gap-3 px-6 py-4 border-t border-[var(--line)]">
                            <button
                                onClick={() => { setShowMcpForm(false); resetMcpForm(); }}
                                className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={handleAddMcpFromJson}
                                disabled={!mcpJsonInput.trim()}
                                className="flex-1 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                            >
                                导入
                            </button>
                        </div>
                        ) : (
                        <div className={`flex items-center px-6 py-4 border-t border-[var(--line)] ${editingMcpId ? 'justify-between' : 'gap-3'}`}>
                            {editingMcpId && (
                                <button
                                    onClick={() => { setShowMcpForm(false); resetMcpForm(); handleDeleteMcp(editingMcpId); }}
                                    className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    删除
                                </button>
                            )}
                            <div className={editingMcpId ? 'flex gap-3' : 'flex gap-3 flex-1'}>
                                <button
                                    onClick={() => { setShowMcpForm(false); resetMcpForm(); }}
                                    className={`rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] ${editingMcpId ? '' : 'flex-1'}`}
                                >
                                    取消
                                </button>
                                <button
                                    onClick={handleAddMcp}
                                    disabled={
                                        !mcpForm.id || !mcpForm.name ||
                                        (mcpForm.type === 'stdio' && !mcpForm.command) ||
                                        ((mcpForm.type === 'http' || mcpForm.type === 'sse') && !mcpForm.url)
                                    }
                                    className={`rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50 ${editingMcpId ? '' : 'flex-1'}`}
                                >
                                    {editingMcpId ? '保存修改' : '添加服务器'}
                                </button>
                            </div>
                        </div>
                        )}
                    </div>
                </OverlayBackdrop>
            )}

            {/* Custom Provider Modal */}
            {showCustomForm && (
                <OverlayBackdrop className="z-50 overflow-y-auto py-8">
                    <div className="mx-4 w-full max-w-md flex max-h-[90vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                        <div className="flex-shrink-0 px-6 pt-6 pb-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-semibold text-[var(--ink)]">添加自定义供应商</h3>
                                <button
                                    onClick={() => {
                                        setShowCustomForm(false);
                                        setCustomForm(EMPTY_CUSTOM_FORM);
                                    }}
                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-4">
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    供应商名称 <span className="text-[var(--error)]">*</span>
                                </label>
                                <input
                                    type="text"
                                    value={customForm.name}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, name: e.target.value }))}
                                    placeholder="例如: My Custom Provider"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">服务商标签</label>
                                <input
                                    type="text"
                                    value={customForm.cloudProvider}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, cloudProvider: e.target.value }))}
                                    placeholder="例如: 云服务商"
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                />
                            </div>

                            <div>
                                <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">API 协议</label>
                                {customForm.apiProtocol === 'openai' && (
                                    <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                                        通过内置桥接自动转换为 Anthropic 协议，存在稳定性风险
                                    </p>
                                )}
                                <div className={`flex gap-4${customForm.apiProtocol !== 'openai' ? ' mt-1' : ''}`}>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="create-apiProtocol"
                                            value="anthropic"
                                            checked={customForm.apiProtocol !== 'openai'}
                                            onChange={() => setCustomForm((p) => ({ ...p, apiProtocol: 'anthropic', authType: 'auth_token' }))}
                                            className="accent-[var(--ink)]"
                                        />
                                        <span className="text-sm text-[var(--ink)]">Anthropic 协议</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="create-apiProtocol"
                                            value="openai"
                                            checked={customForm.apiProtocol === 'openai'}
                                            onChange={() => setCustomForm((p) => ({ ...p, apiProtocol: 'openai', authType: 'api_key' }))}
                                            className="accent-[var(--ink)]"
                                        />
                                        <span className="text-sm text-[var(--ink)]">OpenAI 协议</span>
                                    </label>
                                </div>
                            </div>

                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    API Base URL <span className="text-[var(--error)]">*</span>
                                </label>
                                <input
                                    type="url"
                                    value={customForm.baseUrl}
                                    onChange={(e) => setCustomForm((p) => ({ ...p, baseUrl: e.target.value }))}
                                    placeholder={customForm.apiProtocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.example.com/anthropic'}
                                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                />
                            </div>

                            {customForm.apiProtocol === 'openai' && (
                                <>
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">接口格式</label>
                                        <div className="flex gap-4">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="create-upstreamFormat"
                                                    value="chat_completions"
                                                    checked={customForm.upstreamFormat === 'chat_completions'}
                                                    onChange={() => setCustomForm((p) => ({ ...p, upstreamFormat: 'chat_completions', maxOutputTokensParamName: p.maxOutputTokensParamName === 'max_output_tokens' ? 'max_tokens' : p.maxOutputTokensParamName }))}
                                                    className="accent-[var(--ink)]"
                                                />
                                                <span className="text-sm text-[var(--ink)]">Chat Completions</span>
                                            </label>
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="create-upstreamFormat"
                                                    value="responses"
                                                    checked={customForm.upstreamFormat === 'responses'}
                                                    onChange={() => setCustomForm((p) => ({ ...p, upstreamFormat: 'responses', maxOutputTokensParamName: 'max_output_tokens' }))}
                                                    className="accent-[var(--ink)]"
                                                />
                                                <span className="text-sm text-[var(--ink)]">Responses API</span>
                                            </label>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">最大输出 Token</label>
                                        <div className="flex gap-2 items-center">
                                            <CustomSelect
                                                value={customForm.maxOutputTokensParamName}
                                                onChange={(v) => setCustomForm((p) => ({ ...p, maxOutputTokensParamName: v as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' }))}
                                                options={customForm.upstreamFormat === 'responses'
                                                    ? [{ value: 'max_output_tokens', label: 'max_output_tokens' }]
                                                    : [{ value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]
                                                }
                                                compact
                                                className="shrink-0"
                                            />
                                            <input
                                                type="number"
                                                value={customForm.maxOutputTokens}
                                                onChange={(e) => setCustomForm((p) => ({ ...p, maxOutputTokens: e.target.value }))}
                                                placeholder="留空则不限制"
                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Auth Type - only meaningful for Anthropic protocol (controls x-api-key vs Authorization header) */}
                            {customForm.apiProtocol !== 'openai' && (
                                <div>
                                    <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">认证方式</label>
                                    <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                                        请根据供应商认证参数进行选择
                                    </p>
                                    <div className="flex gap-4">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="create-authType"
                                                value="auth_token"
                                                checked={customForm.authType === 'auth_token'}
                                                onChange={() => setCustomForm((p) => ({ ...p, authType: 'auth_token' }))}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">AUTH_TOKEN</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="create-authType"
                                                value="api_key"
                                                checked={customForm.authType === 'api_key'}
                                                onChange={() => setCustomForm((p) => ({ ...p, authType: 'api_key' }))}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">API_KEY</span>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Models — inline input, no dependency on provider creation */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                    模型 <span className="text-[var(--error)]">*</span>
                                </label>
                                {customForm.models.length > 0 && (
                                    <div className="mb-2 flex flex-wrap gap-1.5">
                                        {customForm.models.map((m) => (
                                            <span
                                                key={m}
                                                className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]"
                                            >
                                                {m}
                                                <button
                                                    type="button"
                                                    onClick={() => setCustomForm((p) => ({ ...p, models: p.models.filter((id) => id !== m) }))}
                                                    className="rounded-sm p-0.5 text-[var(--ink-subtle)] transition-colors hover:text-[var(--ink)]"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                <div className="flex gap-2">
                                    <input
                                        ref={customModelInputRef}
                                        type="text"
                                        placeholder="输入模型 ID，回车添加"
                                        className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--focus-border)] focus:outline-none"
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                addCustomModelFromInput();
                                            }
                                        }}
                                    />
                                    <button
                                        type="button"
                                        onClick={addCustomModelFromInput}
                                        className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                                    >
                                        <Plus className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>

                            {/* API Key moved to provider list page for consistency with edit flow */}
                        </div>

                        <div className="flex-shrink-0 border-t border-[var(--line)] px-6 py-4">
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowCustomForm(false);
                                        setCustomForm(EMPTY_CUSTOM_FORM);
                                    }}
                                    className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={handleAddCustomProvider}
                                    disabled={!customForm.name || !customForm.baseUrl || customForm.models.length === 0}
                                    className="flex-1 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                                >
                                    添加
                                </button>
                            </div>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Provider Management Modal */}
            {editingProvider && (
                <OverlayBackdrop className="z-50 overflow-y-auto py-8">
                    <div className="mx-4 w-full max-w-md flex max-h-[90vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                        <div className="flex-shrink-0 px-6 pt-6 pb-4">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-semibold text-[var(--ink)]">
                                    {editingProvider.provider.isBuiltin ? '管理供应商' : '编辑供应商'}
                                </h3>
                                <button
                                    onClick={() => setEditingProvider(null)}
                                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-6">
                            {/* Provider info - editable for custom, read-only for preset */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">供应商名称</label>
                                {editingProvider.provider.isBuiltin ? (
                                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)]">
                                        {editingProvider.provider.name}
                                    </div>
                                ) : (
                                    <input
                                        type="text"
                                        value={editingProvider.editName || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editName: e.target.value } : null)}
                                        placeholder="输入供应商名称"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                    />
                                )}
                            </div>

                            {/* 云服务商标签 - only for custom providers */}
                            {!editingProvider.provider.isBuiltin && (
                                <div>
                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">云服务商标签</label>
                                    <input
                                        type="text"
                                        value={editingProvider.editCloudProvider || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editCloudProvider: e.target.value } : null)}
                                        placeholder="例如：自定义、代理"
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                    />
                                </div>
                            )}

                            {/* API Protocol - only for custom providers */}
                            {!editingProvider.provider.isBuiltin && (
                                <div>
                                    <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">API 协议</label>
                                    {editingProvider.editApiProtocol === 'openai' && (
                                        <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                                            通过内置桥接自动转换为 Anthropic 协议，存在稳定性风险
                                        </p>
                                    )}
                                    <div className={`flex gap-4${editingProvider.editApiProtocol !== 'openai' ? ' mt-1' : ''}`}>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="edit-apiProtocol"
                                                value="anthropic"
                                                checked={editingProvider.editApiProtocol !== 'openai'}
                                                onChange={() => setEditingProvider((p) => p ? { ...p, editApiProtocol: 'anthropic', editAuthType: 'auth_token' } : null)}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">Anthropic 协议</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="edit-apiProtocol"
                                                value="openai"
                                                checked={editingProvider.editApiProtocol === 'openai'}
                                                onChange={() => setEditingProvider((p) => p ? { ...p, editApiProtocol: 'openai', editAuthType: 'api_key' } : null)}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">OpenAI 协议</span>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Base URL */}
                            <div>
                                <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">API Base URL</label>
                                {editingProvider.provider.isBuiltin ? (
                                    editingProvider.provider.config.baseUrl && (
                                        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-sm text-[var(--ink-muted)] font-mono text-xs break-all">
                                            {editingProvider.provider.config.baseUrl}
                                        </div>
                                    )
                                ) : (
                                    <input
                                        type="text"
                                        value={editingProvider.editBaseUrl || ''}
                                        onChange={(e) => setEditingProvider((p) => p ? { ...p, editBaseUrl: e.target.value } : null)}
                                        placeholder={editingProvider.editApiProtocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.example.com'}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm font-mono transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                    />
                                )}
                            </div>

                            {/* OpenAI Bridge Settings - only for custom providers with OpenAI protocol */}
                            {!editingProvider.provider.isBuiltin && editingProvider.editApiProtocol === 'openai' && (
                                <>
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">接口格式</label>
                                        <div className="flex gap-4">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="edit-upstreamFormat"
                                                    value="chat_completions"
                                                    checked={(editingProvider.editUpstreamFormat || 'chat_completions') === 'chat_completions'}
                                                    onChange={() => setEditingProvider((p) => p ? { ...p, editUpstreamFormat: 'chat_completions', editMaxOutputTokensParamName: (p.editMaxOutputTokensParamName === 'max_output_tokens' ? 'max_tokens' : p.editMaxOutputTokensParamName) } : null)}
                                                    className="accent-[var(--ink)]"
                                                />
                                                <span className="text-sm text-[var(--ink)]">Chat Completions</span>
                                            </label>
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="radio"
                                                    name="edit-upstreamFormat"
                                                    value="responses"
                                                    checked={editingProvider.editUpstreamFormat === 'responses'}
                                                    onChange={() => setEditingProvider((p) => p ? { ...p, editUpstreamFormat: 'responses', editMaxOutputTokensParamName: 'max_output_tokens' } : null)}
                                                    className="accent-[var(--ink)]"
                                                />
                                                <span className="text-sm text-[var(--ink)]">Responses API</span>
                                            </label>
                                        </div>
                                    </div>
                                    <div>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">最大输出 Token</label>
                                        <div className="flex gap-2 items-center">
                                            <CustomSelect
                                                value={editingProvider.editMaxOutputTokensParamName ?? 'max_tokens'}
                                                onChange={(v) => setEditingProvider((p) => p ? { ...p, editMaxOutputTokensParamName: v as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' } : null)}
                                                options={(editingProvider.editUpstreamFormat || 'chat_completions') === 'responses'
                                                    ? [{ value: 'max_output_tokens', label: 'max_output_tokens' }]
                                                    : [{ value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]
                                                }
                                                compact
                                                className="shrink-0"
                                            />
                                            <input
                                                type="number"
                                                value={editingProvider.editMaxOutputTokens || ''}
                                                onChange={(e) => setEditingProvider((p) => p ? { ...p, editMaxOutputTokens: e.target.value } : null)}
                                                placeholder="留空则不限制"
                                                className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-2.5 text-sm transition-colors focus:border-[var(--focus-border)] focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Auth Type - only for custom providers with Anthropic protocol */}
                            {!editingProvider.provider.isBuiltin && editingProvider.editApiProtocol !== 'openai' && (
                                <div>
                                    <label className="mb-0.5 block text-sm font-medium text-[var(--ink)]">认证方式</label>
                                    <p className="mb-1.5 text-xs text-[var(--ink-muted)]">
                                        请根据供应商认证参数进行选择
                                    </p>
                                    <div className="flex gap-4">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="edit-authType"
                                                value="auth_token"
                                                checked={editingProvider.editAuthType === 'auth_token'}
                                                onChange={() => setEditingProvider((p) => p ? { ...p, editAuthType: 'auth_token' } : null)}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">AUTH_TOKEN</span>
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="edit-authType"
                                                value="api_key"
                                                checked={editingProvider.editAuthType === 'api_key'}
                                                onChange={() => setEditingProvider((p) => p ? { ...p, editAuthType: 'api_key' } : null)}
                                                className="accent-[var(--ink)]"
                                            />
                                            <span className="text-sm text-[var(--ink)]">API_KEY</span>
                                        </label>
                                    </div>
                                </div>
                            )}

                            {/* Models — preview + manage button */}
                            <div>
                                <div className="mb-1.5 flex items-center justify-between">
                                    <label className="text-sm font-medium text-[var(--ink)]">
                                        模型
                                    </label>
                                    <button
                                        type="button"
                                        onClick={() => setManagingProviderId(editingProvider.provider.id)}
                                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                                    >
                                        <Settings2 className="h-3.5 w-3.5" />
                                        管理可用模型
                                    </button>
                                </div>
                                <p className="truncate text-sm text-[var(--ink-muted)]">
                                    {editingProvider.provider.models.length > 0
                                        ? editingProvider.provider.models.map(m => m.modelName || m.model).join(', ')
                                        : '暂无模型'}
                                </p>
                            </div>

                            {/* Advanced Options - Model Alias Mapping (not shown for Anthropic providers) */}
                            {editingProvider.provider.id !== 'anthropic-sub' && editingProvider.provider.id !== 'anthropic-api' && (
                                <div className="border-t border-[var(--line)] pt-3">
                                    <button
                                        type="button"
                                        onClick={() => setEditingProvider((p) => p ? { ...p, showAdvanced: !p.showAdvanced } : null)}
                                        className="flex w-full items-center gap-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                                    >
                                        <ChevronDown className={`h-4 w-4 transition-transform ${editingProvider.showAdvanced ? '' : '-rotate-90'}`} />
                                        高级选项
                                    </button>
                                    {editingProvider.showAdvanced && (() => {
                                        const aliasModels = [
                                            { value: '', label: '未设置' },
                                            ...editingProvider.provider.models
                                                .filter(m => !editingProvider.removedModels.includes(m.model))
                                                .map(m => ({ value: m.model, label: m.modelName })),
                                            ...editingProvider.customModels.map(m => ({ value: m, label: m })),
                                        ];
                                        const ALIAS_LABELS: Record<string, string> = {
                                            opus: 'Opus（大杯）',
                                            sonnet: 'Sonnet（中杯）',
                                            haiku: 'Haiku（小杯）',
                                        };
                                        return (
                                            <div className="mt-3">
                                                <label className="mb-1 block text-sm font-medium text-[var(--ink)]">子 Agent 模型映射</label>
                                                <p className="mb-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                                                    Opus 大杯、Sonnet 中杯、Haiku 小杯 — 映射到此供应商的实际模型
                                                </p>
                                                <div className="space-y-2.5">
                                                    {(['opus', 'sonnet', 'haiku'] as const).map((alias) => (
                                                        <div key={alias} className="flex items-center gap-2.5">
                                                            <span className="w-[90px] shrink-0 text-xs text-[var(--ink-muted)]">{ALIAS_LABELS[alias]}</span>
                                                            <CustomSelect
                                                                value={editingProvider.editModelAliases?.[alias] || ''}
                                                                options={aliasModels}
                                                                onChange={(v) => setEditingProvider((p) => p ? {
                                                                    ...p,
                                                                    editModelAliases: { ...p.editModelAliases, [alias]: v },
                                                                } : null)}
                                                                placeholder="未设置"
                                                                compact
                                                                className="flex-1"
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>

                        <div className="flex-shrink-0 border-t border-[var(--line)] px-6 pt-6 pb-4">
                            <div className="flex items-center justify-between">
                                {!editingProvider.provider.isBuiltin ? (
                                    <button
                                        onClick={() => setDeleteConfirmProvider(editingProvider.provider)}
                                        className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:bg-[var(--error-bg)]"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                        删除
                                    </button>
                                ) : (
                                    <div />
                                )}

                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setEditingProvider(null)}
                                        className="rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={saveProviderEdits}
                                        className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                                    >
                                        保存
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Model Management Panel */}
            {managingProvider && (
                <ModelManagementPanel
                    provider={managingProvider}
                    apiKey={apiKeys[managingProvider.id]}
                    config={config}
                    onClose={() => {
                        setManagingProviderId(null);
                        // Refresh editingProvider with latest provider data after model changes
                        if (editingProvider && managingProvider) {
                            const fresh = providers.find(p => p.id === editingProvider.provider.id);
                            if (fresh) setEditingProvider(prev => prev ? { ...prev, provider: fresh } : null);
                        }
                    }}
                    onSaveCustomModels={savePresetCustomModels}
                    onUpdateCustomProvider={updateCustomProvider}
                    onSetPrimaryModel={savePrimaryModel}
                    onRefresh={async () => { await refreshConfig(); await refreshProviders(); }}
                />
            )}

            {/* Delete Confirmation Modal */}
            {deleteConfirmProvider && (
                <OverlayBackdrop className="z-[60]">
                    <div className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl">
                        <div className="mb-4 flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--error-bg)]">
                                <Trash2 className="h-5 w-5 text-[var(--error)]" />
                            </div>
                            <h3 className="text-lg font-semibold text-[var(--ink)]">删除供应商</h3>
                        </div>
                        <p className="mb-6 text-sm text-[var(--ink-muted)]">
                            确定要删除「{deleteConfirmProvider.name}」吗？此操作无法撤销。
                        </p>
                        <div className="flex gap-3">
                            <button
                                onClick={() => setDeleteConfirmProvider(null)}
                                className="flex-1 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                            >
                                取消
                            </button>
                            <button
                                onClick={confirmDeleteCustomProvider}
                                className="flex-1 rounded-lg bg-[var(--error)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--error-hover)]"
                            >
                                删除
                            </button>
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Runtime not found dialog */}
            {runtimeDialog.show && (
                <OverlayBackdrop onClose={() => setRuntimeDialog({ show: false })} className="z-50">
                    <div
                        className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-xl"
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--warning-bg)]">
                                <AlertCircle className="h-5 w-5 text-[var(--warning)]" />
                            </div>
                            <h3 className="flex-1 text-lg font-semibold text-[var(--ink)]">缺少运行环境</h3>
                            <button
                                onClick={() => setRuntimeDialog({ show: false })}
                                aria-label="关闭"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>
                        <p className="mt-4 text-sm text-[var(--ink-muted)]">
                            此 MCP 服务依赖 <span className="font-medium text-[var(--ink)]">{runtimeDialog.runtimeName}</span> 运行，请先安装后再启用。
                        </p>
                        <div className="mt-6 flex gap-3">
                            <div className="flex-1" onClick={() => setRuntimeDialog({ show: false })}>
                                <ExternalLink
                                    href={runtimeDialog.downloadUrl || '#'}
                                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
                                >
                                    去官网下载
                                    <ExternalLinkIcon className="h-3.5 w-3.5" />
                                </ExternalLink>
                            </div>
                            {showAiInstallButton && (
                                <button
                                    onClick={handleAiInstallRuntime}
                                    className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-warm-hover)]"
                                >
                                    让 PM 助手安装
                                </button>
                            )}
                        </div>
                    </div>
                </OverlayBackdrop>
            )}

            {/* Bug Report Overlay */}
            {showBugReport && (
                <BugReportOverlay
                    onClose={() => setShowBugReport(false)}
                    onNavigateToProviders={() => { setShowBugReport(false); setActiveSection('providers'); }}
                    appVersion={appVersion}
                    providers={providers}
                    apiKeys={apiKeys}
                    providerVerifyStatus={providerVerifyStatus}
                />
            )}

            {/* Agent detail overlay */}
            {overlayAgent && (
                <WorkspaceConfigPanel
                    agentDir={overlayAgent.workspacePath}
                    onClose={() => setOverlayAgent(null)}
                    initialTab="agent"
                />
            )}

            {/* Workspace select dialog for Agent upgrade */}
            {showWorkspaceSelect && (
                <WorkspaceSelectDialog
                    projects={projects}
                    onSelect={handleWorkspaceSelected}
                    onClose={() => setShowWorkspaceSelect(false)}
                />
            )}
        </div>
    );
}
