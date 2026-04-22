/**
 * Admin API — Self-Configuration endpoints for the CLI tool.
 *
 * All handlers follow the same pattern:
 *   1. Validate input
 *   2. If dry-run → return preview
 *   3. Write config (atomicModifyConfig)
 *   4. Update Sidecar in-memory state
 *   5. Broadcast SSE event for frontend sync
 *   6. Return result
 */

import type { McpServerDefinition } from '../renderer/config/types';
import { SDK_RESERVED_MCP_NAMES } from './agent-session';
import {
  loadConfig,
  atomicModifyConfig,
  getAllMcpServers,
  getEnabledMcpServerIds,
  loadProjects,
  saveProjects,
  redactSecret,
  findProvider,
  getProvidersDir,
  loadCustomProviderFiles,
  type AdminAppConfig,
  type AgentConfigSlim,
  type ChannelConfigSlim,
} from './utils/admin-config';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { setMcpServers, getMcpServers, getAgentState } from './agent-session';
import { broadcast } from './sse';

// ---------------------------------------------------------------------------
// Management API forwarding (Bun Sidecar → Rust)
// ---------------------------------------------------------------------------

const MGMT_PORT = process.env.PM_COPILOT_MANAGEMENT_PORT;

async function managementApi(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!MGMT_PORT) {
    return { ok: false, error: 'Management API not available (app may still be starting)' };
  }
  const url = `http://127.0.0.1:${MGMT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }
  try {
    const resp = await fetch(url, options);
    return resp.json() as Promise<Record<string, unknown>>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Management API unreachable: ${msg}` };
  }
}

/** Convert Management API response ({ ok, ... }) to Admin API response ({ success, data, error }) */
function wrapMgmtResponse(mgmt: Record<string, unknown>): AdminResponse {
  if (mgmt.ok) {
    const { ok: _ok, ...rest } = mgmt;
    return { success: true, data: rest };
  }
  return { success: false, error: String(mgmt.error ?? 'Unknown error') };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  hint?: string;
  dryRun?: boolean;
  preview?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// MCP Handlers
// ---------------------------------------------------------------------------

export function handleMcpList(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = new Set(getEnabledMcpServerIds(config));

  const data = allServers.map(s => ({
    id: s.id,
    name: s.name,
    type: s.type,
    enabled: enabledIds.has(s.id),
    isBuiltin: s.isBuiltin,
    command: s.command,
    url: s.url,
    requiresConfig: s.requiresConfig,
    hasEnv: !!(s.env && Object.keys(s.env).length > 0),
  }));

  return { success: true, data };
}

export function handleMcpAdd(payload: {
  server: Partial<McpServerDefinition>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const s = payload.server;

  // Validate required fields
  if (!s.id) return { success: false, error: 'Missing required field: id' };
  if (!s.type) return { success: false, error: 'Missing required field: type' };

  // Reject SDK reserved MCP names — these cause the Claude Agent SDK to crash (exit code 1)
  // with "Invalid MCP configuration: X is a reserved MCP name."
  const normalizedId = s.id.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (SDK_RESERVED_MCP_NAMES.includes(normalizedId)) {
    return { success: false, error: `MCP ID "${s.id}" 与 Claude SDK 内置保留名冲突，请使用其他名称（如 "my-${s.id}"）` };
  }

  if (s.type === 'stdio' && !s.command) {
    return { success: false, error: 'stdio type requires "command" field' };
  }
  if ((s.type === 'sse' || s.type === 'http') && !s.url) {
    return { success: false, error: `${s.type} type requires "url" field` };
  }

  const server: McpServerDefinition = {
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    description: s.description,
    command: s.command,
    // Defensive: CLI may send non-array args (boolean, string) due to parsing edge cases
    args: Array.isArray(s.args) ? s.args : undefined,
    env: s.env,
    url: s.url,
    headers: s.headers,
    isBuiltin: false,
    requiresConfig: s.requiresConfig,
    websiteUrl: s.websiteUrl,
    configHint: s.configHint,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: server };
  }

  atomicModifyConfig(c => ({
    ...c,
    mcpServers: [...(c.mcpServers || []).filter(x => x.id !== server.id), server],
  }));

  notifyMcpChange('add', server.id);
  return {
    success: true,
    data: { id: server.id, name: server.name },
    hint: 'Server added. Use "pm-copilot mcp enable" to activate.',
  };
}

export function handleMcpRemove(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Check if it's a built-in preset
  const allServers = getAllMcpServers();
  const target = allServers.find(s => s.id === id);
  if (!target) return { success: false, error: `MCP server '${id}' not found` };
  if (target.isBuiltin) {
    return { success: false, error: `Cannot remove built-in MCP server '${id}'. Only custom servers can be removed.` };
  }

  atomicModifyConfig(c => {
    const servers = (c.mcpServers || []).filter(s => s.id !== id);
    const enabled = (c.mcpEnabledServers || []).filter(s => s !== id);
    const envOverrides = { ...(c.mcpServerEnv || {}) };
    delete envOverrides[id];
    const argsOverrides = { ...(c.mcpServerArgs || {}) };
    delete argsOverrides[id];
    return { ...c, mcpServers: servers, mcpEnabledServers: enabled, mcpServerEnv: envOverrides, mcpServerArgs: argsOverrides };
  });

  notifyMcpChange('remove', id);
  return { success: true, data: { id }, hint: 'Server removed.' };
}

export function handleMcpEnable(payload: { id: string; scope?: string }): AdminResponse {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  // Verify server exists
  const allServers = getAllMcpServers();
  if (!allServers.find(s => s.id === id)) {
    return { success: false, error: `MCP server '${id}' not found` };
  }

  if (scope === 'global' || scope === 'both') {
    atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.add(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    enableMcpForCurrentProject(id);
  }

  notifyMcpChange('enable', id);
  const scopeLabel = scope === 'both' ? 'global + project' : scope;
  return { success: true, data: { id, scope: scopeLabel }, hint: `Enabled ${id} (${scopeLabel}).` };
}

export function handleMcpDisable(payload: { id: string; scope?: string }): AdminResponse {
  const { id, scope = 'both' } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (scope === 'global' || scope === 'both') {
    atomicModifyConfig(c => {
      const enabled = new Set(c.mcpEnabledServers || []);
      enabled.delete(id);
      return { ...c, mcpEnabledServers: Array.from(enabled) };
    });
  }

  if (scope === 'project' || scope === 'both') {
    disableMcpForCurrentProject(id);
  }

  notifyMcpChange('disable', id);
  return { success: true, data: { id } };
}

export function handleMcpEnv(payload: {
  id: string;
  action: 'set' | 'get' | 'delete';
  env?: Record<string, string>;
}): AdminResponse {
  const { id, action, env } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  if (action === 'get') {
    const config = loadConfig();
    const serverEnv = (config.mcpServerEnv ?? {})[id] ?? {};
    // Redact values for safety
    const redacted: Record<string, string> = {};
    for (const [k, v] of Object.entries(serverEnv)) {
      redacted[k] = redactSecret(v);
    }
    return { success: true, data: { id, env: redacted } };
  }

  if (action === 'set') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No environment variables provided' };
    }
    atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      mcpServerEnv[id] = { ...(mcpServerEnv[id] || {}), ...env };
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, keys: Object.keys(env) }, hint: 'Environment variables updated.' };
  }

  if (action === 'delete') {
    if (!env || Object.keys(env).length === 0) {
      return { success: false, error: 'No keys specified for deletion' };
    }
    atomicModifyConfig(c => {
      const mcpServerEnv = { ...(c.mcpServerEnv || {}) };
      if (mcpServerEnv[id]) {
        // Deep-copy per-server env to avoid mutating the original config object
        const serverEnv = { ...mcpServerEnv[id] };
        for (const key of Object.keys(env)) {
          delete serverEnv[key];
        }
        if (Object.keys(serverEnv).length === 0) {
          delete mcpServerEnv[id];
        } else {
          mcpServerEnv[id] = serverEnv;
        }
      }
      return { ...c, mcpServerEnv };
    });
    notifyMcpChange('env', id);
    return { success: true, data: { id, deletedKeys: Object.keys(env) } };
  }

  return { success: false, error: `Unknown action: ${action}. Use 'set', 'get', or 'delete'.` };
}

