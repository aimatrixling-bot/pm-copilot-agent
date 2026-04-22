// ClaudeCodeRuntime — drives the Claude Code CLI as a subprocess (v0.1.59)
//
// Communication: NDJSON bidirectional via stdin/stdout
// Flags: --output-format stream-json --input-format stream-json --verbose
// Permission: --permission-prompt-tool stdio (delegates to PM Copilot UI)
// System prompt: --append-system-prompt (or --bare + --append-system-prompt for IM)
// Session: --session-id / --resume

import { spawn, type Subprocess } from 'bun';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { RuntimeDetection, RuntimeModelInfo, RuntimePermissionMode, RuntimeType } from '../../shared/types/runtime';
import { CC_PERMISSION_MODES } from '../../shared/types/runtime';
import type { AgentRuntime, RuntimeProcess, SessionStartOptions, UnifiedEvent, UnifiedEventCallback } from './types';
import { augmentedProcessEnv, resolveCommand } from './env-utils';

// ─── SessionStart Hook settings generator ───
// CC's hooks fire on session lifecycle events. We inject a SessionStart hook
// that POSTs the session_id to our Sidecar HTTP endpoint for reliable tracking.

const HOOK_DIR = join(
  process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.pm-copilot', 'tmp', 'cc-hooks',
);

// Forwarder script content — inlined to avoid production bundle issues
// (bun build doesn't copy companion .cjs files into the output)
const FORWARDER_SCRIPT = `#!/usr/bin/env node
const http = require('http');
const port = parseInt(process.argv[2], 10);
if (!port || isNaN(port)) process.exit(0);
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hook/session-start',
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (r) => r.resume());
  req.on('error', () => {});
  req.end(body);
});
process.stdin.resume();
`;

/**
 * Generate temporary hook settings + forwarder script for CC SessionStart hook.
 * Both files are written to ~/.pm-copilot/tmp/cc-hooks/ (outside the project).
 */
function generateHookSettings(sidecarPort: number): string | null {
  try {
    mkdirSync(HOOK_DIR, { recursive: true });

    // Write forwarder script (idempotent)
    const forwarderPath = join(HOOK_DIR, 'forwarder.cjs');
    if (!existsSync(forwarderPath)) {
      writeFileSync(forwarderPath, FORWARDER_SCRIPT, { mode: 0o755 });
    }

    // Write settings JSON (per-process to avoid collisions)
    const settingsPath = join(HOOK_DIR, `settings-${process.pid}.json`);
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: '*',
          hooks: [{ type: 'command', command: `node "${forwarderPath}" ${sidecarPort}` }],
        }],
      },
    }));
    return settingsPath;
  } catch (err) {
    console.warn('[claude-code] Failed to generate hook settings:', err);
    return null;
  }
}

// ─── RuntimeProcess wrapper ───

class ClaudeCodeProcess implements RuntimeProcess {
  readonly pid: number;
  exited = false;
  private proc: Subprocess;
  private encoder = new TextEncoder();

  constructor(proc: Subprocess) {
    this.proc = proc;
    this.pid = proc.pid;
  }

  async writeLine(line: string): Promise<void> {
    if (this.exited) throw new Error('Process has exited');
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === 'number') throw new Error('stdin not available');
    // Bun's FileSink has .write() and .flush()
    const sink = stdin as { write(data: Uint8Array): number; flush(): void };
    sink.write(this.encoder.encode(line + '\n'));
    sink.flush();
  }

  kill(signal?: number): void {
    if (this.exited) return;
    try {
      this.proc.kill(signal ?? 15); // SIGTERM
    } catch { /* already dead */ }
  }

  async waitForExit(): Promise<number> {
    const code = await this.proc.exited;
    this.exited = true;
    return code;
  }

  /** Close stdin to signal the process to finish */
  closeStdin(): void {
    const stdin = this.proc.stdin;
    if (!stdin || typeof stdin === 'number') return;
    try {
      const sink = stdin as { end(): void };
      sink.end();
    } catch { /* ignore */ }
  }
}

// ─── Model cache ───

