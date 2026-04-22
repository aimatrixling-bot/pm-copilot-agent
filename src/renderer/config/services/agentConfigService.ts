// Agent config service — CRUD helpers, migration from ImBotConfigs
import type { AppConfig, Project } from '../types';
import { getEffectiveModelAliases } from '../types';
import type { AgentConfig, ChannelConfig, ChannelOverrides } from '../../../shared/types/agent';
import type { ImBotConfig } from '../../../shared/types/im';
import { atomicModifyConfig, loadAppConfig } from './appConfigService';

// ============= Query Helpers =============

export function getAgentById(config: AppConfig, agentId: string): AgentConfig | undefined {
  return config.agents?.find(a => a.id === agentId);
}

export function getChannelById(agent: AgentConfig, channelId: string): ChannelConfig | undefined {
  return agent.channels?.find(c => c.id === channelId);
}

export function getAgentByWorkspacePath(config: AppConfig, workspacePath: string): AgentConfig | undefined {
  const normalized = workspacePath.replace(/\\/g, '/');
  return config.agents?.find(a => a.workspacePath.replace(/\\/g, '/') === normalized);
}

// ============= Migration: ImBotConfigs → Agents =============

let _agentMigrationDone = false;

/**
 * Migrate legacy imBotConfigs[] to agents[].
 * Trigger: imBotConfigs has entries AND agents is empty/absent.
 * Groups bots by defaultWorkspacePath → same workspace bots become channels of one agent.
 */
export function migrateImBotConfigsToAgents(config: AppConfig, projects: Project[]): AppConfig {
  if (_agentMigrationDone) return config;

  const bots = config.imBotConfigs;
  if (!bots || bots.length === 0) return config;
  if (config.agents && config.agents.length > 0) return config;

  _agentMigrationDone = true;
  console.log(`[agentConfigService] Migrating ${bots.length} ImBotConfig(s) to Agent architecture`);

  // Group bots by workspace path
  const groups = new Map<string, ImBotConfig[]>();
  for (const bot of bots) {
    const key = (bot.defaultWorkspacePath || '__default__').replace(/\\/g, '/');
    const group = groups.get(key) || [];
    group.push(bot);
    groups.set(key, group);
  }

  const agents: AgentConfig[] = [];

  for (const [workspacePath, groupBots] of groups) {
    const primary = groupBots[0];
    const agentId = crypto.randomUUID();
    const resolvedPath = workspacePath === '__default__' ? '' : workspacePath;

    // Build channels from each bot
    const channels: ChannelConfig[] = groupBots.map(bot => {
      // Detect overrides: if bot's AI config differs from primary, store in overrides
      const overrides: ChannelOverrides = {};
      let hasOverrides = false;

      if (bot.providerId !== primary.providerId && bot.providerId !== undefined) {
        overrides.providerId = bot.providerId;
        hasOverrides = true;
      }
      if (bot.providerEnvJson !== primary.providerEnvJson && bot.providerEnvJson !== undefined) {
        overrides.providerEnvJson = bot.providerEnvJson;
        hasOverrides = true;
      }
      if (bot.model !== primary.model && bot.model !== undefined) {
        overrides.model = bot.model;
        hasOverrides = true;
      }
      if (bot.permissionMode !== primary.permissionMode) {
        overrides.permissionMode = bot.permissionMode;
        hasOverrides = true;
      }
      if (bot.groupToolsDeny && bot.groupToolsDeny.length > 0) {
        overrides.toolsDeny = bot.groupToolsDeny;
        hasOverrides = true;
      }

      return {
        id: bot.id, // Reuse bot ID as channel ID for continuity
        type: bot.platform,
        name: bot.name,
        enabled: bot.enabled,
        botToken: bot.botToken || undefined,
        telegramUseDraft: bot.telegramUseDraft,
        feishuAppId: bot.feishuAppId,
        feishuAppSecret: bot.feishuAppSecret,
        dingtalkClientId: bot.dingtalkClientId,
        dingtalkClientSecret: bot.dingtalkClientSecret,
        dingtalkUseAiCard: bot.dingtalkUseAiCard,
        dingtalkCardTemplateId: bot.dingtalkCardTemplateId,
        openclawPluginId: bot.openclawPluginId,
        openclawNpmSpec: bot.openclawNpmSpec,
        openclawPluginConfig: bot.openclawPluginConfig,
        openclawManifest: bot.openclawManifest,
        allowedUsers: bot.allowedUsers,
        groupPermissions: bot.groupPermissions,
        groupActivation: bot.groupActivation,
        overrides: hasOverrides ? overrides : undefined,
        setupCompleted: bot.setupCompleted,
      } satisfies ChannelConfig;
    });

    const agent: AgentConfig = {
      id: agentId,
      name: primary.name || `Agent (${resolvedPath.split('/').pop() || 'default'})`,
      enabled: groupBots.some(b => b.enabled),
      workspacePath: resolvedPath,
      providerId: primary.providerId,
      model: primary.model,
      providerEnvJson: primary.providerEnvJson,
      permissionMode: primary.permissionMode,
      mcpEnabledServers: primary.mcpEnabledServers,
      heartbeat: primary.heartbeat,
      channels,
      setupCompleted: primary.setupCompleted,
    };

    agents.push(agent);

    // Mark corresponding project as agent
    const normalizedAgentPath = resolvedPath.replace(/\\/g, '/');
    const project = projects.find(p => p.path.replace(/\\/g, '/') === normalizedAgentPath);
    if (project) {
      project.isAgent = true;
      project.agentId = agentId;
    }
  }

  config.agents = agents;
  // Keep imBotConfigs as empty array to prevent re-migration
  config.imBotConfigs = [];

  console.log(`[agentConfigService] Migration complete: ${agents.length} agent(s) with ${bots.length} channel(s) total`);
  return config;
}

