/**
 * SseConnection - Instance-based SSE connection for per-Tab isolation
 * 
 * Each Tab creates an independent SSE connection, allowing multiple
 * concurrent agent sessions without interference.
 * 
 * Tauri mode:
 * - Rust SSE proxy supports multiple connections (keyed by tabId)
 * - Events are prefixed with tabId: sse:tabId:event-name
 * - Each Tab only receives events from its own connection
 * 
 * Browser mode (development):
 * - Uses native EventSource with full multiple connection support
 */

import type React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { getTabServerUrl, getSessionPort } from './tauriClient';
import { isTauriEnvironment } from '../utils/browserMock';

// Event types that should be parsed as JSON
// IMPORTANT: When adding new SSE events in backend, remember to add them here too!
const JSON_EVENTS = new Set([
    'chat:init',
    'chat:message-replay',
    'chat:thinking-start',
    'chat:thinking-chunk',
    'chat:tool-use-start',
    'chat:server-tool-use-start', // Server-side tool use (e.g., 智谱 GLM-4.7's webReader)
    'chat:tool-input-delta',
    'chat:content-block-stop',
    'chat:tool-result-start',
    'chat:tool-result-delta',
    'chat:tool-result-complete',
    'chat:subagent-tool-use',
    'chat:subagent-tool-input-delta',
    'chat:subagent-tool-result-start',
    'chat:subagent-tool-result-delta',
    'chat:subagent-tool-result-complete',
    'chat:system-init',
    'chat:system-status', // SDK system status (e.g., 'compacting')
    'chat:logs',
    'chat:status',
    'chat:agent-error',
    'permission:request', // Permission prompt for tool usage
    'ask-user-question:request', // AskUserQuestion tool prompt
    'exit-plan-mode:request',  // ExitPlanMode tool - AI submits plan for review
    'enter-plan-mode:request', // EnterPlanMode tool - AI requests plan mode
    'cron:task-exit-requested', // AI requested cron task exit via exit_cron_task tool
    'chat:task-started',    // Background task (SDK Task tool) started
    'chat:task-notification', // Background task completed/failed/stopped
    'mcp:oauth-expired',    // MCP OAuth token expired (trigger re-auth prompt)
    'queue:added',     // Message queued (confirmation)
    'queue:started',   // Queued message started executing
    'queue:cancelled', // Queued message cancelled
    'chat:message-sdk-uuid', // SDK UUID assignment for user/assistant messages (fork button, rewind)
    'config:changed', // Admin CLI modified app config — triggers frontend refresh
    'chat:api-retry', // SDK API retry status (v0.2.77+) — rate limit / transient error retrying
    'chat:permission-mode-changed', // Backend permission mode changed (plan/auto/etc.) — sync frontend UI
    'workspace:files-changed', // File watcher detected workspace file changes
]);

// Event types that can be JSON or plain string
// These are tried as JSON first, fallback to string if parsing fails
// Used when backend sends both formats for the same event type
const JSON_OR_STRING_EVENTS = new Set([
    'chat:log', // agent-session sends strings, logger sends LogEntry objects
]);

// Event types that should be passed as raw strings
const STRING_EVENTS = new Set([
    'chat:message-chunk',
    'chat:message-error',
    'chat:debug-message'
]);

// Event types with null payload
const NULL_EVENTS = new Set(['chat:message-stopped']);

// Event types with JSON payload for analytics
const JSON_ANALYTICS_EVENTS = new Set(['chat:message-complete']);

// All event types
const ALL_EVENTS = [...JSON_EVENTS, ...JSON_OR_STRING_EVENTS, ...STRING_EVENTS, ...NULL_EVENTS, ...JSON_ANALYTICS_EVENTS];

export type SseEventHandler = (eventName: string, data: unknown) => void;
export type SseConnectionStatusHandler = (status: 'connected' | 'disconnected' | 'reconnecting' | 'failed') => void;