export async function handleMcpTest(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { success: false, error: `MCP server '${id}' not found` };

  // Validate config completeness
  if (server.type === 'stdio' && !server.command) {
    return { success: false, error: `MCP server '${id}' has no command configured` };
  }
  if ((server.type === 'sse' || server.type === 'http') && !server.url) {
    return { success: false, error: `MCP server '${id}' has no URL configured` };
  }

  // Built-in MCP: delegate to registry
  if (server.command === '__builtin__') {
    try {
      const { getBuiltinMcp } = await import('./tools/builtin-mcp-registry');
      const entry = getBuiltinMcp(server.id);
      if (entry?.validate) {
        const validationError = await entry.validate(server.env || {});
        if (validationError) {
          const errMsg = typeof validationError === 'string' ? validationError : JSON.stringify(validationError);
          return { success: false, error: errMsg };
        }
      }
    } catch { /* registry not loaded */ }
    return { success: true, data: { id, type: 'builtin' }, hint: 'Built-in MCP validated.' };
  }

  // SSE/HTTP: test URL reachability
  if (server.type === 'sse' || server.type === 'http') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // Inject stored OAuth token if no explicit Authorization header
      const { resolveAuthHeaders } = await import('./mcp-oauth');
      const configHeaders = server.headers || {};
      const hasExplicitAuth = Object.keys(configHeaders).some(k => k.toLowerCase() === 'authorization');
      const oauthHeaders = hasExplicitAuth ? {} : await resolveAuthHeaders(server.id);

      const headers: Record<string, string> = {
        'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
        'Accept-Encoding': 'identity',
        ...configHeaders,
        ...oauthHeaders,
      };

      const resp = server.type === 'http'
        ? await fetch(server.url!, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'PM Copilot', version: '1.0' } } }),
            signal: controller.signal,
          })
        : await fetch(server.url!, { method: 'GET', headers, signal: controller.signal });

      clearTimeout(timeout);

      if (resp.status === 401 || resp.status === 403) {
        const hint = oauthHeaders['Authorization']
          ? 'OAuth token may be expired or revoked. Try re-authorizing.'
          : 'This server may require OAuth authorization. Use Settings UI or `pm-copilot mcp oauth start`.';
        return { success: false, error: `Authentication failed (HTTP ${resp.status}). ${hint}` };
      }
      if (!resp.ok) {
        return { success: false, error: `Server returned HTTP ${resp.status}` };
      }

      return { success: true, data: { id, type: server.type, status: resp.status }, hint: `Connection OK (HTTP ${resp.status}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) return { success: false, error: 'Connection timed out (15s).' };
      return { success: false, error: `Connection failed: ${msg}` };
    }
  }

  // stdio: check command exists in PATH
  if (server.type === 'stdio' && server.command && server.command !== '__builtin__') {
    try {
      const { getShellEnv } = await import('./utils/shell');
      const checkCmd = process.platform === 'win32' ? 'where' : 'which';
      const { spawn } = await import('child_process');
      const code = await new Promise<number | null>(resolve => {
        const proc = spawn(checkCmd, [server.command!], { stdio: 'ignore', env: getShellEnv() });
        proc.on('close', resolve);
        proc.on('error', () => resolve(null));
      });
      if (code === 0) {
        return { success: true, data: { id, type: 'stdio', command: server.command }, hint: `Command '${server.command}' found.` };
      }
      return { success: false, error: `Command '${server.command}' not found in PATH.` };
    } catch (err) {
      return { success: false, error: `Failed to check command: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { success: true, data: { id, type: server.type }, hint: 'Configuration valid.' };
}

