// AgentRuntime abstraction types (v0.1.59)
// Defines the interface that all runtime implementations must satisfy

import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode, RuntimeDetection } from '../../shared/types/runtime';
import type { InteractionScenario } from '../system-prompt';

/**
 * Options for starting a runtime session
 */
export interface SessionStartOptions {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  systemPromptAppend?: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  resumeSessionId?: string;
  disallowedTools?: string[];
  scenario: InteractionScenario;
  additionalArgs?: string[];
}

/**
 * A handle to a running runtime subprocess
 */
export interface RuntimeProcess {
  readonly pid: number;
  /** Write a line to the process stdin */
  writeLine(line: string): Promise<void>;
  /** Kill the process */
  kill(signal?: number): void;
  /** Whether the process has exited */
  exited: boolean;
  /** Wait for the process to exit */
  waitForExit(): Promise<number>;
}

/**
 * Unified event emitted by any runtime, consumed by the session layer.
 * The session layer maps these to SSE broadcast calls.
 */
export type UnifiedEvent =
  // === Text streaming ===
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_stop' }

  // === Thinking/reasoning streaming ===
  | { kind: 'thinking_start'; index: number }
  | { kind: 'thinking_delta'; text: string; index: number }
  | { kind: 'thinking_stop'; index: number }

  // === Tool use ===
  | { kind: 'tool_use_start'; toolUseId: string; toolName: string }
  | { kind: 'tool_input_delta'; toolUseId: string; delta: string }
  | { kind: 'tool_use_stop'; toolUseId: string }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

  // === Permission delegation ===
  | {
    kind: 'permission_request';
    requestId: string;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
  }

  // === Session lifecycle ===
  | { kind: 'session_init'; sessionId: string; model: string; tools: string[] }
  | { kind: 'status_change'; state: 'idle' | 'running' | 'waiting_permission' | 'error' }
  | { kind: 'turn_complete'; result?: string }
  | {
    kind: 'session_complete';
    result: string;
    subtype: 'success' | 'error' | 'error_max_turns' | 'error_max_budget';
  }

  // === Metadata ===
  | { kind: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }

  // === Message replay (for session resume) ===
  | { kind: 'message_replay'; message: { id: string; role: string; content: unknown; timestamp?: string } }

  // === Passthrough for unrecognized events ===
  | { kind: 'raw'; data: unknown };

/**
 * Callback for unified events from the runtime
 */
export type UnifiedEventCallback = (event: UnifiedEvent) => void;

/**
 * AgentRuntime interface — one implementation per CLI type
 */
export interface AgentRuntime {
  readonly type: RuntimeType;

  /** Check if the CLI is installed and get version info */
  detect(): Promise<RuntimeDetection>;

  /** Query available models from the CLI (may spawn a temporary process) */
  queryModels(): Promise<RuntimeModelInfo[]>;

  /** Get the permission modes supported by this runtime */
  getPermissionModes(): RuntimePermissionMode[];

  /**
   * Start a session. Events are delivered via the callback.
   * Returns a RuntimeProcess handle for sending messages and controlling the session.
   */
  startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess>;

  /** Send a follow-up user message to an active session */
  sendMessage(process: RuntimeProcess, message: string, images?: unknown[]): Promise<void>;

  /** Respond to a permission request from the runtime */
  respondPermission(
    process: RuntimeProcess,
    requestId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;

  /** Stop the session gracefully */
  stopSession(process: RuntimeProcess): Promise<void>;
}
