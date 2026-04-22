// Non-streaming response translation: OpenAI → Anthropic

import type { AnthropicResponse, AnthropicResponseContentBlock, AnthropicStopReason } from '../types/anthropic';
import type { OpenAIResponse } from '../types/openai';
import { translateToolCalls } from './tools';
import { generateMessageId } from '../utils/id';
import { fromOpenAIUsage, toAnthropicUsage } from './usage';

/** Map OpenAI finish_reason → Anthropic stop_reason */
export function translateStopReason(reason: string | null): AnthropicStopReason | null {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls': return 'tool_use';
    case 'content_filter': return 'end_turn';
    default: return reason ? 'end_turn' : null;
  }
}

/** Translate OpenAI response → Anthropic response */
export function translateResponse(
  openaiResp: OpenAIResponse,
  requestModel: string,
  translateReasoning = true,
): AnthropicResponse {
  const choice = openaiResp.choices?.[0];
  const content: AnthropicResponseContentBlock[] = [];

  if (choice) {
    // reasoning_content → thinking block (if enabled)
    if (translateReasoning) {
      const reasoning = (choice.message as { reasoning_content?: string }).reasoning_content;
      if (reasoning) {
        content.push({
          type: 'thinking',
          thinking: reasoning,
          signature: '',
        });
      }
    }

    // text content
    if (choice.message.content) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    // tool calls
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      content.push(...translateToolCalls(choice.message.tool_calls));
    }
  }

  // Ensure at least one content block
  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  const usage = fromOpenAIUsage(openaiResp.usage);

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model: requestModel,
    stop_reason: translateStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: toAnthropicUsage(usage),
  };
}
