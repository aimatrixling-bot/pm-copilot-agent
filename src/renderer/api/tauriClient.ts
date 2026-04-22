// Tauri IPC client for communicating with the Rust backend
// Handles sidecar lifecycle and provides server URL for HTTP communication

import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '@/utils/browserMock';

/** Sidecar status returned from Rust backend */
export interface SidecarStatus {
    running: boolean;
    port: number;
    agent_dir: string;
}

/** Check if we're running in Tauri environment */
export function isTauri(): boolean {
    return isTauriEnvironment();
}

/** Cache for server URL to avoid repeated IPC calls */
let cachedServerUrl: string | null = null;

/**
 * Start the sidecar for a project
 * @param agentDir - The directory for the agent workspace
 * @param initialPrompt - Optional initial prompt to start with
 * @returns Sidecar status with port and agent directory
 */
export async function startSidecar(
    agentDir: string,
    initialPrompt?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch API to change directory
        console.debug('[tauriClient] Browser mode: calling /agent/switch API');
        try {
            const response = await fetch('/agent/switch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentDir, initialPrompt }),
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Failed to switch agent directory');
            }
            console.debug('[tauriClient] Switched to:', result.agentDir);
            return {
                running: true,
                port: 3000,
                agent_dir: result.agentDir,
            };
        } catch (error) {
            console.error('[tauriClient] Failed to switch agent:', error);
            // Fallback to mock on error
            return {
                running: true,
                port: 3000,
                agent_dir: agentDir,
            };
        }
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_sidecar', {
            agentDir,
            initialPrompt: initialPrompt ?? null,
        });

        // Update cached URL
        cachedServerUrl = `http://127.0.0.1:${status.port}`;

        return status;
    } catch (error) {
        console.error('Failed to start sidecar:', error);
        throw error;
    }
}

/**
 * Stop the running sidecar
 */
export async function stopSidecar(): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_sidecar');
        cachedServerUrl = null;
    } catch (error) {
        console.error('Failed to stop sidecar:', error);
        throw error;
    }
}

/**
 * Get the current sidecar status
 * @returns Sidecar status or null if not in Tauri
 */
export async function getSidecarStatus(): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_sidecar_status');
    } catch (error) {
        console.error('Failed to get sidecar status:', error);
        return null;
    }
}

/**
 * Get the backend server URL
 * Uses cached value if available, otherwise queries from Tauri
 * Returns empty string in browser mode so requests use relative paths (Vite proxy)
 * 
 * IMPORTANT: This does NOT cache failed URLs - each call will retry if sidecar is not running
 */
export async function getServerUrl(): Promise<string> {
    // Browser mode: return empty string so API calls use relative paths
    // This allows Vite's proxy to forward requests to localhost:3000
    if (!isTauri()) {
        console.debug('[tauriClient] Browser mode: using relative URLs (Vite proxy)');
        return '';
    }

    // Return cached URL if available
    if (cachedServerUrl) {
        return cachedServerUrl;
    }

    try {
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch (error) {
        // Don't cache failed URL - let next call retry
        console.warn('[tauriClient] Sidecar not running:', error);
        throw new Error('Sidecar is not running');
    }
}

/**
 * Get server URL, auto-restarting sidecar if needed
 * This is the preferred method for resilient connections
 */
export async function getServerUrlWithAutoRestart(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    try {
        // First, try to get the URL normally
        const url = await invoke<string>('cmd_get_server_url');
        cachedServerUrl = url;
        return url;
    } catch {
        // Sidecar not running, try to ensure it's running
        console.debug('[tauriClient] Sidecar not running, attempting auto-restart...');
        try {
            const status = await invoke<SidecarStatus>('cmd_ensure_sidecar_running');
            if (status.running) {
                const url = `http://127.0.0.1:${status.port}`;
                cachedServerUrl = url;
                console.debug('[tauriClient] Sidecar auto-restarted:', url);
                return url;
            }
        } catch (restartError) {
            console.error('[tauriClient] Auto-restart failed:', restartError);
        }
        throw new Error('Sidecar is not running and could not be restarted');
    }
}

/**
 * Restart the sidecar process
 */
export async function restartSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_restart_sidecar');
}

/**
 * Ensure sidecar is running, restart if needed
 */
export async function ensureSidecarRunning(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    resetServerUrlCache();
    return invoke<SidecarStatus>('cmd_ensure_sidecar_running');
}

/**
 * Check if sidecar process is still alive (real-time check)
 */