// ---------------------------------------------------------------------------
// MCP OAuth Handlers (CLI-facing wrappers around mcp-oauth module)
// ---------------------------------------------------------------------------

/** Resolve MCP server URL from config by ID */
function getMcpServerUrl(id: string): { url: string } | { error: string } {
  const allServers = getAllMcpServers();
  const server = allServers.find(s => s.id === id);
  if (!server) return { error: `MCP server '${id}' not found` };
  if (server.type !== 'sse' && server.type !== 'http') {
    return { error: `MCP server '${id}' is type '${server.type}' — OAuth only applies to sse/http servers.` };
  }
  if (!server.url) return { error: `MCP server '${id}' has no URL configured` };
  return { url: server.url };
}

export async function handleMcpOAuthDiscover(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { probeOAuthRequirement } = await import('./mcp-oauth');
    const result = await probeOAuthRequirement(id, resolved.url, true);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth discovery failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStart(payload: {
  id: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  callbackPort?: number;
}): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  const resolved = getMcpServerUrl(id);
  if ('error' in resolved) return { success: false, error: resolved.error };

  try {
    const { authorizeServer } = await import('./mcp-oauth');
    const manualConfig = payload.clientId ? {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      scopes: payload.scopes ? payload.scopes.split(/[,\s]+/).filter(Boolean) : undefined,
      callbackPort: payload.callbackPort,
    } : undefined;

    const { authUrl, waitForCompletion } = await authorizeServer(id, resolved.url, manualConfig);

    // Fire-and-forget: log completion but don't block the HTTP response.
    // CLI should poll `mcp oauth status <id>` to check completion.
    waitForCompletion.then(ok => {
      console.log(`[admin] OAuth ${ok ? 'completed' : 'failed/cancelled'} for MCP ${id}`);
    });

    return { success: true, data: { id, authUrl }, hint: 'Authorization started. Complete in browser, then check with `mcp oauth status`.' };
  } catch (err) {
    return { success: false, error: `OAuth start failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthStatus(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { getOAuthStatus } = await import('./mcp-oauth');
    const result = getOAuthStatus(id);
    return { success: true, data: { id, ...result } };
  } catch (err) {
    return { success: false, error: `OAuth status check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleMcpOAuthRevoke(payload: { id: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  try {
    const { revokeAuthorization } = await import('./mcp-oauth');
    await revokeAuthorization(id);
    return { success: true, data: { id }, hint: 'OAuth authorization revoked.' };
  } catch (err) {
    return { success: false, error: `OAuth revoke failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Model Provider Handlers
// ---------------------------------------------------------------------------

export function handleModelList(): AdminResponse {
  const config = loadConfig();
  const apiKeys = config.providerApiKeys ?? {};
  const verifyStatus = config.providerVerifyStatus ?? {};

  // Load preset providers
  let presetProviders: Array<Record<string, unknown>> = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PRESET_PROVIDERS } = require('../renderer/config/types');
    presetProviders = PRESET_PROVIDERS ?? [];
  } catch { /* ignore */ }

  // Load custom providers
  const customProviders = loadCustomProviderFiles();

  const allProviders = [...presetProviders, ...customProviders];
  const data = allProviders.map(p => {
    const id = String(p.id);
    const cfg = p.config as Record<string, unknown> | undefined;
    return {
      id,
      name: String(p.name),
      vendor: p.vendor ? String(p.vendor) : undefined,
      baseUrl: cfg?.baseUrl ? String(cfg.baseUrl) : undefined,
      isBuiltin: !!p.isBuiltin,
      protocol: p.apiProtocol ? String(p.apiProtocol) : 'anthropic',
      hasApiKey: !!apiKeys[id],
      status: (verifyStatus[id] as Record<string, unknown>)?.status ?? 'not-set',
    };
  });

  return { success: true, data };
}

export function handleModelSetKey(payload: { id: string; apiKey: string }): AdminResponse {
  const { id, apiKey } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!apiKey) return { success: false, error: 'Missing required field: apiKey' };

  atomicModifyConfig(c => ({
    ...c,
    providerApiKeys: { ...(c.providerApiKeys || {}), [id]: apiKey },
  }));

  broadcast('config:changed', { section: 'model', action: 'set-key', id });
  return { success: true, data: { id }, hint: `API key saved for ${id}.` };
}

export function handleModelSetDefault(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  atomicModifyConfig(c => ({
    ...c,
    defaultProviderId: id,
  }));

  broadcast('config:changed', { section: 'model', action: 'set-default', id });
  return { success: true, data: { id }, hint: `Default provider set to ${id}.` };
}

export async function handleModelVerify(payload: { id: string; model?: string }): Promise<AdminResponse> {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };

  const config = loadConfig();
  const apiKey = (config.providerApiKeys ?? {})[id];
  if (!apiKey) {
    return { success: false, error: `No API key set for provider '${id}'. Use 'pm-copilot model set-key' first.` };
  }

  // Look up provider config (preset or custom)
  const provider = findProvider(id);
  if (!provider) {
    return { success: false, error: `Provider '${id}' not found in presets or custom providers.` };
  }

  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(providerConfig.baseUrl ?? '');
  const authType = String(provider.authType ?? 'both');
  const apiProtocol = provider.apiProtocol as 'anthropic' | 'openai' | undefined;
  const userPrimary = (config.providerPrimaryModels as Record<string, string> | undefined)?.[id];
  const verifyModel = payload.model ?? userPrimary ?? String(provider.primaryModel ?? '');

  try {
    const { verifyProviderViaSdk } = await import('./provider-verify');
    const result = await verifyProviderViaSdk(
      baseUrl, apiKey, authType, verifyModel,
      apiProtocol,
      provider.maxOutputTokens ? Number(provider.maxOutputTokens) : undefined,
      provider.maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
      provider.upstreamFormat as 'chat_completions' | 'responses' | undefined,
    );

    if (result.success) {
      // Persist verify status
      atomicModifyConfig(c => ({
        ...c,
        providerVerifyStatus: {
          ...(c.providerVerifyStatus ?? {}),
          [id]: { status: 'valid', verifiedAt: new Date().toISOString() },
        },
      }));
      broadcast('config:changed', { section: 'model', action: 'verify', id });
      return { success: true, data: { id, model: verifyModel }, hint: 'Verification successful.' };
    }

    return { success: false, error: result.error ?? 'Verification failed', data: { id, detail: result.detail } };
  } catch (err) {
    return { success: false, error: `Verification error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleModelAdd(payload: {
  provider: Record<string, unknown>;
  dryRun?: boolean;
}): AdminResponse {
  const { dryRun } = payload;
  const p = payload.provider;

  // Validate required fields
  if (!p.id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(String(p.id))) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };
  if (!p.name) return { success: false, error: 'Missing required field: name' };
  if (!p.baseUrl) return { success: false, error: 'Missing required field: baseUrl (API endpoint)' };
  if (!p.models || !Array.isArray(p.models) || p.models.length === 0) {
    return { success: false, error: 'Missing required field: models (at least one model ID required)' };
  }

  // Build model entities
  const modelSeries = (p.modelSeries as string) || String(p.id);
  const modelIds = p.models as string[];
  const modelNames = (p.modelNames as string[]) || modelIds;
  const models = modelIds.map((model, i) => ({
    model,
    modelName: modelNames[i] || model,
    modelSeries,
  }));

  // Build aliases
  let modelAliases: Record<string, string> | undefined;
  if (p.aliases && typeof p.aliases === 'object') {
    modelAliases = p.aliases as Record<string, string>;
  } else if (modelIds.length > 0) {
    // Default: map sonnet/opus/haiku to first model
    modelAliases = { sonnet: modelIds[0], opus: modelIds[0], haiku: modelIds[0] };
  }

  const providerObj = {
    id: String(p.id),
    name: String(p.name),
    vendor: String(p.vendor ?? p.name),
    cloudProvider: String(p.cloudProvider ?? ''),
    type: 'api' as const,
    primaryModel: String(p.primaryModel ?? modelIds[0]),
    isBuiltin: false,
    config: {
      baseUrl: String(p.baseUrl),
      ...(p.timeout ? { timeout: Number(p.timeout) } : {}),
      ...(p.disableNonessential ? { disableNonessential: true } : {}),
    },
    authType: String(p.authType ?? 'auth_token'),
    ...(p.protocol === 'openai' || p.apiProtocol === 'openai' ? {
      apiProtocol: 'openai' as const,
      ...(p.maxOutputTokens ? { maxOutputTokens: Number(p.maxOutputTokens) } : {}),
      ...(p.maxOutputTokensParamName ? { maxOutputTokensParamName: String(p.maxOutputTokensParamName) } : {}),
      upstreamFormat: String(p.upstreamFormat ?? 'chat_completions') as 'chat_completions' | 'responses',
    } : {}),
    websiteUrl: p.websiteUrl ? String(p.websiteUrl) : undefined,
    models,
    modelAliases,
  };

  if (dryRun) {
    return { success: true, dryRun: true, preview: providerObj };
  }

  // Write to ~/.pm-copilot/providers/{id}.json
  saveCustomProviderFile(providerObj);
  broadcast('config:changed', { section: 'model', action: 'add', id: providerObj.id });
  return {
    success: true,
    data: { id: providerObj.id, name: providerObj.name, models: modelIds },
    hint: `Provider added. Use 'pm-copilot model set-key ${providerObj.id} <key>' to set API key.`,
  };
}

export function handleModelRemove(payload: { id: string }): AdminResponse {
  const { id } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!isValidId(id)) return { success: false, error: 'Invalid id: only alphanumeric, hyphens, and underscores allowed' };

  // Check if it's a preset
  const provider = findProvider(id);
  if (provider?.isBuiltin) {
    return { success: false, error: `Cannot remove built-in provider '${id}'. Only custom providers can be removed.` };
  }

  // Delete provider file
  if (!deleteCustomProviderFile(id)) {
    return { success: false, error: `Custom provider '${id}' not found.` };
  }

  // Clean up API key and verify status
  atomicModifyConfig(c => {
    const apiKeys = { ...(c.providerApiKeys ?? {}) };
    delete apiKeys[id];
    const verifyStatus = { ...(c.providerVerifyStatus ?? {}) };
    delete verifyStatus[id];
    // If this was the default provider, clear it
    const defaultId = c.defaultProviderId === id ? undefined : c.defaultProviderId;
    return { ...c, providerApiKeys: apiKeys, providerVerifyStatus: verifyStatus, defaultProviderId: defaultId };
  });

  broadcast('config:changed', { section: 'model', action: 'remove', id });
  return { success: true, data: { id }, hint: 'Provider removed.' };
}

// ---------------------------------------------------------------------------
// Agent Handlers
// ---------------------------------------------------------------------------

export function handleAgentList(): AdminResponse {
  const config = loadConfig();
  const agents = (config.agents ?? []).map(a => ({
    id: a.id,
    name: a.name,
    enabled: a.enabled,
    workspacePath: a.workspacePath,
    channelCount: (a.channels ?? []).length,
    channels: (a.channels ?? []).map(ch => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled,
    })),
  }));
  return { success: true, data: agents };
}

export function handleAgentEnable(payload: { id: string }): AdminResponse {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: true }), 'enable');
}

