// Bridge HTTP handler: receives Anthropic requests, translates to OpenAI, forwards, translates back

import type { BridgeConfig, UpstreamConfig } from './types/bridge';
import type { AnthropicRequest } from './types/anthropic';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from './types/openai';
import type { ResponsesResponse, ResponsesStreamEvent } from './types/openai-responses';
import { translateRequest } from './translate/request';
import { translateResponse } from './translate/response';
import { translateRequestToResponses } from './translate/request-responses';
import { translateResponsesResponse, ResponsesApiError } from './translate/response-responses';
import { StreamTranslator } from './translate/stream';
import { ResponsesStreamTranslator } from './translate/stream-responses';
import { translateError } from './translate/errors';
import { SSEParser } from './utils/sse-parser';
import { formatSSE } from './utils/sse-writer';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const THOUGHT_SIG_CACHE_MAX = 500; // Max cached thought_signatures to prevent unbounded growth

// Gemini-documented dummy value to skip thought_signature validation
// when the real signature is unavailable (e.g., cross-model history, injected tool calls).
// See: https://ai.google.dev/gemini-api/docs/thought-signatures
const THOUGHT_SIG_SKIP_VALIDATOR = 'skip_thought_signature_validator';

/** Detect proxy URL from environment (respects no_proxy for the target URL) */
export function getProxyForUrl(url: string): string | undefined {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return undefined;

  // Check no_proxy
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  if (noProxy === '*') return undefined;
  if (noProxy) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      const excluded = noProxy.split(',').some(p => {
        const pattern = p.trim().toLowerCase();
        return host === pattern || host.endsWith(`.${pattern}`);
      });
      if (excluded) return undefined;
    } catch { /* invalid URL, skip no_proxy check */ }
  }

  return proxy;
}

export interface BridgeHandler {
  /** Handle an incoming Anthropic-format request */
  (request: Request): Promise<Response>;
  /** Seed the thought_signature cache (e.g., from persisted session history) */
  seedThoughtSignatures(entries: Array<{ id: string; thought_signature: string }>): void;
}

