// External Runtime Session Handler (v0.1.59)
//
// Manages the lifecycle of an external CLI runtime session (Claude Code, Codex).
// This module parallels agent-session.ts but is drastically simpler because
// the external CLI handles all SDK interaction, tool execution, and session persistence.
// We only need to: spawn process, relay events, and handle permission delegation.

import { broadcast } from '../sse';
import { buildSystemPromptAppend } from '../system-prompt';
import type { InteractionScenario } from '../system-prompt';
import type { AgentRuntime, RuntimeProcess, UnifiedEvent } from './types';
import { getExternalRuntime, getCurrentRuntimeType, isExternalRuntime } from './factory';
import type { RuntimeType } from '../../shared/types/runtime';
import { saveSessionMetadata, saveSessionMessages, updateSessionMetadata, getSessionMetadata, getSessionData } from '../SessionStore';
import { createSessionMetadata } from '../types/session';
import type { SessionMessage } from '../types/session';

// ─── Module state ───

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let isRunning = false;
let turnCompleted = false;
let startingPromise: Promise<void> | null = null;  // Guard against concurrent startExternalSession
let watchdogTimer: ReturnType<typeof setTimeout> | null = null;  // Hung process detection

// Track session context for multi-turn resume (CC -p mode exits after each turn)
let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastRuntimeSessionId = '';  // Runtime's session ID (CC: from hook/init; Codex: threadId)
let lastModel = '';             // Latest model from config sync (passed on resume)
let lastPermissionMode = '';    // Latest permission mode from config sync

// Message accumulation for SessionStore persistence
// allSessionMessages grows across turns — saveSessionMessages expects the FULL cumulative array
// (it uses messages.slice(existingCount) internally to find new messages to append)
let allSessionMessages: SessionMessage[] = [];
let currentAssistantText = '';  // Accumulate streaming text for the current assistant message (also used by getLastExternalAssistantText)
let currentTurnStartTime = 0;

// ─── Structured content block accumulation ───
// Mirrors the builtin runtime's ContentBlock[] pattern so that session history
// preserves thinking, tool_use, and text blocks (not just flattened text).
// The frontend's JSON parse path (TabProvider.tsx:1969) handles this format.
interface PersistContentBlock {
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  tool?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    inputJson?: string;
    result?: string;
    isError?: boolean;
    streamIndex: number;
  };
  thinking?: string;
  thinkingStreamIndex?: number;
}

let currentContentBlocks: PersistContentBlock[] = [];
let pendingTextBuffer = '';         // text_delta accumulator between block boundaries
let pendingThinkingText = '';       // thinking_delta accumulator for current thinking block
let pendingThinkingIndex = 0;       // index of current thinking block
const pendingToolInputs = new Map<string, { name: string; inputJson: string }>(); // toolUseId → input accumulator

/** Flush accumulated text into a text content block */
function flushPendingText(): void {
  if (pendingTextBuffer) {
    currentContentBlocks.push({ type: 'text', text: pendingTextBuffer });
    pendingTextBuffer = '';
  }
}

/** Flush any incomplete blocks (thinking/tool) at turn boundary — handles interrupts */
function flushAllPending(): void {
  flushPendingText();
  if (pendingThinkingText) {
    currentContentBlocks.push({
      type: 'thinking',
      thinking: pendingThinkingText,
      thinkingStreamIndex: pendingThinkingIndex,
    });
    pendingThinkingText = '';
  }
  // Flush any uncompleted tool uses (interrupted mid-stream)
  for (const [toolId, entry] of pendingToolInputs) {
    let parsedInput: Record<string, unknown> = {};
    try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
    currentContentBlocks.push({
      type: 'tool_use',
      tool: {
        id: toolId,
        name: entry.name,
        input: parsedInput,
        inputJson: entry.inputJson,
        streamIndex: currentContentBlocks.length,
      },
    });
  }
  pendingToolInputs.clear();
}

// ─── Watchdog timer (10 min inactivity → kill hung process) ───
const WATCHDOG_TIMEOUT_MS = 10 * 60 * 1000;