export function handleAgentDisable(payload: { id: string }): AdminResponse {
  const { id } = payload;
  return modifyAgent(id, agent => ({ ...agent, enabled: false }), 'disable');
}

export function handleAgentSet(payload: { id: string; key: string; value: unknown }): AdminResponse {
  const { id, key, value } = payload;
  if (!id) return { success: false, error: 'Missing required field: id' };
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Protect sensitive/structural fields
  const protectedFields = ['id', 'channels'];
  if (protectedFields.includes(key)) {
    return { success: false, error: `Cannot directly set field '${key}'. Use specific commands instead.` };
  }

  return modifyAgent(id, agent => ({ ...agent, [key]: value }), 'set');
}

export function handleAgentChannelList(payload: { agentId: string }): AdminResponse {
  const config = loadConfig();
  const agent = (config.agents ?? []).find(a => a.id === payload.agentId);
  if (!agent) return { success: false, error: `Agent '${payload.agentId}' not found` };

  return { success: true, data: (agent.channels ?? []).map(ch => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.enabled,
  })) };
}

export function handleAgentChannelAdd(payload: {
  agentId: string;
  channel: Record<string, unknown>;
}): AdminResponse {
  const { agentId, channel } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channel.type) return { success: false, error: 'Missing required field: channel.type' };

  const channelId = channel.id as string || crypto.randomUUID();
  const newChannel: ChannelConfigSlim = {
    ...channel,        // user-provided fields first
    id: channelId,     // override with guaranteed values
    type: channel.type as string,
    name: channel.name as string || `${channel.type} channel`,
    enabled: channel.enabled !== undefined ? !!channel.enabled : true,
  };

  return modifyAgent(agentId, agent => ({
    ...agent,
    channels: [...(agent.channels ?? []), newChannel],
  }), 'channel-add');
}

