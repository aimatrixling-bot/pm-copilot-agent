// Message array translation: Anthropic messages → OpenAI messages

import type {
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicSystemBlock,
  AnthropicToolResultBlock,
} from '../types/anthropic';
import type { OpenAIMessage, OpenAIAssistantMessage, OpenAIContentPart } from '../types/openai';
import { translateImageBlock } from './multimodal';

/** Convert Anthropic system + messages to OpenAI messages array */
export function translateMessages(
  system: string | AnthropicSystemBlock[] | undefined,
  messages: AnthropicMessage[],
  thinkingEnabled = false,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // 1. System prompt → system message
  if (system) {
    const systemText = typeof system === 'string'
      ? system
      : system.map(b => b.text).join('\n\n');
    if (systemText) {
      result.push({ role: 'system', content: systemText });
    }
  }

  // 2. Collect known tool_use_ids from assistant messages for orphan detection.
  //    Also detect if ANY assistant message in the conversation has thinking content.
  //    Some upstream models (e.g. Kimi K2.5) require reasoning_content on ALL assistant
  //    messages with tool_calls when thinking was used anywhere in the conversation,
  //    even if the current request's thinking.type is not 'enabled'. See: #69
  const knownToolUseIds = new Set<string>();
  let conversationHasThinking = false;
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          knownToolUseIds.add(block.id);
        } else if (block.type === 'thinking' && block.thinking) {
          conversationHasThinking = true;
        }
      }
    }
  }

  // Use conversation-level thinking detection as fallback for request-level flag.
  // The SDK may not always include thinking.type === 'enabled' on every request,
  // but upstream models still require reasoning_content if thinking was used earlier.
  const effectiveThinkingEnabled = thinkingEnabled || conversationHasThinking;

  // 3. Translate each message
  for (const msg of messages) {
    if (msg.role === 'user') {
      translateUserMessage(msg, result, knownToolUseIds);
    } else if (msg.role === 'assistant') {
      translateAssistantMessage(msg, result, effectiveThinkingEnabled);
    }
  }

  return result;
}

function translateUserMessage(
  msg: AnthropicMessage,
  result: OpenAIMessage[],
  knownToolUseIds: Set<string>,
): void {
  // String content → simple user message
  if (typeof msg.content === 'string') {
    result.push({ role: 'user', content: msg.content });
    return;
  }

  // Block array: split tool_result blocks into separate tool messages
  const toolResults: AnthropicToolResultBlock[] = [];
  const orphanToolResults: AnthropicToolResultBlock[] = [];
  const otherBlocks: AnthropicContentBlock[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      if (knownToolUseIds.has(block.tool_use_id)) {
        toolResults.push(block);
      } else {
        orphanToolResults.push(block);
      }
    } else if (block.type !== 'thinking') {
      // Filter out thinking blocks
      otherBlocks.push(block);
    }
  }

  // Emit tool messages first (OpenAI requires tool responses before next user message)
  for (const tr of toolResults) {
    result.push({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content: extractToolResultContent(tr),
    });
  }

  // Convert orphan tool_results to user text (session rewind can leave orphan references)
  for (const tr of orphanToolResults) {
    const content = extractToolResultContent(tr);
    if (content) {
      otherBlocks.push({
        type: 'text',
        text: `[Previous tool result]:\n${content}`,
      });
    }
  }

  // Emit remaining content as user message (if any)
  if (otherBlocks.length > 0) {
    const parts = convertToOpenAIParts(otherBlocks);
    if (parts.length === 1 && parts[0].type === 'text') {
      result.push({ role: 'user', content: parts[0].text });
    } else if (parts.length > 0) {
      result.push({ role: 'user', content: parts });
    }
  }
}

function translateAssistantMessage(msg: AnthropicMessage, result: OpenAIMessage[], thinkingEnabled: boolean): void {
  if (typeof msg.content === 'string') {
    result.push({ role: 'assistant', content: msg.content });
    return;
  }

  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  // Note: thought_signature is NOT included here. The bridge handler re-injects it from
  // its cache (handler.ts:106-138) after message translation. See: #68
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    } else if (block.type === 'thinking') {
      // Preserve thinking blocks as reasoning_content for upstream models
      // that require it in conversation history (e.g. DeepSeek reasoner)
      if (block.thinking) {
        thinkingParts.push(block.thinking);
      }
    }
  }

  // When thinking is enabled, some upstream models (e.g. Kimi) require reasoning_content
  // on ALL assistant messages that contain tool_calls. The SDK may strip thinking blocks
  // with empty signatures, leaving tool_call messages without reasoning_content.
  // Provide an empty reasoning_content to satisfy this validation.
  const needsReasoningContent = thinkingParts.length > 0
    || (thinkingEnabled && toolCalls.length > 0);

  const assistantMsg: OpenAIAssistantMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null,
    ...(needsReasoningContent ? { reasoning_content: thinkingParts.join('\n') } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  result.push(assistantMsg);
}

function extractToolResultContent(tr: AnthropicToolResultBlock): string {
  const isError = tr.is_error === true;

  if (!tr.content) return isError ? '<error></error>' : '';

  let text: string;
  if (typeof tr.content === 'string') {
    text = tr.content;
  } else {
    const parts: string[] = [];
    for (const c of tr.content) {
      if (c.type === 'text') {
        parts.push(c.text);
      } else if (c.type === 'image') {
        parts.push('[Image content omitted - tool returned an image]');
      }
    }
    text = parts.join('\n');
  }

  return isError ? `<error>${text}</error>` : text;
}

function convertToOpenAIParts(blocks: AnthropicContentBlock[]): OpenAIContentPart[] {
  const parts: OpenAIContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push(translateImageBlock(block));
    }
    // tool_use and tool_result are handled separately
  }
  return parts;
}
