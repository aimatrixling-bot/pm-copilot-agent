// Cron Tool — AI-driven scheduled task management for all Sidecar sessions
// Supports both IM Bot sessions (with delivery) and regular Chat sessions
// Uses Rust Management API (via PM_COPILOT_MANAGEMENT_PORT) for cron task CRUD

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

// MCP Tool Result type
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ===== IM Cron Context =====

interface ImCronContext {
  botId: string;
  chatId: string;
  platform: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' };
}

let imCronContext: ImCronContext | null = null;

export function setImCronContext(ctx: ImCronContext): void {
  imCronContext = ctx;
  console.log(`[im-cron] Context set: botId=${ctx.botId}, chatId=${ctx.chatId}`);
}

export function clearImCronContext(): void {
  imCronContext = null;
  console.log('[im-cron] Context cleared');
}

export function getImCronContext(): ImCronContext | null {
  return imCronContext;
}

// ===== Session Cron Context (for non-IM sessions) =====

export interface SessionCronContext {
  sessionId: string;
  workspacePath: string;
  model?: string;
  permissionMode?: string;
  providerEnv?: { baseUrl?: string; apiKey?: string; authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key'; apiProtocol?: 'anthropic' | 'openai'; maxOutputTokens?: number; maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'; upstreamFormat?: 'chat_completions' | 'responses' };
}

let sessionCronContext: SessionCronContext | null = null;

export function setSessionCronContext(ctx: SessionCronContext): void {
  sessionCronContext = ctx;
  console.log(`[im-cron] Session cron context set: sessionId=${ctx.sessionId}`);
}

export function clearSessionCronContext(): void {
  sessionCronContext = null;
  console.log('[im-cron] Session cron context cleared');
}

export function getSessionCronContext(): SessionCronContext | null {
  return sessionCronContext;
}

// ===== Management API client =====

const MANAGEMENT_PORT = process.env.PM_COPILOT_MANAGEMENT_PORT;

