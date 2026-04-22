/**
 * Provider verification utilities
 * Verifies API key validity by sending a test request
 */

import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveClaudeCodeCli, buildClaudeSessionEnv } from './agent-session';
// Subscription types (keep in sync with src/renderer/types/subscription.ts)
export interface SubscriptionInfo {
  accountUuid?: string;
  email?: string;
  displayName?: string;
  organizationName?: string;
}

export interface SubscriptionStatus {
  available: boolean;
  path?: string;
  info?: SubscriptionInfo;
}

// Error message parser for subscription verification
function parseSubscriptionError(errorText: string, originalText?: string): VerifyError {
  const raw = (originalText ?? errorText).slice(0, 300) || undefined;
  const lower = errorText.toLowerCase();
  if (lower.includes('authentication') || lower.includes('login') || lower.includes('/login')) {
    return { error: '登录已过期，请重新登录 (claude --login)', detail: raw };
  } else if (lower.includes('forbidden') || lower.includes('403')) {
    return { error: '登录已过期，请重新登录 (claude --login)', detail: raw };
  } else if (lower.includes('rate limit') || lower.includes('429')) {
    return { error: '请求频率限制，请稍后再试', detail: raw };
  } else if (lower.includes('network') || lower.includes('connect')) {
    return { error: '网络连接失败', detail: raw };
  }
  return { error: errorText.slice(0, 100) || '验证失败', detail: raw };
}

// Structured error result with human-friendly summary + raw detail for diagnosis
interface VerifyError {
  error: string;
  detail?: string;
}

// Error message parser for provider API key verification
// Returns { error (human-friendly), detail (raw) } so the frontend can show both.
// `errorText` may be lowercased by caller; `originalText` preserves original casing for detail.
function parseProviderError(errorText: string, originalText?: string): VerifyError {
  const raw = (originalText ?? errorText).slice(0, 300) || undefined;
  const lower = errorText.toLowerCase();
  if (lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('401')) {
    return { error: 'API Key 无效或已过期', detail: raw };
  } else if (lower.includes('forbidden') || lower.includes('403')) {
    return { error: '访问被拒绝，请检查 API Key 权限', detail: raw };
  } else if (lower.includes('rate limit') || lower.includes('429')) {
    return { error: '请求频率限制，请稍后再试', detail: raw };
  } else if (lower.includes('network') || lower.includes('connect') || lower.includes('econnrefused')) {
    return { error: '网络连接失败，请检查 Base URL', detail: raw };
  } else if (lower.includes('not found') || lower.includes('404')) {
    return { error: '模型不存在或 API 地址错误', detail: raw };
  }
  return { error: errorText.slice(0, 100) || '验证失败', detail: raw };
}

/**
 * Shared SDK verification core.
 * Spawns an SDK subprocess with a trivial test prompt and returns success/failure.
 */