export async function checkSidecarAlive(): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        return await invoke<boolean>('cmd_check_sidecar_alive');
    } catch {
        return false;
    }
}

/**
 * Build a full API URL for the given endpoint
 * @param endpoint - The API endpoint (e.g., '/chat/send')
 */
export async function getApiUrl(endpoint: string): Promise<string> {
    const baseUrl = await getServerUrl();
    return `${baseUrl}${endpoint}`;
}

/**
 * Reset the cached server URL (useful when stopping/restarting sidecar)
 */
export function resetServerUrlCache(): void {
    cachedServerUrl = null;
}

/** HTTP response from Rust proxy */
interface ProxyHttpResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
    /** True if body is base64 encoded (for binary responses like images) */
    is_base64: boolean;
}

/**
 * Proxy HTTP request through Rust to bypass WebView CORS
 * Falls back to native fetch in browser mode
 */
export async function proxyFetch(
    url: string,
    options?: RequestInit
): Promise<Response> {
    // Browser mode: use native fetch (Vite proxy handles CORS)
    if (!isTauri()) {
        return fetch(url, options);
    }

    const method = options?.method || 'GET';
    const body = options?.body ? String(options.body) : undefined;

    // Extract headers
    const headers: Record<string, string> = {};
    if (options?.headers) {
        if (options.headers instanceof Headers) {
            options.headers.forEach((value, key) => {
                headers[key] = value;
            });
        } else if (Array.isArray(options.headers)) {
            options.headers.forEach(([key, value]) => {
                headers[key] = value;
            });
        } else {
            Object.assign(headers, options.headers);
        }
    }

    try {
        const result = await invoke<ProxyHttpResponse>('proxy_http_request', {
            request: {
                url,
                method,
                body,
                headers: Object.keys(headers).length > 0 ? headers : null,
            }
        });

        // Handle base64 encoded binary responses
        if (result.is_base64) {
            // Decode base64 to binary
            const binaryString = atob(result.body);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return new Response(bytes, {
                status: result.status,
                headers: result.headers,
            });
        }

        // Create a Response-like object for text responses
        return new Response(result.body, {
            status: result.status,
            headers: result.headers,
        });
    } catch (error) {
        console.error('[proxyFetch] Error:', error);
        throw error;
    }
}

/**
 * POST JSON through Rust proxy
 */
export async function proxyPostJson<T>(endpoint: string, data: unknown): Promise<T> {
    const baseUrl = await getServerUrl();
    const url = `${baseUrl}${endpoint}`;

    const response = await proxyFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
}

/**
 * POST JSON with automatic sidecar restart on failure
 * This is the resilient version that handles sidecar crashes
 * 
 * @param endpoint - API endpoint
 * @param data - Request payload
 * @param maxRetries - Maximum retry attempts (default: 1)
 */
export async function proxyPostJsonWithRetry<T>(
    endpoint: string,
    data: unknown,
    maxRetries: number = 1
): Promise<T> {
    // Browser mode: use normal fetch without retry logic
    if (!isTauri()) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        return response.json();
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // Use auto-restart URL getter for resilience
            const baseUrl = await getServerUrlWithAutoRestart();
            const url = `${baseUrl}${endpoint}`;

            const response = await proxyFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            return await response.json();
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            console.warn(`[tauriClient] Request failed (attempt ${attempt + 1}/${maxRetries + 1}):`, lastError.message);

            if (attempt < maxRetries) {
                // Clear cache and try to restart sidecar before next attempt
                resetServerUrlCache();
                console.debug('[tauriClient] Attempting sidecar restart before retry...');
                try {
                    await ensureSidecarRunning();
                    // Wait a bit for sidecar to be fully ready
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (restartError) {
                    console.error('[tauriClient] Sidecar restart failed:', restartError);
                }
            }
        }
    }

    throw lastError || new Error('Request failed after retries');
}

// ============= Multi-instance Sidecar API =============
// These functions support per-Tab Sidecar instances

/** Cache for per-Tab server URLs */
const tabServerUrls = new Map<string, string>();

/**
 * Start a Sidecar for a specific Tab
 * @param tabId - Unique Tab identifier
 * @param agentDir - Optional agent directory (null for global sidecar)
 */
