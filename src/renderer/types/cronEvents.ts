/**
 * Cron Task Event Types (方案 A: Rust 统一恢复)
 *
 * These types correspond to events emitted from Rust cron_task.rs
 * for the unified recovery architecture.
 */

/**
 * Payload for cron:task-recovered event
 * Emitted when a single task is successfully recovered on app restart
 */
export interface CronTaskRecoveredPayload {
  taskId: string;
  sessionId: string;
  workspacePath: string;
  port: number;
  status: string;
  executionCount: number;
  intervalMinutes: number;
}

/**
 * Payload for cron:task-status-changed event
 * Emitted when a task's status changes (running → stopped, etc.)
 */
export interface CronTaskStatusChangedPayload {
  taskId: string;
  sessionId: string;
  oldStatus: string;
  newStatus: string;
  reason?: string;
}

/**
 * Info about a failed recovery attempt
 */
export interface CronRecoveryFailedTask {
  taskId: string;
  workspacePath: string;
  error: string;
}

/**
 * Payload for cron:recovery-summary event
 * Emitted after all recovery attempts complete
 */
export interface CronRecoverySummaryPayload {
  totalTasks: number;
  recoveredCount: number;
  failedCount: number;
  failedTasks: CronRecoveryFailedTask[];
}

/**
 * Event names for Tauri event listeners
 */
export const CRON_EVENTS = {
  /** Single task recovered successfully */
  TASK_RECOVERED: 'cron:task-recovered',
  /** Task status changed */
  TASK_STATUS_CHANGED: 'cron:task-status-changed',
  /** All recovery attempts completed */
  RECOVERY_SUMMARY: 'cron:recovery-summary',
  /** Cron manager is ready (initialization complete) */
  MANAGER_READY: 'cron:manager-ready',
  /** Scheduler started for a task */
  SCHEDULER_STARTED: 'cron:scheduler-started',
  /** Execution starting */
  EXECUTION_STARTING: 'cron:execution-starting',
  /** Execution completed */
  EXECUTION_COMPLETE: 'cron:execution-complete',
  /** Execution error */
  EXECUTION_ERROR: 'cron:execution-error',
  /** Task stopped */
  TASK_STOPPED: 'cron:task-stopped',
  /** Debug events */
  DEBUG: 'cron:debug',
} as const;
