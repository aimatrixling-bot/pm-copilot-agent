// Channel detail view — adapted from ImBotDetail for Agent+Channel architecture.
// Keeps: credentials, binding, groups, platform-specific options, start/stop, enable/disable.
// Removes: workspace, MCP, heartbeat (all Agent-level).
// Adds: optional override section for provider/model/permission.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Power, PowerOff, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { track } from '@/analytics';
import ConfirmDialog from '@/components/ConfirmDialog';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { getProviderModels } from '@/config/types';
import { patchAgentConfig, invokeStartAgentChannel } from '@/config/services/agentConfigService';
import { resolveEffectiveConfig } from '../../../../shared/types/agent';
import BotTokenInput from '../../ImSettings/components/BotTokenInput';
import FeishuCredentialInput from '../../ImSettings/components/FeishuCredentialInput';
import DingtalkCredentialInput from '../../ImSettings/components/DingtalkCredentialInput';
import WhitelistManager from '../../ImSettings/components/WhitelistManager';
import PermissionModeSelect from '../../ImSettings/components/PermissionModeSelect';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import AiConfigCard from '../../ImSettings/components/AiConfigCard';
import DingtalkCardConfig from '../../ImSettings/components/DingtalkCardConfig';
import GroupPermissionList from '../../ImSettings/components/GroupPermissionList';
import type { AgentConfig, ChannelConfig, ChannelOverrides } from '../../../../shared/types/agent';
import type { GroupActivation } from '../../../../shared/types/im';
import type { ChannelStatusData } from '@/hooks/useAgentStatuses';
import { isOpenClawPlatform } from '../../../../shared/types/im';
import type { InstalledPlugin } from '../../../../shared/types/im';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';
import { FEISHU_PERMISSIONS_JSON } from './ChannelWizard';
import OpenClawToolGroupsSelector from './OpenClawToolGroupsSelector';

// ===== OpenClaw Plugin Config Editor =====
function OpenClawConfigEditor({
    pluginConfig,
    pluginId,
    npmSpec,
    onChange,
}: {
    pluginConfig: Record<string, unknown>;
    pluginId: string;
    npmSpec: string;
    onChange: (config: Record<string, unknown>) => void;
}) {
    const entries = Object.entries(pluginConfig);

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                <span>插件: {npmSpec || pluginId}</span>
            </div>
            {entries.length === 0 ? (
                <p className="text-sm text-[var(--ink-muted)]">此插件无需额外配置</p>
            ) : (
                <div className="space-y-3">
                    {entries.map(([key, value]) => (
                        <div key={key}>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                {key}
                            </label>
                            <input
                                type={key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') ? 'password' : 'text'}
                                value={String(value ?? '')}
                                onChange={(e) => {
                                    onChange({ ...pluginConfig, [key]: e.target.value });
                                }}
                                placeholder={`输入 ${key}`}
                                className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                            />
                        </div>
                    ))}
                </div>
            )}
            <p className="text-xs text-[var(--ink-muted)]">
                修改配置后需重启 Channel 才能生效
            </p>
        </div>
    );
}

