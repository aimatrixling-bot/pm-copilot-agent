/**
 * Module-level store for background task (SDK sub-agent) completion statuses.
 *
 * Solves a timing problem: `chat:task-notification` SSE events may fire
 * before the corresponding TaskTool component mounts its event listener.
 * By writing to this Map first, TaskTool can read the status on mount
 * and also subscribe to future changes via the DOM event.
 */

/** Terminal statuses emitted by the SDK's task_notification system messages. */
export type BackgroundTaskTerminalStatus = 'completed' | 'error' | 'failed' | 'stopped';

const TERMINAL: Set<string> = new Set<string>(['completed', 'error', 'failed', 'stopped']);

/** Check whether a status string is terminal (task is done). */
export function isTerminalStatus(status: string | undefined): status is BackgroundTaskTerminalStatus {
    return !!status && TERMINAL.has(status);
}

const statuses = new Map<string, string>();
const descriptions = new Map<string, string>();

const EVENT_NAME = 'background-task-status';

/** Called by TabProvider when `chat:task-started` arrives. Stores description for later display. */
export function setBackgroundTaskDescription(taskId: string, description: string): void {
    descriptions.set(taskId, description);
}

/** Read task description (set at task-started time). */
export function getBackgroundTaskDescription(taskId: string): string | undefined {
    return descriptions.get(taskId);
}

/** Called by TabProvider when `chat:task-notification` arrives. */
export function setBackgroundTaskStatus(taskId: string, status: string): void {
    statuses.set(taskId, status);
    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { taskId, status },
    }));
}

/** Read current status (may be undefined if no notification received yet). */
export function getBackgroundTaskStatus(taskId: string): string | undefined {
    return statuses.get(taskId);
}

/** Clear all entries — call on session reset to prevent unbounded growth. */
export function clearAllBackgroundTaskStatuses(): void {
    statuses.clear();
    descriptions.clear();
}

/** Event name for addEventListener — exported to avoid magic strings. */
export const BACKGROUND_TASK_STATUS_EVENT = EVENT_NAME;
