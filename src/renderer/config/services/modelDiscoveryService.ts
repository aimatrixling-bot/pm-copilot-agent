/**
 * Model Discovery Service
 *
 * Fetches available models from provider APIs and parses the response
 * into a unified format. Supports both OpenAI and Anthropic response schemas.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Provider, ModelEntity } from '../types';

// ============= Types =============

/** Discovered model — temporary display type for the discovery panel */
export interface DiscoveredModel {
  id: string;
  displayName?: string;
  ownedBy?: string;
  contextLength?: number;
  maxOutputTokens?: number;
  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsReasoning?: boolean;
  status?: string;
}

// ============= Fetching =============

/**
 * Fetch models from a provider via external HTTP.
 * - anthropic-api: Anthropic REST API (x-api-key auth)
 * - Other providers: OpenAI-compatible /v1/models (Bearer auth)
 * - anthropic-sub: not supported (no API key, SDK returns aliases not real model IDs)
 */
export async function fetchProviderModels(
  provider: Provider,
  apiKey: string | undefined,
): Promise<DiscoveredModel[]> {
  if (!apiKey) throw new Error('API Key is required');
  const url = resolveModelListUrl(provider);
  if (!url) throw new Error('No model list URL available for this provider');

  // Anthropic API: x-api-key auth + anthropic-version header + pagination
  const isAnthropicApi = provider.id === 'anthropic-api';

  const body = await invoke<unknown>('cmd_fetch_provider_models', {
    url: isAnthropicApi ? `${url}?limit=100` : url,
    authHeaderName: isAnthropicApi ? 'x-api-key' : 'Authorization',
    authHeaderValue: isAnthropicApi ? apiKey : `Bearer ${apiKey}`,
    extraHeaders: isAnthropicApi ? { 'anthropic-version': '2023-06-01' } : null,
  });

  return parseModelsResponse(body);
}

/** Resolve the URL to fetch models from.
 *  Smart inference for custom providers based on base URL patterns:
 *  - .../anthropic → strip suffix, use .../v1/models (Anthropic path has no /v1/models)
 *  - .../v1        → append /models (avoid /v1/v1/models duplication)
 *  - other         → append /v1/models (default OpenAI convention)
 */
function resolveModelListUrl(provider: Provider): string | null {
  if (provider.modelListUrl) return provider.modelListUrl;
  const baseUrl = provider.config.baseUrl;
  if (!baseUrl) return null;
  const trimmed = baseUrl.replace(/\/+$/, '');

  if (/\/anthropic$/i.test(trimmed)) {
    return `${trimmed.slice(0, -'/anthropic'.length)}/v1/models`;
  }
  if (/\/v\d+$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

// ============= Parsing =============

/** Parse raw API response into DiscoveredModel[] — auto-detects format */
function parseModelsResponse(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;

  let rawModels: unknown[] = [];

  // Format A: OpenAI — { object: "list", data: [...] }
  if (obj.object === 'list' && Array.isArray(obj.data)) {
    rawModels = obj.data;
  }
  // Format B: Anthropic — { data: [...], has_more } where items have type: "model"
  else if (Array.isArray(obj.data)) {
    const first = (obj.data as Record<string, unknown>[])[0];
    if (first && first.type === 'model') {
      rawModels = obj.data;
    }
  }

  return rawModels
    .filter((m): m is Record<string, unknown> => m != null && typeof m === 'object')
    .map(mapRawToDiscovered)
    .filter(m => m.id !== '' && m.status !== 'Shutdown');
}

function mapRawToDiscovered(m: Record<string, unknown>): DiscoveredModel {
  const tokenLimits = m.token_limits as Record<string, number> | undefined;
  const topProvider = m.top_provider as Record<string, number> | undefined;
  const inputMods = m.input_modalities as string[] | undefined;
  const arch = m.architecture as Record<string, unknown> | undefined;
  const archInputMods = arch?.input_modalities as string[] | undefined;
  const caps = m.capabilities as Record<string, unknown> | undefined;

  // Resolve capabilities — use || (not ??) for boolean-returning expressions
  // because Array.includes() returns false (not undefined) when item is absent,
  // and false ?? x evaluates to false, blocking the fallback.
  const supportsImage =
    toBoolOrUndef(m.supports_image_in) ||
    inputMods?.includes('image') ||
    archInputMods?.includes('image') ||
    toBoolOrUndef((caps?.image_input as Record<string, unknown>)?.supported) ||
    undefined;

  const supportsVideo =
    toBoolOrUndef(m.supports_video_in) ||
    inputMods?.includes('video') ||
    undefined;

  const supportsReasoning =
    toBoolOrUndef(m.supports_reasoning) ||
    toBoolOrUndef(caps?.reasoning) ||
    toBoolOrUndef((caps?.thinking as Record<string, unknown>)?.supported) ||
    undefined;

  return {
    id: normalizeModelId(String(m.id ?? '')),
    displayName: (m.display_name ?? m.name ?? undefined) as string | undefined,
    ownedBy: m.owned_by as string | undefined,
    // Context length: OpenAI extensions / Anthropic max_input_tokens / Volcengine token_limits
    contextLength:
      asNumberOrUndef(m.context_length) ??
      asNumberOrUndef(m.max_input_tokens) ??
      tokenLimits?.context_window ??
      undefined,
    // Max output: Anthropic max_tokens / OpenRouter top_provider / Volcengine token_limits
    maxOutputTokens:
      asNumberOrUndef(m.max_tokens) ??
      topProvider?.max_completion_tokens ??
      tokenLimits?.max_output_token_length ??
      undefined,
    supportsImage,
    supportsVideo,
    supportsReasoning,
    status: m.status as string | undefined,
  };
}

/** Gemini returns "models/gemini-2.5-flash" — strip the prefix */
function normalizeModelId(id: string): string {
  return id.replace(/^models\//, '');
}

/** Safely cast to boolean or undefined (avoids `0` / `""` leaking as valid) */
function toBoolOrUndef(v: unknown): boolean | undefined {
  if (v === true) return true;
  if (v === false) return false;
  return undefined;
}

/** Safely cast to number or undefined */
function asNumberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && v > 0 ? v : undefined;
}

// ============= Conversion =============

/** Convert a discovered model to a persistable ModelEntity */
export function toModelEntity(d: DiscoveredModel, provider: Provider): ModelEntity {
  const modalities: string[] = ['text'];
  if (d.supportsImage) modalities.push('image');
  if (d.supportsVideo) modalities.push('video');

  return {
    model: d.id,
    modelName: d.displayName ?? d.id,
    modelSeries: provider.vendor.toLowerCase(),
    contextLength: d.contextLength,
    maxOutputTokens: d.maxOutputTokens,
    inputModalities: modalities,
    source: 'discovered',
  };
}

// ============= Helpers =============

/** Format token count for display: 128000 → "128K", 1000000 → "1M" */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const k = count / 1_000;
    return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
  }
  return String(count);
}

/** Check if a provider supports model discovery */
export function supportsModelDiscovery(provider: Provider): boolean {
  // Subscription has no API key for REST API
  if (provider.type === 'subscription') return false;
  // MiniMax has no model list endpoint
  if (provider.id === 'minimax') return false;
  return true;
}