function resetWatchdog(): void {
  if (watchdogTimer) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(async () => {
    console.error('[external-session] Watchdog timeout — no activity for 10 minutes, killing process');
    broadcast('chat:agent-error', { message: 'External runtime timed out (no activity for 10 minutes)' });
    broadcast('chat:message-error', 'External runtime timed out');
    fireImCallback('error', 'External runtime timed out');
    await stopExternalSession();
  }, WATCHDOG_TIMEOUT_MS);
}

function clearWatchdog(): void {
  if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
}

// ─── Turn outcome tracking (stale text protection for cron/heartbeat) ───
let lastTurnSucceeded = false;

// ─── Token usage accumulation ───
let currentTurnUsage: { inputTokens: number; outputTokens: number } | null = null;

/** Reset all per-turn accumulators */
function resetTurnAccumulators(): void {
  currentAssistantText = '';
  currentContentBlocks = [];
  pendingTextBuffer = '';
  pendingThinkingText = '';
  pendingThinkingIndex = 0;
  pendingToolInputs.clear();
  currentTurnUsage = null;
}

/** Check if content looks like JSON ContentBlock[] (matches frontend heuristic in TabProvider.tsx:1969) */
function isContentBlockJson(content: string): boolean {
  return content.startsWith('[') && content.includes('"type"');
}

/** Extract plain text preview from content (handles both JSON ContentBlock[] and plain text) */
function extractTextPreview(content: string, maxLen = 100): string {
  if (isContentBlockJson(content)) {
    try {
      const blocks = JSON.parse(content) as PersistContentBlock[];
      const text = blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('');
      return text.slice(0, maxLen);
    } catch { /* fall through */ }
  }
  return content.slice(0, maxLen);
}

// IM stream callback — mirrors agent-session.ts pattern for IM Bot relay
type ImStreamCallback = (
  event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity',
  data: string,
) => void;
let imStreamCallback: ImStreamCallback | null = null;
let imCallbackNulledDuringTurn = false; // Prevents stale turn events leaking to new callback

/** Fire IM callback only if not stale (guard mirrors agent-session.ts pattern) */
function fireImCallback(event: 'delta' | 'block-end' | 'complete' | 'error' | 'permission-request' | 'activity', data: string): void {
  if (imStreamCallback && !imCallbackNulledDuringTurn) {
    imStreamCallback(event, data);
  }
}

/**
 * Set the runtime's session ID (CC: from hook/system.init; Codex: from thread/start).
 * Used for session resume in multi-turn conversations.
 */
export function setRuntimeSessionId(id: string): void {
  lastRuntimeSessionId = id;
  console.log(`[external-session] Runtime session ID set: ${id}`);
}

/**
 * Restore module-level state after Sidecar restart (session resume).
 * Called from index.ts when an external runtime session is reopened from history.
 * Sets lastRuntimeSessionId so sendExternalMessage uses resume instead of new session.
 */
export function restoreExternalSessionState(
  sessionId: string,
  workspacePath: string,
  scenario: InteractionScenario,
): void {
  lastSessionId = sessionId;
  lastWorkspacePath = workspacePath;
  lastScenario = scenario;

  // Restore the runtime's own session ID from persisted metadata.
  // Three cases:
  // 1. Codex session with runtimeSessionId persisted → use it (threadId)
  // 2. CC session (no runtimeSessionId, but has runtime + messages) → sessionId (CC uses our ID)
  // 3. Brand new session (no metadata) → empty string → sendExternalMessage hits Case 1 (fresh start)
  const meta = getSessionMetadata(sessionId);
  if (meta?.runtimeSessionId) {
    lastRuntimeSessionId = meta.runtimeSessionId;
  } else if (meta?.runtime && meta.runtime !== 'builtin') {
    lastRuntimeSessionId = sessionId; // CC: session ID === runtime session ID
  } else {
    lastRuntimeSessionId = ''; // New session: nothing to resume
  }

  // Load existing messages for correct incremental save
  const data = getSessionData(sessionId);
  if (data?.messages?.length) {
    allSessionMessages = data.messages;
  }
  console.log(`[external-session] Restored state for session ${sessionId}, runtimeSessionId=${lastRuntimeSessionId} (${allSessionMessages.length} messages)`);
}

