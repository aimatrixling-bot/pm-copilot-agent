// Request translation: Anthropic → OpenAI Responses API

import type { AnthropicRequest, AnthropicMessage, AnthropicToolResultBlock, AnthropicSystemBlock } from '../types/anthropic';
import type { ResponsesRequest, ResponsesInputItem, ResponsesInputContentPart, ResponsesInputFunctionCall, ResponsesToolChoice } from '../types/openai-responses';
import type { BridgeConfig } from '../types/bridge';


export interface TranslateRequestResponsesOptions {
  modelMapping?: BridgeConfig['modelMapping'];
  modelOverride?: string;
}

/** Translate Anthropic Messages API request → OpenAI Responses API request */
export function translateRequestToResponses(
  req: AnthropicRequest,
  options?: TranslateRequestResponsesOptions,
): ResponsesRequest {
  // 1. Model mapping
  let model = req.model;
  if (options?.modelOverride) {
    model = options.modelOverride;
  } else if (options?.modelMapping) {
    const mapping = options.modelMapping;
    if (typeof mapping === 'function') {
      model = mapping(req.model) ?? req.model;
    } else {
      model = mapping[req.model] ?? req.model;
    }
  }

  // 2. Instructions (system prompt)
  let instructions: string | undefined;
  if (req.system) {
    instructions = typeof req.system === 'string'
      ? req.system
      : (req.system as AnthropicSystemBlock[]).map(b => b.text).join('\n\n');
  }

  // 3. Input messages
  const input = translateMessagesToResponses(req.messages);

  // 4. Build request
  // NOTE: max_output_tokens, temperature, top_p are intentionally NOT forwarded.
  // - max_output_tokens: handler injects user-configured cap via the correct param name.
  // - temperature, top_p: SDK values may not be compatible with target model. Let upstream use defaults.
  const responsesReq: ResponsesRequest = {
    model,
    input,
  };

  if (instructions) responsesReq.instructions = instructions;

  // 5. Tools
  if (req.tools && req.tools.length > 0) {
    responsesReq.tools = req.tools.map(t => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  // 6. Tool choice
  if (req.tool_choice) {
    responsesReq.tool_choice = translateToolChoiceToResponses(req.tool_choice);
  }

  // 7. Stream
  if (req.stream) {
    responsesReq.stream = true;
  }

  // 8. Thinking → reasoning: intentionally omitted.
  // Many OpenAI-compatible providers don't support reasoning/reasoning_effort,
  // and custom providers would return 400 "Unrecognized request argument".

  return responsesReq;
}

function translateToolChoiceToResponses(choice: NonNullable<AnthropicRequest['tool_choice']>): ResponsesToolChoice {
  switch (choice.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', name: choice.name };
  }
}

function translateMessagesToResponses(messages: AnthropicMessage[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = [];

  // Collect known tool_use_ids for orphan detection
  const knownToolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          knownToolUseIds.add(block.id);
        }
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      translateUserMessageToResponses(msg, result, knownToolUseIds);
    } else if (msg.role === 'assistant') {
      translateAssistantMessageToResponses(msg, result);
    }
  }

  return result;
}

function translateUserMessageToResponses(
  msg: AnthropicMessage,
  result: ResponsesInputItem[],
  knownToolUseIds: Set<string>,
): void {
  if (typeof msg.content === 'string') {
    result.push({ role: 'user', content: msg.content });
    return;
  }

  const toolResults: AnthropicToolResultBlock[] = [];
  const orphanTexts: string[] = [];
  const otherParts: ResponsesInputContentPart[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      if (knownToolUseIds.has(block.tool_use_id)) {
        toolResults.push(block);
      } else {
        const content = extractToolResultText(block);
        if (content) orphanTexts.push(`[Previous tool result]:\n${content}`);
      }
    } else if (block.type === 'text') {
      otherParts.push({ type: 'input_text', text: block.text });
    } else if (block.type === 'image') {
      if (block.source.type === 'url' && block.source.url) {
        otherParts.push({ type: 'input_image', image_url: block.source.url });
      } else if (block.source.data) {
        const mediaType = block.source.media_type || 'image/png';
        otherParts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${block.source.data}` });
      }
    }
    // thinking blocks filtered
  }

  // Emit function_call_output items for tool results
  for (const tr of toolResults) {
    result.push({
      type: 'function_call_output',
      call_id: tr.tool_use_id,
      output: extractToolResultText(tr),
    });
  }

  // Add orphan text to other parts
  for (const text of orphanTexts) {
    otherParts.push({ type: 'input_text', text });
  }

  // Emit user message for remaining content
  if (otherParts.length > 0) {
    if (otherParts.length === 1 && otherParts[0].type === 'input_text') {
      result.push({ role: 'user', content: otherParts[0].text });
    } else {
      result.push({ role: 'user', content: otherParts });
    }
  }
}

function translateAssistantMessageToResponses(msg: AnthropicMessage, result: ResponsesInputItem[]): void {
  if (typeof msg.content === 'string') {
    result.push({ role: 'assistant', content: msg.content });
    return;
  }

  // Build assistant content parts and function calls
  const contentParts: ResponsesInputContentPart[] = [];
  const functionCalls: ResponsesInputFunctionCall[] = [];

  for (const block of msg.content) {
    if (block.type === 'text') {
      contentParts.push({ type: 'output_text', text: block.text });
    } else if (block.type === 'tool_use') {
      // In Responses API input replay, function calls are separate items
      functionCalls.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
      });
    }
    // thinking blocks are not replayed in input
  }

  // Emit text content as assistant message
  if (contentParts.length > 0) {
    result.push({ role: 'assistant', content: contentParts });
  }

  // Emit each function call as a separate input item
  for (const fc of functionCalls) {
    result.push(fc);
  }

  // If no content and no function calls, emit empty assistant message
  if (contentParts.length === 0 && functionCalls.length === 0) {
    result.push({ role: 'assistant', content: '' });
  }
}

function extractToolResultText(tr: AnthropicToolResultBlock): string {
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
