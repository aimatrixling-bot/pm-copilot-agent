// Channel config panel — edit credentials, users, permissions for a single channel
// Reuses existing IM credential input components
import { useCallback, useRef, useEffect } from 'react';
import { ChevronLeft } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentConfig, ChannelConfig } from '../../../../shared/types/agent';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import BotTokenInput from '../../ImSettings/components/BotTokenInput';
import FeishuCredentialInput from '../../ImSettings/components/FeishuCredentialInput';
import DingtalkCredentialInput from '../../ImSettings/components/DingtalkCredentialInput';

interface ChannelConfigPanelProps {
  agent: AgentConfig;
  channel: ChannelConfig;
  onBack: () => void;
  onChanged: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  dingtalk: '钉钉',
};

export default function ChannelConfigPanel({ agent, channel, onBack, onChanged }: ChannelConfigPanelProps) {
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const platformLabel = channel.type.startsWith('openclaw:')
    ? channel.type.slice('openclaw:'.length)
    : PLATFORM_LABELS[channel.type] || channel.type;

  const updateChannel = useCallback(async (patch: Partial<ChannelConfig>) => {
    const updatedChannels = (agent.channels ?? []).map(ch =>
      ch.id === channel.id ? { ...ch, ...patch } : ch,
    );
    await patchAgentConfig(agent.id, { channels: updatedChannels });
    if (isMountedRef.current) onChanged();
  }, [agent, channel.id, onChanged]);

  const handleTokenChange = useCallback((token: string) => {
    void updateChannel({ botToken: token });
  }, [updateChannel]);

  const handleFeishuAppIdChange = useCallback((value: string) => {
    void updateChannel({ feishuAppId: value });
  }, [updateChannel]);

  const handleFeishuAppSecretChange = useCallback((value: string) => {
    void updateChannel({ feishuAppSecret: value });
  }, [updateChannel]);

  const handleDingtalkClientIdChange = useCallback((value: string) => {
    void updateChannel({ dingtalkClientId: value });
  }, [updateChannel]);

  const handleDingtalkClientSecretChange = useCallback((value: string) => {
    void updateChannel({ dingtalkClientSecret: value });
  }, [updateChannel]);

  const handleNameChange = useCallback((name: string) => {
    void updateChannel({ name });
  }, [updateChannel]);

  // Stop the running channel process (safe to call even if not running)
  const stopRunningChannel = useCallback(async () => {
    try {
      await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId: channel.id });
    } catch {
      // Channel may not be running — ignore
    }
  }, [agent.id, channel.id]);

  const handleToggleEnabled = useCallback(async () => {
    // When disabling, stop the running channel first
    if (channel.enabled) {
      await stopRunningChannel();
    }
    await updateChannel({ enabled: !channel.enabled });
  }, [channel.enabled, updateChannel, stopRunningChannel]);

  const handleRemoveChannel = useCallback(async () => {
    // Stop running channel before removing from config
    await stopRunningChannel();
    const updatedChannels = (agent.channels ?? []).filter(ch => ch.id !== channel.id);
    await patchAgentConfig(agent.id, { channels: updatedChannels });
    if (isMountedRef.current) {
      onChanged();
      onBack();
    }
  }, [agent, channel.id, onChanged, onBack, stopRunningChannel]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <button
          className="flex items-center gap-1 text-xs text-[var(--ink-subtle)] hover:text-[var(--ink-muted)] transition-colors"
          onClick={onBack}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          返回
        </button>
        <span className="text-sm font-semibold text-[var(--ink)]">
          {channel.name || platformLabel}
        </span>
        <span className="rounded px-1.5 py-0.5 text-[10px] bg-[var(--paper-inset)] text-[var(--ink-muted)]">
          {platformLabel}
        </span>
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[var(--ink-muted)]">名称</label>
        <input
          className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={channel.name || ''}
          onChange={e => handleNameChange(e.target.value)}
          placeholder={platformLabel}
        />
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-[var(--ink-muted)]">启用</span>
        <button
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            channel.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
          }`}
          onClick={handleToggleEnabled}
        >
          <span
            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
              channel.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Platform-specific credentials */}
      {channel.type === 'telegram' && (
        <BotTokenInput
          value={channel.botToken || ''}
          onChange={handleTokenChange}
          verifyStatus="idle"
        />
      )}
      {channel.type === 'feishu' && (
        <FeishuCredentialInput
          appId={channel.feishuAppId || ''}
          appSecret={channel.feishuAppSecret || ''}
          onAppIdChange={handleFeishuAppIdChange}
          onAppSecretChange={handleFeishuAppSecretChange}
          verifyStatus="idle"
        />
      )}
      {channel.type === 'dingtalk' && (
        <DingtalkCredentialInput
          clientId={channel.dingtalkClientId || ''}
          clientSecret={channel.dingtalkClientSecret || ''}
          onClientIdChange={handleDingtalkClientIdChange}
          onClientSecretChange={handleDingtalkClientSecretChange}
          verifyStatus="idle"
        />
      )}

      {/* Danger zone */}
      <div className="border-t border-[var(--line)] pt-4">
        <button
          className="rounded-lg border border-[var(--error)]/40 px-4 py-2 text-xs font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)]/10"
          onClick={handleRemoveChannel}
        >
          删除渠道
        </button>
      </div>
    </div>
  );
}
