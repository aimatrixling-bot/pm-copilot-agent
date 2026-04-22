// OpenAI Bridge — main entry point
// Translates Anthropic Messages API → OpenAI Chat Completions / Responses API

export { createBridgeHandler, getProxyForUrl } from './handler';
export type { BridgeHandler } from './handler';
export type { BridgeConfig, UpstreamConfig } from './types/bridge';
