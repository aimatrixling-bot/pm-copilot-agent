/**
 * Frontend Logger - Intercepts console.log/error/warn/debug in React
 *
 * Features:
 * - Dispatches custom events for TabProvider to display in UnifiedLogsPanel
 * - Batches logs and sends to backend for file persistence
 * - Uses debounce to reduce API calls
 */

import type { LogEntry, LogLevel } from '@/types/log';
import { localTimestamp } from '../../shared/logTime';

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

// Track initialization state
let initialized = false;

// Custom event name for React logs
export const REACT_LOG_EVENT = 'pm-copilot:react-log';

// Log buffer for batching
const logBuffer: LogEntry[] = [];
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 500; // Flush every 500ms
const MAX_BUFFER_SIZE = 50; // Force flush if buffer exceeds this size

// Server URL cache
let serverUrl: string | null = null;

// Circuit breaker: prevents infinite error spam when Global Sidecar is dead
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
let circuitBrokenUntil = 0; // timestamp (ms) when half-open probe is allowed
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Set the server URL for sending logs
 * Should be called once with Global Sidecar URL on app startup
 * Tab sidecars should NOT override this - logs should always go to global
 * Also resets the circuit breaker (e.g., when Global Sidecar auto-restarts)
 */
export function setLogServerUrl(url: string): void {
  serverUrl = url;
  consecutiveFailures = 0;
  circuitBrokenUntil = 0;
}

/**
 * Clear the server URL (e.g., on app shutdown)
 */
export function clearLogServerUrl(): void {
  serverUrl = null;
  consecutiveFailures = 0;
  circuitBrokenUntil = 0;
}

/**
 * Format arguments to string (safely handles objects)
 */
function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    try {
      return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
}

/**
 * Internal function to send log entries to server
 * Shared by flushLogs and sendLogBatch
 */
async function sendToServer(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0 || !serverUrl) return;

  // Circuit breaker: skip requests while broken
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const now = Date.now();
    if (now < circuitBrokenUntil) {
      return; // Still in backoff — silently drop to prevent error spam
    }
    // Backoff expired → half-open probe (try one request)
  }

  try {
    // Dynamic import to avoid circular dependency
    const { proxyFetch } = await import('@/api/tauriClient');

    await proxyFetch(`${serverUrl}/api/unified-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    // Success: reset circuit breaker
    consecutiveFailures = 0;
    circuitBrokenUntil = 0;
  } catch {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
      const backoff = Math.min(
        BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES),
        BACKOFF_MAX_MS,
      );
      circuitBrokenUntil = Date.now() + backoff;
    }
  }
}

/**
 * Flush log buffer to server
 */
async function flushLogs(): Promise<void> {
  if (logBuffer.length === 0) return;

  // Take all logs from buffer
  const entries = logBuffer.splice(0, logBuffer.length);
  await sendToServer(entries);
}

/**
 * Schedule a flush with debounce
 */
function scheduleFlush(): void {
  // Force flush if buffer is too large
  if (logBuffer.length >= MAX_BUFFER_SIZE) {
    if (flushTimeout) {
      clearTimeout(flushTimeout);
      flushTimeout = null;
    }
    void flushLogs();
    return;
  }

  // Debounce flush
  if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      flushTimeout = null;
      void flushLogs();
    }, FLUSH_INTERVAL);
  }
}

/**
 * Create a log entry, dispatch event, and queue for persistence
 */
function createAndDispatch(level: LogLevel, args: unknown[]): void {
  const message = formatArgs(args);

  // Skip empty messages
  if (!message.trim()) return;

  // Skip recursive logs from our own system
  if (message.includes('[FrontendLogger]')) return;

  const entry: LogEntry = {
    source: 'react',
    level,
    message,
    timestamp: localTimestamp(),
  };

  // Dispatch custom event for TabProvider to listen (for UI display)
  window.dispatchEvent(new CustomEvent(REACT_LOG_EVENT, { detail: entry }));

  // Add to buffer for persistence (cap when circuit is broken to prevent memory leak)
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && logBuffer.length >= MAX_BUFFER_SIZE * 2) {
    logBuffer.splice(0, logBuffer.length - MAX_BUFFER_SIZE);
  }
  logBuffer.push(entry);
  scheduleFlush();
}

/**
 * Initialize frontend logger - overrides console methods
 * Safe to call multiple times (will only initialize once)
 */
export function initFrontendLogger(): void {
  if (initialized) {
    return;
  }

  // Override console.log
  console.log = (...args: unknown[]) => {
    originalConsole.log(...args);
    createAndDispatch('info', args);
  };

  // Override console.error
  console.error = (...args: unknown[]) => {
    originalConsole.error(...args);
    createAndDispatch('error', args);
  };

  // Override console.warn
  console.warn = (...args: unknown[]) => {
    originalConsole.warn(...args);
    createAndDispatch('warn', args);
  };

  // Override console.debug
  console.debug = (...args: unknown[]) => {
    originalConsole.debug(...args);
    createAndDispatch('debug', args);
  };

  initialized = true;
  originalConsole.log('[FrontendLogger] React console logging initialized');
}

/**
 * Restore original console methods (for testing)
 */
export function restoreFrontendLogger(): void {
  if (!initialized) return;

  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;

  initialized = false;
}

/**
 * Check if frontend logger is initialized
 */
export function isFrontendLoggerInitialized(): boolean {
  return initialized;
}

/**
 * Get original console for internal use (avoid recursion)
 */
export const getOriginalConsole = () => originalConsole;

/**
 * Force flush any pending logs (call on unmount/cleanup)
 */
export function forceFlushLogs(): void {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }
  void flushLogs();
}