// Reconnection configuration
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 10000;

/**
 * SseConnection - Manages a single SSE connection with auto-reconnection
 */
export class SseConnection {
    private eventSource: EventSource | null = null;
    private tauriUnlisteners: UnlistenFn[] = [];
    private tauriConnected = false;
    private eventHandler: SseEventHandler | null = null;
    private statusHandler: SseConnectionStatusHandler | null = null;
    private connectionId: string;
    private sessionIdRef?: React.MutableRefObject<string | null>; // For Session-centric port lookup

    // Reconnection state
    private reconnectAttempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private isReconnecting = false;
    private shouldReconnect = true; // Set to false when intentionally disconnecting

    constructor(connectionId: string, sessionIdRef?: React.MutableRefObject<string | null>) {
        this.connectionId = connectionId;
        this.sessionIdRef = sessionIdRef;
    }

    /**
     * Set the event handler for SSE events
     */
    setEventHandler(handler: SseEventHandler): void {
        this.eventHandler = handler;
    }

    /**
     * Set the connection status handler
     */
    setStatusHandler(handler: SseConnectionStatusHandler): void {
        this.statusHandler = handler;
    }

    /**
     * Notify status change
     */
    private notifyStatus(status: 'connected' | 'disconnected' | 'reconnecting' | 'failed'): void {
        if (this.statusHandler) {
            this.statusHandler(status);
        }
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.eventSource !== null || this.tauriConnected;
    }

