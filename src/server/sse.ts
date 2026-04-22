import { randomUUID } from 'crypto';
import { localTimestamp } from '../shared/logTime';

type SseClient = {
  id: string;
  send: (event: string, data: unknown) => void;
  close: () => void;
};

const encoder = new TextEncoder();

// 🔧 Fix: Use globalThis to ensure single clients Set even if module is loaded twice
// (Per ChatGPT's suggestion to prevent module double-loading issues)
const CLIENTS_KEY = '__pm_copilot_sse_clients__';
export const SSE_INSTANCE_ID = Math.random().toString(16).slice(2);

const clients: Set<SseClient> =
  (globalThis as Record<string, unknown>)[CLIENTS_KEY] as Set<SseClient> ??
  ((globalThis as Record<string, unknown>)[CLIENTS_KEY] = new Set<SseClient>());

const HEARTBEAT_INTERVAL_MS = 15000;

// ── Last-Value Cache ──
// Events whose latest value is cached and replayed to newly connected clients.
// Solves the "late joiner" problem: when a Tab connects to a session already in progress
// (e.g., IM Bot mid-flight), it immediately receives the current session state instead
// of showing idle until the next live event arrives.
// Only cache chat:status — chat:system-init is already replayed inline by the /chat/stream
// handler (index.ts), so caching it here would cause duplicate delivery that poisons
// isStreamingRef in the frontend.
const CACHED_EVENTS = new Set(['chat:status']);
const LAST_VALUE_CACHE_KEY = '__pm_copilot_sse_lvc__';
const lastValueCache: Map<string, unknown> =
  (globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] as Map<string, unknown> ??
  ((globalThis as Record<string, unknown>)[LAST_VALUE_CACHE_KEY] = new Map<string, unknown>());

function summarizePayload(event: string, data: unknown): string {
  if (event === 'chat:message-replay' && typeof data === 'object' && data !== null) {
    const message = (data as { message?: { id?: string } }).message;
    if (message?.id) {
      return `messageId=${message.id}`;
    }
  }
  if (event === 'chat:message-chunk' && typeof data === 'string') {
    return `chars=${data.length}`;
  }
  if (typeof data === 'string') {
    const trimmed = data.replace(/\s+/g, ' ').slice(0, 120);
    return `text="${trimmed}"`;
  }
  if (data === null || data === undefined) {
    return 'data=null';
  }
  try {
    return `data=${JSON.stringify(data).slice(0, 160)}`;
  } catch {
    return 'data=[unserializable]';
  }
}

function formatSse(event: string, data: unknown): Uint8Array {
  const lines: string[] = [];
  if (event) {
    lines.push(`event: ${event}`);
  }

  const safeJsonStringify = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ error: 'unserializable_payload' });
    }
  };

  if (data === undefined) {
    lines.push('data:');
  } else if (data === null) {
    lines.push('data: null');
  } else if (typeof data === 'string') {
    const parts = data.split(/\r?\n/);
    parts.forEach((part) => {
      lines.push(`data: ${part}`);
    });
  } else {
    lines.push(`data: ${safeJsonStringify(data)}`);
  }

  lines.push('');
  return encoder.encode(`${lines.join('\n')}\n`);
}

function heartbeatChunk(): Uint8Array {
  return encoder.encode(': ping\n\n');
}

// High-frequency streaming events — skip console.log to reduce unified log noise.
// These events fire per-token/per-delta and produce thousands of lines with zero diagnostic value.
const SILENT_EVENTS = new Set([
  'chat:message-chunk', 'chat:thinking-delta', 'chat:tool-input-delta',
  'chat:content-block-stop', 'chat:message-sdk-uuid', 'chat:log',
  'workspace:files-changed', // File watcher fires frequently — skip console.log
]);

export function broadcast(event: string, data: unknown): void {
  if (!SILENT_EVENTS.has(event)) {
    console.log(`[sse] ${event} -> ${summarizePayload(event, data)}`);
  }
  // Update last-value cache for stateful events
  if (CACHED_EVENTS.has(event)) {
    lastValueCache.set(event, data);
  }
  for (const client of clients) {
    client.send(event, data);
  }
}

/**
 * Get all active SSE clients (for logger integration)
 */
export function getClients(): SseClient[] {
  return Array.from(clients);
}

export function createSseClient(onClose: (client: SseClient) => void): {
  client: SseClient;
  response: Response;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let client: SseClient | null = null;
  const pending: Uint8Array[] = [];
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      if (pending.length > 0) {
        pending.forEach((chunk) => {
          controller?.enqueue(chunk);
        });
        pending.length = 0;
      }
    },
    cancel() {
      if (controller) {
        controller = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  });

  client = {
    id: randomUUID(),
    send: (event, data) => {
      try {
        const payload = formatSse(event, data);
        if (!controller) {
          pending.push(payload);
          return;
        }
        controller.enqueue(payload);
      } catch {
        if (client) {
          clients.delete(client);
          onClose(client);
          console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
          client = null;
        }
      }
    },
    close: () => {
      if (!controller) {
        return;
      }
      controller.close();
      controller = null;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
    }
  };

  clients.add(client);
  console.log(`[sse] client connected id=${client.id} total=${clients.size}`);

  // Send cached log history to newly connected client (Ring Buffer for early logs)
  // Only replay logs from BEFORE this client connected — logs after connectTime
  // are already delivered by live broadcast (client was added to `clients` above).
  const connectTime = localTimestamp();
  try {
    import('./logger').then(({ getLogHistory }) => {
      const history = getLogHistory();
      const replayEntries = history.filter(e => e.timestamp < connectTime);
      if (replayEntries.length > 0) {
        // Small delay to ensure connection is stable
        setTimeout(() => {
          replayEntries.forEach(entry => {
            client?.send('chat:log', entry);
          });
        }, 200);
      }
    }).catch(() => {
      // Ignore if logger not yet initialized
    });
  } catch {
    // Ignore
  }

  // Replay last-value cache to newly connected client.
  // Solves the "late joiner" problem: a Tab connecting to a mid-flight IM session
  // immediately receives the current session state (e.g., chat:status → "running")
  // instead of appearing idle until the next live event.
  // Delay is required: the Bun SSE stream buffers correctly, but the full chain is
  // Bun → SSE bytes → Rust proxy parse → Tauri emit → React listener.
  // React's useEffect registers the Tauri listener AFTER first render, so a synchronous
  // replay arrives before the listener is ready and gets silently dropped.
  // 200ms matches the log replay delay and gives React enough time to mount.
  if (lastValueCache.size > 0) {
    setTimeout(() => {
      for (const [event, cached] of lastValueCache) {
        console.log(`[sse] replaying cached ${event} to client ${client?.id}`);
        client?.send(event, cached);
      }
    }, 200);
  }

  heartbeatTimer = setInterval(() => {
    if (!controller) {
      return;
    }
    try {
      controller.enqueue(heartbeatChunk());
    } catch {
      if (client) {
        clients.delete(client);
        onClose(client);
        console.log(`[sse] client disconnected id=${client.id} total=${clients.size}`);
        client = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  const response = new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }
  });

  response.headers.set('X-SSE-Client-Id', client.id);

  return { client, response };
}
