/**
 * Context Compact — transcript saving on SDK compaction.
 *
 * The Claude Agent SDK handles context compression internally (auto + manual).
 * This module adds value by:
 *   1. Saving compact summaries as transcripts for later review
 *   2. Providing a PostCompact hook for the SDK
 *
 * Storage: ~/.pm-copilot/transcripts/{session-id}-{timestamp}.jsonl
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getPmCopilotUserDir } from './agent-session';

// ===== Types =====

interface TranscriptEntry {
  sessionId: string;
  timestamp: string;
  trigger: 'manual' | 'auto';
  compactSummary: string;
}

// ===== Storage =====

function getTranscriptsDir(): string {
  const dir = join(getPmCopilotUserDir(), 'transcripts');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save a compact summary as a transcript entry.
 * Appends to a JSONL file (one JSON object per line) for easy streaming reads.
 */
export function saveTranscript(
  sessionId: string,
  trigger: 'manual' | 'auto',
  compactSummary: string,
): void {
  const dir = getTranscriptsDir();
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${sessionId}-${dateStr}.jsonl`;
  const filepath = join(dir, filename);

  const entry: TranscriptEntry = {
    sessionId,
    timestamp: now.toISOString(),
    trigger,
    compactSummary,
  };

  appendFileSync(filepath, JSON.stringify(entry) + '\n', 'utf-8');
  console.log(`[context-compact] Transcript saved: ${filename}`);
}

/**
 * Create a PostCompact hook handler for the SDK.
 * Saves the compact summary as a transcript entry.
 *
 * The hook accepts the generic HookInput type (union of all hook input types)
 * and extracts PostCompact-specific fields via type assertion.
 */
export function createPostCompactHook(sessionId: string) {
  return async (input: unknown): Promise<{ continue: boolean }> => {
    try {
      const postInput = input as { hook_event_name: string; trigger?: string; compact_summary?: string };
      if (postInput.hook_event_name === 'PostCompact' && postInput.compact_summary) {
        saveTranscript(
          sessionId,
          (postInput.trigger ?? 'auto') as 'manual' | 'auto',
          postInput.compact_summary,
        );
      }
    } catch (err) {
      console.error('[context-compact] Failed to save transcript:', err);
    }
    return { continue: true };
  };
}
