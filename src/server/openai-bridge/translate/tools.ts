// Tool definition, call, result, and tool_choice translation

import type { AnthropicToolDefinition, AnthropicToolChoice } from '../types/anthropic';
import type { OpenAIToolDefinition, OpenAIToolChoice, OpenAIToolCall } from '../types/openai';
import { generateToolUseId } from '../utils/id';

/** Anthropic tool definitions → OpenAI function tools */
export function translateToolDefinitions(tools: AnthropicToolDefinition[]): OpenAIToolDefinition[] {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/** Anthropic tool_choice → OpenAI tool_choice */
export function translateToolChoice(choice: AnthropicToolChoice): OpenAIToolChoice {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

/** OpenAI tool_calls → Anthropic tool_use content blocks.
 *
 * IMPORTANT: thought_signature is intentionally NOT included here.
 * The SDK stores these Anthropic-format blocks in its session transcript and replays
 * them on resume. Including non-standard fields like thought_signature causes the
 * Anthropic API to reject the request ("Extra inputs are not permitted").
 * The bridge handler caches thought_signatures separately (handler.ts thoughtSignatureCache)
 * and re-injects them on outgoing OpenAI-format requests. See: #68 */
export function translateToolCalls(toolCalls: OpenAIToolCall[]): {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}[] {
  return toolCalls.map(tc => ({
    type: 'tool_use' as const,
    id: tc.id || generateToolUseId(),
    name: tc.function.name,
    input: safeParseJson(tc.function.arguments),
  }));
}

/** Robust JSON parser for tool call arguments from various providers */
export function safeParseJson(str: string): Record<string, unknown> {
  // Empty or whitespace-only → empty object
  if (!str || !str.trim()) return {};

  const trimmed = str.trim();

  // First attempt: direct parse
  try {
    const parsed = JSON.parse(trimmed);
    // Ensure result is an object (not array, string, number, etc.)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: parsed };
    }
    return parsed;
  } catch {
    // Fall through to recovery attempts
  }

  // Second attempt: truncate trailing garbage (some providers emit extra tokens after valid JSON)
  const lastBrace = trimmed.lastIndexOf('}');
  if (lastBrace > 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(0, lastBrace + 1));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return { value: parsed };
    } catch {
      // Fall through
    }
  }

  console.warn('[bridge] Failed to parse tool arguments:', trimmed.slice(0, 200));
  return {};
}
