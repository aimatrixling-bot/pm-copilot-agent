// Shown when a workspace is not yet an Agent — explains benefits + upgrade button
import { useCallback, useEffect, useRef } from 'react';
import { HeartPulse } from 'lucide-react';
import { useConfig } from '@/hooks/useConfig';
import type { AgentConfig } from '../../../shared/types/agent';
import { addAgentConfig } from '@/config/services/agentConfigService';

interface AgentUpgradePromptProps {
  projectId: string;
  workspacePath: string;
  onUpgraded?: (agentId: string) => void;
}

export default function AgentUpgradePrompt({ projectId, workspacePath, onUpgraded }: AgentUpgradePromptProps) {
  const { config, projects, patchProject, refreshConfig } = useConfig();
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const handleUpgrade = useCallback(async () => {
    try {
      const project = projects.find(p => p.id === projectId);
      const agentConfig: AgentConfig = {
        id: crypto.randomUUID(),
        name: project?.displayName || project?.name || workspacePath.split('/').pop() || 'Agent',
        enabled: true,
        workspacePath,
        providerId: project?.providerId ?? undefined,
        model: project?.model ?? undefined,
        permissionMode: project?.permissionMode || config.defaultPermissionMode || 'plan',
        mcpEnabledServers: project?.mcpEnabledServers,
        channels: [],
      };

      // Persist agent config via TypeScript service (maintains imBotConfigs shim)
      await addAgentConfig(agentConfig);

      // Mark project as agent
      await patchProject(projectId, { isAgent: true, agentId: agentConfig.id });
      await refreshConfig();

      if (isMountedRef.current) onUpgraded?.(agentConfig.id);
    } catch (e) {
      console.error('[AgentUpgradePrompt] Upgrade failed:', e);
    }
  }, [projectId, workspacePath, config, projects, patchProject, refreshConfig, onUpgraded]);

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12">
      <HeartPulse className="h-10 w-10 text-[var(--heartbeat)]" />
      <h2 className="text-lg font-semibold text-[var(--ink)]">
        升级为 Agent
      </h2>
      <p className="max-w-md text-center text-sm text-[var(--ink-muted)]">
        升级后可通过飞书、钉钉、Telegram 等渠道远程操控 PM Agent——不在电脑前也能发起任务、接收确认通知、同步项目状态。
      </p>
      <ul className="max-w-md text-sm text-[var(--ink-muted)]">
        <li className="mb-1">• 远程发起 PRD 评审、竞品分析等 PM 任务</li>
        <li className="mb-1">• 跨渠道共享工作区、MCP 工具和知识库</li>
        <li className="mb-1">• 接收 Agent 决策确认和产出完成通知</li>
        <li>• 统一的定时任务和心跳管理</li>
      </ul>
      <button
        className="rounded-lg bg-[var(--button-primary-bg)] px-6 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        onClick={handleUpgrade}
      >
        升级为 Agent
      </button>
    </div>
  );
}