export function handleAgentChannelRemove(payload: { agentId: string; channelId: string }): AdminResponse {
  const { agentId, channelId } = payload;
  if (!agentId) return { success: false, error: 'Missing required field: agentId' };
  if (!channelId) return { success: false, error: 'Missing required field: channelId' };

  return modifyAgent(agentId, agent => ({
    ...agent,
    channels: (agent.channels ?? []).filter(ch => ch.id !== channelId),
  }), 'channel-remove');
}

// ---------------------------------------------------------------------------
// Config Handlers
// ---------------------------------------------------------------------------

export function handleConfigGet(payload: { key: string }): AdminResponse {
  const { key } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  const config = loadConfig();
  const value = getNestedValue(config, key);
  if (value === undefined) {
    return { success: false, error: `Config key '${key}' not found` };
  }

  // Redact sensitive fields recursively
  const redacted = redactSensitiveValues(key, value);
  return { success: true, data: { key, value: redacted } };
}

export function handleConfigSet(payload: { key: string; value: unknown; dryRun?: boolean }): AdminResponse {
  const { key, value, dryRun } = payload;
  if (!key) return { success: false, error: 'Missing required field: key' };

  // Reject dangerous key paths (prototype pollution)
  if (hasDangerousKeySegment(key)) {
    return { success: false, error: 'Invalid key path' };
  }

  // Protect structural/sensitive keys that have dedicated commands
  const protectedKeys = ['providerApiKeys', 'providerVerifyStatus', 'agents', 'mcpServers', 'mcpEnabledServers', 'mcpServerEnv', 'mcpServerArgs', 'imBotConfigs'];
  const rootKey = key.split('.')[0];
  if (protectedKeys.includes(rootKey)) {
    return { success: false, error: `Cannot set '${key}' via config set. Use dedicated commands (e.g., 'pm-copilot mcp', 'pm-copilot agent', 'pm-copilot model set-key').` };
  }

  if (dryRun) {
    return { success: true, dryRun: true, preview: { key, value } };
  }

  atomicModifyConfig(c => setNestedValue(c, key, value));
  broadcast('config:changed', { section: 'config', action: 'set', key });
  return { success: true, data: { key }, hint: `Config '${key}' updated.` };
}