async function managementApi(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
  if (!MANAGEMENT_PORT) {
    throw new Error('PM_COPILOT_MANAGEMENT_PORT not set — management API unavailable');
  }

  const url = `http://127.0.0.1:${MANAGEMENT_PORT}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && method === 'POST') {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  return resp.json();
}

// ===== Ownership verification =====

/**
 * Verify that a task belongs to the current session's workspace (or IM bot).
 * Prevents cross-session/cross-workspace task manipulation.
 * Returns an error CallToolResult if verification fails, or null if OK.
 */
async function verifyTaskOwnership(taskId: string, action: string): Promise<CallToolResult | null> {
  const ctx = imCronContext || sessionCronContext;
  if (!ctx) {
    return {
      content: [{ type: 'text', text: `Error: No cron context available. Cannot ${action} tasks without session context.` }],
      isError: true,
    };
  }

  // Build query: IM sessions filter by botId, desktop sessions by workspace
  const query = imCronContext
    ? `?sourceBotId=${encodeURIComponent(imCronContext.botId)}`
    : `?workspacePath=${encodeURIComponent(ctx.workspacePath)}`;

  const result = await managementApi(`/api/cron/list${query}`) as {
    tasks: Array<{ id: string }>;
  };

  const taskBelongsToContext = result.tasks.some(t => t.id === taskId);
  if (!taskBelongsToContext) {
    return {
      content: [{ type: 'text', text: `Error: Task ${taskId} does not belong to this workspace. You can only ${action} tasks within the current workspace.` }],
      isError: true,
    };
  }

  return null; // ownership verified
}

// ===== Tool handler =====

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('at'),
    at: z.string().describe('ISO-8601 datetime for one-shot execution, e.g. "2024-12-01T14:30:00+08:00"'),
  }),
  z.object({
    kind: z.literal('every'),
    minutes: z.number().min(5).describe('Interval in minutes (minimum 5)'),
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z.string().describe('Cron expression, e.g. "0 9 * * *" for daily 9 AM'),
    tz: z.string().optional().describe('IANA timezone, e.g. "Asia/Shanghai"'),
  }),
  z.object({
    kind: z.literal('loop'),
  }).describe('Ralph Loop: completion-triggered infinite loop. AI finishes → 3s buffer → execute again. Always uses single_session. Stops after 10 consecutive failures.'),
]);

async function imCronToolHandler(args: {
  action: 'list' | 'add' | 'update' | 'remove' | 'run' | 'runs' | 'status' | 'wake' | 'channels';
  job?: {
    name?: string;
    schedule: z.infer<typeof scheduleSchema>;
    message: string;
    sessionTarget?: 'new_session' | 'single_session';
    deliverTo?: string;
  };
  taskId?: string;
  patch?: {
    name?: string;
    message?: string;
    schedule?: z.infer<typeof scheduleSchema>;
    intervalMinutes?: number;
  };
  limit?: number;
  text?: string;
}): Promise<CallToolResult> {
  if (!MANAGEMENT_PORT) {
    return {
      content: [{ type: 'text', text: 'Error: Cron management API is not available (PM_COPILOT_MANAGEMENT_PORT not set).' }],
      isError: true,
    };
  }

  try {
    switch (args.action) {
      case 'add': {
        if (!args.job) {
          return {
            content: [{ type: 'text', text: 'Error: "job" is required for "add" action.' }],
            isError: true,
          };
        }

        // Resolve context: prefer IM context, fall back to session context
        const addCtx = imCronContext || sessionCronContext;
        if (!addCtx) {
          return {
            content: [{ type: 'text', text: 'Error: No cron context available. Cannot create scheduled tasks without session context.' }],
            isError: true,
          };
        }

        // Validate: "at" schedule must be in the future
        if (args.job.schedule.kind === 'at') {
          const atTime = new Date(args.job.schedule.at).getTime();
          const now = Date.now();
          if (isNaN(atTime)) {
            return {
              content: [{ type: 'text', text: `Error: Invalid datetime "${args.job.schedule.at}". Use ISO-8601 format, e.g. "2024-12-01T14:30:00+08:00". Tip: run \`date\` to check the current system time.` }],
              isError: true,
            };
          }
          if (atTime < now - 60_000) { // 1-minute tolerance for clock skew
            const nowIso = new Date().toISOString();
            return {
              content: [{ type: 'text', text: `Error: Scheduled time "${args.job.schedule.at}" is in the past (current time: ${nowIso}). Please run \`date\` to verify the current time and provide a future datetime.` }],
              isError: true,
            };
          }
        }

        // Build create payload
        const createPayload: Record<string, unknown> = {
          name: args.job.name,
          schedule: args.job.schedule,
          message: args.job.message,
          sessionTarget: args.job.sessionTarget ?? 'new_session',
          workspacePath: addCtx.workspacePath,
          model: addCtx.model,
          permissionMode: addCtx.permissionMode ?? 'auto',
          providerEnv: addCtx.providerEnv,
          intervalMinutes: args.job.schedule.kind === 'every' ? args.job.schedule.minutes : 30,
        };

        // --- Delivery resolution (3-tier priority) ---
        // Always set sourceBotId when in IM context, regardless of deliverTo target.
        // This ensures IM-created tasks remain listable/updatable from the originating IM session.
        if (imCronContext) {
          createPayload.sourceBotId = imCronContext.botId;
        }

        let deliveryDesc = '';
        if (args.job.deliverTo) {
          // 1. Explicit: AI specified a target channel by botId
          const channelsResp = await managementApi('/api/im/channels') as {
            ok: boolean; channels: Array<{ botId: string; platform: string; name: string }>;
          };
          const target = channelsResp.channels?.find(ch => ch.botId === args.job!.deliverTo);
          if (!target) {
            const available = channelsResp.channels?.length
              ? channelsResp.channels.map(ch => `${ch.name}(${ch.platform}): ${ch.botId}`).join(', ')
              : 'none — set up a channel in Agent settings first';
            return {
              content: [{ type: 'text', text: `Error: Channel "${args.job.deliverTo}" not found. Available channels: ${available}. Use "channels" action to list all.` }],
              isError: true,
            };
          }
          createPayload.delivery = {
            botId: target.botId,
            chatId: '_auto_', // placeholder — deliver_cron_result_to_bot resolves via router, never reads this field
            platform: target.platform,
          };
          deliveryDesc = ` Results will be delivered to ${target.name} (${target.platform}).`;
        } else if (imCronContext) {
          // 2. Auto: IM session → deliver back to source chat
          createPayload.delivery = {
            botId: imCronContext.botId,
            chatId: imCronContext.chatId,
            platform: imCronContext.platform,
          };
          deliveryDesc = ` Results will be delivered to this chat.`;
        }
        // 3. None: desktop session without deliverTo → no delivery (results stored locally)

        const result = await managementApi('/api/cron/create', 'POST', createPayload) as {
          ok: boolean; taskId?: string; nextExecutionAt?: string; error?: string;
        };

        if (result.ok) {
          const scheduleDescription = formatSchedule(args.job.schedule);
          const resultJson = {
            ok: true,
            taskId: result.taskId,
            name: args.job.name || args.job.message.substring(0, 20),
            schedule: args.job.schedule,
            scheduleDesc: scheduleDescription,
            nextExecutionAt: result.nextExecutionAt,
            deliverTo: args.job.deliverTo || (imCronContext ? imCronContext.botId : null),
            message: `Scheduled task created. ${scheduleDescription}${deliveryDesc}`,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(resultJson) }],
          };
        }
        return {
          content: [{ type: 'text', text: `Error creating task: ${result.error}` }],
          isError: true,
        };
      }

      case 'list': {
        // Filter by sourceBotId for IM sessions, by workspace for desktop sessions
        const listCtx = imCronContext || sessionCronContext;
        const query = imCronContext
          ? `?sourceBotId=${encodeURIComponent(imCronContext.botId)}`
          : listCtx?.workspacePath
            ? `?workspacePath=${encodeURIComponent(listCtx.workspacePath)}`
            : '';
        const result = await managementApi(`/api/cron/list${query}`) as {
          tasks: Array<{
            id: string;
            name?: string;
            prompt: string;
            status: string;
            schedule?: unknown;
            intervalMinutes: number;
            executionCount: number;
            lastExecutedAt?: string;
            createdAt: string;
          }>;
        };

        if (result.tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No scheduled tasks found.' }],
          };
        }

        const lines = result.tasks.map((t, i) => {
          const schedule = t.schedule ? JSON.stringify(t.schedule) : `every ${t.intervalMinutes} min`;
          return `${i + 1}. [${t.status}] ${t.name || t.id}\n   Schedule: ${schedule}\n   Message: ${t.prompt.slice(0, 80)}${t.prompt.length > 80 ? '...' : ''}\n   Executions: ${t.executionCount}${t.lastExecutedAt ? `, last: ${t.lastExecutedAt}` : ''}`;
        });

        return {
          content: [{ type: 'text', text: `Scheduled Tasks:\n\n${lines.join('\n\n')}` }],
        };
      }

      case 'update': {
        if (!args.taskId || !args.patch) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" and "patch" are required for "update" action.' }],
            isError: true,
          };
        }

        // Verify task belongs to current workspace
        const updateOwnershipError = await verifyTaskOwnership(args.taskId, 'update');
        if (updateOwnershipError) return updateOwnershipError;

        // Validate: if updating schedule to an "at" time, it must be in the future
        const patchSchedule = args.patch.schedule as { kind: string; at?: string } | undefined;
        if (patchSchedule?.kind === 'at' && patchSchedule.at) {
          const atTime = new Date(patchSchedule.at).getTime();
          const now = Date.now();
          if (isNaN(atTime)) {
            return {
              content: [{ type: 'text', text: `Error: Invalid datetime "${patchSchedule.at}". Use ISO-8601 format, e.g. "2024-12-01T14:30:00+08:00". Tip: run \`date\` to check the current system time.` }],
              isError: true,
            };
          }
          if (atTime < now - 60_000) {
            const nowIso = new Date().toISOString();
            return {
              content: [{ type: 'text', text: `Error: Scheduled time "${patchSchedule.at}" is in the past (current time: ${nowIso}). Please run \`date\` to verify the current time and provide a future datetime.` }],
              isError: true,
            };
          }
        }

        // Normalize patch: map "message" → "prompt" (tool schema uses "message", backend uses "prompt")
        // Also defensively handle AI nesting fields inside "job" (matching "add" schema structure)
        const rawPatch: Record<string, unknown> = { ...args.patch };
        if (rawPatch.job && typeof rawPatch.job === 'object') {
          const job = rawPatch.job as Record<string, unknown>;
          if (job.message && !rawPatch.message) rawPatch.message = job.message;
          if (job.name && !rawPatch.name) rawPatch.name = job.name;
          if (job.schedule && !rawPatch.schedule) rawPatch.schedule = job.schedule;
          delete rawPatch.job;
        }
        if (rawPatch.message) {
          rawPatch.prompt = rawPatch.message;
          delete rawPatch.message;
        }

        const result = await managementApi('/api/cron/update', 'POST', {
          taskId: args.taskId,
          patch: rawPatch,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} updated successfully.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      case 'remove': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" is required for "remove" action.' }],
            isError: true,
          };
        }

        // Verify task belongs to current workspace
        const removeOwnershipError = await verifyTaskOwnership(args.taskId, 'remove');
        if (removeOwnershipError) return removeOwnershipError;

        const result = await managementApi('/api/cron/delete', 'POST', {
          taskId: args.taskId,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} deleted.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      case 'run': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" is required for "run" action.' }],
            isError: true,
          };
        }

        // Verify task belongs to current workspace
        const runOwnershipError = await verifyTaskOwnership(args.taskId, 'trigger');
        if (runOwnershipError) return runOwnershipError;

        const result = await managementApi('/api/cron/run', 'POST', {
          taskId: args.taskId,
        }) as { ok: boolean; error?: string };

        return result.ok
          ? { content: [{ type: 'text', text: `Task ${args.taskId} triggered for immediate execution.` }] }
          : { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      }

      case 'runs': {
        if (!args.taskId) {
          return {
            content: [{ type: 'text', text: 'Error: "taskId" is required for "runs" action.' }],
            isError: true,
          };
        }

        // Verify task belongs to current workspace
        const runsOwnershipError = await verifyTaskOwnership(args.taskId, 'view execution history of');
        if (runsOwnershipError) return runsOwnershipError;

        const limit = args.limit || 20;
        const resp = await managementApi(
          `/api/cron/runs?taskId=${encodeURIComponent(args.taskId)}&limit=${limit}`,
        ) as { ok: boolean; runs: Array<{ ts: number; ok: boolean; duration_ms: number; content?: string; error?: string }> };

        if (!resp.runs || resp.runs.length === 0) {
          return { content: [{ type: 'text', text: 'No execution records found for this task.' }] };
        }

        const lines = resp.runs.map((r, i) => {
          const time = new Date(r.ts).toISOString();
          const status = r.ok ? 'OK' : 'FAIL';
          const dur = r.duration_ms < 1000 ? `${r.duration_ms}ms` : `${(r.duration_ms / 1000).toFixed(1)}s`;
          let line = `${i + 1}. [${status}] ${time} (${dur})`;
          if (r.error) line += `\n   Error: ${r.error}`;
          if (r.content) line += `\n   Output: ${r.content.slice(0, 120)}${r.content.length > 120 ? '...' : ''}`;
          return line;
        });

        return {
          content: [{ type: 'text', text: `Execution History (last ${resp.runs.length}):\n\n${lines.join('\n\n')}` }],
        };
      }

      case 'status': {
        // For IM sessions, filter by botId; for desktop sessions, filter by workspace
        const statusCtx = imCronContext || sessionCronContext;
        const statusQuery = imCronContext
          ? `?botId=${encodeURIComponent(imCronContext.botId)}`
          : statusCtx?.workspacePath
            ? `?workspacePath=${encodeURIComponent(statusCtx.workspacePath)}`
            : '';
        const resp = await managementApi(
          `/api/cron/status${statusQuery}`,
        ) as { ok: boolean; totalTasks: number; runningTasks: number; lastExecutedAt?: string; nextExecutionAt?: string };

        const parts = [
          `Total tasks: ${resp.totalTasks}`,
          `Running: ${resp.runningTasks}`,
        ];
        if (resp.lastExecutedAt) parts.push(`Last executed: ${resp.lastExecutedAt}`);
        if (resp.nextExecutionAt) parts.push(`Next execution: ${resp.nextExecutionAt}`);

        return { content: [{ type: 'text', text: `Cron Status:\n${parts.join('\n')}` }] };
      }

      case 'wake': {
        if (!imCronContext) {
          return {
            content: [{ type: 'text', text: 'Error: "wake" action is only available in IM Bot sessions.' }],
            isError: true,
          };
        }
        const resp = await managementApi('/api/im/wake', 'POST', {
          botId: imCronContext.botId,
          text: args.text || undefined,
        }) as { ok: boolean; error?: string };

        return resp.ok
          ? { content: [{ type: 'text', text: 'Heartbeat wake triggered.' }] }
          : { content: [{ type: 'text', text: `Wake failed: ${resp.error}` }], isError: true };
      }

      case 'channels': {
        const result = await managementApi('/api/im/channels') as {
          ok: boolean;
          channels: Array<{ botId: string; platform: string; name: string; agentName?: string; status: string }>;
        };

        if (!result.channels || result.channels.length === 0) {
          return {
            content: [{ type: 'text', text: 'No IM channels configured. The user needs to set up an Agent channel (Telegram/Feishu/DingTalk) in Settings first.' }],
          };
        }

        const lines = result.channels.map((ch, i) =>
          `${i + 1}. [${ch.status}] ${ch.name} (${ch.platform}) — botId: ${ch.botId}${ch.agentName ? ` (Agent: ${ch.agentName})` : ''}`,
        );

        return {
          content: [{ type: 'text', text: `Available delivery channels:\n\n${lines.join('\n')}` }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown action: ${args.action}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

function formatSchedule(schedule: z.infer<typeof scheduleSchema>): string {
  switch (schedule.kind) {
    case 'at':
      return `One-shot at ${schedule.at}`;
    case 'every':
      return `Every ${schedule.minutes} minutes`;
    case 'cron':
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
    case 'loop':
      return 'Ralph Loop (completion-triggered)';
  }
}

// ===== Server creation =====

export function createImCronToolServer() {
  return createSdkMcpServer({
    name: 'im-cron',
    version: '1.0.0',
    tools: [
      tool(
        'cron',
        `Create, list, update, remove, or manually trigger scheduled tasks.
Supports delivering results to IM channels (Telegram, Feishu, DingTalk, etc.).

Actions:
- "add": Create a scheduled task. Optionally deliver results to an IM channel via "deliverTo" (set to a botId).
- "list": List all scheduled tasks in the current workspace
- "update": Modify an existing task (name, message, schedule)
- "remove": Delete a task
- "run": Trigger a task immediately
- "runs": View execution history of a task
- "status": Check overall task statistics
- "channels": List available IM channels for delivery (returns botId, platform, name, status)
- "wake": Manually trigger a heartbeat check (IM Bot sessions only)

**Delivery to IM channels:**
When the user wants task results sent to an IM channel (e.g. "run this daily and notify me on Feishu"):
1. Call with action "channels" to get available botIds
2. Call with action "add" and set job.deliverTo to the chosen botId
If "deliverTo" is omitted: IM sessions auto-deliver to the current chat; desktop sessions store results locally (viewable via "runs").

**Time awareness:** Before creating "at" (one-shot) schedules, run \`date\` to confirm the current local time.

Schedules: "at" (one-shot ISO-8601), "every" (interval ≥5min), "cron" (cron expression + optional timezone), "loop" (Ralph Loop — completion-triggered infinite loop, always single_session, stops after 10 consecutive failures).
Each task runs independently in a new AI session (except "loop" which uses single_session).`,
        {
          action: z.enum(['list', 'add', 'update', 'remove', 'run', 'runs', 'status', 'wake', 'channels'])
            .describe('Action to perform'),
          job: z.object({
            name: z.string().optional().describe('Human-readable task name'),
            schedule: scheduleSchema,
            message: z.string().describe('The prompt/instruction for the AI to execute'),
            sessionTarget: z.enum(['new_session', 'single_session']).optional()
              .describe('Whether to create a new session each time (default) or reuse one'),
            deliverTo: z.string().optional()
              .describe('botId of the IM channel to deliver results to. Use "channels" action to find available botIds.'),
          }).optional().describe('Required for "add" action'),
          taskId: z.string().optional().describe('Task ID (required for update/remove/run/runs)'),
          patch: z.object({
            name: z.string().optional().describe('New task name'),
            message: z.string().optional().describe('New prompt/instruction text'),
            schedule: scheduleSchema.optional().describe('New schedule'),
            intervalMinutes: z.number().min(5).optional().describe('New interval in minutes'),
          }).optional().describe('Fields to update (for "update" action). Use top-level keys, NOT nested inside "job".'),
          limit: z.number().optional().describe('Max records to return (for "runs", default 20, max 100)'),
          text: z.string().optional().describe('Optional text to inject as system event (for "wake")'),
        },
        imCronToolHandler,
      ),
    ],
  });
}

export const imCronToolServer = createImCronToolServer();
