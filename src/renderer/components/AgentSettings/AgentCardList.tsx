// Agent card list for Settings page — shows all agents with status indicators
import { useMemo } from 'react';
import { useConfig } from '@/hooks/useConfig';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import type { AgentConfig } from '../../../shared/types/agent';
import type { Project } from '@/config/types';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { HeartPulse } from 'lucide-react';
import WorkspaceIcon from '../launcher/WorkspaceIcon';
import { DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import { findPromotedByPlatform } from '../ImSettings/promotedPlugins';

interface AgentCardListProps {
  onSelectAgent: (agentId: string, workspacePath: string) => void;
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'TG',
  feishu: '飞书',
  dingtalk: '钉钉',
};

function getPlatformBadge(type: string): string {
  if (type.startsWith('openclaw:')) {
    const promoted = findPromotedByPlatform(type);
    return promoted?.name || type.slice('openclaw:'.length);
  }
  return PLATFORM_LABELS[type] || type;
}

function getStatusColor(onlineCount: number, totalCount: number, enabled: boolean): string {
  if (!enabled) return 'var(--ink-subtle)';
  if (totalCount === 0) return 'var(--ink-subtle)';
  if (onlineCount === totalCount) return 'var(--success)';
  if (onlineCount > 0) return 'var(--warning)';
  return 'var(--ink-subtle)';
}

export default function AgentCardList({ onSelectAgent }: AgentCardListProps) {
  const { config, providers, projects } = useConfig();
  const { statuses } = useAgentStatuses();

  const agents: AgentConfig[] = useMemo(() => config.agents || [], [config.agents]);

  // Map agentId → Project for reading canonical name/icon from Project
  const projectByAgentId = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) {
      if (p.agentId) map.set(p.agentId, p);
    }
    return map;
  }, [projects]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-xl border border-dashed border-[var(--line)] px-8 py-16">
        <HeartPulse className="h-8 w-8 text-[var(--heartbeat)]" />
        <p className="mt-3 text-sm text-[var(--ink-muted)]">
          尚未创建 Agent。在工作区设置中可以将工作区升级为 Agent。
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {agents.map(agent => {
        const agentStatus = statuses[agent.id];
        const onlineChannels = agentStatus?.channels.filter(ch => ch.status === 'online').length ?? 0;
        const totalChannels = agent.channels?.length ?? 0;
        const statusColor = getStatusColor(onlineChannels, totalChannels, agent.enabled);
        const proj = projectByAgentId.get(agent.id);
        const displayName = proj?.displayName || proj?.name || agent.name;
        const iconId = proj?.icon || agent.icon || DEFAULT_WORKSPACE_ICON;
        const providerName = providers.find(p => p.id === (proj?.providerId ?? agent.providerId))?.name;
        const modelDisplay = proj?.model || agent.model || '默认模型';

        return (
          <button
            key={agent.id}
            className="flex items-start gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
            onClick={() => onSelectAgent(agent.id, agent.workspacePath)}
          >
            {/* Icon + status dot */}
            <div className="relative flex h-8 w-8 shrink-0 items-center justify-center">
              <WorkspaceIcon icon={iconId} size={24} />
              <div
                className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--paper-elevated)]"
                style={{ background: statusColor }}
              />
            </div>

            <div className="min-w-0 flex-1">
              {/* Name + badges */}
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--ink)]">
                  {displayName}
                </span>
                {!agent.enabled && (
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-[var(--paper-inset)] text-[var(--ink-subtle)]">
                    已禁用
                  </span>
                )}
              </div>

              {/* Workspace path */}
              <div className="mt-0.5 truncate text-[11px] text-[var(--ink-subtle)]">
                {shortenPathForDisplay(agent.workspacePath)}
              </div>

              {/* Channel badges */}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(agent.channels ?? []).map(ch => (
                  <span key={ch.id} className="rounded px-1.5 py-0.5 text-[10px] bg-[var(--paper-inset)] text-[var(--ink-muted)]">
                    {getPlatformBadge(ch.type)}
                  </span>
                ))}
              </div>

              {/* Status + model */}
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--ink-subtle)]">
                <span style={{ color: statusColor }}>
                  {onlineChannels > 0 ? `${onlineChannels}/${totalChannels} 在线` : `${totalChannels} 渠道`}
                </span>
                {providerName && (
                  <>
                    <span>·</span>
                    <span className="truncate">{providerName} / {modelDisplay}</span>
                  </>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
