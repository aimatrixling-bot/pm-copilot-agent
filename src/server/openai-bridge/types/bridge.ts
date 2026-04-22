// Bridge configuration types

export interface BridgeConfig {
  /** Callback to get upstream OpenAI endpoint config per request */
  getUpstreamConfig: (req: Request) => UpstreamConfig | Promise<UpstreamConfig>;

  /** Model name mapping: SDK sends claude-xxx, may need mapping to actual model */
  modelMapping?: Record<string, string> | ((model: string) => string | undefined);

  /** Upstream request timeout in ms. Default 300000 (5 min) */
  upstreamTimeout?: number;

  /** Logger function. null to disable. Default console.log */
  logger?: ((msg: string) => void) | null;

  /** Translate OpenAI reasoning_content to Anthropic thinking block. Default true */
  translateReasoning?: boolean;

  /** Global cap for max_tokens sent to upstream. CLI may send Claude-scale values (128k)
   *  that exceed OpenAI-compatible provider limits. Per-request UpstreamConfig.maxOutputTokens
   *  takes priority over this. Default: no cap. */
  maxOutputTokens?: number;
}

export interface UpstreamConfig {
  /** OpenAI-compatible endpoint base URL, e.g. "https://api.openai.com/v1" */
  baseUrl: string;
  /** Override API Key (optional, defaults to x-api-key from request header) */
  apiKey?: string;
  /** Override model name (optional, higher priority than modelMapping) */
  model?: string;
  /** Per-request max output tokens cap (takes priority over BridgeConfig.maxOutputTokens) */
  maxOutputTokens?: number;
  /** Parameter name for token limit. Default 'max_tokens' for Chat Completions, forced 'max_output_tokens' for Responses. */
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  /** Upstream API format: 'chat_completions' (default) or 'responses' (OpenAI Responses API) */
  upstreamFormat?: 'chat_completions' | 'responses';
}