// ============= BasicAgent Auto-Creation (v0.1.49) =============

/**
 * Ensure every Project has a linked AgentConfig (basicAgent).
 * Runs at startup after migrateImBotConfigsToAgents().
 *
 * - Projects without agentId → create basicAgent with AI fields copied from Project
 * - Projects with agentId but orphaned (agent deleted) → recreate basicAgent
 * - Projects already linked to a valid agent → skip
 *
 * Returns { changed } so caller can decide whether to persist.
 */
export function ensureAllProjectsHaveAgent(
  config: AppConfig,
  projects: Project[],
  defaultPermissionMode?: string,
): { changed: boolean } {
  const agents = config.agents ?? [];
  const agentMap = new Map(agents.map(a => [a.id, a]));
  let changed = false;
  let createdCount = 0;

  for (const project of projects) {
    // Skip if already linked to a valid agent
    if (project.agentId && agentMap.has(project.agentId)) {
      continue;
    }

    // Also check by workspacePath (agent exists but project.agentId is stale/missing)
    const normalized = project.path.replace(/\\/g, '/');
    const existingByPath = agents.find(a => a.workspacePath.replace(/\\/g, '/') === normalized);
    if (existingByPath) {
      // Fix orphaned reference
      project.agentId = existingByPath.id;
      changed = true;
      continue;
    }

    // Create basicAgent — AI fields from Project (fallback to defaults)
    const agentId = crypto.randomUUID();
    const basicAgent: AgentConfig = {
      id: agentId,
      name: project.displayName || project.name,
      workspacePath: project.path,
      enabled: false,
      channels: [],
      providerId: project.providerId ?? undefined,
      model: project.model ?? undefined,
      permissionMode: project.permissionMode || defaultPermissionMode || 'plan',
      mcpEnabledServers: project.mcpEnabledServers,
    };

    agents.push(basicAgent);
    agentMap.set(agentId, basicAgent);
    project.agentId = agentId;
    changed = true;
    createdCount++;
  }

  if (changed) {
    config.agents = agents;
    console.log(`[agentConfigService] ensureAllProjectsHaveAgent: created ${createdCount} basicAgent(s), total agents: ${agents.length}`);
  }

  return { changed };
}

// ============= Persistence Helpers =============

/**
 * Save agents to disk (atomic read-modify-write).
 */
export async function persistAgents(agents: AgentConfig[]): Promise<void> {
  await atomicModifyConfig(config => ({
    ...config,
    agents,
  }));
}

/**
 * Patch a single agent's config (atomic read-modify-write).
 * After disk write, hot-reloads runtime state of running agent instances via Tauri command.
 */
