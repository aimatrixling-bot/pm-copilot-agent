// Agent tools section — MCP server toggles wrapping McpToolsCard
import { useState, useCallback, useEffect } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { getAllMcpServers, getEnabledMcpServerIds } from '@/config/configService';
import type { McpServerDefinition } from '@/config/types';
import McpToolsCard from '../../ImSettings/components/McpToolsCard';

interface AgentToolsSectionProps {
  agent: AgentConfig;
  onAgentChanged: () => void;
}

export default function AgentToolsSection({ agent, onAgentChanged }: AgentToolsSectionProps) {
  const [allServers, setAllServers] = useState<McpServerDefinition[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState<string[]>([]);

  useEffect(() => {
    void (async () => {
      const [servers, enabled] = await Promise.all([
        getAllMcpServers(),
        getEnabledMcpServerIds(),
      ]);
      setAllServers(servers);
      setGlobalEnabled(enabled);
    })();
  }, []);

  // Only show globally-enabled MCP servers
  const availableServers = allServers.filter(s => globalEnabled.includes(s.id));

  const handleToggle = useCallback(async (serverId: string) => {
    const current = agent.mcpEnabledServers || [];
    const newEnabled = current.includes(serverId)
      ? current.filter(id => id !== serverId)
      : [...current, serverId];
    await patchAgentConfig(agent.id, { mcpEnabledServers: newEnabled });
    onAgentChanged();
  }, [agent.id, agent.mcpEnabledServers, onAgentChanged]);

  return (
    <McpToolsCard
      availableMcpServers={availableServers}
      enabledServerIds={agent.mcpEnabledServers || []}
      onToggle={handleToggle}
    />
  );
}