/**
 * Set IM stream callback for relaying CC events to Rust IM.
 * Mirrors agent-session.ts setImStreamCallback pattern.
 */
export function setExternalImStreamCallback(cb: ImStreamCallback | null): void {
  if (cb !== null && imStreamCallback !== null) {
    imCallbackNulledDuringTurn = true;
    try { imStreamCallback('error', '消息处理被新请求取代'); } catch { /* old stream may already be closed */ }
  }
  if (cb === null) {
    imCallbackNulledDuringTurn = true;
  } else {
    imCallbackNulledDuringTurn = false;
  }
  imStreamCallback = cb;
}

// ─── Config change handlers ───

/**
 * Set model for external runtime. Stops any running process so the next
 * sendExternalMessage resumes with the new model.
 * Called from index.ts /api/model/set when runtime is external.
 */
export async function setExternalModel(model: string): Promise<void> {
  lastModel = model;
  console.log(`[external-session] Model set to "${model}"`);
  // Stop running process — next message will start with new model via resume
  if (isRunning || activeProcess) {
    console.log('[external-session] Stopping process for model change');
    await stopExternalSession();
  }
}

/**
 * Set permission mode for external runtime. Stops any running process so the next
 * sendExternalMessage resumes with the new permission mode.
 * Called from index.ts /api/session/permission-mode when runtime is external.
 */
export async function setExternalPermissionMode(mode: string): Promise<void> {
  lastPermissionMode = mode;
  console.log(`[external-session] Permission mode set to "${mode}"`);
  if (isRunning || activeProcess) {
    console.log('[external-session] Stopping process for permission mode change');
    await stopExternalSession();
  }
}

// ─── Public API ───

/**
 * Check if we should use an external runtime for this sidecar
 */
export function shouldUseExternalRuntime(): boolean {
  return isExternalRuntime(getCurrentRuntimeType());
}

/**
 * Get the current external runtime type, or null if builtin
 */
export function getActiveRuntimeType(): RuntimeType {
  return getCurrentRuntimeType();
}

/**
 * Wait for external session to become idle.
 * Detects two idle patterns:
 * - CC -p mode: process exits after each turn → !isRunning && !activeProcess
 * - Codex app-server: process stays alive, turn completes → turnCompleted flag
 * Returns true if completed within timeout, false otherwise.
 */
export async function waitForExternalSessionIdle(timeoutMs: number, pollMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Brief initial delay to let sendExternalMessage → startExternalSession set isRunning.
  // Without this, polling could see the pre-start state (!isRunning && !activeProcess) and
  // return true immediately before the CC process has even started.
  if (!isRunning && !activeProcess) {
    await new Promise(r => setTimeout(r, 200));
    if (!isRunning && !activeProcess) return true; // genuinely idle
  }
  while (Date.now() < deadline) {
    if (!isRunning && !activeProcess) return true;  // CC: process exited
    if (activeProcess?.exited) return true;          // CC: process exited (alt check)
    if (turnCompleted) return true;                  // Codex: turn done, process alive
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Check if the last external turn completed successfully.
 * Used by cron/heartbeat to avoid reading stale assistant text after a crash.
 */
export function didLastTurnSucceed(): boolean {
  return lastTurnSucceeded;
}

/**
 * Get the last assistant message text from the current session.
 * Used by Cron handler and IM heartbeat to extract response text.
 * Handles both JSON ContentBlock[] and plain text formats.
 */
export function getLastExternalAssistantText(): string {
  for (let i = allSessionMessages.length - 1; i >= 0; i--) {
    const msg = allSessionMessages[i];
    if (msg.role === 'assistant') {
      const content = msg.content ?? '';
      // If stored as JSON ContentBlock[], extract text blocks
      if (isContentBlockJson(content)) {
        try {
          const blocks = JSON.parse(content) as PersistContentBlock[];
          return blocks
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
        } catch { /* fall through to plain text */ }
      }
      return content;
    }
  }
  return '';
}

/**
 * Start an external runtime session.
 * Called instead of the builtin startStreamingSession() when runtime is external.
 */
export async function startExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
}): Promise<void> {
  // Concurrency guard — wait for any in-flight start to finish
  if (startingPromise) {
    await startingPromise;
  }
  if (isRunning) {
    console.warn('[external-session] Session already running, ignoring start request');
    return;
  }

  // Wrap the body so concurrent callers serialize via startingPromise
  let resolveStarting: () => void;
  startingPromise = new Promise(r => { resolveStarting = r; });

  try {
    await _doStartExternalSession(options);
  } finally {
    startingPromise = null;
    resolveStarting!();
  }
}

