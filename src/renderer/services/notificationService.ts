/**
 * System Notification Service
 * Sends system-level notifications when user is not focused on the app
 */

import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from '@tauri-apps/plugin-notification';

import { isTauriEnvironment } from '../utils/browserMock';

// Track if we've already requested permission this session
let permissionRequested = false;

// Throttle notifications to avoid notification bombing
let lastNotifyTime = 0;
const NOTIFY_THROTTLE_MS = 3000; // 3 seconds between notifications

// Track window visibility state (updated by useTrayEvents hook)
let isWindowVisible = true;

// Pending navigation: when a notification is sent, store tabId + timestamp
// so that on window focus-regain we can auto-switch to the relevant tab
const PENDING_NAV_TIMEOUT_MS = 2_000; // 2 second window
let pendingNavigation: { tabId: string; timestamp: number } | null = null;

/**
 * Update window visibility state
 * Called by useTrayEvents when window is hidden/shown
 */
export function setWindowVisible(visible: boolean): void {
    isWindowVisible = visible;
    console.log('[Notification] Window visibility updated:', visible);
}

/**
 * Check if user focus is away from the current window/tab
 * Returns true if notification should be sent
 */
function shouldNotify(): boolean {
    // Check if window is hidden to tray (most reliable for minimize-to-tray)
    if (!isWindowVisible) {
        return true;
    }
    // Check if document is hidden (user switched to another tab/window)
    if (document.hidden) {
        return true;
    }
    // Check if window doesn't have focus
    if (!document.hasFocus()) {
        return true;
    }
    return false;
}

/**
 * Ensure notification permission is granted
 * Requests permission if not already granted
 */
async function ensurePermission(): Promise<boolean> {
    if (!isTauriEnvironment()) {
        return false;
    }

    try {
        let granted = await isPermissionGranted();
        if (!granted && !permissionRequested) {
            permissionRequested = true;
            const permission = await requestPermission();
            granted = permission === 'granted';
        }
        return granted;
    } catch (error) {
        console.warn('[Notification] Failed to check/request permission:', error);
        return false;
    }
}

/**
 * Send a system notification
 * Only sends if user is not focused on the app.
 * If tabId is provided, stores it as pending navigation target.
 */
async function notify(title: string, body?: string, tabId?: string): Promise<void> {
    // Only notify when user is not focused
    if (!shouldNotify()) {
        return;
    }

    // Throttle: avoid notification bombing when multiple events fire rapidly
    const now = Date.now();
    if (now - lastNotifyTime < NOTIFY_THROTTLE_MS) {
        return;
    }
    lastNotifyTime = now;

    // Ensure we have permission
    const hasPermission = await ensurePermission();
    if (!hasPermission) {
        return;
    }

    try {
        sendNotification({ title, body });
        // Store pending navigation AFTER successful send
        if (tabId) {
            pendingNavigation = { tabId, timestamp: now };
        }
    } catch (error) {
        console.warn('[Notification] Failed to send notification:', error);
    }
}

/**
 * Store a pending navigation target (for notifications sent from outside the service,
 * e.g. cron task notifications from Rust layer)
 */
export function setPendingNavigation(tabId: string): void {
    pendingNavigation = { tabId, timestamp: Date.now() };
}

/**
 * Consume the pending navigation target if within the time window.
 * Returns the tabId to navigate to, or null if expired/absent.
 * One-time consumption: clears the pending state after reading.
 */
export function consumePendingNavigation(): string | null {
    if (!pendingNavigation) return null;

    const elapsed = Date.now() - pendingNavigation.timestamp;
    const tabId = pendingNavigation.tabId;
    pendingNavigation = null; // always consume

    if (elapsed <= PENDING_NAV_TIMEOUT_MS) {
        return tabId;
    }
    return null;
}

/**
 * Notify that AI has completed a response.
 * @param tabId - If provided, stores as pending navigation target for click-to-navigate
 */
export function notifyMessageComplete(tabId?: string): void {
    void notify('PM Copilot - 任务完成', '请您查看结果', tabId);
}

/**
 * Notify that a cron task has completed (triggered by Rust notification:show event).
 * Sends an OS notification and stores pending navigation if tabId is provided.
 */
export function notifyCronTaskComplete(title: string, body: string, tabId?: string): void {
    void notify(title, body, tabId);
}

/**
 * Notify that AI is requesting permission
 */
export function notifyPermissionRequest(toolName: string): void {
    void notify('PM Copilot - 权限请求', `AI 请求使用工具 - ${toolName}`);
}

/**
 * Notify that AI is asking user a question
 */
export function notifyAskUserQuestion(): void {
    void notify('PM Copilot - 需求确认', 'AI 等待您的确认相关信息');
}

/**
 * Notify that AI is requesting plan mode approval (EnterPlanMode or ExitPlanMode)
 */
export function notifyPlanModeRequest(): void {
    void notify('PM Copilot - 方案审核', 'AI 等待您审核方案');
}

/**
 * Initialize notification service
 * Call this early in app lifecycle to pre-request permission
 */
export async function initNotificationService(): Promise<void> {
    if (!isTauriEnvironment()) {
        return;
    }
    // Pre-check permission status (don't request yet, wait for first notification)
    try {
        await isPermissionGranted();
    } catch {
        // Ignore errors during init
    }
}
