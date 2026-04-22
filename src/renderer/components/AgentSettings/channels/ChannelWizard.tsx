// Channel creation wizard — adapted from ImBotWizard for Agent+Channel architecture.
// Removes workspace step (Agent already has one), uses cmd_start_agent_channel.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, Loader2, Plus, Puzzle, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { patchAgentConfig, invokeStartAgentChannel } from '@/config/services/agentConfigService';
import BotTokenInput from '../../ImSettings/components/BotTokenInput';
import FeishuCredentialInput from '../../ImSettings/components/FeishuCredentialInput';
import DingtalkCredentialInput from '../../ImSettings/components/DingtalkCredentialInput';
import BindQrPanel from '../../ImSettings/components/BindQrPanel';
import BindCodePanel from '../../ImSettings/components/BindCodePanel';
import WhitelistManager from '../../ImSettings/components/WhitelistManager';
import type { AgentConfig, ChannelConfig, ChannelType } from '../../../../shared/types/agent';
import type { InstalledPlugin } from '../../../../shared/types/im';
import type { ChannelStatusData } from '@/hooks/useAgentStatuses';
import telegramBotAddImg from '../../ImSettings/assets/telegram_bot_add.png';
import feishuStep1Img from '../../ImSettings/assets/feishu_step1.png';
import feishuStep2PermImg from '../../ImSettings/assets/feishu_step2_permissions.png';
import feishuStep2EventImg from '../../ImSettings/assets/feishu_step2_events.png';
import feishuStep2AddBotImg from '../../ImSettings/assets/feishu_step2_5_add_bot.png';
import feishuStep2PublishImg from '../../ImSettings/assets/feishu_setp2_6_publish.png';
import dingtalkStep1CreateAppImg from '../../ImSettings/assets/dingtalk_step1_create_app.png';
import dingtalkStep1CredentialsImg from '../../ImSettings/assets/dingtalk_step1_credentials.png';
import dingtalkStep2AddRobotImg from '../../ImSettings/assets/dingtalk_step2_add_robot.png';
import dingtalkStep2StreamModeImg from '../../ImSettings/assets/dingtalk_step2_stream_mode.png';
import dingtalkStep2PublishImg from '../../ImSettings/assets/dingtalk_step2_publish.png';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';

export const FEISHU_PERMISSIONS_JSON = `{
  "scopes": {
    "tenant": [
      "contact:user.base:readonly",
      "docx:document:readonly",
      "im:chat:read",
      "im:chat:update",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.pins:read",
      "im:message.pins:write_only",
      "im:message.reactions:read",
      "im:message.reactions:write_only",
      "im:message:readonly",
      "im:message:recall",
      "im:message:send_as_bot",
      "im:message:send_multi_users",
      "im:message:send_sys_msg",
      "im:message:update",
      "im:resource",
      "application:application:self_manage",
      "cardkit:card:write",
      "cardkit:card:read"
    ],
    "user": [
      "contact:user.employee_id:readonly",
      "offline_access",
      "base:app:copy",
      "base:field:create",
      "base:field:delete",
      "base:field:read",
      "base:field:update",
      "base:record:create",
      "base:record:delete",
      "base:record:retrieve",
      "base:record:update",
      "base:table:create",
      "base:table:delete",
      "base:table:read",
      "base:table:update",
      "base:view:read",
      "base:view:write_only",
      "base:app:create",
      "base:app:update",
      "base:app:read",
      "sheets:spreadsheet.meta:read",
      "sheets:spreadsheet:read",
      "sheets:spreadsheet:create",
      "sheets:spreadsheet:write_only",
      "docs:document:export",
      "docs:document.media:upload",
      "board:whiteboard:node:create",
      "board:whiteboard:node:read",
      "calendar:calendar:read",
      "calendar:calendar.event:create",
      "calendar:calendar.event:delete",
      "calendar:calendar.event:read",
      "calendar:calendar.event:reply",
      "calendar:calendar.event:update",
      "calendar:calendar.free_busy:read",
      "contact:user.base:readonly",
      "contact:user:search",
      "docs:document.comment:create",
      "docs:document.comment:read",
      "docs:document.comment:update",
      "docs:document.media:download",
      "docs:document:copy",
      "docx:document:create",
      "docx:document:readonly",
      "docx:document:write_only",
      "drive:drive.metadata:readonly",
      "drive:file:download",
      "drive:file:upload",
      "im:chat.members:read",
      "im:chat:read",
      "im:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "search:docs:read",
      "search:message",
      "space:document:delete",
      "space:document:move",
      "space:document:retrieve",
      "task:comment:read",
      "task:comment:write",
      "task:task:read",
      "task:task:write",
      "task:task:writeonly",
      "task:tasklist:read",
      "task:tasklist:write",
      "wiki:node:copy",
      "wiki:node:create",
      "wiki:node:move",
      "wiki:node:read",
      "wiki:node:retrieve",
      "wiki:space:read",
      "wiki:space:retrieve",
      "wiki:space:write_only"
    ]
  }
}`;

interface ChannelWizardProps {
    agent: AgentConfig;
    platform: ChannelType;
    onComplete: (channelId: string) => void;
    onCancel: () => void;
}

// WeCom QR polling constants — shared between effect logic and render display
const WECOM_MAX_QR_REFRESHES = 5; // Auto-refresh up to 5 times on QR expiry, then error
const WECOM_POLL_INTERVAL = 3000;
const WECOM_MAX_POLLS_PER_QR = 200; // Defensive ~10min ceiling per QR in case server never returns terminal status

