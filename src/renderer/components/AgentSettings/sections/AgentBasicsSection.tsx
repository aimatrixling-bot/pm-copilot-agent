// Agent basics: name, icon, provider+model, permission, enable/disable
import { useState, useCallback, useEffect, useRef } from 'react';
import { useConfig } from '@/hooks/useConfig';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';
import { patchAgentConfig } from '@/config/services/agentConfigService';

interface AgentBasicsSectionProps {
  agent: AgentConfig;
  status?: AgentStatusData;
  onAgentChanged: () => void;
}

export default function AgentBasicsSection({ agent, status, onAgentChanged }: AgentBasicsSectionProps) {
  const { providers } = useConfig();
  const [name, setName] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  const saveField = useCallback(async (patch: Partial<AgentConfig>) => {
    setSaving(true);
    try {
      await patchAgentConfig(agent.id, patch);
      if (isMountedRef.current) onAgentChanged();
    } catch (e) {
      console.error('[AgentBasics] Save failed:', e);
    } finally {
      if (isMountedRef.current) setSaving(false);
    }
  }, [agent.id, onAgentChanged]);

  const handleNameBlur = useCallback(() => {
    if (name !== agent.name && name.trim()) {
      saveField({ name: name.trim() });
    }
  }, [name, agent.name, saveField]);

  const handleToggleEnabled = useCallback(() => {
    saveField({ enabled: !agent.enabled });
  }, [agent.enabled, saveField]);

  const selectedProvider = providers.find(p => p.id === agent.providerId);
  const modelDisplay = agent.model || selectedProvider?.primaryModel || '未设置';

  const hasRunningChannels = status?.channels.some(ch => ch.status === 'online') ?? false;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-[var(--ink)]">基础信息</h3>

      {/* Name */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">名称</label>
        <input
          className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          disabled={saving}
        />
      </div>

      {/* Provider + Model (read-only summary) */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">模型</label>
        <span className="text-sm text-[var(--ink)]">
          {selectedProvider?.name ?? '默认'} / {modelDisplay}
        </span>
      </div>

      {/* Permission Mode */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">权限</label>
        <span className="text-sm text-[var(--ink)]">
          {agent.permissionMode === 'fullAgency' ? '🚀 自主行动' :
           agent.permissionMode === 'auto' ? '⚡ 行动' : '📋 规划'}
        </span>
      </div>

      {/* Enable/Disable */}
      <div className="flex items-center gap-3">
        <label className="w-20 shrink-0 text-xs text-[var(--ink-muted)]">状态</label>
        <button
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            agent.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
          }`}
          onClick={handleToggleEnabled}
          disabled={saving || hasRunningChannels}
        >
          <span
            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
              agent.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
        <span className="text-xs text-[var(--ink-muted)]">
          {agent.enabled ? '已启用' : '已禁用'}
        </span>
        {hasRunningChannels && (
          <span className="text-xs text-[var(--ink-subtle)]">
            有运行中的 Channel，请先停止
          </span>
        )}
      </div>
    </div>
  );
}