// ---------------------------------------------------------------------------
// Status & Reload
// ---------------------------------------------------------------------------

export function handleStatus(): AdminResponse {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const enabledIds = getEnabledMcpServerIds(config);
  const currentMcp = getMcpServers();

  return {
    success: true,
    data: {
      mcpServers: { total: allServers.length, enabled: enabledIds.length },
      activeMcpInSession: currentMcp ? currentMcp.length : 0,
      defaultProvider: config.defaultProviderId ?? 'not set',
      agents: (config.agents ?? []).length,
    },
  };
}

export function handleReload(workspacePath?: string): AdminResponse {
  // Re-read config from disk and push effective MCP to in-memory state
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];

  if (workspacePath) {
    // Filter by project if workspace is known
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
  } else {
    // Fallback: use all globally enabled servers
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'all', action: 'reload' });
  return { success: true, hint: 'Configuration reloaded. MCP tools will be available in next turn.' };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXTS: Record<string, string> = {
  mcp: `pm-copilot mcp — Manage MCP tool servers

Commands:
  list                     List all MCP servers
  add                      Add a new MCP server
  remove <id>              Remove a custom MCP server
  enable <id>              Enable an MCP server
  disable <id>             Disable an MCP server
  test <id>                Validate MCP server connectivity
  env <id> <action>        Manage environment variables
  oauth <action> <id>      Manage OAuth for HTTP/SSE servers

Options for 'add':
  --id          Server ID (required)
  --name        Display name (defaults to id)
  --type        stdio | sse | http (default: stdio)
  --command     Command to run (for stdio)
  --args        Arguments (repeatable)
  --url         Endpoint URL (for sse/http)
  --env         KEY=VALUE (repeatable)
  --headers     KEY=VALUE (repeatable, for sse/http)

Options for 'enable' / 'disable':
  --scope       global | project | both (default: both)

Options for 'env':
  set KEY=VALUE [KEY2=VALUE2 ...]
  get
  delete KEY [KEY2 ...]

OAuth subcommands:
  oauth discover <id>      Probe server for OAuth requirements
  oauth start <id>         Start OAuth authorization (opens browser)
  oauth status <id>        Check OAuth status
  oauth revoke <id>        Revoke stored OAuth token

Options for 'oauth start' (manual mode):
  --client-id      OAuth client ID (skip for auto mode)
  --client-secret  OAuth client secret
  --scopes         Scopes (comma or space separated)
  --callback-port  Local callback port`,

  model: `pm-copilot model — Manage model providers

Commands:
  list                     List all providers (preset + custom)
  add                      Add a custom provider
  remove <id>              Remove a custom provider
  set-key <id> <api-key>   Set API key for a provider
  verify <id> [--model m]  Verify API key (sends a test message)
  set-default <id>         Set default provider

Options for 'add':
  --id            Provider ID (required)
  --name          Display name (required)
  --base-url      API endpoint URL (required)
  --models        Model IDs (repeatable, at least one)
  --model-names   Display names for models (repeatable)
  --primary-model Default model (default: first in --models)
  --auth-type     auth_token | api_key | both (default: auth_token)
  --protocol      anthropic | openai (default: anthropic)
  --upstream-format  chat_completions | responses (openai only)
  --max-output-tokens  Max output limit (openai only)
  --aliases       SDK alias mapping: sonnet=model,opus=model,haiku=model
  --vendor        Vendor name
  --website-url   Provider website`,

  agent: `pm-copilot agent — Manage agents & channels

Commands:
  list                     List all agents
  enable <id>              Enable an agent
  disable <id>             Disable an agent
  set <id> <key> <value>   Set agent config field
  channel list <agent-id>  List channels for an agent
  channel add <agent-id>   Add a channel
  channel remove <a-id> <ch-id>  Remove a channel

Options for 'channel add':
  --type        telegram | feishu | dingtalk (required)
  --token       Bot token (for telegram)
  --app-id      App ID (for feishu/dingtalk)
  --app-secret  App Secret (for feishu/dingtalk)`,

  config: `pm-copilot config — Read/write application config

Commands:
  get <key>               Read a config value
  set <key> <value>       Set a config value`,

  cron: `pm-copilot cron — Manage scheduled tasks

Commands:
  list                     List all cron tasks
  add                      Create a new cron task
  start <id>               Start a stopped task
  stop <id>                Stop a running task
  remove <id>              Delete a task
  update <id>              Update task fields
  runs <id>                View execution history
  status                   Show cron task summary

Options for 'add':
  --name         Task name
  --prompt       AI prompt (required)
  --schedule     Cron expression (e.g. "*/30 * * * *")
  --every        Interval in minutes (alternative to --schedule)
  --workspace    Workspace path (required)`,

  plugin: `pm-copilot plugin — Manage channel plugins

Commands:
  list                     List installed plugins
  install <npm-spec>       Install a plugin from npm
  remove <plugin-id>       Uninstall a plugin`,
};