/** Internal start implementation — called through concurrency guard above */
async function _doStartExternalSession(options: {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  model?: string;
  permissionMode?: string;
  scenario: InteractionScenario;
  resumeSessionId?: string;
}): Promise<void> {

  const runtimeType = getCurrentRuntimeType();
  const runtime = getExternalRuntime(runtimeType);
  activeRuntime = runtime;

  // Build system prompt using PM Copilot' three-layer architecture
  const systemPromptAppend = buildSystemPromptAppend(options.scenario);

  console.log(`[external-session] Starting ${runtimeType} session for ${options.sessionId}`);
  turnCompleted = false;
  lastTurnSucceeded = false;  // Reset — success only set after turn_complete
  resetTurnAccumulators();
  resetWatchdog();  // Start watchdog — will kill process if no activity for 10 min
  currentTurnStartTime = 0;
  // Track latest config for resume
  if (options.model) lastModel = options.model;
  if (options.permissionMode) lastPermissionMode = options.permissionMode;
  // Only clear message history for new sessions, not resumes
  if (!options.resumeSessionId) {
    allSessionMessages = [];
  }

  // Broadcast user message so frontend displays it in the chat
  // Also record it for SessionStore persistence
  if (options.initialMessage) {
    const userMsg: SessionMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: options.initialMessage,
      timestamp: new Date().toISOString(),
    };
    broadcast('chat:message-replay', { message: userMsg });
    allSessionMessages.push(userMsg);
    resetTurnAccumulators();
    currentTurnStartTime = Date.now();

    // Persist user message immediately (crash safety — don't wait for turn_complete)
    try { saveSessionMessages(options.sessionId, allSessionMessages); }
    catch (err) { console.error('[external-session] Failed to persist user message:', err); }

    // Register session in history index (mirrors agent-session.ts enqueueUserMessage logic)
    if (!options.resumeSessionId && !getSessionMetadata(options.sessionId)) {
      const meta = createSessionMetadata(options.workspacePath);
      meta.id = options.sessionId;
      meta.runtime = getCurrentRuntimeType();
      const trimmed = options.initialMessage.trim();
      meta.title = trimmed.slice(0, 40);
      if (meta.title.length < trimmed.length) meta.title += '...';
      saveSessionMetadata(meta);
      console.log(`[external-session] session ${options.sessionId} persisted to SessionStore`);
    }
  }

  broadcast('chat:status', { sessionState: 'running' });

  // Set session context BEFORE startSession so that events fired during startup
  // (e.g., Codex's synchronous session_init) can reference lastSessionId for persistence.
  lastSessionId = options.sessionId;
  lastWorkspacePath = options.workspacePath;
  lastScenario = options.scenario;

  // Set isRunning BEFORE spawning — prevents waitForExternalSessionIdle from
  // seeing the pre-start state and returning true prematurely. Reset in catch.
  isRunning = true;

  try {
    const process = await runtime.startSession(
      {
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        initialMessage: options.initialMessage,
        systemPromptAppend,
        model: options.model,
        permissionMode: options.permissionMode,
        scenario: options.scenario,
        resumeSessionId: options.resumeSessionId,
      },
      handleUnifiedEvent,
    );

    activeProcess = process;
    console.log(`[external-session] ${runtimeType} process started, pid=${activeProcess.pid}`);
  } catch (err) {
    isRunning = false;
    activeProcess = null;
    activeRuntime = null;
    clearWatchdog();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[external-session] Failed to start ${runtimeType}:`, message);
    broadcast('chat:status', { sessionState: 'error' });
    broadcast('chat:agent-error', { message: `Failed to start ${runtimeType}: ${message}` });
    // Re-throw so the HTTP handler returns an error response
    throw err;
  }
}

/**
 * Session context for first-time initialization (passed from index.ts)
 */
export interface ExternalSendContext {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;  // Runtime-specific model (e.g., "sonnet", "opus")
}

/**
 * Send a user message via external runtime.
 * Handles three cases:
 * 1. No previous session → start a new one (first message)
 * 2. Previous process exited → resume with --resume (CC -p mode multi-turn)
 * 3. Process still running → send via stdin (shouldn't happen in -p mode)
 */
export async function sendExternalMessage(
  text: string,
  _images?: unknown[],
  _permissionMode?: string,
  _model?: string,
  context?: ExternalSendContext,
): Promise<{ queued: boolean; error?: string }> {
  // Case 1: No previous session — start fresh
  if (!lastRuntimeSessionId && !isRunning) {
    if (!context) {
      return { queued: false, error: 'No session context for first message' };
    }
    try {
      await startExternalSession({
        sessionId: context.sessionId,
        workspacePath: context.workspacePath,
        initialMessage: text,
        model: context.model,
        permissionMode: context.permissionMode,
        scenario: context.scenario,
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 2: Previous process exited — resume (CC -p mode multi-turn)
  if (!activeProcess || activeProcess.exited) {
    console.log(`[external-session] Previous process exited, resuming session ${lastRuntimeSessionId}`);
    try {
      await startExternalSession({
        sessionId: lastSessionId,
        workspacePath: lastWorkspacePath,
        initialMessage: text,
        model: lastModel || context?.model,
        permissionMode: lastPermissionMode || context?.permissionMode,
        scenario: lastScenario,
        resumeSessionId: lastRuntimeSessionId, // --resume to continue conversation
      });
      return { queued: true };
    } catch (err) {
      return { queued: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Case 3: Process still running — send via runtime.sendMessage
  // This is the normal path for persistent-process runtimes like Codex app-server.
  if (!activeRuntime) {
    return { queued: false, error: 'No active runtime' };
  }
  try {
    // Broadcast user message + record for persistence (same as startExternalSession)
    const userMsg: SessionMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    broadcast('chat:message-replay', { message: userMsg });
    allSessionMessages.push(userMsg);
    turnCompleted = false;
    lastTurnSucceeded = false;  // Reset for this turn (prevents stale text on failure)
    resetTurnAccumulators();
    resetWatchdog();  // Start watchdog for this turn (Case 3 bypasses startExternalSession)
    currentTurnStartTime = Date.now();

    // Persist user message immediately (crash safety)
    if (lastSessionId) {
      try { saveSessionMessages(lastSessionId, allSessionMessages); }
      catch (err) { console.error('[external-session] Failed to persist user message:', err); }
    }

    broadcast('chat:status', { sessionState: 'running' });
    await activeRuntime.sendMessage(activeProcess, text);
    return { queued: true };
  } catch (err) {
    return { queued: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Respond to a permission request from the external runtime
 */
export async function respondExternalPermission(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  if (!activeProcess || !activeRuntime) {
    console.warn('[external-session] No active process for permission response');
    return;
  }
  await activeRuntime.respondPermission(activeProcess, requestId, approved, reason);
}

/**
 * Stop the active external session
 */
export async function stopExternalSession(): Promise<boolean> {
  clearWatchdog();
  if (!activeProcess || !activeRuntime) return false;
  try {
    await activeRuntime.stopSession(activeProcess);
    return true;
  } catch (err) {
    console.error('[external-session] Error stopping session:', err);
    activeProcess.kill();
    return true;
  } finally {
    activeProcess = null;
    activeRuntime = null;
    isRunning = false;
    // Notify IM stream callback if active (prevents orphaned SSE streams on user-stop)
    fireImCallback('error', 'Session stopped');
    broadcast('chat:status', { sessionState: 'idle' });
  }
}

/**
 * Check if an external session is active
 */
export function isExternalSessionActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

/**
 * Query models for a given runtime type
 */
export async function queryRuntimeModels(runtimeType: RuntimeType): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return await runtime.queryModels();
  } catch (err) {
    console.error(`[external-session] Failed to query models for ${runtimeType}:`, err);
    return [];
  }
}

/**
 * Get permission modes for a given runtime type
 */
export function getRuntimePermissionModes(runtimeType: RuntimeType): unknown[] {
  if (runtimeType === 'builtin') return [];
  try {
    const runtime = getExternalRuntime(runtimeType);
    return runtime.getPermissionModes();
  } catch {
    return [];
  }
}

// ─── Private: UnifiedEvent → SSE broadcast ───

function handleUnifiedEvent(event: UnifiedEvent): void {
  switch (event.kind) {
    case 'text_delta':
      broadcast('chat:message-chunk', event.text);
      currentAssistantText += event.text;
      pendingTextBuffer += event.text;
      fireImCallback('delta', event.text);
      resetWatchdog();
      break;

    case 'text_stop':
      // Text block ended — flush accumulated text into a content block
      flushPendingText();
      fireImCallback('block-end', '');
      break;

    case 'thinking_start':
      flushPendingText();  // Close any open text block before thinking
      pendingThinkingText = '';
      pendingThinkingIndex = event.index;
      broadcast('chat:thinking-start', { index: event.index });
      fireImCallback('activity', '');
      break;

    case 'thinking_delta':
      pendingThinkingText += event.text;
      // Frontend expects { index, delta } — match builtin SSE shape
      broadcast('chat:thinking-chunk', { index: event.index, delta: event.text });
      resetWatchdog();
      break;

    case 'thinking_stop':
      // Finalize thinking block
      if (pendingThinkingText) {
        currentContentBlocks.push({
          type: 'thinking',
          thinking: pendingThinkingText,
          thinkingStreamIndex: pendingThinkingIndex,
        });
        pendingThinkingText = '';
      }
      // Emit content-block-stop so frontend closes the thinking block
      broadcast('chat:content-block-stop', { index: event.index, type: 'thinking' });
      break;

    case 'tool_use_start':
      flushPendingText();  // Close any open text block before tool use
      pendingToolInputs.set(event.toolUseId, { name: event.toolName, inputJson: '' });
      broadcast('chat:tool-use-start', {
        id: event.toolUseId,
        name: event.toolName,
        input: {},
      });
      fireImCallback('activity', '');
      break;

    case 'tool_input_delta': {
      const toolEntry = pendingToolInputs.get(event.toolUseId);
      if (toolEntry) {
        toolEntry.inputJson += event.delta;
      }
      broadcast('chat:tool-input-delta', {
        toolId: event.toolUseId,
        delta: event.delta,
      });
      resetWatchdog();  // Tool streaming is activity — prevent killing long-running tools
      break;
    }

    case 'tool_use_stop': {
      // Finalize tool use block from accumulated input
      const entry = pendingToolInputs.get(event.toolUseId);
      if (entry) {
        let parsedInput: Record<string, unknown> = {};
        try { parsedInput = JSON.parse(entry.inputJson); } catch { /* keep empty */ }
        currentContentBlocks.push({
          type: 'tool_use',
          tool: {
            id: event.toolUseId,
            name: entry.name,
            input: parsedInput,
            inputJson: entry.inputJson,
            streamIndex: currentContentBlocks.length,
          },
        });
        pendingToolInputs.delete(event.toolUseId);
      }
      broadcast('chat:content-block-stop', {
        type: 'tool_use',
        toolId: event.toolUseId,
      });
      break;
    }

    case 'tool_result':
      // Update the matching tool_use block's result
      for (let i = currentContentBlocks.length - 1; i >= 0; i--) {
        if (currentContentBlocks[i].type === 'tool_use' && currentContentBlocks[i].tool?.id === event.toolUseId) {
          currentContentBlocks[i].tool!.result = event.content;
          currentContentBlocks[i].tool!.isError = event.isError ?? false;
          break;
        }
      }
      broadcast('chat:tool-result-start', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
      });
      // Emit complete immediately — external runtimes deliver tool results as a single event
      // (no streaming delta). Frontend needs this to clear tool loading spinner + trigger file refresh.
      broadcast('chat:tool-result-complete', {
        toolUseId: event.toolUseId,
        content: event.content,
        isError: event.isError ?? false,
      });
      resetWatchdog();
      break;

    case 'permission_request':
      broadcast('permission:request', {
        requestId: event.requestId,
        toolName: event.toolName,
        toolUseId: event.toolUseId,
        input: typeof event.input === 'object' ? JSON.stringify(event.input).slice(0, 500) : String(event.input ?? '').slice(0, 500),
      });
      fireImCallback('permission-request', JSON.stringify({
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
      }));
      break;

    case 'session_init':
      // Capture runtime's session ID for multi-turn resume
      // CC: session_id from hook; Codex: threadId from thread/start response
      if (event.sessionId) {
        lastRuntimeSessionId = event.sessionId;
        // Persist to SessionMetadata for cross-restart resume
        if (lastSessionId && event.sessionId !== lastSessionId) {
          updateSessionMetadata(lastSessionId, { runtimeSessionId: event.sessionId });
        }
      }
      // Match builtin broadcast shape: { info: {...}, sessionId } — top-level sessionId
      // is read by frontend for session ID sync (TabProvider).
      broadcast('chat:system-init', {
        info: {
          sessionId: event.sessionId,
          model: event.model,
          tools: event.tools,
        },
        sessionId: lastSessionId,
      });
      break;

    case 'status_change': {
      // Map runtime states to frontend session states (match builtin runtime behavior)
      const stateMap: Record<string, string> = { running: 'running', error: 'error', waiting_permission: 'running' };
      broadcast('chat:status', { sessionState: stateMap[event.state ?? ''] ?? 'idle' });
      break;
    }

    case 'turn_complete': {
      // Mark turn complete — session_complete will follow for -p mode
      turnCompleted = true;
      lastTurnSucceeded = true;  // Successful turn — safe for cron/heartbeat to read
      clearWatchdog();
      const turnDurationMs = currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined;
      const turnToolCount = currentContentBlocks.filter(b => b.type === 'tool_use').length;

      broadcast('chat:message-complete', {
        ...(currentTurnUsage ? { input_tokens: currentTurnUsage.inputTokens, output_tokens: currentTurnUsage.outputTokens } : {}),
        ...(turnToolCount > 0 ? { tool_count: turnToolCount } : {}),
        ...(turnDurationMs ? { duration_ms: turnDurationMs } : {}),
      });
      broadcast('chat:status', { sessionState: 'idle' });
      fireImCallback('complete', '');

      // Flush any pending blocks (text, thinking, tool) and persist structured content
      flushAllPending();

      const usageData = currentTurnUsage ? { inputTokens: currentTurnUsage.inputTokens, outputTokens: currentTurnUsage.outputTokens } : undefined;

      if (currentContentBlocks.length > 0) {
        // Persist as JSON ContentBlock[] — matches builtin runtime format
        const content = JSON.stringify(currentContentBlocks);
        const assistantMsg: SessionMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
          durationMs: turnDurationMs,
          usage: usageData,
          toolCount: turnToolCount || undefined,
        };
        allSessionMessages.push(assistantMsg);
        resetTurnAccumulators();
      } else if (currentAssistantText.trim()) {
        // Fallback: no structured blocks, just plain text (e.g. CC slash commands)
        const assistantMsg: SessionMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: currentAssistantText,
          timestamp: new Date().toISOString(),
          durationMs: turnDurationMs,
          usage: usageData,
        };
        allSessionMessages.push(assistantMsg);
        resetTurnAccumulators();
      }

      // Save cumulative messages to disk (saveSessionMessages uses .slice(existingCount) to append)
      // Do NOT clear allSessionMessages — it must grow across turns for the contract to work
      if (allSessionMessages.length > 0 && lastSessionId) {
        try {
          saveSessionMessages(lastSessionId, allSessionMessages);
          const lastMsg = allSessionMessages[allSessionMessages.length - 1];
          updateSessionMetadata(lastSessionId, {
            lastActiveAt: new Date().toISOString(),
            lastMessagePreview: extractTextPreview(lastMsg?.content ?? ''),
          });
        } catch (err) {
          console.error('[external-session] Failed to save session messages:', err);
        }
      }
      break;
    }

    case 'session_complete':
      clearWatchdog();
      if (event.subtype === 'success') {
        // CC slash commands (e.g. /context, /cost) return output directly in `result`
        // without streaming text_delta events. Only broadcast if NO turn completed
        // (turnCompleted means text was already streamed + persisted normally).
        if (event.result && !turnCompleted && !currentAssistantText.trim()) {
          broadcast('chat:message-chunk', event.result);
          currentAssistantText += event.result;
          pendingTextBuffer += event.result;
        }
        // Only broadcast if turn_complete didn't already
        if (!turnCompleted) {
          // Flush and persist structured content
          flushAllPending();

          if (currentContentBlocks.length > 0) {
            const content = JSON.stringify(currentContentBlocks);
            const assistantMsg: SessionMessage = {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content,
              timestamp: new Date().toISOString(),
              durationMs: currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined,
            };
            allSessionMessages.push(assistantMsg);
            resetTurnAccumulators();
          } else if (currentAssistantText.trim()) {
            // Fallback: plain text (CC slash commands)
            const assistantMsg: SessionMessage = {
              id: `assistant-${Date.now()}`,
              role: 'assistant',
              content: currentAssistantText,
              timestamp: new Date().toISOString(),
              durationMs: currentTurnStartTime ? Date.now() - currentTurnStartTime : undefined,
            };
            allSessionMessages.push(assistantMsg);
            resetTurnAccumulators();
          }

          if (allSessionMessages.length > 0 && lastSessionId) {
            try {
              saveSessionMessages(lastSessionId, allSessionMessages);
              const lastMsg = allSessionMessages[allSessionMessages.length - 1];
              updateSessionMetadata(lastSessionId, {
                lastActiveAt: new Date().toISOString(),
                lastMessagePreview: extractTextPreview(lastMsg?.content ?? ''),
              });
            } catch (err) {
              console.error('[external-session] Failed to save session messages:', err);
            }
          }
          broadcast('chat:message-complete', {});
          fireImCallback('complete', '');
        }
      } else {
        broadcast('chat:message-error', event.result || 'Session ended with error');
        fireImCallback('error', event.result || 'Session ended with error');
        resetTurnAccumulators(); // Prevent stale content leaking into next turn
      }
      broadcast('chat:status', { sessionState: 'idle' });
      // Clean up module state — prevents stuck sessions on CC crash
      isRunning = false;
      activeProcess = null;
      activeRuntime = null;
      break;

    case 'usage':
      // Store latest token usage — Codex emits running totals (not deltas),
      // so we replace rather than accumulate to avoid double-counting.
      currentTurnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
      break;

    case 'log':
      if (event.level === 'error') {
        console.error(`[external-runtime] ${event.message}`);
      } else {
        console.log(`[external-runtime] ${event.message}`);
      }
      break;

    case 'message_replay':
      // Skip assistant message replays during active streaming — CC sends both
      // stream_event deltas AND a complete assistant message, causing duplication.
      // Only replay user messages (for session resume scenarios).
      if (event.message.role === 'user') {
        broadcast('chat:message-replay', { message: event.message });
      }
      // Assistant replays are intentionally dropped — the stream_event deltas
      // already delivered the content to the frontend incrementally.
      break;

    case 'raw':
      // Unrecognized event — ignore
      break;
  }
}
