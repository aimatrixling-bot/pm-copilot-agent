/**
 * Server-side Analytics
 *
 * Lightweight event tracker for the Bun Sidecar.
 * Reads config from ~/.pm-copilot/analytics_config.json (written by frontend at startup).
 * Sends events directly via fetch() — no CORS restrictions in Bun.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_PATH = join(homedir(), '.pm-copilot', 'analytics_config.json');

interface AnalyticsConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  deviceId: string;
  platform: string;
  appVersion: string;
}

interface ServerTrackEvent {
  event: string;
  device_id: string;
  platform: string;
  app_version: string;
  params: Record<string, string | number | boolean | null | undefined>;
  client_timestamp: string;
}

// Lazy-loaded config with retry — frontend writes the file asynchronously at startup,
// so the Sidecar may call trackServer() before the file exists. We retry periodically
// instead of caching the failure permanently.
let config: AnalyticsConfig | false | null = null;
let configLoadedAt = 0;
const CONFIG_RETRY_MS = 10_000; // retry every 10s if config was missing

// Simple batch queue
const queue: ServerTrackEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DELAY_MS = 3000;
const MAX_QUEUE_SIZE = 30;

function loadConfig(): AnalyticsConfig | false {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as AnalyticsConfig;
    if (!parsed.enabled || !parsed.apiKey || !parsed.endpoint) return false;
    return parsed;
  } catch {
    return false;
  }
}

function getConfig(): AnalyticsConfig | false {
  const now = Date.now();
  // Retry if config failed to load and enough time has passed
  if (config === null || (config === false && now - configLoadedAt >= CONFIG_RETRY_MS)) {
    config = loadConfig();
    configLoadedAt = now;
  }
  return config;
}

async function flushQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const cfg = getConfig();
  if (!cfg || queue.length === 0) {
    queue.length = 0;
    return;
  }

  const events = queue.splice(0, MAX_QUEUE_SIZE);

  try {
    await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': cfg.apiKey,
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Silent failure — analytics must never affect the main flow
  }

  // If there are remaining events, schedule another flush
  if (queue.length > 0) {
    flushTimer = setTimeout(() => void flushQueue(), FLUSH_DELAY_MS);
  }
}

/**
 * Track a server-side event.
 * Silent no-op if analytics is disabled or config is missing.
 */
export function trackServer(
  event: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const cfg = getConfig();
  if (!cfg) return;

  queue.push({
    event,
    device_id: cfg.deviceId,
    platform: cfg.platform,
    app_version: cfg.appVersion,
    params,
    client_timestamp: new Date().toISOString(),
  });

  if (queue.length >= MAX_QUEUE_SIZE) {
    void flushQueue();
  } else {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => void flushQueue(), FLUSH_DELAY_MS);
  }
}
