/**
 * Sidecar-side config read/write for Admin API
 *
 * Equivalent to the frontend's appConfigService.ts, but using native fs
 * instead of Tauri plugin-fs. Both read/write the same ~/.pm-copilot/config.json.
 * Atomicity is guaranteed by write-to-tmp → rename pattern.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, mkdirSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import type { McpServerDefinition } from '../../renderer/config/types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.pm-copilot');
}

function getConfigPath(): string {
  return resolve(getConfigDir(), 'config.json');
}

function getProjectsPath(): string {
  return resolve(getConfigDir(), 'projects.json');
}

// ---------------------------------------------------------------------------
// Minimal types (mirrors renderer/config/types.ts — only the fields we touch)
// ---------------------------------------------------------------------------

/** Lightweight AppConfig subset used by admin operations */
export interface AdminAppConfig {
  // MCP
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  // Provider
  defaultProviderId?: string;
  providerApiKeys?: Record<string, string>;
  providerVerifyStatus?: Record<string, { status: string; verifiedAt?: string }>;
  // Agent
  agents?: AgentConfigSlim[];
  // Allow passthrough of all other fields
  [key: string]: unknown;
}

/** Minimal Agent config shape for admin operations */
export interface AgentConfigSlim {
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  providerId?: string;
  model?: string;
  channels?: ChannelConfigSlim[];
  [key: string]: unknown;
}

/** Minimal Channel config shape */
export interface ChannelConfigSlim {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  botToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  [key: string]: unknown;
}

/** Minimal Project shape */
export interface ProjectSlim {
  id: string;
  name: string;
  path: string;
  mcpEnabledServers?: string[];
  model?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

export function loadConfig(): AdminAppConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as AdminAppConfig;
  } catch {
    // Malformed JSON — try .bak fallback
    const bakPath = configPath + '.bak';
    if (existsSync(bakPath)) {
      try {
        console.warn('[admin-config] config.json parse failed, falling back to .bak');
        return JSON.parse(readFileSync(bakPath, 'utf-8')) as AdminAppConfig;
      } catch { /* bak also corrupt */ }
    }
    console.error('[admin-config] config.json and .bak both unreadable, returning empty config');
    return {};
  }
}

/**
 * Atomic read-modify-write on config.json.
 * Pattern: read → modify → write .tmp → backup .bak → rename .tmp → target
 */
export function atomicModifyConfig(
  modifier: (config: AdminAppConfig) => AdminAppConfig
): AdminAppConfig {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  const config = loadConfig();
  const modified = modifier(config);

  const tmpPath = configPath + '.tmp';
  const bakPath = configPath + '.bak';

  writeFileSync(tmpPath, JSON.stringify(modified, null, 2), 'utf-8');
  if (existsSync(configPath)) {
    try { copyFileSync(configPath, bakPath); } catch { /* best-effort backup */ }
  }
  renameSync(tmpPath, configPath);

  return modified;
}

// ---------------------------------------------------------------------------
// Projects read/write
// ---------------------------------------------------------------------------

export function loadProjects(): ProjectSlim[] {
  const path = getProjectsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ProjectSlim[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectSlim[]): void {
  const path = getProjectsPath();
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// MCP helpers (preset + custom merge, matching renderer/config/services/mcpService.ts)
// ---------------------------------------------------------------------------

/** Preset MCP servers — imported at call time to avoid circular deps */
function getPresetMcpServers(): McpServerDefinition[] {
  // Inline the preset list import to avoid pulling in the full types module at module load
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_MCP_SERVERS } = require('../../renderer/config/types');
    return PRESET_MCP_SERVERS as McpServerDefinition[];
  } catch {
    return [];
  }
}

/**
 * Get all MCP servers (preset + custom), with user env/args overrides applied.
 * Mirrors getAllMcpServers() from mcpService.ts.
 */