export async function startTabSidecar(
    tabId: string,
    agentDir?: string
): Promise<SidecarStatus> {
    if (!isTauri()) {
        // Browser mode: call /agent/switch for compatibility
        if (agentDir) {
            try {
                const response = await fetch('/agent/switch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ agentDir }),
                });
                const result = await response.json();
                if (result.success) {
                    tabServerUrls.set(tabId, '');
                    return { running: true, port: 3000, agent_dir: result.agentDir };
                }
            } catch (error) {
                console.error('[tauriClient] Browser mode switch failed:', error);
            }
        }
        tabServerUrls.set(tabId, '');
        return { running: true, port: 3000, agent_dir: agentDir || '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_tab_sidecar', {
            tabId,
            agentDir: agentDir ?? null,
        });
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set(tabId, url);
        console.debug(`[tauriClient] Tab ${tabId} sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error(`[tauriClient] Failed to start sidecar for tab ${tabId}:`, error);
        throw error;
    }
}

/**
 * Stop a Sidecar for a specific Tab
 * @param tabId - Tab identifier
 */
export async function stopTabSidecar(tabId: string): Promise<void> {
    tabServerUrls.delete(tabId);

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_tab_sidecar', { tabId });
        console.debug(`[tauriClient] Tab ${tabId} sidecar stopped`);
    } catch (error) {
        console.error(`[tauriClient] Failed to stop sidecar for tab ${tabId}:`, error);
        // Don't throw - cleanup should be best-effort
    }
}

/**
 * Stop SSE proxy for a specific Tab
 * Should be called BEFORE stopping the Sidecar to avoid EOF errors
 * @param tabId - Tab identifier
 */
export async function stopSseProxy(tabId: string): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('stop_sse_proxy', { tabId });
        console.debug(`[tauriClient] Tab ${tabId} SSE proxy stopped`);
    } catch (error) {
        console.error(`[tauriClient] Failed to stop SSE proxy for tab ${tabId}:`, error);
        // Don't throw - cleanup should be best-effort
    }
}

/**
 * Get server URL for a specific Tab
 * @param tabId - Tab identifier
 */
export async function getTabServerUrl(tabId: string): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    // Check cache first
    const cached = tabServerUrls.get(tabId);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const url = await invoke<string>('cmd_get_tab_server_url', { tabId });
        tabServerUrls.set(tabId, url);
        return url;
    } catch (error) {
        console.warn(`[tauriClient] No sidecar for tab ${tabId}:`, error);
        throw new Error(`No running sidecar for tab ${tabId}`);
    }
}

/**
 * Get sidecar status for a specific Tab
 * @param tabId - Tab identifier
 */
export async function getTabSidecarStatus(tabId: string): Promise<SidecarStatus | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SidecarStatus>('cmd_get_tab_sidecar_status', { tabId });
    } catch (error) {
        console.error(`[tauriClient] Failed to get status for tab ${tabId}:`, error);
        return null;
    }
}

/**
 * Start the global Sidecar (used by Settings page)
 */
export async function startGlobalSidecar(): Promise<SidecarStatus> {
    if (!isTauri()) {
        return { running: true, port: 3000, agent_dir: '' };
    }

    try {
        const status = await invoke<SidecarStatus>('cmd_start_global_sidecar');
        const url = `http://127.0.0.1:${status.port}`;
        tabServerUrls.set('__global__', url);
        console.debug(`[tauriClient] Global sidecar started on port ${status.port}`);
        return status;
    } catch (error) {
        console.error('[tauriClient] Failed to start global sidecar:', error);
        throw error;
    }
}

/** Promise that resolves when global sidecar is ready */
let globalSidecarReadyPromise: Promise<void> | null = null;
let globalSidecarReadyResolve: (() => void) | null = null;

/**
 * Initialize the global sidecar ready promise
 * Called from App.tsx before starting the sidecar
 */
export function initGlobalSidecarReadyPromise(): void {
    if (!globalSidecarReadyPromise) {
        globalSidecarReadyPromise = new Promise<void>((resolve) => {
            globalSidecarReadyResolve = resolve;
        });
    }
}

/**
 * Mark global sidecar as ready
 * Called from App.tsx after sidecar starts successfully
 */
export function markGlobalSidecarReady(): void {
    if (globalSidecarReadyResolve) {
        globalSidecarReadyResolve();
        globalSidecarReadyResolve = null;
    }
}

/**
 * Wait for global sidecar to be ready (with timeout)
 * @param timeoutMs - Maximum time to wait in milliseconds (default: 60000)
 * Note: Timeout is set higher to accommodate macOS permission dialogs
 * that may appear on first launch and require user interaction
 */
