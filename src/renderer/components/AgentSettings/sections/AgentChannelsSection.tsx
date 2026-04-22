// Agent channels section: list channels, add/remove, start/stop, configure
// All channel operations open in a unified overlay panel (same size as WorkspaceConfigPanel)
import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import type { AgentConfig, ChannelConfig, ChannelType } from '../../../../shared/types/agent';
import type { AgentStatusData, ChannelStatusData } from '@/hooks/useAgentStatuses';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { invokeStartAgentChannel } from '@/config/services/agentConfigService';
import ChannelPlatformSelect from '../channels/ChannelPlatformSelect';
import ChannelWizard from '../channels/ChannelWizard';
import ChannelDetailView from '../channels/ChannelDetailView';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import feishuIcon from '../../ImSettings/assets/feishu.jpeg';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';
import { findPromotedByPlatform } from '../../ImSettings/promotedPlugins';

interface AgentChannelsSectionProps {
  agent: AgentConfig;
  status?: AgentStatusData;
  onAgentChanged: () => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function getPlatformLabel(type: string): string {
  if (type.startsWith('openclaw:')) {
    const promoted = findPromotedByPlatform(type);
    if (promoted) return promoted.name;
    return type.slice('openclaw:'.length);
  }
  return PLATFORM_LABELS[type] || type;
}

function getPlatformIcon(type: string) {
  if (type === 'telegram') return <img src={telegramIcon} alt="Telegram" className="h-5 w-5" />;
  if (type === 'feishu') return <img src={feishuIcon} alt="飞书" className="h-5 w-5 rounded" />;
  if (type === 'dingtalk') return <img src={dingtalkIcon} alt="钉钉" className="h-5 w-5 rounded" />;
  const promoted = findPromotedByPlatform(type);
  if (promoted) return <img src={promoted.icon} alt={promoted.name} className="h-5 w-5 rounded" />;
  return <span className="text-base">💬</span>;
}

function getChannelStatus(status: AgentStatusData | undefined, channelId: string): ChannelStatusData | undefined {
  return status?.channels.find(ch => ch.channelId === channelId);
}

// Overlay state machine
type OverlayState =
  | null
  | { view: 'add'; platform?: ChannelType }
  | { view: 'detail'; channelId: string };

export default function AgentChannelsSection({ agent, status, onAgentChanged }: AgentChannelsSectionProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleStartChannel = useCallback(async (channel: ChannelConfig) => {
    setLoading(channel.id);
    try {
      await invokeStartAgentChannel(agent, channel);
      onAgentChanged();
    } catch (e) {
      console.error('[AgentChannels] Start failed:', e);
    } finally {
      if (isMountedRef.current) setLoading(null);
    }
  }, [agent, onAgentChanged]);

  const handleStopChannel = useCallback(async (channelId: string) => {
    setLoading(channelId);
    try {
      await invoke('cmd_stop_agent_channel', {
        agentId: agent.id,
        channelId,
      });
      onAgentChanged();
    } catch (e) {
      console.error('[AgentChannels] Stop failed:', e);
    } finally {
      if (isMountedRef.current) setLoading(null);
    }
  }, [agent.id, onAgentChanged]);

  // Close overlay and refresh
  const closeOverlay = useCallback(() => {
    setOverlay(null);
    onAgentChanged();
  }, [onAgentChanged]);

  // Platform selected → transition to wizard
  const handlePlatformSelected = useCallback((platform: ChannelType) => {
    setOverlay({ view: 'add', platform });
  }, []);

  // Wizard completed → close overlay
  const handleWizardComplete = useCallback((_channelId: string) => {
    closeOverlay();
  }, [closeOverlay]);

  // Wizard cancelled → go back to platform select
  const handleWizardCancel = useCallback(() => {
    setOverlay({ view: 'add' });
  }, []);

  // Detail back → close overlay
  const handleDetailBack = useCallback(() => {
    closeOverlay();
  }, [closeOverlay]);

  // Render overlay content based on state
  const renderOverlayContent = () => {
    if (!overlay) return null;

    if (overlay.view === 'add' && !overlay.platform) {
      return (
        <ChannelPlatformSelect
          onSelect={handlePlatformSelected}
          onCancel={closeOverlay}
        />
      );
    }

    if (overlay.view === 'add' && overlay.platform) {
      return (
        <ChannelWizard
          agent={agent}
          platform={overlay.platform}
          onComplete={handleWizardComplete}
          onCancel={handleWizardCancel}
        />
      );
    }

    if (overlay.view === 'detail') {
      return (
        <ChannelDetailView
          agent={agent}
          channelId={overlay.channelId}
          onBack={handleDetailBack}
          onChanged={onAgentChanged}
        />
      );
    }

    return null;
  };

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium text-[var(--ink)]">聊天机器人 Channels</h3>
          <button
            className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            onClick={() => setOverlay({ view: 'add' })}
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </button>
        </div>

        {(agent.channels?.length ?? 0) === 0 && (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-6">
            <p className="text-xs text-[var(--ink-subtle)]">
              尚未添加任何 Channel。点击上方「添加」来添加 IM 渠道。
            </p>
          </div>
        )}

        <div className="space-y-2">
          {(agent.channels ?? []).map(channel => {
            const chStatus = getChannelStatus(status, channel.id);
            const isRunning = chStatus?.status === 'online' || chStatus?.status === 'connecting';
            const isLoading = loading === channel.id;

            const displayName = chStatus?.botUsername
              ? (channel.type === 'telegram' ? `@${chStatus.botUsername}` : chStatus.botUsername)
              : (channel.name || getPlatformLabel(channel.type));

            return (
              <div
                key={channel.id}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                onClick={() => setOverlay({ view: 'detail', channelId: channel.id })}
              >
                <span className="flex-shrink-0">{getPlatformIcon(channel.type)}</span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate text-sm font-medium text-[var(--ink)]">
                    {displayName}
                  </span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className={`h-1.5 w-1.5 rounded-full ${
                      isRunning ? 'bg-[var(--success)]' : 'bg-[var(--ink-subtle)]'
                    }`} />
                    <span className={`text-xs ${
                      isRunning ? 'text-[var(--success)]' : 'text-[var(--ink-muted)]'
                    }`}>
                      {isRunning ? '运行中' : '已停止'}
                    </span>
                  </div>
                </div>
                <button
                  className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                    isRunning
                      ? 'border border-[var(--error)]/40 text-[var(--error)] hover:bg-[var(--error)]/10'
                      : 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]'
                  }`}
                  onClick={e => {
                    e.stopPropagation();
                    if (isRunning) { handleStopChannel(channel.id); } else { handleStartChannel(channel); }
                  }}
                  disabled={isLoading || !channel.enabled}
                >
                  {isLoading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isRunning ? '停止' : '启动'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* === Unified Overlay Panel === */}
      {overlay && createPortal(
        <OverlayBackdrop onClose={closeOverlay} className="z-[200]">
          <div
            className="relative flex h-[90vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
          >
            {/* Close button — absolute top-right */}
            <button
              onClick={closeOverlay}
              className="absolute right-4 top-4 z-10 rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <X className="h-5 w-5" />
            </button>

            {/* Overlay content — scrollable, sub-components handle their own headers */}
            <div className="flex-1 overflow-y-auto px-8 py-6">
              <div className="mx-auto max-w-2xl">
                {renderOverlayContent()}
              </div>
            </div>
          </div>
        </OverlayBackdrop>,
        document.body,
      )}
    </>
  );
}
