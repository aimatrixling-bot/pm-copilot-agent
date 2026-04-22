/**
 * title-generator.ts — AI-powered session title generation via SDK.
 *
 * Uses the same SDK query() path as normal chat, routed through Global Sidecar.
 * Single-turn, non-persistent session — lightweight and fully verified.
 *
 * Timing: triggered after 3+ QA rounds to ensure enough context for a good title.
 * For 1-2 rounds, the frontend shows a truncated first user message instead.
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv, type ProviderEnv } from './agent-session';

const TITLE_MAX_LENGTH = 30;
const TIMEOUT_MS = 15_000;
/** Max chars per user/assistant message when building context */
const PER_MESSAGE_LIMIT = 200;

const SYSTEM_PROMPT = `You are a conversation title generator. Output ONLY the title — nothing else.

Rules:
- Maximum 30 characters (CJK counts as 1)
- Language MUST match the user's language (Chinese → Chinese title, English → English)
- Identify the MAIN TOPIC or GOAL across all rounds, not just the first message
- Use specific nouns/verbs — e.g. "Redis 缓存优化" not "技术讨论"
- NEVER copy a sentence or phrase directly from the conversation
- NEVER use generic words: help, question, discussion, issue, request, 帮助, 问题, 讨论, 请求
- NEVER output meta-text about the title itself (e.g. "对话标题应该是…", "The title should be…")
- Just output the title directly, like: SSE 流式调试`;

export interface TitleRound {
  user: string;
  assistant: string;
}

function buildUserPrompt(rounds: TitleRound[]): string {
  const parts = rounds.map((r, i) => {
    const user = r.user.slice(0, PER_MESSAGE_LIMIT);
    const assistant = r.assistant.slice(0, PER_MESSAGE_LIMIT);
    return `[Round ${i + 1}]\nUser: ${user}\nAssistant: ${assistant}`;
  });
  return `<conversation>\n${parts.join('\n\n')}\n</conversation>\n\nFollow the System Instruction to generate a short title for the conversation above.`;
}

/**
 * Clean up the generated title: remove surrounding quotes, punctuation, whitespace,
 * and truncate to TITLE_MAX_LENGTH characters.
 */
function cleanTitle(raw: string): string {
  let cleaned = raw.trim();
  // Remove surrounding quotes (single, double, Chinese quotes)
  cleaned = cleaned.replace(/^["'「『《【"']+|["'」』》】"']+$/g, '');
  // Remove trailing punctuation
  cleaned = cleaned.replace(/[。，、；：！？.,:;!?…]+$/, '');
  // Remove common AI preamble patterns
  cleaned = cleaned.replace(/^(标题[：:]|Title[：:])\s*/i, '');
  cleaned = cleaned.trim();
  if (cleaned.length > TITLE_MAX_LENGTH) {
    cleaned = cleaned.slice(0, TITLE_MAX_LENGTH);
  }
  return cleaned;
}

/**
 * Generate a short session title using the SDK query() path.
 * Accepts multiple QA rounds (typically 3) for richer context.
 * Uses the user's current model and provider — single-turn, non-persistent.
 * Returns cleaned title string on success, null on any failure (silent).
 */
export async function generateTitle(
  rounds: TitleRound[],
  model: string,
  providerEnv?: ProviderEnv,
): Promise<string | null> {
  const startTime = Date.now();
  const sessionId = randomUUID();

  try {
    const cliPath = resolveClaudeCodeCli();
    const cwd = join(homedir(), '.pm-copilot', 'projects');
    mkdirSync(cwd, { recursive: true });

    const env = buildClaudeSessionEnv(providerEnv);
    const prompt = buildUserPrompt(rounds);

    async function* titlePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: prompt },
        parent_tool_use_id: null,
        session_id: sessionId,
      };
    }

    const titleQuery = query({
      prompt: titlePrompt(),
      options: {
        maxTurns: 1,
        sessionId,
        cwd,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: cliPath,
        executable: 'bun',
        env,
        systemPrompt: SYSTEM_PROMPT,
        includePartialMessages: false,
        persistSession: false,
        mcpServers: {},
        ...(model ? { model } : {}),
      },
    });

    let titleText: string | null = null;

    // Race: SDK response vs timeout
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), TIMEOUT_MS);
    });

    const queryPromise = (async (): Promise<string | null> => {
      for await (const message of titleQuery) {
        if (message.type === 'assistant') {
          const msg = message as { message?: { content?: Array<{ text?: string }> } };
          const text = msg.message?.content?.[0]?.text;
          if (text) return text;
        }
        // result type — extract from last assistant message if available
        if (message.type === 'result') {
          const resultMsg = message as { subtype?: string; messages?: Array<{ role: string; content?: Array<{ text?: string }> }> };
          if (resultMsg.subtype === 'success' && resultMsg.messages) {
            const lastAssistant = resultMsg.messages.filter(m => m.role === 'assistant').pop();
            const text = lastAssistant?.content?.[0]?.text;
            if (text) return text;
          }
        }
      }
      return null;
    })();

    titleText = await Promise.race([queryPromise, timeoutPromise]);

    // If timeout won, terminate the SDK iterator to release the subprocess
    if (titleText === null) {
      try { titleQuery.return(undefined as never); } catch { /* ignore */ }
    }

    if (!titleText) {
      console.warn(`[title-generator] No title text returned (${Date.now() - startTime}ms)`);
      return null;
    }

    const cleaned = cleanTitle(titleText);
    console.log(`[title-generator] Generated title: "${cleaned}" (${Date.now() - startTime}ms, ${rounds.length} rounds)`);
    return cleaned.length > 0 ? cleaned : null;
  } catch (err) {
    console.warn('[title-generator] SDK query failed:', err);
    return null;
  }
}