export async function waitForGlobalSidecar(timeoutMs: number = 60000): Promise<void> {
    if (!isTauri()) {
        return;
    }

    if (!globalSidecarReadyPromise) {
        // Promise not initialized yet, create one that will resolve when sidecar starts
        initGlobalSidecarReadyPromise();
    }

    // Race between the ready promise and a timeout
    // Use a cleanup pattern to avoid timer leaks
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Global sidecar startup timeout')), timeoutMs);
    });

    try {
        await Promise.race([globalSidecarReadyPromise, timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

/**
 * Get global sidecar server URL (for Settings page)
 */
export async function getGlobalServerUrl(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    try {
        const url = await invoke<string>('cmd_get_global_server_url');
        tabServerUrls.set('__global__', url);
        return url;
    } catch (error) {
        console.warn('[tauriClient] Global sidecar not running:', error);
        throw new Error('Global sidecar is not running');
    }
}

/**
 * Get global sidecar server URL, waiting for it to be ready if needed
 * This is the preferred method for components that need the global sidecar
 */
export async function getGlobalServerUrlWithWait(): Promise<string> {
    if (!isTauri()) {
        return '';
    }

    // First check cache
    const cached = tabServerUrls.get('__global__');
    if (cached !== undefined) {
        return cached;
    }

    // Wait for sidecar to be ready
    await waitForGlobalSidecar();

    // Now get the URL
    return getGlobalServerUrl();
}

/**
 * Stop all Sidecar instances (for app exit)
 */
export async function stopAllSidecars(): Promise<void> {
    tabServerUrls.clear();

    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_stop_all_sidecars');
        console.debug('[tauriClient] All sidecars stopped');
    } catch (error) {
        console.error('[tauriClient] Failed to stop all sidecars:', error);
    }
}

/**
 * Reset Tab server URL cache for a specific Tab
 */
export function resetTabServerUrlCache(tabId: string): void {
    tabServerUrls.delete(tabId);
}

/**
 * Update Global Sidecar server URL cache
 * Called when the Rust health monitor auto-restarts the Global Sidecar on a new port
 */
export function updateGlobalServerUrl(url: string): void {
    tabServerUrls.set('__global__', url);
}

// ============= Session Activation API =============
// These functions support Session singleton constraint

/** Session activation information */
export interface SessionActivation {
    session_id: string;
    tab_id: string | null;
    task_id: string | null;  // If activated by cron task, contains the task ID
    port: number;
    workspace_path: string;
    is_cron_task: boolean;
}

/** Sidecar info for a workspace */
export interface SidecarInfo {
    port: number;
    workspace_path: string;
    is_healthy: boolean;
}

/** Cron task execution response */
export interface CronExecuteResponse {
    success: boolean;
    error?: string;
    ai_requested_exit?: boolean;
    exit_reason?: string;
    output_text?: string;
}

/** Cron task execution provider environment */
export interface ProviderEnv {
    base_url?: string;
    api_key?: string;
    api_protocol?: 'anthropic' | 'openai';
    max_output_tokens?: number;
    max_output_tokens_param_name?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstream_format?: 'chat_completions' | 'responses';
}

/**
 * Get activation status for a session
 * @param sessionId - Session identifier
 * @returns SessionActivation if session is activated, null if not
 */
export async function getSessionActivation(sessionId: string): Promise<SessionActivation | null> {
    if (!isTauri()) {
        return null;
    }

    try {
        return await invoke<SessionActivation | null>('cmd_get_session_activation', { sessionId });
    } catch (error) {
        console.error(`[tauriClient] Failed to get session activation for ${sessionId}:`, error);
        return null;
    }
}

/**
 * Activate a session (mark it as in-use by a Tab/Sidecar)
 * @param sessionId - Session identifier
 * @param tabId - Tab that owns this session (null for cron tasks)
 * @param port - Sidecar port
 * @param workspacePath - Workspace directory path
 * @param isCronTask - Whether this is a cron task activation
 */
export async function activateSession(
    sessionId: string,
    tabId: string | null,
    taskId: string | null,
    port: number,
    workspacePath: string,
    isCronTask: boolean = false
): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_activate_session', {
            sessionId,
            tabId: tabId ?? null,
            taskId: taskId ?? null,
            port,
            workspacePath,
            isCronTask,
        });
        console.debug(`[tauriClient] Session ${sessionId} activated by tab ${tabId || 'cron'}, task: ${taskId || 'none'}`);
    } catch (error) {
        console.error(`[tauriClient] Failed to activate session ${sessionId}:`, error);
        throw error;
    }
}

/**
 * Deactivate a session (mark it as no longer in-use)
 * @param sessionId - Session identifier
 */
