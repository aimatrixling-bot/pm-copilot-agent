// Normalized token usage: intermediate representation between OpenAI and Anthropic formats

import type { OpenAIUsage } from '../types/openai';
import type { AnthropicUsage } from '../types/anthropic';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export function emptyUsage(): UsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningTokens: 0,
  };
}

/** OpenAI usage → normalized UsageSnapshot */
export function fromOpenAIUsage(usage: OpenAIUsage | null | undefined): UsageSnapshot {
  if (!usage) return emptyUsage();
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationInputTokens: 0, // OpenAI doesn't report cache creation
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** UsageSnapshot → Anthropic usage format */
export function toAnthropicUsage(snap: UsageSnapshot): AnthropicUsage {
  return {
    input_tokens: snap.inputTokens,
    output_tokens: snap.outputTokens,
    ...(snap.cacheReadInputTokens > 0 ? { cache_read_input_tokens: snap.cacheReadInputTokens } : {}),
    ...(snap.cacheCreationInputTokens > 0 ? { cache_creation_input_tokens: snap.cacheCreationInputTokens } : {}),
  };
}

/** Merge a partial OpenAI usage update into an existing snapshot (for streaming accumulation) */
export function mergeUsage(existing: UsageSnapshot, usage: OpenAIUsage | null | undefined): UsageSnapshot {
  if (!usage) return existing;
  return {
    inputTokens: usage.prompt_tokens ?? existing.inputTokens,
    outputTokens: usage.completion_tokens ?? existing.outputTokens,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? existing.cacheReadInputTokens,
    cacheCreationInputTokens: existing.cacheCreationInputTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? existing.reasoningTokens,
  };
}