export async function patchAgentConfig(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
): Promise<AgentConfig | undefined> {
  let updated: AgentConfig | undefined;

  // If mcpEnabledServers changed, resolve mcpServersJson before disk write
  // so both fields are persisted atomically in a single transaction
  let resolvedMcpJson: string | undefined;
  if ('mcpEnabledServers' in patch) {
    try {
      const { getAllMcpServers, getEnabledMcpServerIds } = await import('@/config/configService');
      const allServers = await getAllMcpServers();
      const globalEnabled = await getEnabledMcpServerIds();
      const agentMcpIds = patch.mcpEnabledServers ?? [];
      const enabledMcpDefs = allServers.filter(
        s => globalEnabled.includes(s.id) && agentMcpIds.includes(s.id),
      );
      resolvedMcpJson = enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : undefined;
    } catch (e) {
      console.warn('[agentConfigService] Failed to resolve MCP servers:', e);
    }
  }

  // If providerId changed but providerEnvJson was NOT explicitly provided,
  // auto-resolve from provider registry + stored API keys.
  // This is the "pit of success" pattern: callers only need to set providerId,
  // credentials are resolved centrally so IM Bot / CronTask always get correct provider env.
  let resolvedProviderEnvJson: string | undefined | null;
  let shouldUpdateProviderEnv = false;
  if ('providerId' in patch && !('providerEnvJson' in patch)) {
    shouldUpdateProviderEnv = true;
    try {
      const { getAllProviders, loadApiKeys } = await import('./providerService');
      const [allProviders, apiKeys] = await Promise.all([getAllProviders(), loadApiKeys()]);
      const provider = allProviders.find(p => p.id === patch.providerId);
      if (provider && provider.type !== 'subscription') {
        // Load config to get user's providerModelAliases overrides
        const latestConfig = await loadAppConfig();
        const aliases = getEffectiveModelAliases(provider, latestConfig.providerModelAliases);
        resolvedProviderEnvJson = JSON.stringify({
          baseUrl: provider.config.baseUrl,
          apiKey: apiKeys[provider.id],
          authType: provider.authType,
          apiProtocol: provider.apiProtocol,
          maxOutputTokens: provider.maxOutputTokens,
          maxOutputTokensParamName: provider.maxOutputTokensParamName,
          upstreamFormat: provider.upstreamFormat,
          ...(aliases ? { modelAliases: aliases } : {}),
        });
      } else {
        // Subscription provider (e.g. Anthropic) or unknown — clear providerEnvJson
        resolvedProviderEnvJson = undefined;
      }
    } catch (e) {
      console.warn('[agentConfigService] Failed to resolve provider env:', e);
      shouldUpdateProviderEnv = false;
    }
  }

  await atomicModifyConfig(config => {
    const agents = [...(config.agents || [])];
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx < 0) return config;
    agents[idx] = {
      ...agents[idx],
      ...patch,
      id: agentId,
      // Persist resolved MCP JSON alongside mcpEnabledServers
      ...(resolvedMcpJson !== undefined || 'mcpEnabledServers' in patch
        ? { mcpServersJson: resolvedMcpJson }
        : {}),
      // Persist resolved provider env alongside providerId
      ...(shouldUpdateProviderEnv
        ? { providerEnvJson: resolvedProviderEnvJson ?? undefined }
        : {}),
    };
    updated = agents[idx];
    return {
      ...config,
      agents,
    };
  });

  // Hot-reload runtime state if any runtime-sensitive field changed
  if (updated) {
    // If providerEnvJson was auto-resolved (not in original patch), inject it
    // so syncAgentRuntime pushes the new credentials to the running agent
    const effectivePatch = shouldUpdateProviderEnv
      ? { ...patch, providerEnvJson: resolvedProviderEnvJson ?? undefined }
      : patch;
    await syncAgentRuntime(agentId, effectivePatch, updated, resolvedMcpJson);
  }

  return updated;
}

/**
 * Sync runtime-sensitive fields to running agent instance via Tauri command.
 * Only sends fields that are present in the patch (i.e. actually changed).
 */