/** Create a bridge handler that translates Anthropic → OpenAI → Anthropic */
export function createBridgeHandler(config: BridgeConfig): BridgeHandler {
  const log = config.logger === null ? () => {} : (config.logger ?? console.log);
  const timeout = config.upstreamTimeout ?? DEFAULT_TIMEOUT;
  const translateReasoning = config.translateReasoning ?? true;

  // Cache tool_call_id → thought_signature across requests.
  // Gemini thinking models require round-tripping thought_signature on every request
  // that includes tool calls in history. The Claude Agent SDK strips non-standard fields,
  // so we must cache them here and re-inject on outgoing requests.
  // Capped at THOUGHT_SIG_CACHE_MAX to prevent unbounded growth in long-lived sessions.
  const thoughtSignatureCache = new Map<string, string>();

  const handler = async (request: Request): Promise<Response> => {
    // 1. Extract API key from request headers
    const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace('Bearer ', '') || '';

    // 2. Parse Anthropic request body
    let anthropicReq: AnthropicRequest;
    try {
      anthropicReq = await request.json() as AnthropicRequest;
    } catch {
      return jsonError(400, 'invalid_request_error', 'Invalid JSON in request body');
    }

    // 3. Get upstream config
    let upstream: UpstreamConfig;
    try {
      upstream = await config.getUpstreamConfig(request);
    } catch (err) {
      log(`[bridge] Failed to get upstream config: ${err}`);
      return jsonError(500, 'api_error', 'Bridge configuration error');
    }

    const effectiveApiKey = upstream.apiKey || apiKey;
    const baseUrl = upstream.baseUrl.replace(/\/+$/, ''); // trim trailing slashes
    const isResponses = upstream.upstreamFormat === 'responses';

    // 4. Translate request (choose format based on upstream config)
    const translatedReq = isResponses
      ? translateRequestToResponses(anthropicReq, { modelOverride: upstream.model, modelMapping: config.modelMapping })
      : translateRequest(anthropicReq, { modelMapping: config.modelMapping, modelOverride: upstream.model });

    // 4a. Normalize thought_signatures on tool_calls (Gemini thinking models).
    // Gemini requires thought_signature on tool_calls in conversation history.
    // In OpenAI-compat format, Gemini expects it at extra_content.google.thought_signature.
    // The Claude Agent SDK strips non-standard fields, so we re-inject from cache.
    // We normalize ALL tool_calls to have BOTH locations (direct + extra_content):
    //   - Sig exists at one location → copy to the other (normalization)
    //   - No sig at either → inject from cache or Google-documented dummy fallback
    if (!isResponses) {
      const chatReq = translatedReq as OpenAIRequest;
      let injectedCached = 0;
      let injectedDummy = 0;
      let normalized = 0;
      for (const msg of chatReq.messages) {
        if (msg.role === 'assistant' && 'tool_calls' in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            const existingSig = tc.thought_signature
              || tc.extra_content?.google?.thought_signature;
            if (existingSig) {
              // Normalize: ensure both locations have the sig
              if (!tc.thought_signature || !tc.extra_content?.google?.thought_signature) {
                tc.thought_signature = existingSig;
                tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: existingSig } };
                normalized++;
              }
            } else {
              // No sig anywhere — inject from cache or dummy
              const cached = thoughtSignatureCache.get(tc.id);
              const sig = cached || THOUGHT_SIG_SKIP_VALIDATOR;
              tc.thought_signature = sig;
              tc.extra_content = { ...tc.extra_content, google: { ...tc.extra_content?.google, thought_signature: sig } };
              if (cached) injectedCached++;
              else injectedDummy++;
            }
          }
        }
      }
      if (injectedCached > 0 || injectedDummy > 0 || normalized > 0) {
        log(`[bridge] thought_signatures: ${injectedCached} cached, ${injectedDummy} dummy, ${normalized} normalized`);
      }
    }

    // 4b. Inject token limit if configured.
    // Request translators intentionally omit token limits (SDK sends Claude-scale values
    // that are meaningless for other providers). Only inject when the user explicitly
    // configured a cap via maxOutputTokens in provider settings.
    const maxOutputTokensCap = upstream.maxOutputTokens ?? config.maxOutputTokens;
    if (maxOutputTokensCap) {
      if (isResponses) {
        // Responses API always uses max_output_tokens
        (translatedReq as { max_output_tokens?: number }).max_output_tokens = maxOutputTokensCap;
        log(`[bridge] Injecting max_output_tokens=${maxOutputTokensCap}`);
      } else {
        // Chat Completions: use user-configured param name (default max_tokens for widest compatibility)
        const paramName = upstream.maxOutputTokensParamName ?? 'max_tokens';
        const chatReq = translatedReq as OpenAIRequest & { [key: string]: unknown };
        chatReq[paramName] = maxOutputTokensCap;
        log(`[bridge] Injecting ${paramName}=${maxOutputTokensCap}`);
      }
    }

    const logModel = (translatedReq as { model: string }).model;
    log(`[bridge] ${anthropicReq.model} → ${logModel} stream=${!!anthropicReq.stream} tools=${anthropicReq.tools?.length ?? 0} format=${isResponses ? 'responses' : 'chat_completions'}`);

    // 5. Forward to upstream
    const upstreamUrl = isResponses
      ? `${baseUrl}/responses`
      : `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let upstreamResp: Response;
    try {
      // Detect proxy for upstream URL (reads from sidecar's process.env, respects no_proxy)
      const proxyUrl = getProxyForUrl(upstreamUrl);
      upstreamResp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${effectiveApiKey}`,
        },
        body: JSON.stringify(translatedReq),
        signal: controller.signal,
        ...(proxyUrl ? { proxy: proxyUrl } : {}),
      } as RequestInit);
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`[bridge] Upstream ${isTimeout ? 'timeout' : 'error'}: ${errMsg}`);
      return jsonError(
        isTimeout ? 408 : 502,
        'api_error',
        isTimeout ? 'Upstream request timed out' : `Upstream connection error: ${errMsg}`,
      );
    }

    // 6. Handle upstream errors
    if (!upstreamResp.ok) {
      clearTimeout(timer);
      const errBody = await upstreamResp.text();
      log(`[bridge] Upstream error ${upstreamResp.status}: ${errBody.slice(0, 300)}`);
      const { status, body } = translateError(upstreamResp.status, errBody);
      if (status !== upstreamResp.status) {
        log(`[bridge] Remapped ${upstreamResp.status} → ${status} (${body.error.type})`);
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    clearTimeout(timer);

    // 7. Detect Content-Type to handle unexpected SSE on non-stream requests
    const contentType = upstreamResp.headers.get('content-type') ?? '';
    const isSSEResponse = contentType.includes('text/event-stream');

    // 8. Translate response
    if (anthropicReq.stream || isSSEResponse) {
      // Stream response (or non-stream request that got SSE back — auto-fallback)
      if (isSSEResponse && !anthropicReq.stream) {
        log('[bridge] Non-stream request received SSE response — auto-falling back to stream processing');
      }
      return isResponses
        ? handleResponsesStreamResponse(upstreamResp, anthropicReq.model, log)
        : handleStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache);
    } else {
      return isResponses
        ? handleResponsesNonStreamResponse(upstreamResp, anthropicReq.model, log)
        : handleNonStreamResponse(upstreamResp, anthropicReq.model, translateReasoning, log, thoughtSignatureCache);
    }
  };

  // Expose cache seeding for session resume (thought_signatures from persisted history)
  // Uses cacheThoughtSignatures() to enforce THOUGHT_SIG_CACHE_MAX consistently.
  handler.seedThoughtSignatures = (entries: Array<{ id: string; thought_signature: string }>) => {
    cacheThoughtSignatures(entries, thoughtSignatureCache, THOUGHT_SIG_CACHE_MAX);
    if (entries.length > 0) {
      log(`[bridge] Seeded ${entries.length} thought_signature(s) from session history`);
    }
  };

  // Safe: function object with an attached method property matches BridgeHandler's callable + method shape
  return handler as BridgeHandler;
}

