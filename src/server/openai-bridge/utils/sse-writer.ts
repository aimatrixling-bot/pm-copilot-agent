// Anthropic SSE event serializer

import type { AnthropicStreamEvent } from '../types/anthropic';

export function formatSSE(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