export function getAllMcpServers(config?: AdminAppConfig): McpServerDefinition[] {
  const c = config ?? loadConfig();
  const presets = getPresetMcpServers();
  const custom = c.mcpServers ?? [];
  const envOverrides = c.mcpServerEnv ?? {};
  const argsOverrides = c.mcpServerArgs ?? {};

  // Custom servers can override presets with same ID
  const customIds = new Set(custom.map(s => s.id));
  const merged = [
    ...presets.filter(p => !customIds.has(p.id)),
    ...custom,
  ];

  // Apply user env/args overrides
  return merged.map(server => {
    const userEnv = envOverrides[server.id];
    const userArgs = argsOverrides[server.id];
    return {
      ...server,
      ...(userEnv ? { env: { ...(server.env || {}), ...userEnv } } : {}),
      ...(userArgs !== undefined ? { args: userArgs } : {}),
    };
  });
}

/**
 * Get globally enabled MCP server IDs
 */
export function getEnabledMcpServerIds(config?: AdminAppConfig): string[] {
  const c = config ?? loadConfig();
  return c.mcpEnabledServers ?? [];
}

/**
 * Get effective MCP servers for a specific project (global enabled ∩ project enabled)
 */
export function getEffectiveMcpServers(projectPath: string): McpServerDefinition[] {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  // Find project by path
  const projects = loadProjects();
  const project = projects.find(p => p.path === projectPath);
  const projectEnabled = new Set(project?.mcpEnabledServers ?? []);

  if (projectEnabled.size === 0) return [];

  return allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/** Redact sensitive values for display (show first 4 + last 4 chars) */
export function redactSecret(value: string): string {
  if (value.length <= 10) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Path to custom provider files directory */
export function getProvidersDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.pm-copilot', 'providers');
}

/** Find a provider by ID: checks PRESET_PROVIDERS first, then custom files in ~/.pm-copilot/providers/ */
export function findProvider(id: string): Record<string, unknown> | null {
  // Check presets first
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_PROVIDERS } = require('../../renderer/config/types');
    const preset = (PRESET_PROVIDERS as Array<Record<string, unknown>>)?.find(
      (p: Record<string, unknown>) => p.id === id
    );
    if (preset) return preset;
  } catch { /* ignore */ }

  // Check custom providers
  try {
    const dir = getProvidersDir();
    const filePath = resolve(dir, `${id}.json`);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  return null;
}

/** Load all custom provider files from ~/.pm-copilot/providers/ */
export function loadCustomProviderFiles(): Array<Record<string, unknown>> {
  try {
    const dir = getProvidersDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as Record<string, unknown>;
        } catch { return null; }
      })
      .filter((p): p is Record<string, unknown> => p !== null && !!p.id);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Provider resolution (Sidecar self-resolve — eliminates dependency on providerEnvJson snapshots)
// ---------------------------------------------------------------------------

/** Provider environment for SDK subprocess (structural match with ProviderEnv in agent-session.ts) */
export interface ResolvedProviderEnv {
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  modelAliases?: { sonnet?: string; opus?: string; haiku?: string };
}

/**
 * Resolve provider environment from providerId by looking up the real provider definition
 * (preset or custom) and API key from config. Handles ALL providers including custom ones.
 *
 * Returns undefined for subscription providers or if provider/key not found.
 */