let modelCache: { models: RuntimeModelInfo[]; timestamp: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── ClaudeCodeRuntime ───

/**
 * Map PM Copilot permission mode values to CC CLI's --permission-mode values.
 * PM Copilot uses internal names (auto/plan/fullAgency), CC uses different names.
 */
function mapPermissionModeToCc(mode: string): string {
  switch (mode) {
    case 'auto': return 'acceptEdits';
    case 'plan': return 'plan';
    case 'fullAgency': return 'bypassPermissions';
    // CC's own mode values pass through directly
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'dontAsk':
      return mode;
    default: return 'default';
  }
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'claude-code';

  // Track content_block_index → toolUseId for associating input_json_delta with tool blocks
  private blockIndexToToolUseId = new Map<number, string>();
  // Track content_block_index → block type for correct stop events
  private blockIndexToType = new Map<number, 'text' | 'thinking' | 'tool_use'>();

  async detect(): Promise<RuntimeDetection> {
    try {
      const proc = spawn([resolveCommand('claude'), '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: augmentedProcessEnv(),
      });
      const text = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return {
          installed: true,
          version: text.trim(),
          path: 'claude', // system_binary finds full path on Rust side
        };
      }
    } catch { /* not installed */ }
    return { installed: false };
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    // Return cached if fresh
    if (modelCache && Date.now() - modelCache.timestamp < MODEL_CACHE_TTL_MS) {
      return modelCache.models;
    }

    // Reuse canonical CC_MODELS from shared types (single source of truth)
    const { CC_MODELS } = await import('../../shared/types/runtime');
    modelCache = { models: CC_MODELS, timestamp: Date.now() };
    return CC_MODELS;
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return CC_PERMISSION_MODES;
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    // Clear stale state from previous sessions (singleton instance, maps persist)
    this.blockIndexToToolUseId.clear();
    this.blockIndexToType.clear();

    const args: string[] = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',  // Required to receive stream_event (text/thinking/tool deltas)
    ];

    // System Prompt injection
    const isImOrChannel = options.scenario.type === 'im' || options.scenario.type === 'agent-channel';
    if (isImOrChannel) {
      // IM/Channel: bare mode + full system prompt
      args.push('--bare');
    }
    if (options.systemPromptAppend) {
      args.push('--append-system-prompt', options.systemPromptAppend);
    }

    // Permission mode
    if (isImOrChannel || options.scenario.type === 'cron') {
      // IM/Cron: no human to approve → bypass
      // MUST pass --allow-dangerously-skip-permissions BEFORE --dangerously-skip-permissions
      args.push('--allow-dangerously-skip-permissions');
      args.push('--permission-mode', 'bypassPermissions');
      args.push('--dangerously-skip-permissions');
    } else {
      // Desktop: delegate permission prompts to PM Copilot UI
      const ccMode = options.permissionMode ? mapPermissionModeToCc(options.permissionMode) : 'default';

      if (ccMode === 'bypassPermissions') {
        // bypassPermissions requires these two flags — even in desktop mode
        args.push('--allow-dangerously-skip-permissions');
        args.push('--dangerously-skip-permissions');
      } else {
        // Non-bypass modes: delegate permission prompts to PM Copilot via stdio
        args.push('--permission-prompt-tool', 'stdio');
      }
      args.push('--permission-mode', ccMode);
    }

    // Model
    if (options.model) {
      args.push('--model', options.model);
    }

    // Session management
    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId);
    } else {
      args.push('--session-id', options.sessionId);
    }

    // Safety limits
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }

    // Tool control
    if (options.disallowedTools?.length) {
      args.push('--disallowed-tools', ...options.disallowedTools);
    }

    // IM: disable interactive-only tools
    if (isImOrChannel) {
      args.push('--disallowed-tools', 'AskUserQuestion');
    }

    // Inject SessionStart hook settings for reliable session ID tracking
    // Read the sidecar's HTTP port from the --port CLI arg
    const portArgIdx = process.argv.indexOf('--port');
    const sidecarPort = portArgIdx >= 0 ? parseInt(process.argv[portArgIdx + 1], 10) : 0;
    if (sidecarPort > 0) {
      const hookSettingsPath = generateHookSettings(sidecarPort);
      if (hookSettingsPath) {
        args.push('--settings', hookSettingsPath);
      }
    }

    // Additional args from config
    if (options.additionalArgs?.length) {
      args.push(...options.additionalArgs);
    }

    // NOTE: Initial message is sent via stdin (not positional arg) because
    // --input-format stream-json mode ignores positional prompts and waits for stdin.

    // Log ALL args for debugging (don't truncate — user needs to see full command)
    console.log(`[claude-code] Starting session: claude ${args.join(' ')}`);

    // Augment PATH with user-level directories (e.g. ~/.local/bin where `claude` lives).
    // NOTE: Also inherits NO_PROXY from Sidecar (injected by proxy_config::apply_to_subprocess()).
    const proc = spawn([resolveCommand('claude'), ...args], {
      cwd: options.workspacePath,
      env: augmentedProcessEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'pipe',
    });

    const handle = new ClaudeCodeProcess(proc);

    // Send initial message via stdin (must happen before reading stdout to avoid deadlock)
    if (options.initialMessage) {
      const userMsg = {
        type: 'user',
        message: { role: 'user', content: options.initialMessage },
        parent_tool_use_id: null,
      };
      await handle.writeLine(JSON.stringify(userMsg));
      console.log(`[claude-code] Initial message sent via stdin (${options.initialMessage.length} chars)`);
    }

    // Read stderr for logging
    this.readStderr(proc.stderr);

    // Track process exit — only emit session_complete if NDJSON parser didn't already
    let sessionCompleteEmitted = false;
    const wrappedOnEvent: UnifiedEventCallback = (event) => {
      if (event.kind === 'session_complete') sessionCompleteEmitted = true;
      onEvent(event);
    };

    // Start reading stdout NDJSON in background (uses wrappedOnEvent)
    this.readEvents(proc.stdout, wrappedOnEvent, handle);

    proc.exited.then((code) => {
      handle.exited = true;
      console.log(`[claude-code] Process exited with code ${code}`);
      if (!sessionCompleteEmitted) {
        onEvent({
          kind: 'session_complete',
          result: '',
          subtype: code === 0 ? 'success' : 'error',
        });
      }
    });

    return handle;
  }

  async sendMessage(process: RuntimeProcess, message: string): Promise<void> {
    const userMsg = {
      type: 'user',
      message: { role: 'user', content: message },
      parent_tool_use_id: null,
    };
    await process.writeLine(JSON.stringify(userMsg));
  }

  async respondPermission(
    process: RuntimeProcess,
    requestId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void> {
    // CC expects { behavior: "allow"/"deny" }, NOT { approved: true/false }
    // See specs/research/claude_code_cli_reference.md Section 4.4.2
    const response = approved
      ? {
        type: 'control_response' as const,
        response: {
          request_id: requestId,
          subtype: 'success' as const,
          response: {
            behavior: 'allow' as const,
            decisionClassification: 'user_temporary' as const,
          },
        },
      }
      : {
        type: 'control_response' as const,
        response: {
          request_id: requestId,
          subtype: 'success' as const,
          response: {
            behavior: 'deny' as const,
            message: reason || 'User denied the request',
            interrupt: false,
            decisionClassification: 'user_reject' as const,
          },
        },
      };
    await process.writeLine(JSON.stringify(response));
  }

  async stopSession(process: RuntimeProcess): Promise<void> {
    if (process.exited) return;

    // Close stdin to let CC finish naturally
    (process as ClaudeCodeProcess).closeStdin();

    // Wait briefly then force kill
    const timeout = setTimeout(() => {
      if (!process.exited) {
        process.kill(15); // SIGTERM
      }
    }, 5000);

    await process.waitForExit().catch(() => { });
    clearTimeout(timeout);

    // Clean up per-process hook settings file
    try {
      const settingsPath = join(HOOK_DIR, `settings-${process.pid}.json`);
      if (existsSync(settingsPath)) unlinkSync(settingsPath);
    } catch { /* best-effort cleanup */ }
  }

  // ─── Private: NDJSON event stream reader ───

  private async readEvents(
    stdout: ReadableStream<Uint8Array>,
    onEvent: UnifiedEventCallback,
    handle: ClaudeCodeProcess,
  ): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineCount = 0;

    console.log('[claude-code] NDJSON reader started, waiting for stdout data...');

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[claude-code] stdout stream ended after ${lineCount} lines`);
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          lineCount++;
          // Log first few lines and then periodically for diagnostics
          if (lineCount <= 5 || lineCount % 50 === 0) {
            const preview = line.length > 500 ? line.slice(0, 500) + '...' : line;
            console.log(`[claude-code] stdout line #${lineCount}: ${preview}`);
          }
          const event = this.parseLine(line);
          if (event) {
            // Log non-delta events (deltas are too frequent)
            if (event.kind !== 'text_delta' && event.kind !== 'thinking_delta' && event.kind !== 'tool_input_delta') {
              console.log(`[claude-code] event: ${event.kind}`);
            }
            onEvent(event);
          }
        }
      }
    } catch (err) {
      if (!handle.exited) {
        console.error('[claude-code] stdout read error:', err);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.trim()) {
          console.log(`[claude-code:stderr] ${text.trim()}`);
        }
      }
    } catch { /* ignore */ } finally {
      reader.releaseLock();
    }
  }

  // ─── Private: NDJSON line parser ───

  private parseLine(line: string): UnifiedEvent | null {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return null;
    }

    switch (msg.type) {
      case 'stream_event':
        return this.parseStreamEvent(msg.event as Record<string, unknown>);

      case 'assistant':
        // Complete assistant message (for replay / resume)
        return {
          kind: 'message_replay',
          message: {
            id: (msg.uuid as string) || '',
            role: 'assistant',
            content: (msg.message as Record<string, unknown>)?.content,
          },
        };

      case 'user':
        return {
          kind: 'message_replay',
          message: {
            id: (msg.uuid as string) || '',
            role: 'user',
            content: (msg.message as Record<string, unknown>)?.content,
          },
        };

      case 'system':
        return this.parseSystemMessage(msg);

      case 'result':
        return {
          kind: 'session_complete',
          result: (msg.result as string) || '',
          subtype: this.mapResultSubtype(msg.subtype as string),
        };

      case 'control_request': {
        const request = msg.request as Record<string, unknown> | undefined;
        if (request?.subtype === 'can_use_tool') {
          return {
            kind: 'permission_request',
            // request_id is at the TOP level of control_request, not inside .request
            requestId: (msg.request_id as string) || '',
            toolName: (request.tool_name as string) || '',
            toolUseId: (request.tool_use_id as string) || '',
            input: (request.input as Record<string, unknown>) || {},
          };
        }
        return null;
      }

      case 'rate_limit_event':
        return { kind: 'log', level: 'warn', message: 'Rate limited by API' };

      default:
        return null;
    }
  }

  private parseStreamEvent(event: Record<string, unknown> | undefined): UnifiedEvent | null {
    if (!event) return null;

    switch (event.type) {
      case 'content_block_start': {
        const block = event.content_block as Record<string, unknown>;
        const index = event.index as number | undefined;
        if (block?.type === 'tool_use') {
          const toolUseId = (block.id as string) || '';
          if (index !== undefined) {
            this.blockIndexToToolUseId.set(index, toolUseId);
            this.blockIndexToType.set(index, 'tool_use');
          }
          return {
            kind: 'tool_use_start',
            toolUseId,
            toolName: (block.name as string) || '',
          };
        }
        if (block?.type === 'thinking') {
          const idx = index ?? 0;
          if (index !== undefined) {
            this.blockIndexToType.set(index, 'thinking');
          }
          return { kind: 'thinking_start', index: idx };
        }
        // Text block
        if (index !== undefined) {
          this.blockIndexToType.set(index, 'text');
        }
        return null;
      }

      case 'content_block_delta': {
        const delta = event.delta as Record<string, unknown>;
        const index = event.index as number | undefined;
        if (delta?.type === 'text_delta') {
          return { kind: 'text_delta', text: (delta.text as string) || '' };
        }
        if (delta?.type === 'thinking_delta') {
          return { kind: 'thinking_delta', text: (delta.thinking as string) || '', index: index ?? 0 };
        }
        if (delta?.type === 'input_json_delta') {
          const toolUseId = (index !== undefined ? this.blockIndexToToolUseId.get(index) : undefined) || '';
          return {
            kind: 'tool_input_delta',
            toolUseId,
            delta: (delta.partial_json as string) || '',
          };
        }
        return null;
      }

      case 'content_block_stop': {
        const index = event.index as number | undefined;
        const blockType = index !== undefined ? this.blockIndexToType.get(index) : undefined;
        if (blockType === 'tool_use') {
          const toolUseId = (index !== undefined ? this.blockIndexToToolUseId.get(index) : undefined) || '';
          return { kind: 'tool_use_stop', toolUseId };
        }
        if (blockType === 'thinking') {
          return { kind: 'thinking_stop', index: index ?? 0 };
        }
        return { kind: 'text_stop' };
      }

      case 'message_stop':
        return { kind: 'turn_complete' };

      case 'message_start':
        return { kind: 'status_change', state: 'running' };

      default:
        return null;
    }
  }

  private parseSystemMessage(msg: Record<string, unknown>): UnifiedEvent | null {
    switch (msg.subtype) {
      case 'init':
        return {
          kind: 'session_init',
          sessionId: (msg.session_id as string) || '',
          model: (msg.model as string) || '',
          tools: (msg.tools as string[]) || [],
        };
      case 'status':
      case 'session_state_changed':
        return { kind: 'status_change', state: 'running' };
      default:
        return null;
    }
  }

  private mapResultSubtype(subtype: string): 'success' | 'error' | 'error_max_turns' | 'error_max_budget' {
    switch (subtype) {
      case 'success': return 'success';
      case 'error_max_turns': return 'error_max_turns';
      case 'error_max_budget_usd': return 'error_max_budget';
      default: return 'error';
    }
  }
}
