// StreamTranslator: OpenAI stream chunks → Anthropic SSE events (state machine)

import type { AnthropicStreamEvent, AnthropicResponse } from '../types/anthropic';
import type { OpenAIStreamChunk, OpenAIStreamToolCall } from '../types/openai';
import { translateStopReason } from './response';
import { generateMessageId, generateToolUseId } from '../utils/id';
import { emptyUsage, mergeUsage, toAnthropicUsage, type UsageSnapshot } from './usage';

interface ToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

export class StreamTranslator {
  private messageId: string;
  private requestModel: string;
  private contentIndex = 0;
  private activeBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private toolCallBuffers = new Map<number, ToolCallBuffer>();
  private usage: UsageSnapshot = emptyUsage();
  private hasEmittedStart = false;
  private hasFinished = false;
  private translateReasoning: boolean;

  constructor(requestModel: string, translateReasoning = true) {
    this.messageId = generateMessageId();
    this.requestModel = requestModel;
    this.translateReasoning = translateReasoning;
  }

  /** Feed an OpenAI stream chunk, returns Anthropic SSE events to emit */
  feed(chunk: OpenAIStreamChunk): AnthropicStreamEvent[] {
    const events: AnthropicStreamEvent[] = [];

    // Emit message_start on first chunk
    if (!this.hasEmittedStart) {
      this.hasEmittedStart = true;
      events.push(this.makeMessageStart());
    }

    // Track usage
    if (chunk.usage) {
      this.usage = mergeUsage(this.usage, chunk.usage);
    }

    const choice = chunk.choices?.[0];
    if (!choice) {
      // Usage-only chunk (final chunk with no choices)
      return events;
    }

    const delta = choice.delta;

    // Handle reasoning_content (thinking)
    if (this.translateReasoning && delta.reasoning_content) {
      if (this.activeBlockType !== 'thinking') {
        this.closeActiveBlock(events);
        this.activeBlockType = 'thinking';
        events.push({
          type: 'content_block_start',
          index: this.contentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
      }
      events.push({
        type: 'content_block_delta',
        index: this.contentIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      });
    }

    // Handle text content
    if (delta.content) {
      if (this.activeBlockType !== 'text') {
        this.closeActiveBlock(events);
        this.activeBlockType = 'text';
        events.push({
          type: 'content_block_start',
          index: this.contentIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      events.push({
        type: 'content_block_delta',
        index: this.contentIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    // Handle tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        this.handleToolCallDelta(tc, events);
      }
    }

    // Handle finish
    if (choice.finish_reason) {
      this.closeActiveBlock(events);
      this.hasFinished = true;

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: translateStopReason(choice.finish_reason),
          stop_sequence: null,
        },
        usage: { output_tokens: this.usage.outputTokens },
      });
      events.push({ type: 'message_stop' });
    }

    return events;
  }

  private handleToolCallDelta(tc: OpenAIStreamToolCall, events: AnthropicStreamEvent[]): void {
    const idx = tc.index;

    if (!this.toolCallBuffers.has(idx)) {
      // New tool call — close previous block, start new tool_use
      this.closeActiveBlock(events);
      this.activeBlockType = 'tool_use';

      const id = tc.id || generateToolUseId();
      const name = tc.function?.name || '';
      this.toolCallBuffers.set(idx, { id, name, args: '' });

      // IMPORTANT: thought_signature is intentionally NOT included on content_block_start.
      // The SDK stores these events in its session transcript and replays them on resume.
      // Including non-standard fields causes API rejection ("Extra inputs are not permitted").
      // The bridge handler caches thought_signatures separately. See: #68
      events.push({
        type: 'content_block_start',
        index: this.contentIndex,
        content_block: { type: 'tool_use', id, name, input: {} },
      });
    }

    // Accumulate arguments
    const buffer = this.toolCallBuffers.get(idx)!;
    if (tc.function?.arguments) {
      buffer.args += tc.function.arguments;
      events.push({
        type: 'content_block_delta',
        index: this.contentIndex,
        delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
      });
    }
  }

  /**
   * Finalize the stream — emit closing events for incomplete streams.
   * Called when the upstream connection ends (normally or abnormally).
   * No-op if finish_reason was already received via feed().
   */
  finalize(): AnthropicStreamEvent[] {
    if (this.hasFinished || !this.hasEmittedStart) return [];

    const events: AnthropicStreamEvent[] = [];
    this.closeActiveBlock(events);
    this.hasFinished = true;

    events.push({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: this.usage.outputTokens },
    });
    events.push({ type: 'message_stop' });
    return events;
  }

  private closeActiveBlock(events: AnthropicStreamEvent[]): void {
    if (this.activeBlockType !== null) {
      events.push({ type: 'content_block_stop', index: this.contentIndex });
      this.contentIndex++;
      this.activeBlockType = null;
    }
  }

  private makeMessageStart(): AnthropicStreamEvent {
    const message: AnthropicResponse = {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.requestModel,
      stop_reason: null,
      stop_sequence: null,
      usage: toAnthropicUsage(this.usage),
    };
    return { type: 'message_start', message };
  }
}