    /**
     * Handle SSE event - parse and emit to handler
     */
    private handleSseEvent(eventName: string, data: string): void {
        if (!this.eventHandler) {
            console.warn(`[SSE ${this.connectionId}] Event received but no handler: ${eventName}`);
            return;
        }

        // Handle null-payload events (message-stopped)
        if (NULL_EVENTS.has(eventName)) {
            console.debug(`[SSE ${this.connectionId}] Received: ${eventName}`);
            this.eventHandler(eventName, null);
            return;
        }

        // Handle JSON analytics events (message-complete with usage data)
        if (JSON_ANALYTICS_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed);
            } catch (e) {
                console.warn(`[SSE ${this.connectionId}] Failed to parse analytics JSON for ${eventName}:`, e);
                // Still emit event with null so tracking can proceed with defaults
                this.eventHandler(eventName, null);
            }
            return;
        }

        if (JSON_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed);
            } catch (e) {
                console.warn(`[SSE ${this.connectionId}] Failed to parse JSON for ${eventName}:`, e);
                this.eventHandler(eventName, null);
            }
            return;
        }

        // JSON_OR_STRING_EVENTS: try JSON first, fallback to raw string
        if (JSON_OR_STRING_EVENTS.has(eventName)) {
            try {
                const parsed = JSON.parse(data);
                this.eventHandler(eventName, parsed);
            } catch {
                // Not valid JSON, pass as raw string (this is expected for legacy log format)
                this.eventHandler(eventName, data);
            }
            return;
        }

        if (STRING_EVENTS.has(eventName)) {
            this.eventHandler(eventName, data);
            return;
        }

        // Unrecognized event - log warning to help identify missing event registrations
        console.warn(`[SSE ${this.connectionId}] Unrecognized event dropped: ${eventName}`);
    }

    /**
     * Connect using browser EventSource with auto-reconnection
     */
    private async connectBrowser(): Promise<void> {
        if (this.eventSource) return;

        // Use Tab-specific server URL (or fixed port if provided)
        const serverUrl = await this.getServerUrl();
        const sseUrl = `${serverUrl}/chat/stream`;

        console.debug(`[SSE ${this.connectionId}] Connecting browser EventSource:`, sseUrl);

        this.eventSource = new EventSource(sseUrl);

        this.eventSource.onopen = () => {
            console.debug(`[SSE ${this.connectionId}] Connected`);
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.notifyStatus('connected');
        };

        for (const eventName of ALL_EVENTS) {
            this.eventSource.addEventListener(eventName, ((event: MessageEvent<string>) => {
                this.handleSseEvent(event.type, event.data);
            }) as EventListener);
        }

        this.eventSource.onerror = () => {
            console.warn(`[SSE ${this.connectionId}] Connection error`);

            // Only attempt reconnection if not intentionally disconnected
            if (this.shouldReconnect && !this.isReconnecting) {
                this.scheduleReconnect();
            }
        };
    }

    /**
     * Connect using Tauri SSE proxy (multi-instance)
     * Each Tab has its own SSE connection with tab-prefixed events
     */
    private async connectTauri(): Promise<void> {
        if (this.tauriConnected) return;

        // Use Tab-specific server URL (or fixed port if provided)
        const serverUrl = await this.getServerUrl();
        const sseUrl = `${serverUrl}/chat/stream`;

        console.debug(`[SSE ${this.connectionId}] Connecting Tauri SSE proxy:`, sseUrl);

        // Set up listeners for Tab-prefixed SSE event types
        // Events are now: sse:tabId:chat:init, sse:tabId:chat:message-chunk, etc.
        for (const eventName of ALL_EVENTS) {
            // Listen for events with this Tab's prefix
            const tauriEventName = `sse:${this.connectionId}:${eventName}`;
            const unlisten = await listen<string>(tauriEventName, (event) => {
                this.handleSseEvent(eventName, event.payload);
            });
            this.tauriUnlisteners.push(unlisten);
        }

        // Listen for Tab-specific SSE proxy errors
        const errorUnlisten = await listen<string>(`sse:${this.connectionId}:error`, (event) => {
            console.error(`[SSE ${this.connectionId}] Proxy error:`, event.payload);
            // Trigger reconnection on Tauri SSE errors
            if (this.shouldReconnect && !this.isReconnecting) {
                this.scheduleTauriReconnect();
            }
        });
        this.tauriUnlisteners.push(errorUnlisten);

        // Start the Rust SSE proxy with Tab ID
        try {
            await invoke('start_sse_proxy', { url: sseUrl, tabId: this.connectionId });
            this.tauriConnected = true;
            this.reconnectAttempts = 0;
            this.isReconnecting = false;
            this.notifyStatus('connected');
            console.debug(`[SSE ${this.connectionId}] Tauri SSE proxy started`);
        } catch (error) {
            console.error(`[SSE ${this.connectionId}] Failed to start Tauri SSE proxy:`, error);
            throw error;
        }
    }

    /**
     * Connect to SSE stream
     */
    async connect(): Promise<void> {
        // Reset state for new connection
        this.shouldReconnect = true;

        if (isTauriEnvironment()) {
            await this.connectTauri();
        } else {
            await this.connectBrowser();
        }
    }

    /**
     * Disconnect SSE stream
     * Safe to call multiple times - subsequent calls are no-ops
     */
    async disconnect(): Promise<void> {
        // Guard: if already disconnected (or never connected), do nothing
        // This prevents duplicate cleanup work and duplicate logs
        if (!this.tauriConnected && !this.eventSource) {
            return;
        }

        console.debug(`[SSE ${this.connectionId}] Disconnecting`);

        // Stop any pending reconnection attempts
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.isReconnecting = false;

        // Disconnect Tauri SSE proxy
        if (this.tauriConnected) {
            try {
                await invoke('stop_sse_proxy', { tabId: this.connectionId });
            } catch (error) {
                console.error(`[SSE ${this.connectionId}] Failed to stop Tauri SSE proxy:`, error);
            }

            // Unregister all Tauri event listeners
            for (const unlisten of this.tauriUnlisteners) {
                unlisten();
            }
            this.tauriUnlisteners = [];
            this.tauriConnected = false;
        }

        // Disconnect browser EventSource
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        this.notifyStatus('disconnected');
    }

    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[SSE ${this.connectionId}] Max reconnection attempts (${RECONNECT_MAX_ATTEMPTS}) reached`);
            this.isReconnecting = false;
            this.notifyStatus('failed');
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        // Exponential backoff: 1s, 2s, 4s, 8s... capped at max
        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );

        // Throttle reconnect logs: first attempt + every 10th
        if (this.reconnectAttempts === 1) {
            console.warn(`[SSE ${this.connectionId}] Connection failed, retrying...`);
        } else if (this.reconnectAttempts % 10 === 0) {
            console.debug(`[SSE ${this.connectionId}] Still reconnecting (attempt ${this.reconnectAttempts})`);
        }
        this.notifyStatus('reconnecting');

        // Clear any existing timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(async () => {
            if (!this.shouldReconnect) return;

            try {
                // Close existing connection first
                if (this.eventSource) {
                    this.eventSource.close();
                    this.eventSource = null;
                }

                const attempts = this.reconnectAttempts;
                await this.connect();
                if (attempts > 0) {
                    console.log(`[SSE ${this.connectionId}] Reconnected after ${attempts} attempts`);
                }
            } catch (_error) {
                // Schedule another attempt
                if (this.shouldReconnect) {
                    this.scheduleReconnect();
                }
            }
        }, delay);
    }

    /**
     * Schedule a Tauri SSE reconnection attempt
     * Similar to scheduleReconnect but for Tauri proxy
     */
    private scheduleTauriReconnect(): void {
        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`[SSE ${this.connectionId}] Max Tauri reconnection attempts reached`);
            this.isReconnecting = false;
            this.notifyStatus('failed');
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;

        const delay = Math.min(
            RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
            RECONNECT_MAX_DELAY_MS
        );

        // Throttle reconnect logs: first attempt + every 10th
        if (this.reconnectAttempts === 1) {
            console.warn(`[SSE ${this.connectionId}] Connection failed, retrying...`);
        } else if (this.reconnectAttempts % 10 === 0) {
            console.debug(`[SSE ${this.connectionId}] Still reconnecting (attempt ${this.reconnectAttempts})`);
        }
        this.notifyStatus('reconnecting');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(async () => {
            if (!this.shouldReconnect) return;

            try {
                // Stop existing proxy
                if (this.tauriConnected) {
                    await invoke('stop_sse_proxy', { tabId: this.connectionId });
                    this.tauriConnected = false;
                }
                // Clear listeners
                for (const unlisten of this.tauriUnlisteners) {
                    unlisten();
                }
                this.tauriUnlisteners = [];

                const attempts = this.reconnectAttempts;
                await this.connectTauri();
                if (attempts > 0) {
                    console.log(`[SSE ${this.connectionId}] Reconnected after ${attempts} attempts`);
                }
            } catch (_error) {
                if (this.shouldReconnect) {
                    this.scheduleTauriReconnect();
                }
            }
        }, delay);
    }

    /**
     * Reset reconnection state (call when intentionally connecting)
     */
    resetReconnectState(): void {
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.shouldReconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    /**
     * Get the server URL for this connection
     * Session-centric: first try to get port from sessionId, then fallback to tabId lookup
     */
    private async getServerUrl(): Promise<string> {
        // Session-centric: try to get port from sessionId first
        const sessionId = this.sessionIdRef?.current;
        if (sessionId) {
            const port = await getSessionPort(sessionId);
            if (port !== null) {
                return `http://127.0.0.1:${port}`;
            }
        }
        // Fallback to Tab-based lookup (legacy compatibility)
        return getTabServerUrl(this.connectionId);
    }
}

/**
 * Create a new SSE connection instance
 * @param connectionId - Tab ID for this connection
 * @param sessionIdRef - Ref to current sessionId for Session-centric port lookup
 */
export function createSseConnection(connectionId: string, sessionIdRef?: React.MutableRefObject<string | null>): SseConnection {
    return new SseConnection(connectionId, sessionIdRef);
}