async function handleNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache?: Map<string, string>,
): Promise<Response> {
  // Use text() + manual JSON.parse to tolerate non-standard Content-Type
  let openaiResp: OpenAIResponse;
  try {
    const text = await upstreamResp.text();
    openaiResp = JSON.parse(text) as OpenAIResponse;
  } catch {
    log('[bridge] Failed to parse upstream JSON response');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  // Cache thought_signatures from tool calls (Gemini thinking models)
  if (thoughtSignatureCache) {
    cacheThoughtSignatures(openaiResp.choices?.[0]?.message?.tool_calls, thoughtSignatureCache);
  }

  const anthropicResp = translateResponse(openaiResp, requestModel, translateReasoning);
  return new Response(JSON.stringify(anthropicResp), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function handleStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  translateReasoning: boolean,
  log: (msg: string) => void,
  thoughtSignatureCache?: Map<string, string>,
): Response {
  const translator = new StreamTranslator(requestModel, translateReasoning);
  const sseParser = new SSEParser();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamResp.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const sseEvents = sseParser.feed(text);

          for (const sseEvent of sseEvents) {
            if (sseEvent.data === '[DONE]') continue;
            let chunk: OpenAIStreamChunk;
            try {
              chunk = JSON.parse(sseEvent.data) as OpenAIStreamChunk;
            } catch {
              continue; // Skip malformed chunks
            }

            // Cache thought_signatures from streaming tool call chunks (Gemini thinking models).
            // Gemini OpenAI-compat format puts it at: extra_content.google.thought_signature
            // Also check direct thought_signature field for forward compatibility.
            if (thoughtSignatureCache) {
              const delta = chunk.choices?.[0]?.delta;
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  if (tc.id) {
                    const sig = tc.thought_signature
                      || tc.extra_content?.google?.thought_signature;
                    if (sig) {
                      thoughtSignatureCache.set(tc.id, sig);
                      log(`[bridge] Cached thought_signature for ${tc.id} (len=${sig.length})`);
                    }
                  }
                }
                // Evict oldest if over cap
                if (thoughtSignatureCache.size > THOUGHT_SIG_CACHE_MAX) {
                  const excess = thoughtSignatureCache.size - THOUGHT_SIG_CACHE_MAX;
                  const iter = thoughtSignatureCache.keys();
                  for (let i = 0; i < excess; i++) {
                    thoughtSignatureCache.delete(iter.next().value!);
                  }
                }
              }
            }

            const anthropicEvents = translator.feed(chunk);
            for (const event of anthropicEvents) {
              controller.enqueue(encoder.encode(formatSSE(event)));
            }
          }
        }
      } catch (err) {
        log(`[bridge] Stream error: ${err}`);
      } finally {
        // Emit closing events for incomplete streams (no-op if already finished)
        const finalEvents = translator.finalize();
        for (const event of finalEvents) {
          controller.enqueue(encoder.encode(formatSSE(event)));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ==================== Responses API handlers ====================

async function handleResponsesNonStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
): Promise<Response> {
  let responsesResp: ResponsesResponse;
  try {
    const text = await upstreamResp.text();
    responsesResp = JSON.parse(text) as ResponsesResponse;
  } catch {
    log('[bridge] Failed to parse upstream Responses JSON');
    return jsonError(502, 'api_error', 'Invalid upstream response');
  }

  try {
    const anthropicResp = translateResponsesResponse(responsesResp, requestModel);
    return new Response(JSON.stringify(anthropicResp), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof ResponsesApiError) {
      log(`[bridge] Responses API failed: [${err.code}] ${err.message}`);
      return jsonError(502, err.code, err.message);
    }
    throw err;
  }
}

function handleResponsesStreamResponse(
  upstreamResp: Response,
  requestModel: string,
  log: (msg: string) => void,
): Response {
  const translator = new ResponsesStreamTranslator(requestModel);
  const sseParser = new SSEParser();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamResp.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const encoder = new TextEncoder();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value, { stream: true });
          const sseEvents = sseParser.feed(text);

          for (const sseEvent of sseEvents) {
            if (sseEvent.data === '[DONE]') continue;
            let event: ResponsesStreamEvent;
            try {
              event = JSON.parse(sseEvent.data) as ResponsesStreamEvent;
            } catch {
              continue;
            }

            const anthropicEvents = translator.feed(event);
            for (const ae of anthropicEvents) {
              controller.enqueue(encoder.encode(formatSSE(ae)));
            }
          }
        }
      } catch (err) {
        log(`[bridge] Responses stream error: ${err}`);
      } finally {
        const finalEvents = translator.finalize();
        for (const event of finalEvents) {
          controller.enqueue(encoder.encode(formatSSE(event)));
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

function jsonError(status: number, type: string, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Extract and cache thought_signatures from tool calls (non-stream response).
 * Checks both direct thought_signature and extra_content.google.thought_signature (Gemini OpenAI-compat). */
function cacheThoughtSignatures(
  toolCalls: { id: string; thought_signature?: string; extra_content?: { google?: { thought_signature?: string } } }[] | undefined,
  cache: Map<string, string>,
  maxSize = THOUGHT_SIG_CACHE_MAX,
): void {
  if (!toolCalls) return;
  for (const tc of toolCalls) {
    const sig = tc.thought_signature || tc.extra_content?.google?.thought_signature;
    if (tc.id && sig) {
      cache.set(tc.id, sig);
    }
  }
  // Evict oldest entries if cache exceeds max size
  if (cache.size > maxSize) {
    const excess = cache.size - maxSize;
    const iter = cache.keys();
    for (let i = 0; i < excess; i++) {
      cache.delete(iter.next().value!);
    }
  }
}
