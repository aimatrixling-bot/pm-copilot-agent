// ID generation utilities for Anthropic-compatible IDs

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomString(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

export function generateMessageId(): string {
  return `msg_bridge_${randomString(20)}`;
}

export function generateToolUseId(): string {
  return `toolu_bridge_${randomString(20)}`;
}
