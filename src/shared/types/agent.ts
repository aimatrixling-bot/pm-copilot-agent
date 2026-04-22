// Agent architecture types (v0.1.41)
// Agent = upgraded workspace with pluggable I/O channels

import type {
  ImPlatform,
  HeartbeatConfig,
  MemoryAutoUpdateConfig,
  GroupPermission,
  GroupActivation,
} from './im';
import type { RuntimeType, RuntimeConfig } from './runtime';

/**
 * Channel type — reuses ImPlatform, not redefined
 */
export type ChannelType = ImPlatform;

/**
 * Last active channel tracking for heartbeat/cron routing
 */
export interface LastActiveChannel {
  channelId: string;
  sessionKey: string;
  lastActiveAt: string; // ISO timestamp
}

/**
 * Channel-level config overrides (empty = inherit from Agent)
 */
export interface ChannelOverrides {
  providerId?: string;
  providerEnvJson?: string;
  model?: string;
  permissionMode?: string;
  toolsDeny?: string[];
}

/**
 * Channel configuration — a single I/O endpoint within an Agent
 */
export interface ChannelConfig {
  // Identity
  id: string;
  type: ChannelType;
  name?: string;           // Defaults to platform display name
  enabled: boolean;

  // Platform credentials (vary by type)
  botToken?: string;
  telegramUseDraft?: boolean;

  feishuAppId?: string;
  feishuAppSecret?: string;

  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  dingtalkUseAiCard?: boolean;
  dingtalkCardTemplateId?: string;

  // OpenClaw Plugin
  openclawPluginId?: string;
  openclawNpmSpec?: string;
  openclawPluginConfig?: Record<string, string>;
  openclawManifest?: Record<string, string>;
  /** Enabled tool groups for OpenClaw plugins with tools (e.g. feishu) */
  openclawEnabledToolGroups?: string[];

  // User management
  allowedUsers?: string[];

  // Group chat
  groupPermissions?: GroupPermission[];
  groupActivation?: GroupActivation;

  // Optional overrides (empty/undefined = inherit from Agent)
  overrides?: ChannelOverrides;

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Agent configuration — an upgraded workspace with AI config and channels
 */
export interface AgentConfig {
  // Identity
  id: string;
  name: string;
  icon?: string;           // Phosphor icon ID or emoji
  enabled: boolean;

  // Core: Workspace
  workspacePath: string;

  // AI Configuration (defaults for all channels)
  providerId?: string;
  model?: string;
  providerEnvJson?: string;
  permissionMode: string;  // 'plan' | 'auto' | 'fullAgency'
  mcpEnabledServers?: string[];
  /** Resolved MCP server definitions JSON (persisted for auto-start, rebuilt on manual start) */
  mcpServersJson?: string;

  // Heartbeat (Agent-level, shared across channels)
  heartbeat?: HeartbeatConfig;

  // Memory Auto-Update (v0.1.43)
  memoryAutoUpdate?: MemoryAutoUpdateConfig;

  // Channels
  channels: ChannelConfig[];

  // Active message routing
  lastActiveChannel?: LastActiveChannel;

  // Agent Runtime (v0.1.59)
  runtime?: RuntimeType;           // 'builtin' | 'claude-code' | 'codex', defaults to 'builtin'
  runtimeConfig?: RuntimeConfig;   // Runtime-specific model/permission/args

  // Runtime
  setupCompleted?: boolean;
}

/**
 * Resolve effective config for a channel by merging Agent defaults with Channel overrides
 */
export function resolveEffectiveConfig(agent: AgentConfig, channel: ChannelConfig) {
  return {
    providerId: channel.overrides?.providerId ?? agent.providerId,
    providerEnvJson: channel.overrides?.providerEnvJson ?? agent.providerEnvJson,
    model: channel.overrides?.model ?? agent.model,
    permissionMode: channel.overrides?.permissionMode ?? agent.permissionMode,
    mcpEnabledServers: agent.mcpEnabledServers,      // Channel cannot override
    toolsDeny: channel.overrides?.toolsDeny ?? [],
    workspacePath: agent.workspacePath,               // Always Agent's
    heartbeat: agent.heartbeat,                       // Always Agent's
  };
}