async function syncAgentRuntime(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  _updatedAgent: AgentConfig,
  preResolvedMcpJson?: string,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  // Build a runtime patch with only the fields that changed
  const runtimePatch: Record<string, unknown> = {};
  let hasRuntimeChanges = false;

  if ('model' in patch) {
    runtimePatch.model = patch.model ?? null;
    hasRuntimeChanges = true;
  }
  if ('providerEnvJson' in patch) {
    runtimePatch.providerEnvJson = patch.providerEnvJson ?? null;
    hasRuntimeChanges = true;
  }
  if ('permissionMode' in patch) {
    runtimePatch.permissionMode = patch.permissionMode ?? null;
    hasRuntimeChanges = true;
  }
  if ('heartbeat' in patch) {
    runtimePatch.heartbeatConfigJson = patch.heartbeat ? JSON.stringify(patch.heartbeat) : null;
    hasRuntimeChanges = true;
  }
  if ('memoryAutoUpdate' in patch) {
    runtimePatch.memoryAutoUpdateConfigJson = patch.memoryAutoUpdate ? JSON.stringify(patch.memoryAutoUpdate) : null;
    hasRuntimeChanges = true;
  }

  // mcpEnabledServers changed → use pre-resolved JSON (already persisted to disk atomically)
  if ('mcpEnabledServers' in patch) {
    runtimePatch.mcpServersJson = preResolvedMcpJson ?? null;
    hasRuntimeChanges = true;
  }
  // channels changed → forward to Rust for per-channel hot-reload (groupActivation etc.)
  if ('channels' in patch && patch.channels) {
    runtimePatch.channels = patch.channels;
    hasRuntimeChanges = true;
  }

  if (!hasRuntimeChanges) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_update_agent_config', { agentId, patch: runtimePatch });
  } catch (e) {
    // Agent may not be running — that's fine, config is already persisted to disk
    console.debug('[agentConfigService] Runtime sync skipped (agent not running?):', e);
  }
}

/**
 * Add a new agent config to disk.
 */
export async function addAgentConfig(agent: AgentConfig): Promise<void> {
  await atomicModifyConfig(config => {
    const agents = [...(config.agents || []), agent];
    return {
      ...config,
      agents,
    };
  });
}

/**
 * Remove an agent config from disk.
 */
export async function removeAgentConfig(agentId: string): Promise<void> {
  await atomicModifyConfig(config => {
    const agents = (config.agents || []).filter(a => a.id !== agentId);
    return {
      ...config,
      agents,
    };
  });
}

// ============= Runtime Helpers =============

/**
 * Start an agent channel via Tauri command.
 * Resolves MCP server definitions and effective config (agent + channel overrides).
 */
export async function invokeStartAgentChannel(
  agent: AgentConfig,
  channel: ChannelConfig,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const { getAllMcpServers, getEnabledMcpServerIds } = await import('@/config/configService');
  const { resolveEffectiveConfig } = await import('../../../shared/types/agent');

  // Resolve MCP server definitions
  const allServers = await getAllMcpServers();
  const globalEnabled = await getEnabledMcpServerIds();
  const agentMcpIds = agent.mcpEnabledServers ?? [];
  const enabledMcpDefs = allServers.filter(
    s => globalEnabled.includes(s.id) && agentMcpIds.includes(s.id),
  );

  // Resolve effective config (agent defaults + channel overrides)
  const effective = resolveEffectiveConfig(agent, channel);

  await invoke('cmd_start_agent_channel', {
    agentId: agent.id,
    channelId: channel.id,
    agentConfig: {
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      workspacePath: agent.workspacePath,
      providerId: effective.providerId,
      model: effective.model,
      providerEnvJson: effective.providerEnvJson,
      permissionMode: effective.permissionMode,
      mcpEnabledServers: agent.mcpEnabledServers,
      mcpServersJson: enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null,
      heartbeat: agent.heartbeat,
      memoryAutoUpdate: agent.memoryAutoUpdate,
      channels: [],
      lastActiveChannel: agent.lastActiveChannel,
    },
    channelConfig: {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      botToken: channel.botToken,
      telegramUseDraft: channel.telegramUseDraft,
      feishuAppId: channel.feishuAppId,
      feishuAppSecret: channel.feishuAppSecret,
      dingtalkClientId: channel.dingtalkClientId,
      dingtalkClientSecret: channel.dingtalkClientSecret,
      dingtalkUseAiCard: channel.dingtalkUseAiCard,
      dingtalkCardTemplateId: channel.dingtalkCardTemplateId,
      openclawPluginId: channel.openclawPluginId,
      openclawNpmSpec: channel.openclawNpmSpec,
      openclawPluginConfig: channel.openclawPluginConfig,
      openclawManifest: channel.openclawManifest,
      openclawEnabledToolGroups: channel.openclawEnabledToolGroups,
      allowedUsers: channel.allowedUsers || [],
      groupPermissions: channel.groupPermissions || [],
      groupActivation: channel.groupActivation,
      overrides: channel.overrides,
      setupCompleted: channel.setupCompleted,
    },
  });
}
