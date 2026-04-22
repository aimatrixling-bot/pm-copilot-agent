#!/usr/bin/env bun
/**
 * pm-copilot — Self-Configuration CLI for PM Copilot
 *
 * A thin wrapper that parses CLI arguments and forwards them as HTTP requests
 * to the Sidecar's Admin API. All business logic lives in the Sidecar.
 *
 * Environment:
 *   PM_COPILOT_PORT — Sidecar port (injected by buildClaudeSessionEnv)
 */

// ---------------------------------------------------------------------------
// Port discovery
// ---------------------------------------------------------------------------

// Port is resolved after arg parsing (--port flag can override env)
let PORT = process.env.PM_COPILOT_PORT ?? '';
let BASE = '';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);

/** Parse CLI arguments into structured flags and positional args */
function parseArgs(args: string[]): { positional: string[]; flags: Record<string, unknown> } {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  const repeatable = new Set(['args', 'env', 'headers', 'models', 'model-names']);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      // Boolean flags (no value follows)
      if (key === 'help' || key === 'json' || key === 'dry-run' || key === 'disable-nonessential') {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      // Repeatable flags: ALWAYS consume the next token as a value, even if it
      // starts with '--' (e.g. --args "--stdio"). The boolean-fallback check
      // below must NOT run for repeatable flags — it would overwrite the
      // accumulated array with `true`.
      if (repeatable.has(key)) {
        const value = args[i + 1];
        if (value === undefined) {
          // No value — normalize to empty array (not boolean) to keep type consistent
          const cKey = camelCase(key);
          if (!flags[cKey]) flags[cKey] = [];
          i++;
          continue;
        }
        // Collect values under camelCase key for consistency with non-repeatable flags
        const cKey = camelCase(key);
        const arr = (flags[cKey] as string[]) || [];
        arr.push(value);
        flags[cKey] = arr;
        i += 2;
        continue;
      }
      // Key-value flags (non-repeatable)
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags[camelCase(key)] = true;
        i++;
        continue;
      }
      {
        flags[camelCase(key)] = value;
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const TOP_HELP = `pm-copilot — PM Copilot Self-Configuration CLI

Usage: pm-copilot <command> [options]

Commands:
  mcp       Manage MCP tool servers
  model     Manage model providers
  agent     Manage agents & channels
  cron      Manage scheduled tasks
  plugin    Manage channel plugins
  config    Read/write application config
  status    Show app running state
  version   Show app version
  reload    Hot-reload configuration

Global flags:
  --help      Show help for any command
  --json      Output as JSON
  --dry-run   Preview changes without applying
  --port NUM  Override Sidecar port (default: $PM_COPILOT_PORT)

Examples:
  pm-copilot mcp list
  pm-copilot mcp add --id playwright --type stdio --command npx --args @playwright/mcp@latest
  pm-copilot mcp enable playwright --scope both
  pm-copilot mcp oauth discover notion-mcp
  pm-copilot mcp oauth start notion-mcp
  pm-copilot model list
  pm-copilot model set-key deepseek sk-xxx
  pm-copilot cron list
  pm-copilot plugin list
  pm-copilot version
  pm-copilot reload

Run 'pm-copilot <command> --help' for details on a specific command.`;

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

async function callApi(route: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  try {
    const resp = await fetch(`${BASE}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await resp.json() as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      console.error('Error: Cannot connect to PM Copilot. Is the app running?');
      process.exit(3);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResult(group: string, action: string, result: Record<string, unknown>, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    return;
  }

  // Dry-run
  if (result.dryRun) {
    console.log('[DRY RUN] Would apply:');
    console.log(formatObject(result.preview as Record<string, unknown>));
    console.log('\nRun without --dry-run to apply.');
    return;
  }

  // Group-specific formatting
  if (group === 'mcp' && action === 'list') {
    printMcpList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'model' && action === 'list') {
    printModelList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'agent' && action === 'list') {
    printAgentList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'list') {
    printCronList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'runs') {
    printCronRuns(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'cron' && action === 'status') {
    printCronStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'plugin' && action === 'list') {
    printPluginList(result.data as Array<Record<string, unknown>>);
    return;
  }
  if (group === 'mcp' && action === 'oauth') {
    printMcpOAuth(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'version') {
    console.log((result.data as { version: string })?.version ?? 'Unknown');
    return;
  }
  if (group === 'agent' && action === 'runtime-status') {
    printAgentRuntimeStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'status') {
    printStatus(result.data as Record<string, unknown>);
    return;
  }
  if (group === 'help') {
    console.log((result.data as { text: string })?.text ?? '');
    return;
  }

  // Generic success output
  const symbol = '\u2713'; // ✓
  const hint = result.hint ? ` ${result.hint}` : '';
  const id = (result.data as Record<string, unknown>)?.id ?? '';
  console.log(`${symbol} ${action} ${id}${hint}`);
}

function printMcpList(servers: Array<Record<string, unknown>>): void {
  if (!servers || servers.length === 0) {
    console.log('No MCP servers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Type', 8) + pad('Status', 10) + 'Name');
  for (const s of servers) {
    const status = s.enabled ? 'enabled' : 'disabled';
    const builtin = s.isBuiltin ? ' (built-in)' : '';
    console.log(pad(String(s.id), 24) + pad(String(s.type), 8) + pad(status, 10) + String(s.name) + builtin);
  }
  const enabled = servers.filter(s => s.enabled).length;
  console.log(`\n${servers.length} MCP servers (${enabled} enabled)`);
}

function printModelList(providers: Array<Record<string, unknown>>): void {
  if (!providers || providers.length === 0) {
    console.log('No model providers configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 12) + 'Name');
  for (const p of providers) {
    console.log(pad(String(p.id), 24) + pad(String(p.status), 12) + String(p.name));
  }
}

function printAgentList(agents: Array<Record<string, unknown>>): void {
  if (!agents || agents.length === 0) {
    console.log('No agents configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 38) + pad('Status', 10) + pad('Channels', 10) + 'Name');
  for (const a of agents) {
    const status = a.enabled ? 'enabled' : 'disabled';
    console.log(pad(String(a.id).slice(0, 36), 38) + pad(status, 10) + pad(String(a.channelCount), 10) + String(a.name));
  }
}

function printStatus(data: Record<string, unknown>): void {
  const mcp = data.mcpServers as Record<string, number>;
  console.log(`MCP Servers: ${mcp?.total ?? 0} total, ${mcp?.enabled ?? 0} enabled`);
  console.log(`Active MCP in session: ${data.activeMcpInSession}`);
  console.log(`Default provider: ${data.defaultProvider}`);
  console.log(`Agents: ${data.agents}`);
}

function printCronList(tasks: Array<Record<string, unknown>>): void {
  if (!tasks || tasks.length === 0) {
    console.log('No cron tasks configured.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 24) + pad('Status', 10) + pad('Schedule', 20) + 'Name');
  for (const t of tasks) {
    const schedule = t.schedule
      ? (typeof t.schedule === 'object' && (t.schedule as Record<string, unknown>).kind === 'cron'
        ? String((t.schedule as Record<string, unknown>).expr)
        : `Every ${t.intervalMinutes}m`)
      : `Every ${t.intervalMinutes}m`;
    console.log(
      pad(String(t.id).slice(0, 22), 24) +
      pad(String(t.status), 10) +
      pad(schedule.slice(0, 18), 20) +
      String(t.name ?? (t.prompt as string)?.slice(0, 40) ?? '')
    );
  }
  const running = tasks.filter(t => t.status === 'Running' || t.status === 'running').length;
  console.log(`\n${tasks.length} cron tasks (${running} running)`);
}

function printCronRuns(runs: Array<Record<string, unknown>>): void {
  if (!runs || runs.length === 0) {
    console.log('No execution records.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('Time', 22) + pad('Status', 8) + pad('Duration', 12) + 'Output');
  for (const r of runs) {
    const time = r.ts ? new Date(Number(r.ts)).toLocaleString() : '?';
    const status = r.ok ? '\u2713' : '\u2717';
    const dur = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '?';
    const output = r.ok
      ? String(r.content ?? '').slice(0, 50)
      : String(r.error ?? '').slice(0, 50);
    console.log(pad(time, 22) + pad(status, 8) + pad(dur, 12) + output);
  }
}

function printCronStatus(data: Record<string, unknown>): void {
  console.log(`Total tasks: ${data.totalTasks ?? 0}`);
  console.log(`Running: ${data.runningTasks ?? 0}`);
  if (data.lastExecutedAt) console.log(`Last executed: ${data.lastExecutedAt}`);
  if (data.nextExecutionAt) console.log(`Next execution: ${data.nextExecutionAt}`);
}

function printPluginList(plugins: Array<Record<string, unknown>>): void {
  if (!plugins || plugins.length === 0) {
    console.log('No plugins installed.');
    return;
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('ID', 30) + pad('Version', 12) + 'Name');
  for (const p of plugins) {
    console.log(
      pad(String(p.name ?? p.id ?? '?'), 30) +
      pad(String(p.version ?? '?'), 12) +
      String(p.description ?? '')
    );
  }
  console.log(`\n${plugins.length} plugins installed`);
}

function printMcpOAuth(data: Record<string, unknown>): void {
  if (!data) return;
  const id = data.id ?? '';

  // discover result
  if (data.required !== undefined) {
    console.log(`MCP: ${id}`);
    console.log(`OAuth required: ${data.required ? 'yes' : 'no'}`);
    if (data.supportsDynamicRegistration) console.log('Dynamic registration: supported (zero-config)');
    if (data.scopes) console.log(`Scopes: ${(data.scopes as string[]).join(', ')}`);
    return;
  }

  // status result
  if (data.status !== undefined) {
    const symbol = data.status === 'connected' ? '\u2713' : data.status === 'expired' ? '\u26A0' : '\u2717';
    console.log(`${symbol} ${id}: ${data.status}`);
    if (data.expiresAt) console.log(`  Expires: ${new Date(Number(data.expiresAt)).toLocaleString()}`);
    if (data.scope) console.log(`  Scope: ${data.scope}`);
    return;
  }

  // start result (authUrl present)
  if (data.authUrl) {
    console.log(`OAuth authorization URL:\n  ${data.authUrl}`);
    return;
  }

  // Generic fallback (revoke, etc.)
  console.log(`\u2713 ${id}: done`);
}

function printAgentRuntimeStatus(data: Record<string, unknown>): void {
  const entries = Object.values(data);
  if (entries.length === 0) {
    console.log('No agents running.');
    return;
  }
  for (const a of entries as Array<Record<string, unknown>>) {
    const enabled = a.enabled ? 'enabled' : 'disabled';
    console.log(`Agent: ${a.agentName} (${a.agentId}) [${enabled}]`);
    const channels = (a.channels as Array<Record<string, unknown>>) ?? [];
    if (channels.length === 0) {
      console.log('  No channels');
    } else {
      const pad = (s: string, n: number) => s.padEnd(n);
      for (const ch of channels) {
        const uptime = ch.uptimeSeconds ? `uptime: ${Math.round(Number(ch.uptimeSeconds) / 60)}m` : '';
        const err = ch.errorMessage ? `error: ${ch.errorMessage}` : '';
        console.log(`  ${pad(String(ch.channelId).slice(0, 16), 18)} ${pad(String(ch.channelType), 12)} ${pad(String(ch.status), 12)} ${uptime || err}`);
      }
    }
    console.log('');
  }
}

function formatObject(obj: Record<string, unknown> | undefined, indent = '  '): string {
  if (!obj) return `${indent}(empty)`;
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${indent}${k}: ${v.join(' ')}`;
      if (typeof v === 'object') return `${indent}${k}: ${JSON.stringify(v)}`;
      return `${indent}${k}: ${v}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Command routing
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(rawArgs);
  const jsonMode = !!flags.json;

  // Top-level help (no args, or bare --help)
  if (positional.length === 0) {
    console.log(TOP_HELP);
    return;
  }

  // Resolve port: --port flag overrides env
  PORT = (flags.port as string) || PORT;
  if (!PORT) {
    console.error('Error: PM_COPILOT_PORT not set. This CLI runs within the PM Copilot app.');
    process.exit(3);
  }
  BASE = `http://127.0.0.1:${PORT}/api/admin`;

  // Help flag for sub-commands
  if (flags.help) {
    const result = await callApi('help', { path: positional });
    printResult('help', 'help', result, jsonMode);
    return;
  }

  const group = positional[0];
  const action = positional[1] || 'list';

  // Simple commands (no subcommand)
  let result: Record<string, unknown>;
  if (group === 'status') {
    result = await callApi('status');
    printResult('status', 'status', result, jsonMode);
  } else if (group === 'reload') {
    result = await callApi('reload', { workspacePath: flags.workspacePath });
    printResult('reload', 'reload', result, jsonMode);
  } else if (group === 'version') {
    result = await callApi('version');
    printResult('version', 'version', result, jsonMode);
  } else {
    // Build request body based on group/action
    const restArgs = positional.slice(2);
    const body = buildRequestBody(group, action, restArgs, flags);
    const route = buildRoute(group, action, restArgs);
    result = await callApi(route, body);
    printResult(group, action, result, jsonMode);
  }

  // Exit with proper code: 0 = success, 1 = business error
  if (result && !result.success) process.exit(1);
}

function buildRoute(group: string, action: string, rest: string[]): string {
  // Handle nested commands like "agent channel list/add/remove"
  if (group === 'agent' && action === 'channel') {
    const channelAction = rest[0] || 'list';
    return `agent/channel/${channelAction}`;
  }
  // Agent runtime status
  if (group === 'agent' && action === 'runtime-status') {
    return 'agent/runtime-status';
  }
  // MCP OAuth subcommands: mcp oauth discover/start/status/revoke
  if (group === 'mcp' && action === 'oauth') {
    const oauthAction = rest[0] || 'status';
    return `mcp/oauth/${oauthAction}`;
  }
  return `${group}/${action}`;
}

function buildRequestBody(
  group: string,
  action: string,
  rest: string[],
  flags: Record<string, unknown>,
): Record<string, unknown> {
  // MCP commands
  if (group === 'mcp') {
    if (action === 'add') {
      return {
        server: {
          id: flags.id,
          name: flags.name,
          type: flags.type || 'stdio',
          command: flags.command,
          args: flags.args,
          url: flags.url,
          env: parseEnvFlags(flags.env as string[] | undefined),
          headers: parseEnvFlags(flags.headers as string[] | undefined),
          description: flags.description,
        },
        dryRun: flags.dryRun,
      };
    }
    if (action === 'remove' || action === 'enable' || action === 'disable' || action === 'test') {
      return { id: rest[0] || flags.id, scope: flags.scope };
    }
    if (action === 'oauth') {
      const oauthAction = rest[0] || 'status'; // discover | start | status | revoke
      const serverId = rest[1] || (flags.id as string);
      if (!serverId) return { id: undefined }; // will trigger missing field error
      if (oauthAction === 'start') {
        return {
          id: serverId,
          clientId: flags.clientId,
          clientSecret: flags.clientSecret,
          scopes: flags.scopes,
          callbackPort: flags.callbackPort ? Number(flags.callbackPort) : undefined,
        };
      }
      return { id: serverId };
    }
    if (action === 'env') {
      const serverId = rest[0];
      const subAction = rest[1]; // set | get | delete
      const envPairs = rest.slice(2);
      // For 'delete', bare keys (no =value) are valid — convert to KEY=1 for parseEnvFlags
      const envInput = subAction === 'delete'
        ? envPairs.map(k => k.includes('=') ? k : `${k}=`)
        : envPairs;
      return {
        id: serverId,
        action: subAction,
        env: parseEnvFlags(envInput.length > 0 ? envInput : flags.env as string[] | undefined),
      };
    }
    return {};
  }

  // Model commands
  if (group === 'model') {
    if (action === 'set-key') return { id: rest[0] || flags.id, apiKey: rest[1] || flags.apiKey };
    if (action === 'verify') return { id: rest[0] || flags.id, model: flags.model };
    if (action === 'set-default') return { id: rest[0] || flags.id };
    if (action === 'add') {
      // Structure the provider object from flags
      const provider: Record<string, unknown> = {
        id: flags.id,
        name: flags.name,
        baseUrl: flags.baseUrl,
        models: flags.models,           // array (repeatable)
        modelNames: flags.modelNames,   // array (repeatable)
        modelSeries: flags.modelSeries,
        primaryModel: flags.primaryModel,
        authType: flags.authType,
        apiProtocol: flags.protocol,    // --protocol maps to apiProtocol
        upstreamFormat: flags.upstreamFormat,
        maxOutputTokens: flags.maxOutputTokens,
        vendor: flags.vendor,
        websiteUrl: flags.websiteUrl,
        timeout: flags.timeout,
        disableNonessential: flags.disableNonessential,
      };
      // Build aliases from --aliases sonnet=model-id,opus=model-id
      if (typeof flags.aliases === 'string') {
        const aliases: Record<string, string> = {};
        for (const pair of (flags.aliases as string).split(',')) {
          const [k, v] = pair.split('=');
          if (k && v) aliases[k.trim()] = v.trim();
        }
        provider.aliases = aliases;
      }
      return { provider, dryRun: flags.dryRun };
    }
    if (action === 'remove') return { id: rest[0] || flags.id };
    return {};
  }

  // Agent commands
  if (group === 'agent') {
    if (action === 'enable' || action === 'disable') return { id: rest[0] || flags.id };
    if (action === 'set') return { id: rest[0], key: rest[1], value: tryParseJson(rest[2]) };
    if (action === 'channel') {
      const channelAction = rest[0] || 'list'; // list | add | remove
      if (channelAction === 'list') return { agentId: rest[1] || flags.agentId };
      if (channelAction === 'add') return { agentId: rest[1] || flags.agentId, channel: stripGlobalFlags(flags) };
      if (channelAction === 'remove') return { agentId: rest[1], channelId: rest[2] };
      return { agentId: rest[1] };
    }
    return {};
  }

  // Cron commands
  if (group === 'cron') {
    if (action === 'add') {
      return {
        name: flags.name,
        message: flags.prompt,
        workspacePath: flags.workspace,
        schedule: flags.schedule ? { kind: 'cron', expr: flags.schedule } : undefined,
        intervalMinutes: flags.every ? Number(flags.every) : undefined,
      };
    }
    if (action === 'start' || action === 'stop' || action === 'remove') {
      return { taskId: rest[0] || flags.id };
    }
    if (action === 'update') {
      // Map CLI flags to Rust field names expected by update_task_fields
      const patch: Record<string, unknown> = {};
      if (flags.name !== undefined) patch.name = flags.name;
      if (flags.prompt !== undefined) patch.prompt = flags.prompt;
      if (flags.schedule !== undefined) patch.schedule = { kind: 'cron', expr: flags.schedule };
      if (flags.every !== undefined) patch.intervalMinutes = Number(flags.every);
      if (flags.model !== undefined) patch.model = flags.model;
      if (flags.permissionMode !== undefined) patch.permissionMode = flags.permissionMode;
      return { taskId: rest[0] || flags.id, patch };
    }
    if (action === 'runs') {
      return { taskId: rest[0] || flags.id, limit: flags.limit ? Number(flags.limit) : undefined };
    }
    if (action === 'list' || action === 'status') {
      return { workspacePath: flags.workspace };
    }
    return {};
  }

  // Plugin commands
  if (group === 'plugin') {
    if (action === 'install') return { npmSpec: rest[0] || flags.npmSpec };
    if (action === 'remove') return { pluginId: rest[0] || flags.pluginId };
    return {};
  }

  // Config commands
  if (group === 'config') {
    if (action === 'get') return { key: rest[0] || flags.key };
    if (action === 'set') return { key: rest[0] || flags.key, value: tryParseJson(rest[1] ?? String(flags.value ?? '')), dryRun: flags.dryRun };
    return {};
  }

  return flags;
}

/** Parse KEY=VALUE pairs from --env flags */
function parseEnvFlags(envPairs: string[] | undefined): Record<string, string> | undefined {
  if (!envPairs || envPairs.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const pair of envPairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx > 0) {
      result[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Strip CLI-global flags that should not be persisted into config data */
function stripGlobalFlags(flags: Record<string, unknown>): Record<string, unknown> {
  const globalKeys = new Set(['json', 'dryRun', 'help', 'port', 'workspacePath']);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (!globalKeys.has(k)) result[k] = v;
  }
  return result;
}

/** Try to parse a string as JSON, otherwise return as-is */
function tryParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