export function handleHelp(payload: { path?: string[] }): AdminResponse {
  const path = payload.path ?? [];
  const group = path[0];

  if (group && HELP_TEXTS[group]) {
    return { success: true, data: { text: HELP_TEXTS[group] } };
  }

  return {
    success: true,
    data: {
      text: `Available command groups: mcp, model, agent, config, cron, plugin, status, reload
Use "pm-copilot <group> --help" for details on a specific group.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export function handleVersion(): AdminResponse {
  // npm_package_version is set by npm/bun when launched via npm scripts;
  // PM_COPILOT_VERSION can be injected by the build system as a fallback.
  const version = process.env.npm_package_version
    ?? process.env.PM_COPILOT_VERSION
    ?? '0.1.51';
  return { success: true, data: { version } };
}

// ---------------------------------------------------------------------------
// Cron Task forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleCronList(payload: { workspacePath?: string }): Promise<AdminResponse> {
  const qs = payload.workspacePath ? `?workspacePath=${encodeURIComponent(payload.workspacePath)}` : '';
  const resp = await managementApi(`/api/cron/list${qs}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).tasks ?? [] };
  }
  return { success: false, error: String(resp.error ?? 'Failed to list cron tasks') };
}

export async function handleCronCreate(payload: Record<string, unknown>): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/create', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStop(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/stop', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronStart(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/run', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronDelete(payload: { taskId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/delete', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronUpdate(payload: { taskId: string; patch: Record<string, unknown> }): Promise<AdminResponse> {
  const resp = await managementApi('/api/cron/update', 'POST', payload);
  return wrapMgmtResponse(resp);
}

export async function handleCronRuns(payload: { taskId: string; limit?: number }): Promise<AdminResponse> {
  const qs = `?taskId=${encodeURIComponent(payload.taskId)}${payload.limit ? `&limit=${payload.limit}` : ''}`;
  const resp = await managementApi(`/api/cron/runs${qs}`);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).runs ?? [] };
  }
  return { success: false, error: String(resp.error ?? 'Failed to get cron runs') };
}

export async function handleCronStatus(payload: { workspacePath?: string }): Promise<AdminResponse> {
  const qs = payload.workspacePath ? `?workspacePath=${encodeURIComponent(payload.workspacePath)}` : '';
  const resp = await managementApi(`/api/cron/status${qs}`);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Plugin forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handlePluginList(): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/list');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugins ?? [] };
  }
  return { success: false, error: String(resp.error ?? 'Failed to list plugins') };
}

export async function handlePluginInstall(payload: { npmSpec: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/install', 'POST', payload);
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).plugin, hint: 'Plugin installed successfully.' };
  }
  return { success: false, error: String(resp.error ?? 'Failed to install plugin') };
}

export async function handlePluginUninstall(payload: { pluginId: string }): Promise<AdminResponse> {
  const resp = await managementApi('/api/plugin/uninstall', 'POST', payload);
  return wrapMgmtResponse(resp);
}

// ---------------------------------------------------------------------------
// Agent runtime status forwarding (Admin API → Management API)
// ---------------------------------------------------------------------------

