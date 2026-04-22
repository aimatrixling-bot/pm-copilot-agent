// RuntimeFactory — creates and caches AgentRuntime instances (v0.1.59)

import type { RuntimeType } from '../../shared/types/runtime';
import type { AgentRuntime } from './types';
import { ClaudeCodeRuntime } from './claude-code';
import { CodexRuntime } from './codex';

// ─── Runtime registry ───

const runtimes: Partial<Record<RuntimeType, AgentRuntime>> = {};

// Runtime types that have actual implementations
const SUPPORTED_EXTERNAL_RUNTIMES = new Set<RuntimeType>(['claude-code', 'codex']);

function ensureRuntime(type: RuntimeType): AgentRuntime {
  if (!runtimes[type]) {
    switch (type) {
      case 'claude-code':
        runtimes[type] = new ClaudeCodeRuntime();
        break;
      case 'codex':
        runtimes[type] = new CodexRuntime();
        break;
      default:
        throw new Error(`Runtime "${type}" is not yet supported. Available: ${[...SUPPORTED_EXTERNAL_RUNTIMES].join(', ')}`);
    }
  }
  return runtimes[type]!;
}

/**
 * Check if a runtime type has an actual implementation (not just type definition)
 */
export function isRuntimeSupported(type: RuntimeType): boolean {
  return type === 'builtin' || SUPPORTED_EXTERNAL_RUNTIMES.has(type);
}

/**
 * Get a runtime instance by type.
 * 'builtin' is not handled here — it uses the existing agent-session.ts path.
 */
export function getExternalRuntime(type: RuntimeType): AgentRuntime {
  if (type === 'builtin') {
    throw new Error('builtin runtime does not use AgentRuntime interface — use existing agent-session.ts path');
  }
  return ensureRuntime(type);
}

/**
 * Check if a runtime type is external (not builtin)
 */
export function isExternalRuntime(type: RuntimeType | undefined): boolean {
  return type !== undefined && type !== 'builtin';
}

/**
 * Get the current runtime type from environment or default to 'builtin'
 */
export function getCurrentRuntimeType(): RuntimeType {
  const env = process.env.PM_COPILOT_RUNTIME;
  if (env === 'claude-code' || env === 'codex') return env;
  return 'builtin';
}
