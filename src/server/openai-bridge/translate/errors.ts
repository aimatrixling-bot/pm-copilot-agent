// Error format translation: OpenAI → Anthropic

import type { AnthropicErrorResponse } from '../types/anthropic';

/** Map HTTP status code to Anthropic error type */
function statusToErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    case 500:
    case 502:
    case 503:
    case 529:
      return 'api_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

/** Extract error message from various upstream response formats */
function extractErrorMessage(body: string, status: number): string {
  const fallback = `Upstream error (${status})`;

  try {
    const parsed = JSON.parse(body);

    // OpenAI format: { error: { message, type, code } }
    if (parsed?.error?.message) {
      return parsed.error.message;
    }

    // FastAPI / some providers: { detail: "..." } or { detail: [{ msg: "..." }] }
    if (parsed?.detail) {
      if (typeof parsed.detail === 'string') return parsed.detail;
      if (Array.isArray(parsed.detail) && parsed.detail[0]?.msg) {
        return parsed.detail.map((d: { msg: string }) => d.msg).join('; ');
      }
    }

    // Simple format: { message: "..." }
    if (typeof parsed?.message === 'string') {
      return parsed.message;
    }

    // Nested error object: { error: "string" }
    if (typeof parsed?.error === 'string') {
      return parsed.error;
    }

    return fallback;
  } catch {
    // Not JSON — use raw body (truncated)
    if (body) return body.slice(0, 500);
    return fallback;
  }
}

/** Detect non-retryable 429 errors (quota exhausted vs temporary rate limit).
 *  Claude Agent SDK retries 429/rate_limit_error indefinitely with backoff,
 *  which is correct for temporary rate limits but wrong for permanent quota errors.
 *  We remap these to 402 so the SDK surfaces the error immediately. */
function isQuotaExhausted(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('exceeded your current quota')
    || lower.includes('quota exceeded')
    || lower.includes('insufficient_quota')
    || lower.includes('payment required')
    || lower.includes('billing_not_active')
    || lower.includes('billing hard limit');
}

/** Translate an upstream error to Anthropic error format */
export function translateError(status: number, body: string): { status: number; body: AnthropicErrorResponse } {
  const message = extractErrorMessage(body, status);

  // Non-retryable quota errors: remap 429 → 402 so SDK won't retry infinitely.
  // The SDK treats 429 as transient and retries, but quota exhaustion is permanent.
  if (status === 429 && isQuotaExhausted(message)) {
    return {
      status: 402,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message,
        },
      },
    };
  }

  // Map OpenAI status codes to Anthropic equivalents
  const anthropicStatus = status === 402 ? 400 : status;

  return {
    status: anthropicStatus,
    body: {
      type: 'error',
      error: {
        type: statusToErrorType(status),
        message,
      },
    },
  };
}