/** Inline collapsible button to view/copy Feishu permissions JSON */
function FeishuPermissionsButton() {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
                <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`} />
                飞书权限 JSON
            </button>
            {expanded && (
                <div className="relative rounded-lg border border-[var(--line)] bg-[var(--paper-inset)] p-3">
                    <button
                        type="button"
                        onClick={async () => {
                            await navigator.clipboard.writeText(FEISHU_PERMISSIONS_JSON);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }}
                        className="absolute right-2 top-2 rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                    >
                        {copied ? '已复制' : '复制'}
                    </button>
                    <pre className="max-h-[240px] overflow-auto text-[11px] leading-relaxed text-[var(--ink-muted)]">
                        {FEISHU_PERMISSIONS_JSON}
                    </pre>
                </div>
            )}
        </div>
    );
}

interface ChannelDetailViewProps {
    agent: AgentConfig;
    channelId: string;
    onBack: () => void;
    onChanged: () => void;
}

export default function ChannelDetailView({
    agent,
    channelId,
    onBack,
    onChanged,
}: ChannelDetailViewProps) {
    const { config, providers, apiKeys, refreshConfig } = useConfig();
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    const nameSyncedRef = useRef(false);

    // Find channel from agent config
    const channel = useMemo(
        () => agent.channels?.find(c => c.id === channelId),
        [agent.channels, channelId],
    );

    // Bot runtime status (uses channelId as botId)
    const [botStatus, setBotStatus] = useState<ChannelStatusData | null>(null);
    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [toggling, setToggling] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [credentialsExpanded, setCredentialsExpanded] = useState<boolean | null>(null);
    const [bindingExpanded, setBindingExpanded] = useState<boolean | null>(null);
    const [groupsExpanded, setGroupsExpanded] = useState<boolean | null>(null);
    const [overridesExpanded, setOverridesExpanded] = useState(false);
    const [pluginMissing, setPluginMissing] = useState(false);
    const [installedPlugin, setInstalledPlugin] = useState<InstalledPlugin | null>(null);

    // Whether credentials are filled
    const hasCredentials = channel
        ? channel.type === 'feishu'
            ? !!(channel.feishuAppId && channel.feishuAppSecret)
            : channel.type === 'dingtalk'
                ? !!(channel.dingtalkClientId && channel.dingtalkClientSecret)
                : channel.type.startsWith('openclaw:')
                    ? !!channel.openclawPluginId
                    : !!channel.botToken
        : false;
    const hasUsers = (channel?.allowedUsers?.length ?? 0) > 0;

    // Auto-collapse: default collapsed when filled, expanded when empty
    const isCredentialsExpanded = credentialsExpanded ?? !hasCredentials;
    const isBindingExpanded = bindingExpanded ?? !hasUsers;

    useEffect(() => {
        const mountedRef = isMountedRef;
        const qrRunIdRef = wecomQrRunIdRef;
        return () => { mountedRef.current = false; qrRunIdRef.current++; };
    }, []);

    // Check if OpenClaw plugin is still installed
    useEffect(() => {
        if (!isTauriEnvironment() || !channel?.openclawPluginId || !channel.type.startsWith('openclaw:')) return;
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (!cancelled) {
                    const found = plugins.find(p => p.pluginId === channel.openclawPluginId);
                    setPluginMissing(!found);
                    if (found) setInstalledPlugin(found);
                }
            } catch {
                // Ignore
            }
        })();
        return () => { cancelled = true; };
    }, [channel?.openclawPluginId, channel?.type]);

    // Patch channel config in agent
    const patchChannel = useCallback(async (patch: Partial<ChannelConfig>) => {
        const updatedChannels = (agent.channels ?? []).map(ch =>
            ch.id === channelId ? { ...ch, ...patch } : ch,
        );
        await patchAgentConfig(agent.id, { channels: updatedChannels });
        if (isMountedRef.current) onChanged();
    }, [agent, channelId, onChanged]);

    // Patch channel overrides
    const patchOverrides = useCallback(async (overridePatch: Partial<ChannelOverrides>) => {
        const current = channel?.overrides ?? {};
        const updated = { ...current, ...overridePatch };
        // Remove keys that are undefined/empty to "unset" override
        for (const key of Object.keys(updated) as (keyof ChannelOverrides)[]) {
            if (updated[key] === undefined || updated[key] === '') {
                delete updated[key];
            }
        }
        const hasAnyOverride = Object.keys(updated).length > 0;
        await patchChannel({ overrides: hasAnyOverride ? updated : undefined });
    }, [channel?.overrides, patchChannel]);

    // Ref for channel (used in effects without re-triggering)
    const channelRef = useRef(channel);
    channelRef.current = channel;

    // Poll bot status (skip while toggling to avoid overwriting optimistic update)
    const togglingRef = useRef(toggling);
    togglingRef.current = toggling;

    useEffect(() => {
        if (!isTauriEnvironment()) return;

        const fetchStatus = async () => {
            if (togglingRef.current) return;
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId });
                if (isMountedRef.current && !togglingRef.current) {
                    setBotStatus(status);
                    if (status?.botUsername) {
                        setBotUsername(status.botUsername);
                        setVerifyStatus('valid');
                        // Auto-sync channel name from platform username (once)
                        if (!nameSyncedRef.current && !togglingRef.current) {
                            nameSyncedRef.current = true;
                            const ch = channelRef.current;
                            const displayName = ch?.type === 'telegram'
                                ? `@${status.botUsername}`
                                : status.botUsername;
                            if (ch?.name !== displayName) {
                                const updatedChannels = (agent.channels ?? []).map(c =>
                                    c.id === channelId ? { ...c, name: displayName } : c,
                                );
                                patchAgentConfig(agent.id, { channels: updatedChannels })
                                    .then(() => { if (isMountedRef.current) onChanged(); })
                                    .catch(err => {
                                        console.error('[ChannelDetail] Failed to sync channel name:', err);
                                    });
                            }
                        }
                    }
                }
            } catch {
                if (isMountedRef.current && !togglingRef.current) setBotStatus(null);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, [channelId, agent.id]); // eslint-disable-line react-hooks/exhaustive-deps -- agent.channels excluded to prevent poll resets on every config change; channelRef tracks latest

    // Listen for user-bound events
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current || event.payload.botId !== channelId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;
                toastRef.current.success(`用户 ${displayName} 已通过二维码绑定`);
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [channelId]);

    // Listen for group permission changes
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; event: string; groupName?: string }>('im:group-permission-changed', (ev) => {
                if (!isMountedRef.current || ev.payload.botId !== channelId) return;
                if (ev.payload.event === 'added') {
                    toastRef.current.info(`群聊「${ev.payload.groupName ?? ''}」待审核`);
                }
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });
        return () => { cancelled = true; unlisten?.(); };
    }, [channelId]);

    // Start channel via shared utility (resolves MCP + overrides)
    const startChannelCmd = useCallback(async () => {
        if (!channel) return;
        await invokeStartAgentChannel(agent, channel);
    }, [agent, channel]);

    // Toggle channel start/stop
    const botStatusRef = useRef(botStatus);
    botStatusRef.current = botStatus;

    const toggleChannel = useCallback(async () => {
        if (!isTauriEnvironment() || !channelRef.current) return;

        setToggling(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const isRunning = botStatusRef.current?.status === 'online' || botStatusRef.current?.status === 'connecting';

            if (isRunning) {
                await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId });
                if (isMountedRef.current) {
                    track('agent_channel_toggle', { platform: channelRef.current.type, enabled: false });
                    toastRef.current.success('Channel 已停止');
                    setBotStatus(null);
                    await patchChannel({ enabled: false });
                }
            } else {
                const ch = channelRef.current;
                const creds = ch.type === 'feishu'
                    ? (ch.feishuAppId && ch.feishuAppSecret)
                    : ch.type === 'dingtalk'
                        ? (ch.dingtalkClientId && ch.dingtalkClientSecret)
                        : ch.type.startsWith('openclaw:')
                            ? !!ch.openclawPluginId
                            : ch.botToken;
                if (!creds) {
                    toastRef.current.error(ch.type === 'telegram' ? '请先配置 Bot Token' : '请先配置应用凭证');
                    setToggling(false);
                    return;
                }
                await startChannelCmd();
                if (isMountedRef.current) {
                    track('agent_channel_toggle', { platform: channelRef.current.type, enabled: true });
                    toastRef.current.success('Channel 已启动');
                    await patchChannel({ enabled: true });
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`操作失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) setToggling(false);
        }
    }, [agent.id, channelId, startChannelCmd, patchChannel]);

    // Delete channel
    const executeDelete = useCallback(async () => {
        setDeleting(true);
        try {
            if (isTauriEnvironment()) {
                const { invoke } = await import('@tauri-apps/api/core');
                try {
                    await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId });
                } catch {
                    // May not be running
                }
            }
            const updatedChannels = (agent.channels ?? []).filter(ch => ch.id !== channelId);
            await patchAgentConfig(agent.id, { channels: updatedChannels });
            track('agent_channel_remove', { platform: channelRef.current?.type ?? 'unknown' });
            toastRef.current.success('Channel 已删除');
            onChanged();
            onBack();
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`删除失败: ${err}`);
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }
    }, [agent, channelId, onChanged, onBack]);

    // === Override section: provider/model/permission ===
    // Resolve effective values (agent default or channel override)
    const effective = useMemo(
        () => channel ? resolveEffectiveConfig(agent, channel) : null,
        [agent, channel],
    );

    const providerOptions = useMemo(() => {
        const options = [{ value: '', label: '默认 (继承 Agent)' }];
        for (const p of providers) {
            if (p.type === 'subscription') continue;
            if (p.type === 'api' && apiKeys[p.id]) {
                options.push({ value: p.id, label: p.name });
            }
        }
        return options;
    }, [providers, apiKeys]);

    const overrideProviderId = channel?.overrides?.providerId ?? '';
    const effectiveProviderId = effective?.providerId || 'anthropic-sub';

    const selectedProvider = useMemo(
        () => providers.find(p => p.id === effectiveProviderId),
        [providers, effectiveProviderId],
    );

    const modelOptions = useMemo(() => {
        if (!selectedProvider) return [];
        const options = [{ value: '', label: '默认 (继承 Agent)' }];
        for (const m of getProviderModels(selectedProvider)) {
            options.push({ value: m.model, label: m.modelName });
        }
        return options;
    }, [selectedProvider]);

    const _effectiveModel = useMemo(() => {
        if (channel?.overrides?.model) return channel.overrides.model;
        if (agent.model) return agent.model;
        if (selectedProvider?.primaryModel) return selectedProvider.primaryModel;
        if (modelOptions.length > 0) return modelOptions[0].value;
        return '';
    }, [channel?.overrides?.model, agent.model, selectedProvider?.primaryModel, modelOptions]);

    const hasAnyOverride = !!(channel?.overrides && Object.keys(channel.overrides).length > 0);

    // Derived values that depend on channel (safe with optional chaining before early return)
    const isRunning = botStatus?.status === 'online' || botStatus?.status === 'connecting';
    const isOpenClaw = channel ? isOpenClawPlatform(channel.type) : false;
    const promoted = isOpenClaw && channel ? findPromotedByPlatform(channel.type) : undefined;
    const isQrLoginPlugin = promoted?.authType === 'qrLogin' || installedPlugin?.supportsQrLogin === true;
    const isDualConfigPlugin = promoted?.authType === 'dualConfig';

    // WeCom dualConfig: inline QR re-scan state
    const [dualDetailMode, setDualDetailMode] = useState<'view' | 'qr' | 'edit'>('view');
    const [wecomQrImageUrl, setWecomQrImageUrl] = useState<string | null>(null);
    const [wecomQrStatus, setWecomQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'error'>('idle');
    const wecomQrRunIdRef = useRef(0);

    const startWecomQrRescan = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        const runId = ++wecomQrRunIdRef.current;
        setWecomQrStatus('loading');
        setDualDetailMode('qr');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const result = await invoke<{ scode: string; auth_url: string }>('cmd_wecom_qr_generate');
            if (!isMountedRef.current || wecomQrRunIdRef.current !== runId) return;
            const dataUrl = await QRCode.toDataURL(result.auth_url, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
            if (!isMountedRef.current || wecomQrRunIdRef.current !== runId) return;
            setWecomQrImageUrl(dataUrl);
            setWecomQrStatus('waiting');

            const POLL_INTERVAL = 3000;
            const MAX_POLLS = 100;
            for (let i = 0; i < MAX_POLLS; i++) {
                if (!isMountedRef.current || wecomQrRunIdRef.current !== runId) return;
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
                if (!isMountedRef.current || wecomQrRunIdRef.current !== runId) return;
                const poll = await invoke<{ status: string; bot_id?: string; secret?: string }>('cmd_wecom_qr_poll', { scode: result.scode });
                // Terminal states — QR expired or user denied
                if (poll.status === 'expired' || poll.status === 'cancelled' || poll.status === 'denied') {
                    if (isMountedRef.current && wecomQrRunIdRef.current === runId) setWecomQrStatus('error');
                    return;
                }
                if (poll.status === 'success' && poll.bot_id && poll.secret) {
                    if (!isMountedRef.current || wecomQrRunIdRef.current !== runId) return;
                    // Re-read fresh config to avoid stale closure overwriting concurrent changes
                    const freshConfig = await import('@/config/services/appConfigService').then(m => m.loadAppConfig());
                    const freshAgent = freshConfig.agents?.find(a => a.id === agent.id);
                    const freshChannel = freshAgent?.channels?.find(c => c.id === channelId);
                    const freshPluginConfig = freshChannel?.openclawPluginConfig ?? {};
                    const updatedPluginConfig = { ...freshPluginConfig, botId: poll.bot_id, secret: poll.secret };
                    await patchChannel({ openclawPluginConfig: updatedPluginConfig });
                    // Restart the channel so it reconnects with new credentials
                    if (freshChannel) {
                        try {
                            await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId });
                            await invokeStartAgentChannel(agent, { ...freshChannel, openclawPluginConfig: updatedPluginConfig });
                        } catch { /* best-effort restart */ }
                    }
                    setWecomQrStatus('success');
                    toastRef.current.success('扫码成功，凭证已更新，正在重连...');
                    setDualDetailMode('view');
                    return;
                }
            }
            if (isMountedRef.current) setWecomQrStatus('error');
        } catch {
            if (isMountedRef.current) setWecomQrStatus('error');
        }
    }, [agent, channelId, patchChannel]);

    // QR Login state — must be declared before any early return (rules-of-hooks)
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [qrMessage, setQrMessage] = useState('');
    const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'connected' | 'error'>('idle');
    const qrAbortRef = useRef(false);
    const qrSessionKeyRef = useRef<string | undefined>(undefined);
    const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);

    // Convert qrDataUrl to renderable image (URL → QR-encode, data:image → pass through)
    useEffect(() => {
        if (!qrDataUrl) { setQrImageUrl(null); return; }
        if (qrDataUrl.startsWith('data:image/')) { setQrImageUrl(qrDataUrl); return; }
        let cancelled = false;
        QRCode.toDataURL(qrDataUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
            .then((url: string) => { if (!cancelled) setQrImageUrl(url); })
            .catch(() => { if (!cancelled) setQrImageUrl(null); });
        return () => { cancelled = true; };
    }, [qrDataUrl]);

    const startDetailQrLogin = useCallback(async () => {
        if (!channel || !isTauriEnvironment() || !isRunning) return;
        qrAbortRef.current = false;
        setQrStatus('loading');
        setQrMessage('正在获取二维码...');
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const startResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                'cmd_plugin_qr_login_start', { agentId: agent.id, channelId: channel.id }
            );
            if (!startResult.ok || !startResult.qrDataUrl) {
                throw new Error(startResult.message || '获取二维码失败');
            }
            if (!isMountedRef.current) return;
            qrSessionKeyRef.current = startResult.sessionKey;
            setQrDataUrl(startResult.qrDataUrl);
            setQrStatus('waiting');
            setQrMessage(`请使用${promoted?.name || channel.name || '对应 App'}扫描二维码`);
            // Poll for scan completion (pass sessionKey — WeChat requires it)
            const MAX_QR_RETRIES = 10;
            let qrRetryCount = 0;
            while (!qrAbortRef.current && isMountedRef.current) {
                try {
                    const waitResult = await invoke<{ ok: boolean; connected?: boolean; message?: string; accountId?: string }>(
                        'cmd_plugin_qr_login_wait', { agentId: agent.id, channelId: channel.id, sessionKey: qrSessionKeyRef.current }
                    );
                    if (!isMountedRef.current || qrAbortRef.current) return;
                    if (waitResult.connected) {
                        setQrStatus('connected');
                        setQrMessage('登录成功！');
                        await invoke('cmd_plugin_restart_gateway', { agentId: agent.id, channelId: channel.id, accountId: waitResult.accountId });
                        // Persist accountId so Bridge finds credentials on restart
                        if (waitResult.accountId) {
                            const { loadAppConfig } = await import('@/config/configService');
                            const lat = await loadAppConfig();
                            const latAgent = (lat.agents ?? []).find(a => a.id === agent.id);
                            const updChs = (latAgent?.channels ?? agent.channels ?? []).map(ch =>
                                ch.id === channel.id
                                    ? { ...ch, openclawPluginConfig: { ...(ch.openclawPluginConfig ?? {}), accountId: waitResult.accountId! } }
                                    : ch,
                            );
                            await patchAgentConfig(agent.id, { channels: updChs });
                            await refreshConfig();
                        }
                        toastRef.current.success('扫码登录成功');
                        return;
                    }
                    if (waitResult.message) setQrMessage(waitResult.message);
                    await new Promise(r => setTimeout(r, 1000));
                } catch (err) {
                    if (!isMountedRef.current || qrAbortRef.current) return;
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isTerminal = /ECONNREFUSED|not support|501/i.test(errMsg);
                    if (isTerminal || qrRetryCount >= MAX_QR_RETRIES) {
                        setQrStatus('error');
                        setQrMessage(qrRetryCount >= MAX_QR_RETRIES
                            ? `超过最大重试次数 (${MAX_QR_RETRIES})，请手动重试`
                            : `登录失败: ${errMsg}`);
                        return;
                    }
                    qrRetryCount++;
                    try {
                        const r = await invoke<{ ok: boolean; qrDataUrl?: string; sessionKey?: string }>('cmd_plugin_qr_login_start', { agentId: agent.id, channelId: channel.id });
                        if (r.ok && r.qrDataUrl) { qrSessionKeyRef.current = r.sessionKey; setQrDataUrl(r.qrDataUrl); setQrMessage(`二维码已刷新 (${qrRetryCount}/${MAX_QR_RETRIES})，请扫描`); }
                    } catch { setQrStatus('error'); setQrMessage('二维码获取失败，请手动重试'); return; }
                }
            }
        } catch (err) {
            if (isMountedRef.current) { setQrStatus('error'); setQrMessage(`失败: ${err}`); }
        }
    }, [isRunning, agent.id, agent.channels, channel, promoted?.name, refreshConfig]);

    // Early return AFTER all hooks (rules-of-hooks compliance)
    if (!channel) {
        return (
            <div className="text-center py-12">
                <p className="text-sm text-[var(--ink-muted)]">Channel 配置未找到</p>
                <button onClick={onBack} className="mt-4 text-sm text-[var(--button-primary-bg)] hover:underline">
                    返回列表
                </button>
            </div>
        );
    }

    // Platform icon for header
    const detailPlatformIcon = (() => {
        if (channel.type === 'telegram') return telegramIcon;
        if (channel.type === 'feishu') return feishuIcon;
        if (channel.type === 'dingtalk') return dingtalkIcon;
        const promoted = findPromotedByPlatform(channel.type);
        if (promoted) return promoted.icon;
        return undefined;
    })();

    const platformLabel = channel.type === 'telegram' ? 'Telegram'
        : channel.type === 'feishu' ? '飞书'
        : channel.type === 'dingtalk' ? '钉钉'
        : findPromotedByPlatform(channel.type)?.name || channel.type;

    // Status summary for header
    const statusText = botStatus?.status === 'online' ? '运行中'
        : botStatus?.status === 'connecting' ? '连接中'
        : botStatus?.status === 'error' ? '异常'
        : '已停止';
    const statusColor = botStatus?.status === 'online' ? 'var(--success)'
        : botStatus?.status === 'connecting' ? 'var(--warning)'
        : botStatus?.status === 'error' ? 'var(--error)'
        : 'var(--ink-subtle)';
    const uptimeText = botStatus && botStatus.uptimeSeconds > 0
        ? (botStatus.uptimeSeconds >= 3600
            ? `${Math.floor(botStatus.uptimeSeconds / 3600)}h`
            : botStatus.uptimeSeconds >= 60
                ? `${Math.floor(botStatus.uptimeSeconds / 60)}m`
                : '<1m')
        : undefined;
    const sessionCount = botStatus?.activeSessions?.length ?? 0;

    return (
        <div className="space-y-6">
            {/* Header: icon + name + status + start/stop */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    {detailPlatformIcon && (
                        <img src={detailPlatformIcon} alt={platformLabel} className="h-8 w-8 rounded-lg" />
                    )}
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-[var(--ink)]">
                                {channel.name || platformLabel}
                            </h2>
                            <div className="flex items-center gap-1.5">
                                <div className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor }} />
                                <span className="text-xs" style={{ color: statusColor }}>{statusText}</span>
                            </div>
                            {uptimeText && (
                                <span className="text-xs text-[var(--ink-subtle)]">{uptimeText}</span>
                            )}
                            {sessionCount > 0 && (
                                <span className="text-xs text-[var(--ink-subtle)]">{sessionCount} 个会话</span>
                            )}
                        </div>
                        <p className="text-xs text-[var(--ink-muted)]">{platformLabel} Channel</p>
                    </div>
                </div>
                <button
                    onClick={toggleChannel}
                    disabled={toggling || pluginMissing || (!hasCredentials && !isRunning)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                        isRunning
                            ? 'bg-[var(--error-bg)] text-[var(--error)] hover:brightness-95'
                            : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                    } disabled:opacity-50`}
                >
                    {toggling ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isRunning ? (
                        <PowerOff className="h-4 w-4" />
                    ) : (
                        <Power className="h-4 w-4" />
                    )}
                    {isRunning ? '停止' : '启动'}
                </button>
            </div>

            {/* Plugin missing warning */}
            {pluginMissing && (
                <div className="flex items-center gap-3 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-4 py-3">
                    <span className="text-base">⚠️</span>
                    <div>
                        <p className="text-sm font-medium text-[var(--warning)]">插件已卸载</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            此 Channel 依赖的社区插件已被卸载，无法启动。请重新安装插件或删除此 Channel。
                        </p>
                    </div>
                </div>
            )}

            {/* Platform credentials / Plugin config */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setCredentialsExpanded(!isCredentialsExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">
                            {isOpenClaw
                                ? (findPromotedByPlatform(channel.type)?.setupGuide?.credentialTitle || '插件配置')
                                : channel.type === 'feishu' ? '飞书应用凭证' : channel.type === 'dingtalk' ? '钉钉应用凭证' : 'Telegram Bot'}
                        </h3>
                        {!isCredentialsExpanded && hasCredentials && (
                            <span className="text-xs text-[var(--success)]">
                                {isOpenClaw ? '已配置' : botUsername ? `已验证: ${botUsername}` : '已配置'}
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isCredentialsExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isCredentialsExpanded && (
                    <div className="px-5 pb-5">
                        {isOpenClaw && isDualConfigPlugin ? (
                            /* WeCom dualConfig: summary view + rescan/edit actions */
                            <div className="space-y-4">
                                {dualDetailMode === 'view' && (
                                    <>
                                        <div className="space-y-2">
                                            {(promoted?.requiredFields ?? ['botId', 'secret']).map((key) => {
                                                const val = channel.openclawPluginConfig?.[key] ?? '';
                                                const masked = /secret|token|password|key/i.test(key)
                                                    ? (val ? '••••••••••••' : '未配置')
                                                    : (val || '未配置');
                                                return (
                                                    <div key={key} className="flex items-center justify-between">
                                                        <span className="text-sm text-[var(--ink-muted)]">{key}</span>
                                                        <span className={`text-sm font-mono ${val ? 'text-[var(--ink)]' : 'text-[var(--ink-subtle)]'}`}>{masked}</span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={startWecomQrRescan}
                                                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            >
                                                重新扫码
                                            </button>
                                            <button
                                                onClick={() => setDualDetailMode('edit')}
                                                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            >
                                                编辑凭证
                                            </button>
                                        </div>
                                    </>
                                )}
                                {dualDetailMode === 'qr' && (
                                    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                        {wecomQrStatus === 'loading' && <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />}
                                        {wecomQrStatus === 'waiting' && wecomQrImageUrl && (
                                            <img src={wecomQrImageUrl} alt="企业微信扫码" className="h-[180px] w-[180px] rounded-xl border border-[var(--line)]" />
                                        )}
                                        {wecomQrStatus === 'error' && <p className="text-sm text-[var(--error)]">获取二维码失败</p>}
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {wecomQrStatus === 'loading' ? '正在获取二维码...' : wecomQrStatus === 'waiting' ? '请使用企业微信 App 扫描' : ''}
                                        </p>
                                        <button
                                            onClick={() => { wecomQrRunIdRef.current++; setDualDetailMode('view'); }}
                                            className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline"
                                        >
                                            取消
                                        </button>
                                    </div>
                                )}
                                {dualDetailMode === 'edit' && (
                                    <div className="space-y-3">
                                        <OpenClawConfigEditor
                                            pluginConfig={channel.openclawPluginConfig ?? {}}
                                            pluginId={channel.openclawPluginId ?? ''}
                                            npmSpec={channel.openclawNpmSpec ?? ''}
                                            onChange={async (newConfig) => {
                                                await patchChannel({ openclawPluginConfig: newConfig as Record<string, string> });
                                            }}
                                        />
                                        <button
                                            onClick={() => setDualDetailMode('view')}
                                            className="text-xs text-[var(--ink-muted)] hover:text-[var(--ink)] hover:underline"
                                        >
                                            返回
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : isOpenClaw ? (
                            <OpenClawConfigEditor
                                pluginConfig={channel.openclawPluginConfig ?? {}}
                                pluginId={channel.openclawPluginId ?? ''}
                                npmSpec={channel.openclawNpmSpec ?? ''}
                                onChange={async (newConfig) => {
                                    await patchChannel({ openclawPluginConfig: newConfig as Record<string, string> });
                                }}
                            />
                        ) : channel.type === 'dingtalk' ? (
                            <DingtalkCredentialInput
                                clientId={channel.dingtalkClientId ?? ''}
                                clientSecret={channel.dingtalkClientSecret ?? ''}
                                onClientIdChange={(clientId) => {
                                    // Check for dups across all agents' channels
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.dingtalkClientId === clientId)) {
                                        toastRef.current.error('该钉钉应用凭证已被其他 Channel 使用');
                                        return;
                                    }
                                    patchChannel({ dingtalkClientId: clientId });
                                }}
                                onClientSecretChange={(clientSecret) => patchChannel({ dingtalkClientSecret: clientSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : channel.type === 'feishu' ? (
                            <FeishuCredentialInput
                                appId={channel.feishuAppId ?? ''}
                                appSecret={channel.feishuAppSecret ?? ''}
                                onAppIdChange={(appId) => {
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.feishuAppId === appId)) {
                                        toastRef.current.error('该飞书应用凭证已被其他 Channel 使用');
                                        return;
                                    }
                                    patchChannel({ feishuAppId: appId });
                                }}
                                onAppSecretChange={(appSecret) => patchChannel({ feishuAppSecret: appSecret })}
                                verifyStatus={verifyStatus}
                                botName={botUsername}
                            />
                        ) : (
                            <BotTokenInput
                                value={channel.botToken ?? ''}
                                onChange={(token) => {
                                    const allChannels = (config.agents ?? [])
                                        .flatMap(a => a.channels)
                                        .filter(ch => ch.id !== channelId && ch.setupCompleted);
                                    if (allChannels.some(ch => ch.botToken === token)) {
                                        toastRef.current.error('该 Bot Token 已被其他 Channel 使用');
                                        return;
                                    }
                                    patchChannel({ botToken: token });
                                }}
                                verifyStatus={verifyStatus}
                                botUsername={botUsername}
                            />
                        )}
                    </div>
                )}
            </div>

            {/* Feishu permissions JSON — quick access for existing configurations */}
            {(channel.type === 'feishu' || channel.openclawPluginId === 'openclaw-lark') && (
                <FeishuPermissionsButton />
            )}

            {/* OpenClaw Tool Groups (e.g. feishu) */}
            {isOpenClaw && channel.openclawPluginId && (
                <OpenClawToolGroupsSelector
                    enabledGroups={channel.openclawEnabledToolGroups}
                    onChange={async (newGroups) => {
                        await patchChannel({ openclawEnabledToolGroups: newGroups });
                    }}
                    pluginId={channel.openclawPluginId}
                />
            )}

            {/* User binding — all platforms including OpenClaw (Rust handles BIND codes) */}
            {(
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setBindingExpanded(!isBindingExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">用户绑定</h3>
                        {!isBindingExpanded && hasUsers && (
                            <span className="text-xs text-[var(--ink-muted)]">
                                {channel.allowedUsers!.length} 个用户
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isBindingExpanded ? '' : '-rotate-90'}`} />
                </button>
                {isBindingExpanded && (
                    <div className="space-y-5 px-5 pb-5">
                        {/* QR Login section for plugins that use QR authentication (e.g. WeChat) */}
                        {isRunning && isQrLoginPlugin && (
                            <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)] p-4">
                                <div className="flex flex-col items-center gap-3">
                                    {qrStatus === 'idle' && (() => {
                                        const savedAccountId = (channel.openclawPluginConfig as Record<string, unknown> | undefined)?.accountId as string | undefined;
                                        if (savedAccountId) {
                                            return (
                                                <>
                                                    <div className="flex items-center gap-2">
                                                        <span className="h-2 w-2 rounded-full bg-[var(--accent-success)]" />
                                                        <span className="text-sm font-medium text-[var(--ink)]">已登录</span>
                                                    </div>
                                                    <p className="text-xs text-[var(--ink-muted)] font-mono">{savedAccountId}</p>
                                                    <button
                                                        onClick={startDetailQrLogin}
                                                        className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                                                    >
                                                        重新扫码
                                                    </button>
                                                </>
                                            );
                                        }
                                        return (
                                            <button
                                                onClick={startDetailQrLogin}
                                                className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                            >
                                                扫码登录
                                            </button>
                                        );
                                    })()}
                                    {qrStatus === 'loading' && (
                                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    )}
                                    {(qrStatus === 'waiting') && qrImageUrl && (
                                        <img src={qrImageUrl} alt="扫码登录" className="h-40 w-40 rounded-lg" />
                                    )}
                                    {qrStatus === 'connected' && (
                                        <p className="text-sm font-medium text-[var(--accent-success)]">登录成功</p>
                                    )}
                                    {qrStatus === 'error' && (
                                        <button
                                            onClick={() => { setQrStatus('idle'); }}
                                            className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                        >
                                            重试
                                        </button>
                                    )}
                                    {qrMessage && <p className="text-xs text-[var(--ink-muted)]">{qrMessage}</p>}
                                </div>
                            </div>
                        )}
                        {isRunning && (channel.type === 'feishu' || channel.type === 'dingtalk' || (isOpenClaw && !isQrLoginPlugin)) && botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={(channel.allowedUsers?.length ?? 0) > 0}
                                platformName={channel.type === 'dingtalk' ? '钉钉' : channel.type === 'feishu' ? '飞书' : (channel.name || '插件 Bot')}
                            />
                        )}
                        {isRunning && channel.type === 'telegram' && botStatus?.bindUrl && (
                            <BindQrPanel
                                bindUrl={botStatus.bindUrl}
                                hasWhitelistUsers={(channel.allowedUsers?.length ?? 0) > 0}
                            />
                        )}
                        {isQrLoginPlugin ? (
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-[var(--ink)]">用户绑定</label>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    扫码即可使用，无需手动绑定用户。
                                </p>
                            </div>
                        ) : (
                            <WhitelistManager
                                users={channel.allowedUsers ?? []}
                                onChange={async (users) => {
                                    await patchChannel({ allowedUsers: users });
                                }}
                                platform={channel.type}
                            />
                        )}
                    </div>
                )}
            </div>
            )}

            {/* Group Permissions */}
            {(() => {
                const groupPerms = channel.groupPermissions ?? [];
                const hasGroups = groupPerms.length > 0;
                const pendingCount = groupPerms.filter(g => g.status === 'pending').length;
                const approvedCount = groupPerms.filter(g => g.status === 'approved').length;
                const isGroupsExpanded_ = groupsExpanded ?? (pendingCount > 0 || hasGroups);
                return (
                    <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                        <button
                            type="button"
                            onClick={() => setGroupsExpanded(!isGroupsExpanded_)}
                            className="flex w-full items-center justify-between p-5"
                        >
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-[var(--ink)]">群聊管理</h3>
                                {!isGroupsExpanded_ && hasGroups && (
                                    <span className="text-xs text-[var(--ink-muted)]">
                                        {approvedCount > 0 && `${approvedCount} 个群聊`}
                                        {pendingCount > 0 && approvedCount > 0 && '，'}
                                        {pendingCount > 0 && `${pendingCount} 个待审核`}
                                    </span>
                                )}
                                {pendingCount > 0 && (
                                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--warning)] px-1.5 text-[10px] font-bold text-white">
                                        {pendingCount}
                                    </span>
                                )}
                            </div>
                            <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${isGroupsExpanded_ ? '' : '-rotate-90'}`} />
                        </button>
                        {isGroupsExpanded_ && (
                            <div className="space-y-4 px-5 pb-5">
                                {/* Group activation mode */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="text-sm font-medium text-[var(--ink)]">群聊触发方式</p>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {(channel.groupActivation ?? 'mention') === 'mention'
                                                ? '仅在 @Bot 或回复 Bot 时响应'
                                                : '收到所有群消息，AI 自行判断是否回复'}
                                        </p>
                                    </div>
                                    <div className="flex rounded-lg bg-[var(--paper-inset)] p-0.5">
                                        {(['mention', 'always'] as GroupActivation[]).map(mode => (
                                            <button
                                                key={mode}
                                                onClick={async () => {
                                                    await patchChannel({ groupActivation: mode });
                                                }}
                                                className={`rounded-md px-3 py-1 text-xs font-medium transition-all ${
                                                    (channel.groupActivation ?? 'mention') === mode
                                                        ? 'bg-[var(--accent)] text-white'
                                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                                }`}
                                            >
                                                {mode === 'mention' ? '@提及' : '全部消息'}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                {/* Group list */}
                                <GroupPermissionList
                                    permissions={groupPerms}
                                    onApprove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_approve_group', { botId: channelId, groupId });
                                    }}
                                    onReject={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_reject_group', { botId: channelId, groupId });
                                    }}
                                    onRemove={async (groupId) => {
                                        if (!isTauriEnvironment()) return;
                                        const { invoke } = await import('@tauri-apps/api/core');
                                        await invoke('cmd_remove_group', { botId: channelId, groupId });
                                    }}
                                />
                            </div>
                        )}
                    </div>
                );
            })()}

            {/* DingTalk AI Card Config */}
            {channel.type === 'dingtalk' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <DingtalkCardConfig
                        useAiCard={channel.dingtalkUseAiCard ?? false}
                        cardTemplateId={channel.dingtalkCardTemplateId ?? ''}
                        onUseAiCardChange={async (value) => {
                            await patchChannel({ dingtalkUseAiCard: value });
                        }}
                        onCardTemplateIdChange={async (value) => {
                            await patchChannel({ dingtalkCardTemplateId: value || undefined });
                        }}
                    />
                </div>
            )}

            {/* Telegram Draft Streaming */}
            {channel.type === 'telegram' && (
                <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-[var(--ink)]">Draft 流式模式</p>
                            <p className="text-xs text-[var(--ink-muted)] mt-0.5">
                                使用 sendMessageDraft 实现打字机效果，默认开启。如果消息加载异常可以关闭此选项，修改后需重启 Channel 生效。
                            </p>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={channel.telegramUseDraft ?? true}
                            onClick={async () => {
                                await patchChannel({ telegramUseDraft: !(channel.telegramUseDraft ?? true) });
                            }}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                (channel.telegramUseDraft ?? true) ? 'bg-[var(--accent)]' : 'bg-[var(--ink-muted)]/30'
                            }`}
                        >
                            <span
                                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[var(--toggle-thumb)] shadow ring-0 transition duration-200 ease-in-out ${
                                    (channel.telegramUseDraft ?? true) ? 'translate-x-4' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </div>
            )}

            {/* Channel Overrides (optional: provider/model/permission) */}
            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]">
                <button
                    type="button"
                    onClick={() => setOverridesExpanded(!overridesExpanded)}
                    className="flex w-full items-center justify-between p-5"
                >
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[var(--ink)]">配置覆盖</h3>
                        {!overridesExpanded && hasAnyOverride && (
                            <span className="text-xs text-[var(--ink-muted)]">
                                已自定义
                            </span>
                        )}
                    </div>
                    <ChevronDown className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${overridesExpanded ? '' : '-rotate-90'}`} />
                </button>
                {overridesExpanded && (
                    <div className="space-y-5 px-5 pb-5">
                        <p className="text-xs text-[var(--ink-muted)]">
                            以下选项为空时将继承 Agent 的默认配置。设置后仅对此 Channel 生效。
                        </p>

                        {/* AI Configuration override */}
                        <AiConfigCard
                            providerId={overrideProviderId}
                            model={channel?.overrides?.model ?? ''}
                            providerOptions={providerOptions}
                            modelOptions={modelOptions}
                            onProviderChange={async (providerId) => {
                                if (!providerId) {
                                    // Clear override → inherit from agent
                                    await patchOverrides({ providerId: undefined, providerEnvJson: undefined, model: undefined });
                                    return;
                                }
                                const provider = providers.find(p => p.id === providerId);
                                const newModel = provider ? provider.primaryModel : undefined;
                                let providerEnvJson: string | undefined;
                                if (provider && provider.type !== 'subscription') {
                                    providerEnvJson = JSON.stringify({
                                        baseUrl: provider.config.baseUrl,
                                        apiKey: apiKeys[provider.id],
                                        authType: provider.authType,
                                        apiProtocol: provider.apiProtocol,
                                    });
                                }
                                await patchOverrides({ providerId, providerEnvJson, model: newModel });
                            }}
                            onModelChange={async (model) => {
                                await patchOverrides({ model: model || undefined });
                            }}
                        />

                        {/* Permission mode override */}
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
                            <div className="flex items-center justify-between mb-3">
                                <h4 className="text-sm font-medium text-[var(--ink)]">权限模式</h4>
                                {channel?.overrides?.permissionMode && (
                                    <button
                                        className="text-[10px] text-[var(--ink-subtle)] hover:text-[var(--ink-muted)] transition-colors"
                                        onClick={() => patchOverrides({ permissionMode: undefined })}
                                    >
                                        恢复默认
                                    </button>
                                )}
                            </div>
                            <PermissionModeSelect
                                value={channel?.overrides?.permissionMode ?? agent.permissionMode}
                                onChange={async (mode) => {
                                    // If same as agent default, clear override
                                    if (mode === agent.permissionMode) {
                                        await patchOverrides({ permissionMode: undefined });
                                    } else {
                                        await patchOverrides({ permissionMode: mode });
                                    }
                                }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Danger zone */}
            <div className="rounded-xl border border-[var(--error)]/20 bg-[var(--error-bg)]/50 p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--error)]">危险操作</h3>
                <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center gap-2 rounded-lg bg-[var(--error-bg)] px-4 py-2 text-sm font-medium text-[var(--error)] transition-colors hover:brightness-95"
                >
                    <Trash2 className="h-4 w-4" />
                    删除 Channel
                </button>
            </div>

            {/* Delete confirmation dialog */}
            {showDeleteConfirm && (
                <ConfirmDialog
                    title="删除 Channel"
                    message="确定要删除此 Channel 吗？此操作不可撤销。"
                    confirmText="删除"
                    cancelText="取消"
                    confirmVariant="danger"
                    loading={deleting}
                    onConfirm={executeDelete}
                    onCancel={() => setShowDeleteConfirm(false)}
                />
            )}
        </div>
    );
}