export async function deactivateSession(sessionId: string): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_deactivate_session', { sessionId });
        console.debug(`[tauriClient] Session ${sessionId} deactivated`);
    } catch (error) {
        console.error(`[tauriClient] Failed to deactivate session ${sessionId}:`, error);
        // Don't throw - deactivation should be best-effort
    }
}

/**
 * Update a session's owning Tab (for Tab switching within same Sidecar)
 * @param sessionId - Session identifier
 * @param newTabId - New Tab identifier
 */
export async function updateSessionTab(sessionId: string, newTabId: string | null | undefined): Promise<void> {
    if (!isTauri()) {
        return;
    }

    try {
        await invoke('cmd_update_session_tab', { sessionId, newTabId: newTabId ?? null });
        console.debug(`[tauriClient] Session ${sessionId} transferred to tab ${newTabId ?? 'none'}`);
    } catch (error) {
        console.error(`[tauriClient] Failed to update session tab for ${sessionId}:`, error);
        throw error;
    }
}


// ============= Session-Centric Sidecar API (v0.1.11) =============
// These functions support the new Owner model where Sidecar lifecycle
// is tied to Sessions, not Tabs or CronTasks.

/** Result from ensureSessionSidecar */
export interface EnsureSidecarResult {
    port: number;
    isNew: boolean;
}

/**
 * Ensure a Session has a Sidecar running, adding the specified owner.
 * If the Session already has a healthy Sidecar, just adds the owner.
 * If no Sidecar exists, creates a new one with the owner.
 *
 * @param sessionId - Session identifier
 * @param workspacePath - Workspace directory path
 * @param ownerType - Type of owner ('tab' | 'cron_task')
 * @param ownerId - ID of the owner (Tab ID or CronTask ID)
 * @returns {port, isNew} where isNew is true if a new Sidecar was started
 */
export async function ensureSessionSidecar(
    sessionId: string,
    workspacePath: string,
    ownerType: 'tab' | 'cron_task',
    ownerId: string
): Promise<EnsureSidecarResult> {
    if (!isTauri()) {
        return { port: 3000, isNew: false };
    }

    try {
        const result = await invoke<EnsureSidecarResult>('cmd_ensure_session_sidecar', {
            sessionId,
            workspacePath,
            ownerType,
            ownerId,
        });
        console.debug(`[tauriClient] ensureSessionSidecar: session=${sessionId}, owner=${ownerType}:${ownerId}, port=${result.port}, isNew=${result.isNew}`);
        return result;
    } catch (error) {
        console.error(`[tauriClient] Failed to ensure session sidecar for ${sessionId}:`, error);
        throw error;
    }
}

/**
 * Release an owner from a Session's Sidecar.
 * If this was the last owner, the Sidecar is stopped.
 *
 * @param sessionId - Session identifier
 * @param ownerType - Type of owner ('tab' | 'cron_task')
 * @param ownerId - ID of the owner (Tab ID or CronTask ID)
 * @returns true if the Sidecar was stopped (no more owners)
 */
export async function releaseSessionSidecar(
    sessionId: string,
    ownerType: 'tab' | 'cron_task',
    ownerId: string
): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    try {
        const stopped = await invoke<boolean>('cmd_release_session_sidecar', {
            sessionId,
            ownerType,
            ownerId,
        });
        console.debug(`[tauriClient] releaseSessionSidecar: session=${sessionId}, owner=${ownerType}:${ownerId}, stopped=${stopped}`);
        return stopped;
    } catch (error) {
        console.error(`[tauriClient] Failed to release session sidecar for ${sessionId}:`, error);
        // Don't throw - release should be best-effort
        return false;
    }
}

/**
 * Get the port for a Session's Sidecar
 *
 * @param sessionId - Session identifier
 * @returns Port number if Session has a Sidecar, null otherwise
 */
export async function getSessionPort(sessionId: string): Promise<number | null> {
    if (!isTauri()) {
        return 3000;
    }

    try {
        const port = await invoke<number | null>('cmd_get_session_port', { sessionId });
        return port;
    } catch (error) {
        console.warn(`[tauriClient] Failed to get session port for ${sessionId}:`, error);
        return null;
    }
}

/**
 * Upgrade a session ID (e.g., from "pending-xxx" to real session ID)
 * This updates HashMap keys in Rust without stopping the Sidecar.
 *
 * @param oldSessionId - The old session ID (typically "pending-{tabId}")
 * @param newSessionId - The new real session ID
 * @returns true if the upgrade was successful
 */
