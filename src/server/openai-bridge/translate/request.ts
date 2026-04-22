// Full request translation: Anthropic → OpenAI

import type { AnthropicRequest } from '../types/anthropic';
import type { OpenAIRequest } from '../types/openai';
import type { BridgeConfig } from '../types/bridge';
import { translateMessages } from './messages';
import { translateToolDefinitions, translateToolChoice } from './tools';


export interface TranslateRequestOptions {
  modelMapping?: BridgeConfig['modelMapping'];
  /** Override model name (highest priority) */
  modelOverride?: string;
}

/** Translate Anthropic Messages API request → OpenAI Chat Completions request */
export function translateRequest(
  req: AnthropicRequest,
  options?: TranslateRequestOptions,
): OpenAIRequest {
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

  // 2. Messages (system extraction + role mapping + tool_result splitting)
  const thinkingEnabled = req.thinking?.type === 'enabled';
  const messages = translateMessages(req.system, req.messages, thinkingEnabled);

  // 3. Build request
  // NOTE: max_tokens, temperature, top_p, stop are intentionally NOT forwarded.
  // - max_tokens: SDK sends Claude-scale values (128k); the handler injects the user-configured
  //   cap via the correct param name (max_tokens / max_completion_tokens) based on provider config.
  // - temperature, top_p, stop: Anthropic SDK values may not be compatible with the target model
  //   (e.g., reasoning models reject non-default temperature/top_p/stop). Let upstream use defaults.
  const openaiReq: OpenAIRequest = {
    model,
    messages,
  };

  // 4. Tools
  if (req.tools && req.tools.length > 0) {
    openaiReq.tools = translateToolDefinitions(req.tools);
  }
  if (req.tool_choice) {
    openaiReq.tool_choice = translateToolChoice(req.tool_choice);
    // Map disable_parallel_tool_use → parallel_tool_calls
    if ('disable_parallel_tool_use' in req.tool_choice && req.tool_choice.disable_parallel_tool_use) {
      openaiReq.parallel_tool_calls = false;
    }
  }

  // 5. Stream
  if (req.stream) {
    openaiReq.stream = true;
    openaiReq.stream_options = { include_usage: true };
  }

  // 6. Thinking → reasoning_effort: intentionally omitted.
  // Many OpenAI-compatible providers don't support reasoning_effort,
  // and custom providers would return 400 "Unrecognized request argument".

  return openaiReq;
}