async function verifyViaSdk(
  env: NodeJS.ProcessEnv,
  opts: {
    model?: string;
    sessionId: string;
    logPrefix: string;
    parseError: (text: string, originalText?: string) => VerifyError;
    settingSources: ('user' | 'project')[];
  },
): Promise<{ success: boolean; error?: string; detail?: string }> {
  const TIMEOUT_MS = 30000;
  const startTime = Date.now();
  const stderrMessages: string[] = [];
  // Collect the first real API error seen during the verify window.
  // If the SDK retries internally (e.g. 429) and our timeout fires first,
  // we use this instead of the generic "验证超时" message.
  let firstAuthError: VerifyError | undefined;
  const { logPrefix, parseError } = opts;

  try {
    const cliPath = resolveClaudeCodeCli();
    // Use ~/.pm-copilot/projects/ as cwd — a dedicated app directory with guaranteed permissions.
    // Avoids potential permission or .claude/ config issues in home directory.
    const cwd = join(homedir(), '.pm-copilot', 'projects');
    mkdirSync(cwd, { recursive: true });

    async function* simplePrompt() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: 'It\'s a test, directly reply "1"' },
        parent_tool_use_id: null,
        session_id: opts.sessionId,
      };
    }

    // Determine thinking config — mirrors startStreamingSession() logic.
    // Third-party anthropic-protocol providers (SiliconFlow etc.) reject `thinking: {type:"adaptive"}`
    // with 400 "thinking type should be enabled or disabled". Only enable for Claude models or official API.
    const modelLower = (opts.model ?? '').toLowerCase();
    const isClaudeModel = modelLower.includes('sonnet-4') || modelLower.includes('sonnet-5')
      || modelLower.includes('opus-4') || modelLower.includes('opus-5');
    const isOfficialAnthropicApi = !env.ANTHROPIC_BASE_URL || (() => {
      try { return new URL(env.ANTHROPIC_BASE_URL!).host === 'api.anthropic.com'; }
      catch { return false; }
    })();
    const thinkingConfig = (isOfficialAnthropicApi || isClaudeModel)
      ? { type: 'adaptive' as const }
      : { type: 'disabled' as const };

    const testQuery = query({
      prompt: simplePrompt(),
      options: {
        maxTurns: 1,
        sessionId: opts.sessionId,
        cwd,
        settingSources: opts.settingSources,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: cliPath,
        executable: 'bun',
        env,
        thinking: thinkingConfig,
        stderr: (message: string) => {
          console.error(`[${logPrefix}] stderr:`, message);
          stderrMessages.push(message);
        },
        systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
        includePartialMessages: true,
        persistSession: false,
        mcpServers: {},
        ...(opts.model ? { model: opts.model } : {}),
      },
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ success: false; error: string; detail?: string }>((resolve) => {
      timeoutId = setTimeout(() => {
        // Priority: real API error collected during retries > stderr > generic timeout
        if (firstAuthError) {
          console.log(`[${logPrefix}] timeout but have auth error collected, using it`);
          resolve({ success: false, error: firstAuthError.error, detail: firstAuthError.detail });
          return;
        }
        const stderrHint = stderrMessages.length > 0
          ? ` (stderr: ${stderrMessages.join('; ').slice(0, 200)})`
          : '';
        resolve({ success: false, error: `验证超时，请检查网络连接${stderrHint}` });
      }, TIMEOUT_MS);
    });
    // Cleanup helper: terminate SDK subprocess regardless of race outcome.
    // Without this, the losing promise's `for await` keeps the subprocess alive.
    const cleanupQuery = () => {
      try { testQuery.return(undefined as never); } catch { /* already terminated */ }
    };

    const verifyPromise = (async (): Promise<{ success: boolean; error?: string; detail?: string }> => {
      for await (const message of testQuery) {
        if (message.type === 'system') continue;

        // With includePartialMessages, stream_event arrives before result.
        // A message_start event means the API accepted our request and is streaming
        // a response — the API key is valid. Return success immediately.
        if (message.type === 'stream_event') {
          const streamMsg = message as { event?: { type?: string } };
          if (streamMsg.event?.type === 'message_start') {
            const elapsed = Date.now() - startTime;
            console.log(`[${logPrefix}] verification successful (${elapsed}ms)`);
            return { success: true };
          }
          continue;
        }

        // assistant message: check for SDK-wrapped errors first.
        // When API returns 403/401, SDK wraps it as a synthetic assistant message
        // with an `error` field (e.g. "authentication_failed"). Without this check,
        // verification would falsely report success.
        if (message.type === 'assistant') {
          const assistantMsg = message as { error?: string; message?: { content?: Array<{ text?: string }> } };
          if (assistantMsg.error) {
            const errorDetail = assistantMsg.message?.content?.[0]?.text ?? assistantMsg.error;
            console.error(`[${logPrefix}] auth error: ${errorDetail}`);
            const parsed = parseError(errorDetail.toLowerCase(), errorDetail);
            // Store the first auth error so the timeout handler can use it
            // if the SDK keeps retrying and our timeout fires first.
            if (!firstAuthError) firstAuthError = parsed;
            return { success: false, ...parsed };
          }
          const elapsed = Date.now() - startTime;
          console.log(`[${logPrefix}] verification successful (${elapsed}ms)`);
          return { success: true };
        }

        if (message.type === 'result') {
          const resultMsg = message as {
            subtype?: string;
            errors?: string[];
          };

          if (resultMsg.subtype === 'success') {
            console.log(`[${logPrefix}] verification successful`);
            return { success: true };
          }

          // Error result (error_during_execution, error_max_turns, etc.)
          const errorsArray = resultMsg.errors;
          const errorText = (errorsArray && errorsArray.length > 0)
            ? errorsArray.join('; ')
            : resultMsg.subtype || '验证失败';
          console.error(`[${logPrefix}] error: ${errorText} (subtype: ${resultMsg.subtype})`);
          const parsed = parseError(errorText);
          const stderrHint = stderrMessages.length > 0
            ? ` (详情: ${stderrMessages.join('; ').slice(0, 100)})`
            : '';
          return { success: false, error: parsed.error + stderrHint, detail: parsed.detail };
        }
      }

      const stderrHint = stderrMessages.length > 0
        ? `: ${stderrMessages.join('; ').slice(0, 200)}`
        : '';
      return { success: false, error: `验证未返回结果${stderrHint}` };
    })();

    try {
      return await Promise.race([verifyPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      cleanupQuery();
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${logPrefix}] SDK exception: ${errorMsg}`);
    const parsed = parseError(errorMsg);
    const stderrHint = stderrMessages.length > 0
      ? ` (详情: ${stderrMessages.join('; ').slice(0, 200)})`
      : '';
    return { success: false, error: parsed.error + stderrHint, detail: parsed.detail };
  }
}

/**
 * Verify a provider API key via SDK.
 * Uses the same SDK path as normal chat requests, ensuring verification = real usage.
 */
export async function verifyProviderViaSdk(
  baseUrl: string,
  apiKey: string,
  authType: string,
  model?: string,
  apiProtocol?: 'anthropic' | 'openai',
  maxOutputTokens?: number,
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens',
  upstreamFormat?: 'chat_completions' | 'responses',
): Promise<{ success: boolean; error?: string; detail?: string }> {
  console.log(`[provider/verify] Starting SDK verification for ${baseUrl}, model=${model ?? 'default'}, authType=${authType}, apiProtocol=${apiProtocol ?? 'anthropic'}, maxOutputTokens=${maxOutputTokens ?? 'none'}`);
  const env = buildClaudeSessionEnv({
    baseUrl,
    apiKey,
    authType: authType as 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key',
    apiProtocol,
    maxOutputTokens,
    maxOutputTokensParamName,
    upstreamFormat,
  });
  return verifyViaSdk(env, {
    model,
    sessionId: randomUUID(),
    logPrefix: 'provider/verify',
    parseError: parseProviderError,
    // Match chat sessions: use 'project' to read .claude/ from cwd.
    // MUST NOT use 'user' — it reads ~/.claude/settings.json which may contain
    // enabledPlugins causing 30s+ initialization and triggering our timeout.
    settingSources: ['project'],
  });
}

/**
 * Fetch supported models from SDK by spawning a lightweight query.
 * Works for both subscription (OAuth) and API key providers.
 * Uses the same SDK spawning pattern as verify, but only reads initialization data.
 */
export async function fetchSdkSupportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
  const cliPath = resolveClaudeCodeCli();
  const cwd = join(homedir(), '.pm-copilot', 'projects');
  mkdirSync(cwd, { recursive: true });

  // Use default Anthropic env (includes proxy config, NO_PROXY etc.)
  const env = buildClaudeSessionEnv();

  const testQuery = query({
    prompt: '1+1=',
    options: {
      maxTurns: 0,
      sessionId: randomUUID(),
      cwd,
      // 'user' reads ~/.claude/ OAuth credentials (same as verifySubscription)
      settingSources: ['user'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      pathToClaudeCodeExecutable: cliPath,
      executable: 'bun',
      env,
      persistSession: false,
      mcpServers: {},
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const },
    },
  });

  const INIT_TIMEOUT_MS = 30000;
  try {
    const initResult = await Promise.race([
      testQuery.initializationResult(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SDK initialization timeout')), INIT_TIMEOUT_MS),
      ),
    ]);
    return initResult.models ?? [];
  } finally {
    try { testQuery.return(undefined as never); } catch { /* cleanup */ }
  }
}

/**
 * Check if Anthropic subscription credentials exist locally
 * Claude CLI stores OAuth account info in ~/.claude.json file
 */
export function checkAnthropicSubscription(): SubscriptionStatus {
  const claudeJsonPath = join(homedir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    return { available: false };
  }

  // Check if ~/.claude.json has oauthAccount field (indicates logged in)
  try {
    const content = readFileSync(claudeJsonPath, 'utf-8');
    const config = JSON.parse(content);

    if (config.oauthAccount && config.oauthAccount.accountUuid) {
      return {
        available: true,
        path: claudeJsonPath,
        info: {
          accountUuid: config.oauthAccount.accountUuid,
          email: config.oauthAccount.emailAddress,
          displayName: config.oauthAccount.displayName,
          organizationName: config.oauthAccount.organizationName,
        }
      };
    }
  } catch {
    // File exists but can't read/parse
  }

  return { available: false };
}

/**
 * Verify Anthropic subscription by sending a test request via SDK.
 * Uses the same SDK path as normal chat requests.
 */
export async function verifySubscription(): Promise<{ success: boolean; error?: string; detail?: string }> {
  console.log('[subscription/verify] Starting SDK verification...');
  const env = buildClaudeSessionEnv(); // No provider override = default Anthropic auth
  return verifyViaSdk(env, {
    sessionId: randomUUID(),
    logPrefix: 'subscription/verify',
    parseError: parseSubscriptionError,
    // Subscription needs 'user' to read ~/.claude/ OAuth credentials
    settingSources: ['user'],
  });
}

/**
 * Get the current git branch for a directory
 * Returns undefined if not a git repository
 */
export function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'], // Suppress stderr
    });
    return branch.trim() || undefined;
  } catch {
    // Not a git repository or git not available
    return undefined;
  }
}
