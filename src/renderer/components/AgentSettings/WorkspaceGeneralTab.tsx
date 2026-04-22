// WorkspaceGeneralTab — the "通用" tab in WorkspaceConfigPanel
// Flat layout: section titles + dividers, no outer card borders

import { useState, useCallback, useEffect, useRef } from 'react';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import { useAgentStatuses } from '@/hooks/useAgentStatuses';
import { isTauriEnvironment } from '@/utils/browserMock';
import { getAgentById, addAgentConfig, patchAgentConfig, invokeStartAgentChannel } from '@/config/services/agentConfigService';
import type { AgentConfig } from '../../../shared/types/agent';
import { DEFAULT_HEARTBEAT_CONFIG } from '../../../shared/types/im';
import WorkspaceBasicsSection from './WorkspaceBasicsSection';
import AgentChannelsSection from './sections/AgentChannelsSection';
import AgentHeartbeatSection from './sections/AgentHeartbeatSection';
import AgentMemoryUpdateSection from './sections/AgentMemoryUpdateSection';
import AgentTasksSection from './sections/AgentTasksSection';
import { Settings2, HeartPulse } from 'lucide-react';

interface WorkspaceGeneralTabProps {
  agentDir: string;
}

export default function WorkspaceGeneralTab({ agentDir }: WorkspaceGeneralTabProps) {
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const project = projects.find(p => p.path.replace(/\\/g, '/') === agentDir.replace(/\\/g, '/'));
  const agent = project?.agentId ? getAgentById(config, project.agentId) : undefined;
  const isProactive = !!(project?.isAgent && agent?.enabled);
  const { statuses, refresh: refreshStatuses } = useAgentStatuses(isProactive);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleAgentChanged = useCallback(async () => {
    await refreshConfig();
    await refreshStatuses();
  }, [refreshConfig, refreshStatuses]);

  // Toggle proactive agent mode
  const handleToggleProactive = useCallback(async () => {
    if (!project || toggling) return;
    setToggling(true);
    try {
      if (agent && !agent.enabled) {
        // Upgrade existing basicAgent to proactive mode
        await patchAgentConfig(agent.id, {
          enabled: true,
          heartbeat: agent.heartbeat ?? {
            ...DEFAULT_HEARTBEAT_CONFIG,
            enabled: true,
            activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' },
          },
        });
        if (!project.isAgent) {
          await patchProject(project.id, { isAgent: true });
        }
        toastRef.current.success('主动 Agent 模式已开启');
      } else if (!agent) {
        // Fallback: create AgentConfig if somehow missing (shouldn't happen after migration)
        const newAgent: AgentConfig = {
          id: crypto.randomUUID(),
          name: project.displayName || project.name || agentDir.split('/').pop() || 'Agent',
          icon: project.icon,
          enabled: true,
          workspacePath: agentDir,
          providerId: project.providerId ?? undefined,
          model: project.model ?? undefined,
          permissionMode: project.permissionMode || config.defaultPermissionMode || 'plan',
          mcpEnabledServers: project.mcpEnabledServers,
          channels: [],
          heartbeat: {
            ...DEFAULT_HEARTBEAT_CONFIG,
            enabled: true,
            activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' },
          },
        };
        await addAgentConfig(newAgent);
        await patchProject(project.id, { isAgent: true, agentId: newAgent.id });
        toastRef.current.success('主动 Agent 模式已开启');
      } else if (agent.enabled) {
        // Disable — stop all running channels first
        let stoppedCount = 0;
        if (isTauriEnvironment()) {
          const { invoke } = await import('@tauri-apps/api/core');
          for (const ch of (agent.channels ?? [])) {
            try {
              await invoke('cmd_stop_agent_channel', { agentId: agent.id, channelId: ch.id });
              stoppedCount++;
            } catch { /* channel may not be running */ }
          }
        }
        await patchAgentConfig(agent.id, { enabled: false });
        toastRef.current.success(
          stoppedCount > 0
            ? `主动 Agent 模式已关闭，${stoppedCount} 个渠道已停止`
            : '主动 Agent 模式已关闭',
        );
      } else {
        // Re-enable — auto-restart channels that have credentials (setupCompleted)
        await patchAgentConfig(agent.id, { enabled: true });
        await refreshConfig(); // Refresh first so invokeStartAgentChannel reads latest config
        // Re-read the latest agent config after refresh
        const latestAgent = getAgentById(await (async () => {
          const { loadAppConfig } = await import('@/config/services/appConfigService');
          return loadAppConfig();
        })(), agent.id);
        if (latestAgent && isTauriEnvironment()) {
          const startable = (latestAgent.channels ?? []).filter(ch => ch.enabled && ch.setupCompleted);
          let startedCount = 0;
          for (const ch of startable) {
            try {
              await invokeStartAgentChannel(latestAgent, ch);
              startedCount++;
            } catch (e) {
              console.warn(`[WorkspaceGeneralTab] Auto-start channel ${ch.id} failed:`, e);
            }
          }
          toastRef.current.success(
            startedCount > 0
              ? `主动 Agent 模式已开启，${startedCount} 个渠道已启动`
              : '主动 Agent 模式已开启',
          );
        } else {
          toastRef.current.success('主动 Agent 模式已开启');
        }
        if (isMountedRef.current) await refreshStatuses();
        if (isMountedRef.current) setToggling(false);
        return; // refreshConfig already called above
      }
      await refreshConfig();
      if (isMountedRef.current) await refreshStatuses();
    } catch (e) {
      console.error('[WorkspaceGeneralTab] Toggle proactive failed:', e);
      toastRef.current.error('操作失败');
    } finally {
      if (isMountedRef.current) setToggling(false);
    }
  }, [project, agent, agentDir, config.defaultPermissionMode, toggling, patchProject, refreshConfig, refreshStatuses]);

  const status = agent ? statuses[agent.id] : undefined;

  if (!project) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="text-sm text-[var(--ink-subtle)]">未找到工作区配置</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="mx-auto max-w-2xl space-y-6 pb-8">
        {/* Card 1: 基础设置 */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
            <Settings2 className="h-[18px] w-[18px] text-[var(--ink-muted)]" />
            基础设置
          </h3>
          <div className="mt-4">
            <WorkspaceBasicsSection project={project} agent={agent} agentDir={agentDir} />
          </div>
        </div>

        {/* Card 2: 主动 Agent 模式 */}
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <div className="flex items-center justify-between">
            <div className="flex-1 pr-4">
              <h3 className="flex items-center gap-2 text-base font-medium text-[var(--ink)]">
                <HeartPulse className="h-[18px] w-[18px] text-[var(--heartbeat)]" />
                主动 Agent 模式
              </h3>
              <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                启用后让 AI 具备 24 小时感知与行动能力、可添加聊天机器人（如飞书、钉钉）主动与你互动
              </p>
            </div>
            <button
              className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                toggling ? 'cursor-wait opacity-50' : 'cursor-pointer'
              } ${
                isProactive ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
              }`}
              onClick={handleToggleProactive}
              disabled={toggling}
            >
              <span
                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                  isProactive ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Sub-sections: Channels / Heartbeat / Tasks */}
          {isProactive && agent && (
            <>
              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentChannelsSection agent={agent} status={status} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentHeartbeatSection agent={agent} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentMemoryUpdateSection agent={agent} onAgentChanged={handleAgentChanged} />
              </div>

              <div className="mt-6 border-t border-[var(--line)] pt-5">
                <AgentTasksSection agent={agent} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