export async function handleAgentRuntimeStatus(): Promise<AdminResponse> {
  const resp = await managementApi('/api/agent/runtime-status');
  if (resp.ok) {
    return { success: true, data: (resp as Record<string, unknown>).agents ?? {} };
  }
  return { success: false, error: String(resp.error ?? 'Failed to get agent runtime status') };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Validate that an ID is safe for use as a filename (prevent path traversal) */
function isValidId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/** Reject dangerous property names to prevent prototype pollution */
function hasDangerousKeySegment(key: string): boolean {
  return key.split('.').some(p => p === '__proto__' || p === 'constructor' || p === 'prototype');
}

// ---------------------------------------------------------------------------
// Provider file I/O (~/.pm-copilot/providers/{id}.json)
// ---------------------------------------------------------------------------

// findProvider, getProvidersDir, loadCustomProviderFiles → imported from admin-config.ts

/** Save a custom provider JSON file */
function saveCustomProviderFile(provider: Record<string, unknown>): void {
  const dir = getProvidersDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `${provider.id}.json`);
  writeFileSync(filePath, JSON.stringify(provider, null, 2), 'utf-8');
}

/** Delete a custom provider file. Returns true if file existed. */
function deleteCustomProviderFile(id: string): boolean {
  const filePath = resolve(getProvidersDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

/** Update Sidecar MCP state and notify frontend after config change.
 *  Respects project-scope: only servers enabled both globally AND in the
 *  current workspace project are pushed to the session. */
function notifyMcpChange(action: string, id: string): void {
  const workspacePath = getCurrentWorkspacePath();
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  let effectiveServers: McpServerDefinition[];
  if (workspacePath) {
    const projects = loadProjects();
    const project = projects.find(p => p.path === workspacePath);
    const projectEnabled = new Set(project?.mcpEnabledServers ?? []);
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
  } else {
    effectiveServers = allServers.filter(s => globalEnabled.has(s.id));
  }

  setMcpServers(effectiveServers);
  broadcast('config:changed', { section: 'mcp', action, id });
}

/** Enable MCP for the current workspace project */
function enableMcpForCurrentProject(serverId: string): void {
  // The workspace path is set via process-global; use it to find the project
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.add(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Disable MCP for the current workspace project */
function disableMcpForCurrentProject(serverId: string): void {
  const workspacePath = getCurrentWorkspacePath();
  if (!workspacePath) return;

  const projects = loadProjects();
  const idx = projects.findIndex(p => p.path === workspacePath);
  if (idx < 0) return;

  const project = projects[idx];
  const enabled = new Set(project.mcpEnabledServers ?? []);
  enabled.delete(serverId);
  projects[idx] = { ...project, mcpEnabledServers: Array.from(enabled) };
  saveProjects(projects);
}

/** Get workspace path from agent-session (set during session init) */
function getCurrentWorkspacePath(): string | undefined {
  const state = getAgentState();
  return state.agentDir || undefined;
}

/** Modify an agent in config by ID */
function modifyAgent(
  id: string,
  modifier: (agent: AgentConfigSlim) => AgentConfigSlim,
  action: string,
): AdminResponse {
  // Pre-check existence (fast-fail before acquiring write)
  const config = loadConfig();
  if (!(config.agents ?? []).some(a => a.id === id)) {
    return { success: false, error: `Agent '${id}' not found` };
  }

  // Find by ID inside the modifier to avoid TOCTOU stale-index bugs
  atomicModifyConfig(c => {
    const updated = [...(c.agents ?? [])];
    const freshIdx = updated.findIndex(a => a.id === id);
    if (freshIdx < 0) return c; // agent disappeared between reads — no-op
    updated[freshIdx] = modifier(updated[freshIdx]);
    return { ...c, agents: updated };
  });

  broadcast('config:changed', { section: 'agent', action, id });
  return { success: true, data: { id } };
}

/** Keys and patterns that contain secrets and must be redacted in config get */
const SENSITIVE_KEY_PATTERNS = /apikey|api_key|secret|token|password/i;
const SENSITIVE_TOP_KEYS = new Set(['providerApiKeys', 'mcpServerEnv']);

/** Recursively redact sensitive values in config output */
function redactSensitiveValues(key: string, value: unknown): unknown {
  const rootKey = key.split('.')[0];

  // Top-level known sensitive maps
  if (SENSITIVE_TOP_KEYS.has(rootKey) && typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  // Any key path containing sensitive patterns
  if (SENSITIVE_KEY_PATTERNS.test(key) && typeof value === 'string') {
    return redactSecret(value);
  }

  // For arrays/objects that may contain sensitive nested fields (e.g., agents, imBotConfigs)
  if (typeof value === 'object' && value !== null) {
    return deepRedact(value);
  }

  return value;
}

/** Recursively walk an object and redact string values whose keys match sensitive patterns */
function deepRedact(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(item => deepRedact(item));
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && SENSITIVE_KEY_PATTERNS.test(k)) {
        result[k] = redactSecret(v);
      } else if (typeof v === 'object' && v !== null) {
        result[k] = deepRedact(v);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
  return obj;
}

/** Get nested value from object by dot-separated key */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set nested value in object by dot-separated key */
function setNestedValue(obj: AdminAppConfig, key: string, value: unknown): AdminAppConfig {
  const parts = key.split('.');
  if (parts.length === 1) {
    return { ...obj, [key]: value };
  }
  const [first, ...rest] = parts;
  const child = (obj[first] ?? {}) as Record<string, unknown>;
  return { ...obj, [first]: setNestedValue(child as AdminAppConfig, rest.join('.'), value) };
}