export function resolveProviderEnv(
  providerId: string,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  if (!providerId) return undefined;

  const provider = findProvider(providerId);
  if (!provider) return undefined;

  // Subscription providers don't use providerEnv (SDK uses built-in OAuth)
  if (provider.type === 'subscription') return undefined;

  // Get API key from config
  const c = config ?? loadConfig();
  const apiKey = (c.providerApiKeys ?? {})[providerId];
  if (!apiKey) return undefined;

  // Extract provider config fields (same shape as frontend Chat.tsx builds)
  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const result: ResolvedProviderEnv = {
    baseUrl: providerConfig.baseUrl ? String(providerConfig.baseUrl) : undefined,
    apiKey,
    authType: (provider.authType as ResolvedProviderEnv['authType']) ?? 'both',
  };
  if (provider.apiProtocol) result.apiProtocol = provider.apiProtocol as ResolvedProviderEnv['apiProtocol'];
  if (provider.maxOutputTokens) result.maxOutputTokens = Number(provider.maxOutputTokens);
  if (provider.maxOutputTokensParamName) result.maxOutputTokensParamName = provider.maxOutputTokensParamName as ResolvedProviderEnv['maxOutputTokensParamName'];
  if (provider.upstreamFormat) result.upstreamFormat = provider.upstreamFormat as ResolvedProviderEnv['upstreamFormat'];

  // Model aliases: merge preset defaults with user overrides (from config.providerModelAliases)
  const presetAliases = (provider as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
  const aliasOverrides = c.providerModelAliases as Record<string, Record<string, string>> | undefined;
  const userOverrides = aliasOverrides?.[providerId];
  const mergedAliases = presetAliases || userOverrides
    ? { ...presetAliases, ...userOverrides }
    : undefined;
  if (mergedAliases && (mergedAliases.sonnet || mergedAliases.opus || mergedAliases.haiku)) {
    result.modelAliases = {
      sonnet: mergedAliases.sonnet,
      opus: mergedAliases.opus,
      haiku: mergedAliases.haiku,
    };
  } else {
    // Fallback: no aliases configured — use provider's primaryModel or first model
    // so sub-agents don't send raw claude-* model names to third-party APIs.
    const primaryModel = (provider as Record<string, unknown>).primaryModel as string | undefined;
    const models = (provider as Record<string, unknown>).models as Array<{ model: string }> | undefined;
    const fallback = primaryModel || models?.[0]?.model;
    if (fallback) {
      result.modelAliases = { sonnet: fallback, opus: fallback, haiku: fallback };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Workspace config resolution (Sidecar self-resolve at startup)
// ---------------------------------------------------------------------------

/** Result of self-resolution for a workspace */
export interface WorkspaceResolvedConfig {
  mcpServers: McpServerDefinition[];
  providerEnv: ResolvedProviderEnv | undefined;
  model: string | undefined;
}

/**
 * Resolve the complete AI configuration for a workspace by reading source data from disk.
 *
 * This eliminates the dependency on pre-serialized snapshot fields (providerEnvJson, mcpServersJson)
 * that can fail to save or go stale. The Sidecar calls this during initializeAgent() so IM Bot
 * sessions work correctly without the frontend having been opened first.
 *
 * For desktop Chat sessions, the frontend's /api/mcp/set and per-message providerEnv will
 * override the self-resolved values — so there is no conflict.
 */
export function resolveWorkspaceConfig(agentDir: string): WorkspaceResolvedConfig {
  const config = loadConfig();

  // Normalize path separators for cross-platform matching
  const normalizedDir = agentDir.replace(/\\/g, '/');

  // Find matching agent by workspace path
  const agents = (config.agents ?? []) as Array<Record<string, unknown>>;
  const agent = agents.find(a =>
    typeof a.workspacePath === 'string' && a.workspacePath.replace(/\\/g, '/') === normalizedDir
  );

  // --- Resolve MCP ---
  // Uses the existing getEffectiveMcpServers which does: global enabled ∩ project enabled
  // For agent workspaces, mcpEnabledServers is synced to both project and agent.
  const mcpServers = getEffectiveMcpServers(agentDir);

  // --- Resolve Provider ---
  // Priority: agent.providerId → config.defaultProviderId → persisted snapshot
  let providerEnv: ResolvedProviderEnv | undefined;
  const providerId = (agent?.providerId as string | undefined)
    || (config.defaultProviderId as string | undefined);
  if (providerId) {
    providerEnv = resolveProviderEnv(providerId, config);
  }
  // Fallback: if runtime resolution failed, try the persisted snapshot (backward compat)
  if (!providerEnv && agent?.providerEnvJson) {
    try {
      providerEnv = JSON.parse(agent.providerEnvJson as string) as ResolvedProviderEnv;
    } catch { /* ignore malformed snapshot */ }
  }

  // --- Resolve Model ---
  // Priority: agent.model → provider's primaryModel (if resolved)
  let model = (agent?.model as string | undefined) ?? undefined;
  if (!model && providerId) {
    const provider = findProvider(providerId);
    if (provider) {
      model = (provider as Record<string, unknown>).primaryModel as string | undefined;
    }
  }

  if (mcpServers.length > 0 || providerEnv || model) {
    console.log(
      `[admin-config] resolveWorkspaceConfig: ` +
      `provider=${providerId ?? 'subscription'}, model=${model ?? 'default'}, ` +
      `mcp=${mcpServers.length} server(s)${agent ? '' : ' (no agent match)'}`
    );
  }

  return { mcpServers, providerEnv, model };
}
