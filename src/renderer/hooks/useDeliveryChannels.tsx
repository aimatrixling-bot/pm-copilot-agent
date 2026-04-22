// Hook: Build delivery channel options for cron task UI
// Groups channels by current workspace vs other workspaces

import { useCallback, useMemo } from 'react';
import { useAgentStatuses } from './useAgentStatuses';
import { useConfig } from './useConfig';
import type { SelectOption } from '@/components/CustomSelect';
import type { CronDelivery } from '@/types/cronTask';
import { getChannelTypeLabel } from '@/utils/taskCenterUtils';

/** Sentinel value: Rust deliver_cron_result_to_bot uses the bot's router to auto-determine chat target */
const AUTO_CHAT_ID = '_auto_';

export interface DeliveryChannelInfo {
  botId: string;
  chatId: string;
  platform: string;
  name: string;
  agentName: string;
  status: string;
}

/**
 * Derive the best display name for a channel bot.
 * Priority: botUsername (runtime) > name (config, skip npm specs) > platform label + " Bot"
 */
function deriveBotDisplayName(ch: { name?: string; botUsername?: string; channelType: string }): string {
  // 1. Runtime bot name from verify_connection() — most accurate (skip npm specs)
  if (ch.botUsername && !ch.botUsername.includes('/')) return ch.botUsername;
  // 2. Config name, but skip npm package specs (contain "/")
  if (ch.name && !ch.name.includes('/')) return ch.name;
  // 3. Fallback: platform label
  return getChannelTypeLabel(ch.channelType) + ' Bot';
}

/**
 * Build grouped SelectOption[] for delivery channel picker.
 *
 * Section headers use Project display name (matching Agent card list).
 * Channel labels use runtime bot name with platform tag.
 * Lists are sorted by agentId + channelId for stable ordering.
 */
export function useDeliveryChannels(currentWorkspacePath?: string) {
  const { statuses, loading } = useAgentStatuses();
  const { config, projects } = useConfig();
  const agents = useMemo(() => config.agents ?? [], [config.agents]);

  const { options, channelMap } = useMemo(() => {
    const map = new Map<string, DeliveryChannelInfo>();
    const result: SelectOption[] = [
      { value: '', label: '桌面通知（默认）' },
    ];

    // Build agentId → Project display name mapping (matches Agent card list logic)
    const agentDisplayNames = new Map<string, string>();
    const wsToAgent = new Map<string, string>();
    for (const a of agents) {
      wsToAgent.set(a.workspacePath, a.id);
      // Find corresponding Project for display name (same logic as AgentCardList/AgentSettingsPanel)
      const proj = projects.find(p => p.agentId === a.id);
      const displayName = proj?.displayName || proj?.name || a.workspacePath.split('/').pop() || a.id;
      agentDisplayNames.set(a.id, displayName);
    }

    const currentAgentId = currentWorkspacePath ? wsToAgent.get(currentWorkspacePath) : undefined;

    interface ChannelGroup {
      agentId: string;
      displayName: string;
      channels: SelectOption[];
    }

    const currentGroup: ChannelGroup = { agentId: '', displayName: '', channels: [] };
    const otherGroups: ChannelGroup[] = [];

    // Collect entries and sort by agentId for stable ordering
    const sortedEntries = Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b));

    for (const [agentKey, agentStatus] of sortedEntries) {
      if (!agentStatus.enabled || agentStatus.channels.length === 0) continue;

      const agentId = agentStatus.agentId || agentKey;
      const displayName = agentDisplayNames.get(agentId) || agentStatus.agentName || agentKey;
      const isCurrent = agentId === currentAgentId;

      // Sort channels by channelId for stable ordering
      const sortedChannels = [...agentStatus.channels].sort((a, b) => a.channelId.localeCompare(b.channelId));

      const channelOptions: SelectOption[] = [];
      for (const ch of sortedChannels) {
        const botName = deriveBotDisplayName(ch);
        const platformTag = getChannelTypeLabel(ch.channelType);
        const statusText = ch.status === 'online' ? '在线' : ch.status === 'connecting' ? '连接中' : ch.status === 'error' ? '异常' : '离线';
        const statusColor = ch.status === 'online' ? 'text-[var(--success)]' : 'text-[var(--ink-muted)]';

        map.set(ch.channelId, {
          botId: ch.channelId,
          chatId: AUTO_CHAT_ID,
          platform: ch.channelType,
          name: botName,
          agentName: displayName,
          status: ch.status,
        });

        channelOptions.push({
          value: ch.channelId,
          label: `${botName} (${platformTag})`,
          suffix: <span className={`text-[10px] ${statusColor}`}>{statusText}</span>,
        });
      }

      if (isCurrent) {
        currentGroup.agentId = agentId;
        currentGroup.displayName = displayName;
        currentGroup.channels = channelOptions;
      } else if (channelOptions.length > 0) {
        otherGroups.push({ agentId, displayName, channels: channelOptions });
      }
    }

    // Add current workspace channels first
    if (currentGroup.channels.length > 0) {
      result.push({ value: '__sep_current__', label: currentGroup.displayName, isSeparator: true });
      result.push(...currentGroup.channels);
    }

    // Add other workspace channels (already sorted by agentId via sortedEntries)
    for (const group of otherGroups) {
      result.push({ value: `__sep_${group.agentId}__`, label: group.displayName, isSeparator: true });
      result.push(...group.channels);
    }

    return { options: result, channelMap: map };
  }, [statuses, agents, projects, currentWorkspacePath]);

  const hasChannels = options.length > 1; // More than just "桌面通知"

  /** Resolve a botId to CronDelivery (for creating/updating tasks) */
  const resolveDelivery = useCallback((botId: string): CronDelivery | undefined => {
    const info = channelMap.get(botId);
    if (!info) return undefined;
    return { botId: info.botId, chatId: info.chatId, platform: info.platform };
  }, [channelMap]);

  /** Get display info for a delivery target (for read-only display) */
  const getChannelInfo = useCallback((botId: string): DeliveryChannelInfo | undefined => {
    return channelMap.get(botId);
  }, [channelMap]);

  return { options, hasChannels, loading, resolveDelivery, getChannelInfo };
}