export async function upgradeSessionId(
    oldSessionId: string,
    newSessionId: string
): Promise<boolean> {
    if (!isTauri()) {
        return true;
    }

    try {
        const upgraded = await invoke<boolean>('cmd_upgrade_session_id', {
            oldSessionId,
            newSessionId,
        });
        console.debug(`[tauriClient] upgradeSessionId: ${oldSessionId} -> ${newSessionId}, success=${upgraded}`);
        return upgraded;
    } catch (error) {
        console.error(`[tauriClient] Failed to upgrade session ID from ${oldSessionId} to ${newSessionId}:`, error);
        return false;
    }
}

/**
 * Check if a session's Sidecar has persistent background owners (CronTask or ImBot)
 * that will keep it alive after a Tab releases its ownership.
 */
export async function sessionHasPersistentOwners(sessionId: string): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        return await invoke<boolean>('cmd_session_has_persistent_owners', { sessionId });
    } catch {
        return false;
    }
}

/**
 * Execute a cron task synchronously via Sidecar
 * This is the full execution that waits for completion and returns results
 *
 * @param workspacePath - Workspace directory path
 * @param taskId - Cron task identifier
 * @param sessionId - Session ID for activation tracking (prevents Sidecar kill during execution)
 * @param prompt - Task prompt to execute
 * @param isFirstExecution - Whether this is the first execution
 * @param aiCanExit - Whether AI can exit the task
 * @param permissionMode - Permission mode ('auto' | 'always_ask' | 'always_allow')
 * @param model - Optional model to use
 * @param providerEnv - Optional provider environment (API key, base URL)
 */
export async function executeCronTask(
    workspacePath: string,
    taskId: string,
    sessionId: string,
    prompt: string,
    isFirstExecution?: boolean,
    aiCanExit?: boolean,
    permissionMode?: string,
    model?: string,
    providerEnv?: ProviderEnv
): Promise<CronExecuteResponse> {
    if (!isTauri()) {
        return { success: false, error: 'Not in Tauri environment' };
    }

    try {
        const response = await invoke<CronExecuteResponse>('cmd_execute_cron_task', {
            workspacePath,
            taskId,
            sessionId,
            prompt,
            isFirstExecution: isFirstExecution ?? null,
            aiCanExit: aiCanExit ?? null,
            permissionMode: permissionMode ?? null,
            model: model ?? null,
            providerEnv: providerEnv ?? null,
        });
        console.debug(`[tauriClient] Cron task ${taskId} execution completed:`, response);
        return response;
    } catch (error) {
        console.error(`[tauriClient] Failed to execute cron task ${taskId}:`, error);
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

// ============= Background Session Completion API =============

/** Result from startBackgroundCompletion */
export interface BackgroundCompletionResult {
    started: boolean;
    sessionId: string;
}

/**
 * Start background completion for a session.
 * If the AI is actively generating a response, adds a BackgroundCompletion owner
 * to keep the Sidecar alive and spawns a polling thread to monitor completion.
 *
 * @param sessionId - Session identifier
 * @returns { started: true } if AI is running and background completion started,
 *          { started: false } if AI is idle (no background completion needed)
 */
export async function startBackgroundCompletion(
    sessionId: string
): Promise<BackgroundCompletionResult> {
    if (!isTauri()) {
        return { started: false, sessionId };
    }

    try {
        const result = await invoke<BackgroundCompletionResult>('cmd_start_background_completion', {
            sessionId,
        });
        console.debug(`[tauriClient] startBackgroundCompletion: session=${sessionId}, started=${result.started}`);
        return result;
    } catch (error) {
        console.error(`[tauriClient] Failed to start background completion for ${sessionId}:`, error);
        return { started: false, sessionId };
    }
}

/**
 * Cancel background completion for a session.
 * Removes the BackgroundCompletion owner so the polling thread exits gracefully.
 * Used when user reconnects to a session that's completing in the background.
 *
 * @param sessionId - Session identifier
 * @returns true if a BackgroundCompletion owner was found and removed
 */
export async function cancelBackgroundCompletion(
    sessionId: string
): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    try {
        const cancelled = await invoke<boolean>('cmd_cancel_background_completion', {
            sessionId,
        });
        console.debug(`[tauriClient] cancelBackgroundCompletion: session=${sessionId}, cancelled=${cancelled}`);
        return cancelled;
    } catch (error) {
        console.error(`[tauriClient] Failed to cancel background completion for ${sessionId}:`, error);
        return false;
    }
}