export default function ChannelWizard({
    agent,
    platform,
    onComplete,
    onCancel,
}: ChannelWizardProps) {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const { config, refreshConfig } = useConfig();
    const isMountedRef = useRef(true);

    const isFeishu = platform === 'feishu';
    const isDingtalk = platform === 'dingtalk';
    const isOpenClaw = platform.startsWith('openclaw:');
    const openclawPluginId = isOpenClaw ? platform.slice('openclaw:'.length) : undefined;
    const promoted = isOpenClaw ? findPromotedByPlatform(platform) : undefined;

    // OpenClaw: config(1) → start(2) → binding(3)
    // OpenClaw QR: qrLogin(1) → binding(2)
    // OpenClaw dualConfig: config-or-qr(1) → start(2) → binding(3)
    // Telegram: credentials(1) → binding(2)
    // Feishu:   credentials(1) → permissions(2) → binding(3)
    // DingTalk: credentials(1) → permissions(2) → binding(3)
    // isQrLogin is computed below after installedPlugin state is declared
    const isQrLoginFromPreset = promoted?.authType === 'qrLogin';
    const isDualConfig = promoted?.authType === 'dualConfig';
    const totalStepsBase = isQrLoginFromPreset ? 2 : isOpenClaw ? 3 : (isFeishu || isDingtalk) ? 3 : 2;

    const [step, setStep] = useState(1);
    // Telegram credentials
    const [botToken, setBotToken] = useState('');
    // Feishu credentials
    const [feishuAppId, setFeishuAppId] = useState('');
    const [feishuAppSecret, setFeishuAppSecret] = useState('');
    // DingTalk credentials
    const [dingtalkClientId, setDingtalkClientId] = useState('');
    const [dingtalkClientSecret, setDingtalkClientSecret] = useState('');

    // OpenClaw plugin state
    const [installedPlugin, setInstalledPlugin] = useState<InstalledPlugin | null>(null);
    const [openclawSchemaValues, setOpenclawSchemaValues] = useState<Record<string, string>>({});
    const [openclawCustomFields, setOpenclawCustomFields] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);

    const [verifyStatus, setVerifyStatus] = useState<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
    const [botUsername, setBotUsername] = useState<string | undefined>();
    const [starting, setStarting] = useState(false);
    const [channelId] = useState(() => crypto.randomUUID());
    const [allowedUsers, setAllowedUsers] = useState<string[]>([]);
    const [botStatus, setBotStatus] = useState<ChannelStatusData | null>(null);
    const [permJsonCopied, setPermJsonCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    // QR Login state
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [qrMessage, setQrMessage] = useState<string>('');
    const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'connected' | 'error'>('idle');
    const qrAbortRef = useRef(false);
    const qrSessionKeyRef = useRef<string | undefined>(undefined);
    // Rendered QR image: either the raw data URI (WhatsApp) or QR-encoded from URL (WeChat)
    const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);

    // Convert qrDataUrl to a renderable image:
    // - data:image/* → use directly (WhatsApp returns base64 PNG)
    // - http(s):// URL → encode the URL INTO a QR code image (WeChat returns a URL to be QR-encoded)
    useEffect(() => {
        if (!qrDataUrl) { setQrImageUrl(null); return; }
        if (qrDataUrl.startsWith('data:image/')) {
            setQrImageUrl(qrDataUrl);
            return;
        }
        // URL needs to be QR-encoded into an image
        let cancelled = false;
        QRCode.toDataURL(qrDataUrl, { width: 200, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
            .then((dataUrl: string) => { if (!cancelled) setQrImageUrl(dataUrl); })
            .catch(() => { if (!cancelled) setQrImageUrl(null); });
        return () => { cancelled = true; };
    }, [qrDataUrl]);

    // WeCom dualConfig state: QR scan OR manual config to obtain botId+secret
    const [dualConfigMode, setDualConfigMode] = useState<'qr' | 'config'>('qr');
    const [wecomQrStatus, setWecomQrStatus] = useState<'idle' | 'loading' | 'waiting' | 'success' | 'error'>('idle');
    const [wecomQrBotId, setWecomQrBotId] = useState('');
    const [wecomQrSecret, setWecomQrSecret] = useState('');
    const wecomQrAbortRef = useRef(false);
    const wecomQrStartedRef = useRef(false);
    const [wecomQrRetryTrigger, setWecomQrRetryTrigger] = useState(0);
    // Rendered QR image for WeCom (auth_url → QR code image)
    const [wecomQrImageUrl, setWecomQrImageUrl] = useState<string | null>(null);
    // QR refresh count for display (e.g., "二维码已刷新 (2/5)")
    const [wecomQrRefreshCount, setWecomQrRefreshCount] = useState(0);

    // Derived: QR login detection (from preset or installed plugin's detected capability)
    const isQrLogin = isQrLoginFromPreset || (!promoted && installedPlugin?.supportsQrLogin === true);
    const totalSteps = isQrLogin ? 2 : totalStepsBase;
    const bindingStep = totalSteps; // All platforms have binding as the last step

    useEffect(() => {
        return () => {
            isMountedRef.current = false;
            wecomQrAbortRef.current = true;
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        };
    }, []);

    // WeCom dualConfig: auto-start QR flow when in QR mode on step 1
    // Design: polling lifecycle is tied to QR validity. When a QR expires,
    // auto-generate a new one and continue polling (up to WECOM_MAX_QR_REFRESHES auto-refreshes).
    // After all refreshes exhausted → error state. User can click retry to restart.
    useEffect(() => {
        if (!isDualConfig || dualConfigMode !== 'qr' || step !== 1 || wecomQrStartedRef.current) return;
        if (!isTauriEnvironment()) return;
        wecomQrStartedRef.current = true;
        let cancelled = false;

        // Helper: generate QR and render as image
        const generateQr = async (invoke: typeof import('@tauri-apps/api/core').invoke) => {
            const result = await invoke<{ scode: string; auth_url: string }>('cmd_wecom_qr_generate');
            if (cancelled || !isMountedRef.current) return null;
            const dataUrl = await QRCode.toDataURL(result.auth_url, {
                width: 200, margin: 2,
                color: { dark: '#000000', light: '#ffffff' },
            });
            if (cancelled || !isMountedRef.current) return null;
            setWecomQrImageUrl(dataUrl);
            return result.scode;
        };

        (async () => {
            try {
                setWecomQrStatus('loading');
                setWecomQrRefreshCount(0);
                const { invoke } = await import('@tauri-apps/api/core');
                let scode = await generateQr(invoke);
                if (!scode) return;
                setWecomQrStatus('waiting');

                let qrRefreshCount = 0;
                let globalPollIndex = 0;

                // Outer loop: one iteration per QR code (initial + up to N refreshes)
                while (qrRefreshCount <= WECOM_MAX_QR_REFRESHES) {
                    let pollsThisQr = 0;
                    // Inner loop: poll until success, terminal state, or per-QR ceiling
                    while (pollsThisQr < WECOM_MAX_POLLS_PER_QR) {
                        if (cancelled || !isMountedRef.current || wecomQrAbortRef.current) return;
                        await new Promise(r => setTimeout(r, WECOM_POLL_INTERVAL));
                        if (cancelled || !isMountedRef.current || wecomQrAbortRef.current) return;

                        const poll = await invoke<{ status: string; bot_id?: string; secret?: string }>(
                            'cmd_wecom_qr_poll', { scode, pollIndex: globalPollIndex }
                        );
                        globalPollIndex++;
                        pollsThisQr++;

                        if (poll.status === 'success' && poll.bot_id && poll.secret) {
                            if (cancelled || !isMountedRef.current) return;
                            setWecomQrBotId(poll.bot_id);
                            setWecomQrSecret(poll.secret);
                            setWecomQrStatus('success');
                            return;
                        }

                        // QR expired → auto-refresh
                        if (poll.status === 'expired') {
                            qrRefreshCount++;
                            if (qrRefreshCount > WECOM_MAX_QR_REFRESHES) break; // → error
                            if (cancelled || !isMountedRef.current) return;
                            setWecomQrRefreshCount(qrRefreshCount);
                            setWecomQrStatus('loading');
                            scode = await generateQr(invoke);
                            if (!scode) return;
                            setWecomQrStatus('waiting');
                            break; // restart inner poll loop with new scode
                        }

                        // User cancelled or denied on WeCom side → error
                        if (poll.status === 'cancelled' || poll.status === 'denied') {
                            if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
                            return;
                        }
                        // Otherwise "waiting" — continue polling
                    }
                    // If inner loop hit the per-QR ceiling without a terminal status,
                    // treat it as if the QR expired (auto-refresh)
                    if (pollsThisQr >= WECOM_MAX_POLLS_PER_QR) {
                        qrRefreshCount++;
                        if (qrRefreshCount > WECOM_MAX_QR_REFRESHES) break;
                        if (cancelled || !isMountedRef.current) return;
                        setWecomQrRefreshCount(qrRefreshCount);
                        setWecomQrStatus('loading');
                        scode = await generateQr(invoke);
                        if (!scode) return;
                        setWecomQrStatus('waiting');
                    }
                }

                // Exhausted all QR refreshes
                if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
            } catch (err) {
                console.error('[ChannelWizard] WeCom QR flow error:', err);
                if (!cancelled && isMountedRef.current) setWecomQrStatus('error');
            }
        })();

        return () => { cancelled = true; };
    }, [isDualConfig, dualConfigMode, step, wecomQrRetryTrigger]);

    // Reset QR state when switching to QR mode (always re-trigger, even after prior success)
    const handleDualModeSwitch = useCallback((mode: 'qr' | 'config') => {
        setDualConfigMode(mode);
        if (mode === 'qr') {
            wecomQrStartedRef.current = false;
            wecomQrAbortRef.current = false;
            setWecomQrStatus('idle');
            setWecomQrImageUrl(null);
            setWecomQrBotId('');
            setWecomQrSecret('');
            setWecomQrRefreshCount(0);
        }
    }, []);

    // Load OpenClaw plugin info for config schema
    useEffect(() => {
        if (!isOpenClaw || !openclawPluginId || !isTauriEnvironment()) return;
        let cancelled = false;
        (async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
                if (cancelled) return;
                const found = plugins.find(p => p.pluginId === openclawPluginId);
                if (found) {
                    setInstalledPlugin(found);
                    // Pre-populate custom fields from requiredFields if no schema
                    const hasSchema = found.manifest?.configSchema?.properties
                        && Object.keys(found.manifest.configSchema.properties).length > 0;
                    // Try plugin's extracted requiredFields first, fallback to promoted plugin's hardcoded list
                    const reqFields = found.requiredFields?.length
                        ? found.requiredFields
                        : promoted?.requiredFields;
                    if (!hasSchema && reqFields?.length) {
                        setOpenclawCustomFields(reqFields.map(k => ({ key: k, value: '' })));
                    }
                }
            } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
    }, [isOpenClaw, openclawPluginId, promoted?.requiredFields]);

    // OpenClaw config schema helpers
    const openclawSchemaProps = installedPlugin?.manifest?.configSchema?.properties as
        Record<string, { type?: string; description?: string }> | undefined;
    const hasOpenclawSchema = !!(openclawSchemaProps && Object.keys(openclawSchemaProps).length > 0);
    const openclawSchemaRequired = useMemo(
        () => new Set(installedPlugin?.manifest?.configSchema?.required ?? []),
        [installedPlugin?.manifest?.configSchema?.required],
    );

    const buildOpenclawConfig = useCallback((): Record<string, string> => {
        const cfg: Record<string, string> = { ...openclawSchemaValues };
        for (const f of openclawCustomFields) {
            if (f.key.trim()) cfg[f.key.trim()] = f.value.trim();
        }
        return cfg;
    }, [openclawSchemaValues, openclawCustomFields]);

    const openclawHasIncompleteFields = openclawCustomFields.some(f => f.key.trim() && !f.value.trim());
    const openclawHasIncompleteSchema = hasOpenclawSchema
        && Array.from(openclawSchemaRequired).some(k => !openclawSchemaValues[k]?.trim());

    // Poll status when in binding step
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;

        const poll = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                const status = await invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId });
                if (isMountedRef.current) {
                    setBotStatus(status);
                }
            } catch {
                // Not running
            }
        };

        poll();
        const interval = setInterval(poll, 3000);
        return () => clearInterval(interval);
    }, [step, bindingStep, channelId, agent.id]);

    // Listen for user-bound events
    useEffect(() => {
        if (step !== bindingStep || !isTauriEnvironment()) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;

        import('@tauri-apps/api/event').then(({ listen }) => {
            if (cancelled) return;
            listen<{ botId: string; userId: string; username?: string }>('im:user-bound', (event) => {
                if (!isMountedRef.current || event.payload.botId !== channelId) return;
                const { userId, username } = event.payload;
                const displayName = username || userId;

                setAllowedUsers(prev => {
                    if (prev.includes(userId) || (username && prev.includes(username))) return prev;
                    toastRef.current.success(`用户 ${displayName} 已绑定`);
                    return [...prev, userId];
                });
            }).then(fn => {
                if (cancelled) fn();
                else unlisten = fn;
            });
        });

        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [step, bindingStep, channelId]);

    // Check if credentials are filled
    const hasCredentials = isDualConfig
        ? (dualConfigMode === 'qr'
            ? wecomQrStatus === 'success' // QR scan returned botId+secret
            : !!(openclawSchemaValues['botId']?.trim() && openclawSchemaValues['secret']?.trim()))
        : isOpenClaw
            ? true // OpenClaw uses its own validation
            : isFeishu
                ? feishuAppId.trim() && feishuAppSecret.trim()
                : isDingtalk
                    ? dingtalkClientId.trim() && dingtalkClientSecret.trim()
                    : botToken.trim();

    // Build channel config from current wizard state
    const buildChannelConfig = useCallback((): ChannelConfig => {
        if (isOpenClaw) {
            const pluginConfig = buildOpenclawConfig();
            // For dualConfig QR mode, inject the QR-obtained credentials
            if (isDualConfig && dualConfigMode === 'qr' && wecomQrBotId && wecomQrSecret) {
                pluginConfig.botId = wecomQrBotId;
                pluginConfig.secret = wecomQrSecret;
            }
            // Merge promoted plugin defaults (e.g. dmPolicy: 'open') under user values
            const mergedConfig = { ...(promoted?.defaultConfig ?? {}), ...pluginConfig };
            const pluginName = promoted?.name || installedPlugin?.manifest?.name || openclawPluginId || 'Plugin Bot';
            // Enable all non-sensitive tool groups by default.
            // Sensitive groups (im, perm) are opt-in. Rust auto-merges new plugin groups at startup.
            const allToolGroups = ['doc', 'chat', 'wiki_drive', 'bitable', 'calendar', 'task', 'sheet', 'search', 'common'];
            return {
                id: channelId,
                type: platform,
                name: pluginName,
                enabled: true,
                allowedUsers: [],
                setupCompleted: false,
                openclawPluginId: openclawPluginId,
                openclawNpmSpec: installedPlugin?.npmSpec,
                openclawPluginConfig: Object.keys(mergedConfig).length > 0 ? mergedConfig : undefined,
                openclawEnabledToolGroups: allToolGroups,
            };
        }
        return {
            id: channelId,
            type: platform,
            name: isDingtalk ? '钉钉 Bot' : isFeishu ? '飞书 Bot' : 'Telegram Bot',
            enabled: true,
            botToken: (isFeishu || isDingtalk) ? undefined : botToken.trim(),
            feishuAppId: isFeishu ? feishuAppId.trim() : undefined,
            feishuAppSecret: isFeishu ? feishuAppSecret.trim() : undefined,
            dingtalkClientId: isDingtalk ? dingtalkClientId.trim() : undefined,
            dingtalkClientSecret: isDingtalk ? dingtalkClientSecret.trim() : undefined,
            allowedUsers: [],
            setupCompleted: false,
        };
    }, [channelId, platform, isFeishu, isDingtalk, isOpenClaw, isDualConfig, dualConfigMode, wecomQrBotId, wecomQrSecret, botToken, feishuAppId, feishuAppSecret, dingtalkClientId, dingtalkClientSecret, openclawPluginId, promoted, installedPlugin, buildOpenclawConfig]);

    // Start channel via shared utility (resolves MCP + overrides)
    const startChannel = useCallback(async (channelCfg: ChannelConfig) => {
        if (!isTauriEnvironment()) return null;
        await invokeStartAgentChannel(agent, channelCfg);
        // Poll initial status after start
        const { invoke } = await import('@tauri-apps/api/core');
        return invoke<ChannelStatusData | null>('cmd_agent_channel_status', { agentId: agent.id, channelId: channelCfg.id });
    }, [agent]);

    // OpenClaw: step 2 = start channel, then advance to binding step
    const handleOpenClawStart = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        setStarting(true);
        try {
            const channelCfg = { ...buildChannelConfig(), setupCompleted: true };

            // Save channel to agent config (dedup: replace if same ID exists from a previous attempt)
            const existingChannels = (agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, {
                channels: [...existingChannels, channelCfg],
            });
            await refreshConfig();

            // Start the channel
            await startChannel(channelCfg);

            if (isMountedRef.current) {
                track('agent_channel_create', { platform });
                toastRef.current.success('Channel 启动成功，请完成用户绑定');
                setStep(bindingStep); // Advance to binding step
            }
        } catch (err) {
            if (isMountedRef.current) {
                toastRef.current.error(`启动失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) setStarting(false);
        }
    }, [buildChannelConfig, agent, platform, startChannel, refreshConfig]);

    // QR Login: start channel then initiate QR login flow
    const startQrLogin = useCallback(async () => {
        if (!isTauriEnvironment()) return;
        qrAbortRef.current = false;
        setQrStatus('loading');
        setQrMessage('正在启动插件...');

        try {
            const { invoke } = await import('@tauri-apps/api/core');
            // 1. Start the channel (spawns Bridge process)
            // disk-first: read latest config from disk before writing (CLAUDE.md convention)
            const { loadAppConfig } = await import('@/config/configService');
            const latestConfig = await loadAppConfig();
            const latestAgent = (latestConfig.agents ?? []).find(a => a.id === agent.id);
            const channelCfg = { ...buildChannelConfig(), setupCompleted: true };
            const existingChannels = (latestAgent?.channels ?? agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, { channels: [...existingChannels, channelCfg] });
            await refreshConfig();
            await invokeStartAgentChannel(agent, channelCfg);

            // 2. Wait a moment for Bridge to load the plugin
            await new Promise(r => setTimeout(r, 2000));
            if (qrAbortRef.current || !isMountedRef.current) return;

            // 3. Request QR code from Bridge
            setQrMessage('正在获取二维码...');
            const startResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                'cmd_plugin_qr_login_start', { agentId: agent.id, channelId }
            );

            if (!startResult.ok || !startResult.qrDataUrl) {
                throw new Error(startResult.message || '获取二维码失败');
            }

            if (!isMountedRef.current || qrAbortRef.current) return;
            qrSessionKeyRef.current = startResult.sessionKey;
            setQrDataUrl(startResult.qrDataUrl);
            setQrStatus('waiting');
            setQrMessage(`请使用${openclawPluginName}扫描二维码`);

            // 4. Poll for QR scan completion (pass sessionKey — WeChat requires it)
            // Auto-retry with QR refresh on timeout/error, up to MAX_QR_RETRIES
            const MAX_QR_RETRIES = 10;
            let qrRetryCount = 0;

            while (!qrAbortRef.current && isMountedRef.current) {
                try {
                    const waitResult = await invoke<{ ok: boolean; connected?: boolean; message?: string; accountId?: string }>(
                        'cmd_plugin_qr_login_wait', { agentId: agent.id, channelId, sessionKey: qrSessionKeyRef.current }
                    );

                    if (!isMountedRef.current || qrAbortRef.current) return;

                    if (waitResult.connected) {
                        setQrStatus('connected');
                        setQrMessage('登录成功！正在启动...');
                        await invoke('cmd_plugin_restart_gateway', {
                            agentId: agent.id, channelId,
                            accountId: waitResult.accountId,
                        });
                        // Persist accountId to channel config so Bridge finds credentials on restart
                        if (waitResult.accountId) {
                            const { loadAppConfig } = await import('@/config/configService');
                            const lat = await loadAppConfig();
                            const latAgent = (lat.agents ?? []).find(a => a.id === agent.id);
                            const updChs = (latAgent?.channels ?? []).map(ch =>
                                ch.id === channelId
                                    ? { ...ch, openclawPluginConfig: { ...(ch.openclawPluginConfig ?? {}), accountId: waitResult.accountId! } }
                                    : ch,
                            );
                            await patchAgentConfig(agent.id, { channels: updChs });
                            await refreshConfig();
                        }
                        if (isMountedRef.current) {
                            track('agent_channel_create', { platform });
                            toastRef.current.success('扫码登录成功');
                            setStep(2);
                        }
                        return;
                    }

                    // connected:false — could be timeout or terminal. Add delay to prevent spinning.
                    if (waitResult.message) setQrMessage(waitResult.message);
                    await new Promise(r => setTimeout(r, 1000));

                } catch (err) {
                    if (!isMountedRef.current || qrAbortRef.current) return;

                    // Most errors are transient: Rust proxy timeout, connection reset, QR expired.
                    // Only truly terminal: plugin 501 (not supported), Bridge crashed (ECONNREFUSED).
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isTerminal = /ECONNREFUSED|not support|501/i.test(errMsg);

                    if (isTerminal || qrRetryCount >= MAX_QR_RETRIES) {
                        setQrStatus('error');
                        setQrMessage(qrRetryCount >= MAX_QR_RETRIES
                            ? `超过最大重试次数 (${MAX_QR_RETRIES})，请手动重试`
                            : `登录失败: ${errMsg}`);
                        return;
                    }

                    // Auto-retry: refresh QR code and continue polling
                    qrRetryCount++;
                    try {
                        const refreshResult = await invoke<{ ok: boolean; qrDataUrl?: string; message?: string; sessionKey?: string }>(
                            'cmd_plugin_qr_login_start', { agentId: agent.id, channelId }
                        );
                        if (refreshResult.ok && refreshResult.qrDataUrl) {
                            qrSessionKeyRef.current = refreshResult.sessionKey;
                            setQrDataUrl(refreshResult.qrDataUrl);
                            setQrMessage(`二维码已刷新 (${qrRetryCount}/${MAX_QR_RETRIES})，请扫描`);
                        }
                    } catch {
                        setQrStatus('error');
                        setQrMessage('二维码获取失败，请手动重试');
                        return;
                    }
                }
            }
        } catch (err) {
            if (isMountedRef.current) {
                setQrStatus('error');
                setQrMessage(`启动失败: ${err}`);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buildChannelConfig, agent, channelId, platform, refreshConfig]);

    // Auto-start QR login when entering step 1 for QR plugins.
    // CRITICAL: startQrLogin must NOT be in deps — it depends on `agent` which changes
    // after refreshConfig(), causing cleanup → abort → stuck. Use ref for stable access.
    const startQrLoginRef = useRef(startQrLogin);
    startQrLoginRef.current = startQrLogin;
    const qrStartedRef = useRef(false);
    useEffect(() => {
        if (!isQrLogin || step !== 1 || qrStartedRef.current) return;
        qrStartedRef.current = true;
        startQrLoginRef.current();
    }, [isQrLogin, step]);

    // Handle "Next" for all steps
    const handleNext = useCallback(async () => {
        // OpenClaw step 1 → step 2: just advance (validation is on the button disabled state)
        if (isOpenClaw && step === 1) {
            setStep(2);
            return;
        }

        // Feishu/DingTalk step 2 -> step 3 (permissions guide -> binding)
        if ((isFeishu || isDingtalk) && step === 2) {
            setStep(3);
            return;
        }

        // Step 1 -> Step 2: validate credentials and start channel
        if (!hasCredentials) {
            toastRef.current.error(
                isFeishu ? '请输入 App ID 和 App Secret'
                    : isDingtalk ? '请输入 Client ID 和 Client Secret'
                        : '请输入 Bot Token'
            );
            return;
        }

        // Check for duplicate credentials — against existing channels in this agent + other agents
        const allChannels = [
            ...(agent.channels ?? []).filter(ch => ch.id !== channelId && ch.setupCompleted),
            ...(config.agents ?? [])
                .filter(a => a.id !== agent.id)
                .flatMap(a => (a.channels ?? []).filter(ch => ch.setupCompleted)),
        ];
        if (isFeishu) {
            if (allChannels.some(ch => ch.feishuAppId === feishuAppId.trim())) {
                toastRef.current.error('该飞书应用凭证已被其他 Channel 使用');
                return;
            }
        } else if (isDingtalk) {
            if (allChannels.some(ch => ch.dingtalkClientId === dingtalkClientId.trim())) {
                toastRef.current.error('该钉钉应用凭证已被其他 Channel 使用');
                return;
            }
        } else {
            if (allChannels.some(ch => ch.botToken === botToken.trim())) {
                toastRef.current.error('该 Bot Token 已被其他 Channel 使用');
                return;
            }
        }

        setStarting(true);
        setVerifyStatus('verifying');

        try {
            const channelCfg = buildChannelConfig();

            // Save channel to agent config (dedup: replace if same ID exists from a previous attempt)
            const existingChannels = (agent.channels ?? []).filter(ch => ch.id !== channelCfg.id);
            await patchAgentConfig(agent.id, {
                channels: [...existingChannels, channelCfg],
            });
            await refreshConfig();

            if (!isTauriEnvironment()) {
                setVerifyStatus('valid');
                setStep(2);
                return;
            }

            // Start the channel (this verifies the credentials)
            const status = await startChannel(channelCfg);

            if (isMountedRef.current) {
                setVerifyStatus('valid');
                setBotUsername(status?.botUsername ?? undefined);
                setBotStatus(status);
                // Save channel name from verification
                if (status?.botUsername) {
                    const displayName = platform === 'telegram' ? `@${status.botUsername}` : status.botUsername;
                    const updatedChannels = (agent.channels ?? [])
                        .filter(ch => ch.id !== channelId)
                        .concat([{ ...channelCfg, name: displayName }]);
                    await patchAgentConfig(agent.id, { channels: updatedChannels });
                    await refreshConfig();
                }
                setStep(2);
            }
        } catch (err) {
            if (isMountedRef.current) {
                setVerifyStatus('invalid');
                toastRef.current.error(`验证失败: ${err}`);
            }
        } finally {
            if (isMountedRef.current) {
                setStarting(false);
            }
        }
    }, [hasCredentials, isFeishu, isDingtalk, isOpenClaw, step, botToken, feishuAppId, dingtalkClientId, channelId, platform, agent, config.agents, buildChannelConfig, startChannel, refreshConfig]);

    // Complete wizard — merge local users with any Rust-persisted users
    const handleComplete = useCallback(async () => {
        // Read latest agent config from disk to merge users
        const { loadAppConfig } = await import('@/config/configService');
        const latest = await loadAppConfig();
        const latestAgent = (latest.agents ?? []).find(a => a.id === agent.id);
        const diskChannel = latestAgent?.channels?.find(ch => ch.id === channelId);
        const diskUsers = diskChannel?.allowedUsers ?? [];
        const mergedUsers = [...new Set([...diskUsers, ...allowedUsers])];

        // Update channel with setupCompleted + merged users
        const updatedChannels = (latestAgent?.channels ?? agent.channels ?? []).map(ch =>
            ch.id === channelId
                ? { ...ch, setupCompleted: true, allowedUsers: mergedUsers }
                : ch,
        );
        await patchAgentConfig(agent.id, { channels: updatedChannels });
        await refreshConfig();

        track('agent_channel_create', { platform });
        if (isMountedRef.current) onComplete(channelId);
    }, [agent.id, agent.channels, channelId, allowedUsers, platform, onComplete, refreshConfig]);

    // Cancel wizard - stop channel, remove from agent config
    const handleCancel = useCallback(async () => {
        if (isTauriEnvironment()) {
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId });
            } catch {
                // Channel might not be running
            }
        }

        // Remove channel from agent config
        const updatedChannels = (agent.channels ?? []).filter(ch => ch.id !== channelId);
        await patchAgentConfig(agent.id, { channels: updatedChannels });
        await refreshConfig();

        if (isMountedRef.current) onCancel();
    }, [agent.id, agent.channels, channelId, onCancel, refreshConfig]);

    const handleCopyPermJson = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(FEISHU_PERMISSIONS_JSON);
            setPermJsonCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setPermJsonCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, []);

    const openclawPluginName = promoted?.name || installedPlugin?.manifest?.name || openclawPluginId || 'Plugin';
    const platformLabel = isOpenClaw ? openclawPluginName : isDingtalk ? '钉钉' : isFeishu ? '飞书' : 'Telegram';

    // Platform icon for header
    const platformIcon = (() => {
        if (platform === 'telegram') return telegramIcon;
        if (platform === 'feishu') return feishuIcon;
        if (platform === 'dingtalk') return dingtalkIcon;
        if (promoted) return promoted.icon;
        return undefined;
    })();

    const stepLabel = (() => {
        if (isQrLogin) {
            if (step === 1) return '扫码登录';
            return '绑定用户';
        }
        if (isOpenClaw) {
            if (step === 1) return '配置插件';
            if (step === 2) return '确认并启动';
            return '绑定用户';
        }
        if (isDingtalk) {
            if (step === 1) return '配置应用凭证';
            if (step === 2) return '配置权限与能力';
            return '绑定你的钉钉账号';
        }
        if (isFeishu) {
            if (step === 1) return '配置应用凭证';
            if (step === 2) return '配置权限与事件';
            return '绑定你的飞书账号';
        }
        if (step === 1) return '配置 Bot Token';
        return '绑定你的 Telegram 账号';
    })();

    // Reusable action bar for each step
    const renderActionBar = (props: {
        onBack?: () => void;
        backLabel?: string;
        onNext: () => void;
        nextLabel: string;
        nextDisabled?: boolean;
        nextLoading?: boolean;
        nextIcon?: React.ReactNode;
    }) => (
        <div className="flex items-center justify-between">
            {props.onBack ? (
                <button
                    onClick={props.onBack}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                    <ArrowLeft className="h-4 w-4" />
                    {props.backLabel || '上一步'}
                </button>
            ) : (
                <button
                    onClick={handleCancel}
                    className="rounded-lg border border-[var(--line)] px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                    取消
                </button>
            )}
            <button
                onClick={props.onNext}
                disabled={props.nextDisabled}
                className="flex items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
            >
                {props.nextLabel}
                {props.nextLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                ) : props.nextIcon ? (
                    props.nextIcon
                ) : null}
            </button>
        </div>
    );

    return (
        <div className="space-y-6">
            {/* Header: platform badge + title + step indicator */}
            <div className="space-y-4">
                <div className="flex items-center gap-3">
                    {platformIcon && (
                        <img src={platformIcon} alt={platformLabel} className="h-8 w-8 rounded-lg" />
                    )}
                    <div>
                        <h2 className="text-lg font-semibold text-[var(--ink)]">
                            添加 {platformLabel} Channel
                        </h2>
                        <p className="text-xs text-[var(--ink-muted)]">
                            步骤 {step}/{totalSteps}: {stepLabel}
                        </p>
                    </div>
                </div>
                <div className="flex gap-1">
                    {Array.from({ length: totalSteps }, (_, i) => (
                        <div
                            key={i}
                            className={`h-1 flex-1 rounded-full ${step >= i + 1 ? 'bg-[var(--button-primary-bg)]' : 'bg-[var(--line)]'}`}
                        />
                    ))}
                </div>
            </div>

            {/* Step 1: QR Login (for plugins that use QR code authentication) */}
            {step === 1 && isQrLogin && (
                <div className="space-y-6">
                    {/* Action bar — must use handleCancel to stop Bridge + remove config */}
                    {renderActionBar({
                        onNext: () => { qrAbortRef.current = true; handleCancel(); },
                        nextLabel: '取消',
                        nextIcon: undefined,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted && (
                                <img src={promoted.icon} alt={openclawPluginName} className="h-10 w-10 shrink-0 rounded-xl" />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* QR Code display */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6">
                        <div className="flex flex-col items-center gap-4">
                            {qrStatus === 'loading' && (
                                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-[var(--paper-inset)]">
                                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                                </div>
                            )}
                            {(qrStatus === 'waiting' || qrStatus === 'scanned') && qrImageUrl && (
                                <img src={qrImageUrl} alt="扫码登录" className="h-48 w-48 rounded-xl" />
                            )}
                            {qrStatus === 'connected' && (
                                <div className="flex h-48 w-48 items-center justify-center rounded-xl bg-[var(--accent-success-subtle)]">
                                    <Check className="h-12 w-12 text-[var(--accent-success)]" />
                                </div>
                            )}
                            {qrStatus === 'error' && (
                                <div className="flex h-48 w-48 flex-col items-center justify-center gap-2 rounded-xl bg-[var(--paper-inset)]">
                                    <p className="text-sm text-[var(--accent-danger)]">获取失败</p>
                                    <button
                                        onClick={() => { setQrStatus('idle'); }}
                                        className="rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"
                                    >
                                        重试
                                    </button>
                                </div>
                            )}
                            <p className="text-sm text-[var(--ink-muted)]">{qrMessage}</p>
                        </div>
                    </div>
                </div>
            )}

            {/* Step 1: DualConfig — QR scan OR manual config (WeCom) */}
            {step === 1 && isDualConfig && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: '下一步',
                        nextDisabled: !hasCredentials,
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted && (
                                <img src={promoted.icon} alt={promoted.name} className="h-10 w-10 shrink-0 rounded-xl" />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{promoted?.name || openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                                {promoted?.description && (
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">{promoted.description}</p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Mode switcher: pill tab */}
                    <div className="flex gap-1 rounded-lg bg-[var(--paper-inset)] p-1">
                        <button
                            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                                dualConfigMode === 'qr'
                                    ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                            onClick={() => handleDualModeSwitch('qr')}
                        >
                            扫码添加
                        </button>
                        <button
                            className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
                                dualConfigMode === 'config'
                                    ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                            onClick={() => handleDualModeSwitch('config')}
                        >
                            手动配置
                        </button>
                    </div>

                    {/* QR mode */}
                    {dualConfigMode === 'qr' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <p className="text-sm font-medium text-[var(--ink)]">扫码创建机器人</p>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                使用 {promoted?.name?.replace(/（.*）/, '') || '企业微信'} App 扫描下方二维码，一键创建机器人并自动获取凭证
                            </p>

                            <div className="mt-5 flex flex-col items-center py-4">
                                {wecomQrStatus === 'loading' && (
                                    <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl border border-[var(--line)] bg-white">
                                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    </div>
                                )}
                                {wecomQrStatus === 'waiting' && wecomQrImageUrl && (
                                    <img src={wecomQrImageUrl} alt="企业微信扫码" className="h-[200px] w-[200px] rounded-xl border border-[var(--line)]" />
                                )}
                                {wecomQrStatus === 'success' && (
                                    <div className="flex h-[200px] w-[200px] flex-col items-center justify-center rounded-xl border border-[var(--success)] bg-[var(--success-bg)]">
                                        <Check className="h-8 w-8 text-[var(--success)]" />
                                        <p className="mt-2 text-sm font-medium text-[var(--success)]">扫码成功</p>
                                        <p className="mt-1 text-xs text-[var(--success)]">Bot ID 和 Secret 已自动获取</p>
                                    </div>
                                )}
                                {wecomQrStatus === 'error' && (
                                    <div className="flex h-[200px] w-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                        <p className="text-sm text-[var(--ink-muted)]">
                                            {wecomQrRefreshCount > 0 ? '二维码多次过期' : '获取二维码失败'}
                                        </p>
                                        <button
                                            onClick={() => {
                                                wecomQrStartedRef.current = false;
                                                wecomQrAbortRef.current = false;
                                                setWecomQrStatus('idle');
                                                setWecomQrRefreshCount(0);
                                                setWecomQrRetryTrigger(n => n + 1);
                                            }}
                                            className="text-xs text-[var(--accent-warm)] hover:underline"
                                        >
                                            重试
                                        </button>
                                    </div>
                                )}
                                {wecomQrStatus === 'idle' && (
                                    <div className="flex h-[200px] w-[200px] items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--paper-inset)]">
                                        <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                    </div>
                                )}

                                <p className="mt-3 text-xs text-[var(--ink-muted)]">
                                    {wecomQrStatus === 'loading' && (wecomQrRefreshCount > 0
                                        ? `二维码已过期，正在刷新 (${wecomQrRefreshCount}/${WECOM_MAX_QR_REFRESHES})...`
                                        : '正在获取二维码...')}
                                    {wecomQrStatus === 'waiting' && '请使用企业微信 App 扫描二维码'}
                                    {wecomQrStatus === 'success' && '凭证已就绪，点击「下一步」继续'}
                                    {wecomQrStatus === 'error' && (wecomQrRefreshCount > 0
                                        ? '二维码多次过期，请检查网络后重试'
                                        : '请检查网络后重试')}
                                </p>
                            </div>

                            <p className="mt-2 text-xs text-[var(--ink-subtle)]">
                                扫码后将创建新的智能机器人。如需关联已有机器人，请切换到「手动配置」
                            </p>
                        </div>
                    )}

                    {/* Manual config mode */}
                    {dualConfigMode === 'config' && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <h3 className="text-sm font-medium text-[var(--ink)]">
                                {promoted?.setupGuide?.credentialTitle || '插件配置'}
                            </h3>
                            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                                {promoted?.setupGuide?.credentialHintLink ? (
                                    <>
                                        {'前往 '}
                                        <a
                                            href={promoted.setupGuide.credentialHintLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                            onClick={(e) => {
                                                if (isTauriEnvironment()) {
                                                    e.preventDefault();
                                                    import('@tauri-apps/plugin-shell').then(({ open }) => open(promoted!.setupGuide!.credentialHintLink!));
                                                }
                                            }}
                                        >
                                            企业微信管理后台
                                            <ExternalLink className="inline h-3 w-3" />
                                        </a>
                                        {' '}创建智能机器人，获取凭证
                                    </>
                                ) : (
                                    promoted?.setupGuide?.credentialHint || '输入插件需要的配置参数'
                                )}
                            </p>

                            <div className="mt-4 space-y-3">
                                {(promoted?.requiredFields ?? []).map((key) => (
                                    <div key={key}>
                                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                            {key}
                                            <span className="ml-1 text-[var(--error)]">*</span>
                                        </label>
                                        <input
                                            type={/secret|token|password|key/i.test(key) ? 'password' : 'text'}
                                            value={openclawSchemaValues[key] || ''}
                                            onChange={(e) => setOpenclawSchemaValues(prev => ({ ...prev, [key]: e.target.value }))}
                                            placeholder={`输入 ${key}`}
                                            className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                                        />
                                    </div>
                                ))}
                            </div>

                            <p className="mt-4 text-xs text-[var(--ink-subtle)]">
                                创建方法：企微客户端 → 工作台 → 智能机器人 → 创建机器人 → 手动创建 → API 模式创建 → 使用长连接
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Step 1: Credentials / OpenClaw Config */}
            {step === 1 && isOpenClaw && !isQrLogin && !isDualConfig && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: '下一步',
                        nextDisabled: openclawHasIncompleteFields || openclawHasIncompleteSchema,
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    {/* Plugin info card */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <div className="flex items-start gap-4">
                            {promoted ? (
                                <img src={promoted.icon} alt={openclawPluginName} className="h-10 w-10 shrink-0 rounded-xl" />
                            ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
                                    <Puzzle className="h-5 w-5 text-[var(--accent-warm)]" />
                                </div>
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-semibold text-[var(--ink)]">{openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                                            v{installedPlugin.packageVersion}
                                        </span>
                                    )}
                                </div>
                                {(promoted?.description || installedPlugin?.manifest?.description) && (
                                    <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                        {promoted?.description || installedPlugin?.manifest?.description}
                                    </p>
                                )}
                                {installedPlugin?.homepage && (
                                    <button
                                        className="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--accent-warm)] hover:underline"
                                        onClick={() => {
                                            if (isTauriEnvironment()) {
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(installedPlugin!.homepage!));
                                            }
                                        }}
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        项目主页
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Config section */}
                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">
                            {promoted?.setupGuide?.credentialTitle || '插件配置'}
                        </h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            {promoted?.setupGuide?.credentialHintLink ? (
                                <>
                                    {promoted.setupGuide.credentialHint.split(promoted.setupGuide.credentialHintLink)[0] || '前往 '}
                                    <a
                                        href={promoted.setupGuide.credentialHintLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                        onClick={(e) => {
                                            if (isTauriEnvironment()) {
                                                e.preventDefault();
                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(promoted!.setupGuide!.credentialHintLink!));
                                            }
                                        }}
                                    >
                                        {openclawPluginName} 开放平台
                                        <ExternalLink className="inline h-3 w-3" />
                                    </a>
                                    {' '}创建应用，获取凭证
                                </>
                            ) : (
                                promoted?.setupGuide?.credentialHint || '输入插件需要的配置参数（如 appId、clientSecret 等）'
                            )}
                        </p>

                        <div className="mt-4">
                            {hasOpenclawSchema ? (
                                <div className="space-y-4">
                                    <div className="space-y-3">
                                        {Object.entries(openclawSchemaProps!).map(([key, field]) => {
                                            const isRequired = openclawSchemaRequired.has(key);
                                            return (
                                                <div key={key}>
                                                    <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                                                        {key}
                                                        {isRequired && <span className="ml-1 text-[var(--error)]">*</span>}
                                                    </label>
                                                    {field.description && (
                                                        <p className="mb-1 text-xs text-[var(--ink-muted)]">{field.description}</p>
                                                    )}
                                                    <input
                                                        type={/secret|token|password|key/i.test(key) ? 'password' : 'text'}
                                                        value={openclawSchemaValues[key] || ''}
                                                        onChange={(e) => setOpenclawSchemaValues(prev => ({ ...prev, [key]: e.target.value }))}
                                                        placeholder={`输入 ${key}`}
                                                        className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors"
                                                    />
                                                </div>
                                            );
                                        })}
                                    </div>
                                    {/* Extra custom fields */}
                                    <div className="border-t border-[var(--line-subtle)] pt-3">
                                        <p className="mb-2 text-xs text-[var(--ink-muted)]">自定义配置</p>
                                        <div className="space-y-2">
                                            {openclawCustomFields.map((field, i) => (
                                                <div key={i} className="flex items-center gap-2">
                                                    <input type="text" value={field.key} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], key: e.target.value }; setOpenclawCustomFields(next); }} placeholder="配置名" className="w-[140px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                                    <input type="text" value={field.value} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], value: e.target.value }; setOpenclawCustomFields(next); }} placeholder="值" className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                                    <button onClick={() => setOpenclawCustomFields(openclawCustomFields.filter((_, idx) => idx !== i))} className="shrink-0 rounded-lg p-1.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                                                </div>
                                            ))}
                                            <button onClick={() => setOpenclawCustomFields([...openclawCustomFields, { key: '', value: '' }])} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                                <Plus className="h-3.5 w-3.5" />
                                                添加配置项
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {openclawCustomFields.map((field, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                            <input type="text" value={field.key} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], key: e.target.value }; setOpenclawCustomFields(next); }} placeholder="配置名" className="w-[140px] shrink-0 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                            <input type="text" value={field.value} onChange={(e) => { const next = [...openclawCustomFields]; next[i] = { ...next[i], value: e.target.value }; setOpenclawCustomFields(next); }} placeholder="值" className="min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--button-primary-bg)] focus:outline-none transition-colors" />
                                            <button onClick={() => setOpenclawCustomFields(openclawCustomFields.filter((_, idx) => idx !== i))} className="shrink-0 rounded-lg p-1.5 text-[var(--ink-subtle)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--error)]"><Trash2 className="h-3.5 w-3.5" /></button>
                                        </div>
                                    ))}
                                    <button onClick={() => setOpenclawCustomFields([...openclawCustomFields, { key: '', value: '' }])} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                        <Plus className="h-3.5 w-3.5" />
                                        添加配置项
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Step-by-step image guide (promoted plugins only) */}
                    {promoted?.setupGuide?.steps && promoted.setupGuide.steps.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <p className="text-sm font-medium text-[var(--ink)]">配置指引</p>
                            {promoted.setupGuide.steps.map((guideStep, i) => {
                                const linkText = guideStep.captionLinkText;
                                const linkUrl = guideStep.captionLinkUrl;
                                const splitIdx = linkText ? guideStep.caption.indexOf(linkText) : -1;
                                return (
                                    <div key={i} className={i > 0 ? 'mt-5' : 'mt-3'}>
                                        <p className="text-xs text-[var(--ink-muted)]">
                                            {splitIdx >= 0 && linkUrl ? (
                                                <>
                                                    {guideStep.caption.slice(0, splitIdx)}
                                                    <a
                                                        href={linkUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                                        onClick={(e) => {
                                                            if (isTauriEnvironment()) {
                                                                e.preventDefault();
                                                                import('@tauri-apps/plugin-shell').then(({ open }) => open(linkUrl));
                                                            }
                                                        }}
                                                    >
                                                        {linkText}
                                                        <ExternalLink className="inline h-3 w-3" />
                                                    </a>
                                                    {guideStep.caption.slice(splitIdx + linkText!.length)}
                                                </>
                                            ) : guideStep.caption}
                                        </p>
                                        <img
                                            src={guideStep.image}
                                            alt={guideStep.alt}
                                            className="mt-2 w-full rounded-lg border border-[var(--line)]"
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Step 1: Credentials (built-in platforms) */}
            {step === 1 && !isOpenClaw && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onNext: handleNext,
                        nextLabel: '下一步',
                        nextDisabled: !hasCredentials || starting,
                        nextLoading: starting,
                        nextIcon: !starting ? <ArrowRight className="h-4 w-4" /> : undefined,
                    })}

                    {isDingtalk ? (
                        <div className="space-y-6">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <DingtalkCredentialInput
                                    clientId={dingtalkClientId}
                                    clientSecret={dingtalkClientSecret}
                                    onClientIdChange={setDingtalkClientId}
                                    onClientSecretChange={setDingtalkClientSecret}
                                    verifyStatus={verifyStatus}
                                    botName={botUsername}
                                    showGuide={false}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <p className="text-sm font-medium text-[var(--ink)]">如何获取钉钉应用凭证？</p>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>1. 登录<a
                                        href="https://open-dev.dingtalk.com"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mx-0.5 inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                    >
                                        钉钉开放平台
                                    </a>，进入 <span className="font-medium text-[var(--ink)]">应用开发</span> &gt; <span className="font-medium text-[var(--ink)]">钉钉应用</span></li>
                                    <li>2. 点击右上角 <span className="font-medium text-[var(--ink)]">创建应用</span>，填写应用名称和描述</li>
                                    <li>3. 创建后进入应用详情，在左侧菜单 <span className="font-medium text-[var(--ink)]">凭证与基础信息</span> 页获取 Client ID 和 Client Secret</li>
                                </ol>
                                <img src={dingtalkStep1CreateAppImg} alt="钉钉开放平台 - 创建应用" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                                <img src={dingtalkStep1CredentialsImg} alt="钉钉凭证与基础信息" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </div>
                    ) : isFeishu ? (
                        <div className="space-y-6">
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <FeishuCredentialInput
                                    appId={feishuAppId}
                                    appSecret={feishuAppSecret}
                                    onAppIdChange={setFeishuAppId}
                                    onAppSecretChange={setFeishuAppSecret}
                                    verifyStatus={verifyStatus}
                                    botName={botUsername}
                                    showGuide={false}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <p className="text-sm font-medium text-[var(--ink)]">如何获取飞书应用凭证？</p>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>1. 登录<a
                                        href="https://open.feishu.cn/app"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mx-0.5 inline-flex items-center gap-0.5 text-[var(--button-primary-bg)] hover:underline"
                                    >
                                        飞书开放平台
                                    </a>并创建自建应用</li>
                                    <li>2. 在「凭证与基础信息」页获取 App ID 和 App Secret</li>
                                    <li>3. 左侧菜单进入 <span className="font-medium text-[var(--ink)]">添加应用能力</span>，找到 <span className="font-medium text-[var(--ink)]">机器人</span> 卡片，点击 <span className="font-medium text-[var(--ink)]">配置</span> 按钮添加</li>
                                </ol>
                                <img src={feishuStep1Img} alt="飞书开放平台 - 凭证与基础信息" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                                <img src={feishuStep2AddBotImg} alt="飞书添加应用能力 - 机器人" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <BotTokenInput
                                    value={botToken}
                                    onChange={setBotToken}
                                    verifyStatus={verifyStatus}
                                    botUsername={botUsername}
                                />
                            </div>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">
                                    如何获取 Bot Token？
                                </h3>
                                <div className="mt-3 flex gap-5">
                                    <img
                                        src={telegramBotAddImg}
                                        alt="Telegram BotFather tutorial"
                                        className="h-[270px] flex-shrink-0 rounded-lg border border-[var(--line)] object-cover"
                                    />
                                    <ol className="flex-1 space-y-2 text-sm text-[var(--ink-muted)]">
                                        <li>1. 扫左侧二维码，或在 Telegram 中搜索 <span className="font-medium text-[var(--ink)]">@BotFather</span></li>
                                        <li>2. 发送 <code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs">/newbot</code> 创建新 Bot</li>
                                        <li>3. 按提示设置 Bot 名称和用户名</li>
                                        <li>4. 复制返回的 <span className="font-medium text-[var(--ink)]">HTTP API Token</span></li>
                                        <li>5. 粘贴到上方的 Bot Token 输入框</li>
                                    </ol>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Step 2 (DingTalk): Permissions & Capabilities guide */}
            {isDingtalk && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleNext,
                        nextLabel: '下一步',
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">4. 添加机器人能力</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>在应用详情页，左侧菜单进入 <span className="font-medium text-[var(--ink)]">添加应用能力</span></li>
                            <li>找到 <span className="font-medium text-[var(--ink)]">机器人</span> 卡片，点击 <span className="font-medium text-[var(--ink)]">+ 添加</span></li>
                        </ol>
                        <img src={dingtalkStep2AddRobotImg} alt="钉钉添加应用能力 - 机器人" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">5. 配置机器人</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">机器人</span>，开启 <span className="font-medium text-[var(--ink)]">机器人配置</span> 开关</li>
                            <li>填写机器人名称和简介</li>
                            <li>消息接收模式选择 <span className="font-medium text-[var(--ink)]">Stream 模式</span>（无需公网服务器，推荐）</li>
                            <li>点击 <span className="font-medium text-[var(--ink)]">发布</span> 保存机器人配置</li>
                        </ol>
                        <img src={dingtalkStep2StreamModeImg} alt="钉钉机器人配置 - Stream 模式" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">6. 创建版本并发布</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">版本管理与发布</span></li>
                            <li>点击右上角 <span className="font-medium text-[var(--ink)]">创建新版本</span>，填写版本号和描述</li>
                            <li>设置 <span className="font-medium text-[var(--ink)]">应用可用范围</span>（建议选择<span className="font-medium text-[var(--ink)]">全部员工</span>或目标范围）</li>
                            <li>保存后提交发布，管理员审批通过后即可使用</li>
                        </ol>
                        <img src={dingtalkStep2PublishImg} alt="钉钉版本管理与发布" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>
                </div>
            )}

            {/* Step 2 (Feishu): Permissions & Events guide */}
            {isFeishu && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleNext,
                        nextLabel: '下一步',
                        nextIcon: <ArrowRight className="h-4 w-4" />,
                    })}

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">4. 配置权限</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">权限管理</span></li>
                            <li>点击 <span className="font-medium text-[var(--ink)]">批量导入</span></li>
                            <li>粘贴以下 JSON（一键导入所有需要的权限）：</li>
                        </ol>
                        <div className="mt-3 relative">
                            <button
                                onClick={handleCopyPermJson}
                                className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                title="复制 JSON"
                            >
                                {permJsonCopied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                            <pre className="overflow-x-auto rounded-lg bg-[var(--paper-inset)] p-3 text-[11px] leading-relaxed text-[var(--ink-muted)]">
                                {FEISHU_PERMISSIONS_JSON}
                            </pre>
                        </div>
                        <img src={feishuStep2PermImg} alt="飞书权限管理 - 批量导入" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">5. 配置事件订阅</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">事件与回调</span> &gt; <span className="font-medium text-[var(--ink)]">事件配置</span></li>
                            <li>请求方式选择：<span className="font-medium text-[var(--ink)]">使用长连接接收事件</span>（不需要公网服务器）</li>
                            <li>添加事件：搜索 <code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px]">im.message.receive_v1</code>（接收消息），勾选添加</li>
                        </ol>
                        <img src={feishuStep2EventImg} alt="飞书事件与回调 - 事件配置" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">6. 创建版本并发布</h3>
                        <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                            <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">版本管理与发布</span></li>
                            <li>点击右上角 <span className="font-medium text-[var(--ink)]">创建版本</span>，填写版本信息后提交发布</li>
                        </ol>
                        <img src={feishuStep2PublishImg} alt="飞书版本管理与发布" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                    </div>
                </div>
            )}

            {/* OpenClaw Step 2: Setup guide (for promoted plugins like feishu) + Confirm + Start */}
            {/* Skip for QR login plugins — they go directly from scan (step 1) to binding (step 2) */}
            {isOpenClaw && !isQrLogin && step === 2 && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: () => setStep(1),
                        onNext: handleOpenClawStart,
                        nextLabel: starting ? '启动中…' : '启动 Channel',
                        nextDisabled: starting,
                        nextLoading: starting,
                        nextIcon: !starting ? <Check className="h-4 w-4" /> : undefined,
                    })}

                    {/* Feishu-specific: Permissions + Events + Publish guide (reuse built-in feishu setup) */}
                    {promoted?.pluginId === 'openclaw-lark' && (
                        <>
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">2. 配置权限</h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">权限管理</span></li>
                                    <li>点击 <span className="font-medium text-[var(--ink)]">批量导入</span></li>
                                    <li>粘贴以下 JSON（一键导入所有需要的权限）：</li>
                                </ol>
                                <div className="mt-3 relative">
                                    <button
                                        onClick={handleCopyPermJson}
                                        className="absolute right-2 top-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                        title="复制 JSON"
                                    >
                                        {permJsonCopied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                                    </button>
                                    <pre className="overflow-x-auto rounded-lg bg-[var(--paper-inset)] p-3 text-[11px] leading-relaxed text-[var(--ink-muted)]">
                                        {FEISHU_PERMISSIONS_JSON}
                                    </pre>
                                </div>
                                <img src={feishuStep2PermImg} alt="飞书权限管理 - 批量导入" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>

                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">3. 配置事件订阅</h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">事件与回调</span> &gt; <span className="font-medium text-[var(--ink)]">事件配置</span></li>
                                    <li>请求方式选择：<span className="font-medium text-[var(--ink)]">使用长连接接收事件</span>（不需要公网服务器）</li>
                                    <li>添加事件：搜索 <code className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px]">im.message.receive_v1</code>（接收消息），勾选添加</li>
                                </ol>
                                <img src={feishuStep2EventImg} alt="飞书事件与回调 - 事件配置" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>

                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <h3 className="text-sm font-medium text-[var(--ink)]">4. 添加机器人能力并发布</h3>
                                <ol className="mt-3 space-y-1.5 text-sm text-[var(--ink-muted)]">
                                    <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">添加应用能力</span>，找到 <span className="font-medium text-[var(--ink)]">机器人</span> 卡片，点击添加</li>
                                    <li>左侧菜单进入 <span className="font-medium text-[var(--ink)]">版本管理与发布</span>，点击 <span className="font-medium text-[var(--ink)]">创建版本</span>，提交发布</li>
                                </ol>
                                <img src={feishuStep2AddBotImg} alt="飞书添加机器人能力" className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                            </div>
                        </>
                    )}

                    {/* Promoted plugin setup guide steps (non-feishu plugins) */}
                    {promoted && promoted.pluginId !== 'openclaw-lark' && promoted.setupGuide?.steps && (
                        <>
                            {promoted.setupGuide.steps.map((s, i) => (
                                <div key={i} className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                    <p className="text-sm text-[var(--ink-muted)]">{s.caption}</p>
                                    <img src={s.image} alt={s.alt} className="mt-4 w-full rounded-lg border border-[var(--line)]" />
                                </div>
                            ))}
                        </>
                    )}

                    <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                        <h3 className="text-sm font-medium text-[var(--ink)]">确认配置</h3>
                        <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                            确认以上设置完成后，点击「启动 Channel」
                        </p>

                        <div className="mt-4 space-y-3">
                            <div className="flex items-center gap-3 rounded-lg border border-[var(--line)] p-3">
                                {promoted ? (
                                    <img src={promoted.icon} alt={openclawPluginName} className="h-8 w-8 shrink-0 rounded-lg" />
                                ) : (
                                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)]">
                                        <Puzzle className="h-4 w-4 text-[var(--accent-warm)]" />
                                    </div>
                                )}
                                <div>
                                    <p className="text-sm font-medium text-[var(--ink)]">{openclawPluginName}</p>
                                    {installedPlugin?.packageVersion && (
                                        <p className="text-xs text-[var(--ink-muted)]">v{installedPlugin.packageVersion}</p>
                                    )}
                                </div>
                            </div>

                            {(() => {
                                const cfg = buildOpenclawConfig();
                                const count = Object.keys(cfg).length;
                                return count > 0 ? (
                                    <div className="flex items-center justify-between rounded-lg border border-[var(--line)] p-3">
                                        <span className="text-xs text-[var(--ink-muted)]">配置项</span>
                                        <span className="text-sm text-[var(--ink)]">{count} 个</span>
                                    </div>
                                ) : null;
                            })()}
                        </div>
                    </div>
                </div>
            )}

            {/* Binding step (all platforms) */}
            {step === bindingStep && (
                <div className="space-y-6">
                    {/* Action bar at top */}
                    {renderActionBar({
                        onBack: isQrLogin ? undefined : () => setStep((isFeishu || isDingtalk || isOpenClaw) ? 2 : 1),
                        onNext: handleComplete,
                        nextLabel: '完成',
                        nextIcon: <Check className="h-4 w-4" />,
                    })}

                    {(isFeishu || isDingtalk || (isOpenClaw && !isQrLogin)) ? (
                        botStatus?.bindCode && (
                            <BindCodePanel
                                bindCode={botStatus.bindCode}
                                hasWhitelistUsers={allowedUsers.length > 0}
                                platformName={isOpenClaw ? platformLabel : isDingtalk ? '钉钉' : '飞书'}
                            />
                        )
                    ) : isQrLogin ? (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-[var(--ink)]">用户绑定</label>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    扫码即可使用，无需手动绑定用户。
                                </p>
                            </div>
                        </div>
                    ) : (
                        <>
                            {botStatus?.bindUrl && (
                                <BindQrPanel
                                    bindUrl={botStatus.bindUrl}
                                    hasWhitelistUsers={allowedUsers.length > 0}
                                />
                            )}
                            <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <WhitelistManager
                                    users={allowedUsers}
                                    onChange={setAllowedUsers}
                                    platform={platform}
                                />
                            </div>
                        </>
                    )}

                    {(isFeishu || isDingtalk || (isOpenClaw && !isQrLogin)) && allowedUsers.length > 0 && (
                        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                            <WhitelistManager
                                users={allowedUsers}
                                onChange={setAllowedUsers}
                                platform={platform}
                            />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
