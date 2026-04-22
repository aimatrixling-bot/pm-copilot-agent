// API client for cron task management
// Communicates with Rust CronTaskManager via Tauri commands

import { isTauriEnvironment } from '@/utils/browserMock';
import type { CronTask, CronTaskConfig, CronRunRecord, CronSchedule, CronEndConditions, CronDelivery } from '@/types/cronTask';

// Cached invoke function to avoid repeated dynamic imports
let cachedInvoke: typeof import('@tauri-apps/api/core').invoke | null = null;

/**
 * Get the invoke function, caching it for subsequent calls
 */
async function getInvoke(): Promise<typeof import('@tauri-apps/api/core').invoke> {
  if (!cachedInvoke) {
    const { invoke } = await import('@tauri-apps/api/core');
    cachedInvoke = invoke;
  }
  return cachedInvoke;
}

/**
 * Helper to invoke a Tauri command with environment check
 * Throws error if not in Tauri environment
 */
async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriEnvironment()) {
    throw new Error('Cron tasks are only available in Tauri environment');
  }
  console.log('[cronTaskClient] invokeCommand:', cmd, args);
  const invoke = await getInvoke();
  console.log('[cronTaskClient] invoke function obtained, calling...');
  const result = await invoke<T>(cmd, args);
  console.log('[cronTaskClient] invoke completed:', cmd);
  return result;
}

/**
 * Helper to invoke a Tauri command with fallback for non-Tauri environment
 * Returns fallback value if not in Tauri environment
 */
async function invokeCommandWithFallback<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  fallback: T
): Promise<T> {
  if (!isTauriEnvironment()) {
    return fallback;
  }
  const invoke = await getInvoke();
  return invoke(cmd, args);
}

// ============= Cron Task CRUD Operations =============

/** Create a new cron task */
export const createCronTask = (config: CronTaskConfig): Promise<CronTask> =>
  invokeCommand('cmd_create_cron_task', { config });

/** Start a cron task */
export const startCronTask = (taskId: string): Promise<CronTask> =>
  invokeCommand('cmd_start_cron_task', { taskId });

/** Stop a cron task with optional exit reason */
export const stopCronTask = (taskId: string, exitReason?: string): Promise<CronTask> =>
  invokeCommand('cmd_stop_cron_task', { taskId, exitReason });

/** Delete a cron task */
export const deleteCronTask = (taskId: string): Promise<void> =>
  invokeCommand('cmd_delete_cron_task', { taskId });

/** Get a cron task by ID */
export const getCronTask = (taskId: string): Promise<CronTask> =>
  invokeCommand('cmd_get_cron_task', { taskId });

/** Get all cron tasks */
export const getAllCronTasks = (): Promise<CronTask[]> =>
  invokeCommandWithFallback('cmd_get_cron_tasks', undefined, []);

/** Get cron tasks for a specific workspace */
export const getWorkspaceCronTasks = (workspacePath: string): Promise<CronTask[]> =>
  invokeCommandWithFallback('cmd_get_workspace_cron_tasks', { workspacePath }, []);

/** Get active cron task for a session (running only) */
export const getSessionCronTask = (sessionId: string): Promise<CronTask | null> =>
  invokeCommandWithFallback('cmd_get_session_cron_task', { sessionId }, null);

/** Get active cron task for a tab (running only) */
export const getTabCronTask = (tabId: string): Promise<CronTask | null> =>
  invokeCommandWithFallback('cmd_get_tab_cron_task', { tabId }, null);

// ============= Cron Task Execution Tracking =============

/** Record task execution (called after Sidecar executes task) */
export const recordCronExecution = (taskId: string): Promise<CronTask> =>
  invokeCommand('cmd_record_cron_execution', { taskId });

/** Update task's tab association */
export const updateCronTaskTab = (taskId: string, tabId?: string): Promise<CronTask> =>
  invokeCommand('cmd_update_cron_task_tab', { taskId, tabId });

/** Update task's session ID (called when session is created after task creation) */
export const updateCronTaskSession = (taskId: string, sessionId: string): Promise<CronTask> =>
  invokeCommand('cmd_update_cron_task_session', { taskId, sessionId });

/** Get tasks that need recovery (tasks that were running before app restart) */
export const getTasksToRecover = (): Promise<CronTask[]> =>
  invokeCommandWithFallback('cmd_get_tasks_to_recover', undefined, []);

// ============= Background Session Queries =============

/** Get session IDs that have active background completions */
export const getBackgroundSessions = (): Promise<string[]> =>
  invokeCommandWithFallback('cmd_get_background_sessions', undefined, []);

// ============= Cron Scheduler Control =============

/** Start the scheduler for a task (called after task is started) */
export const startCronScheduler = async (taskId: string): Promise<void> => {
  console.log('[cronTaskClient] startCronScheduler called for task:', taskId);
  try {
    const result = await invokeCommand<void>('cmd_start_cron_scheduler', { taskId });
    console.log('[cronTaskClient] startCronScheduler completed for task:', taskId);
    return result;
  } catch (error) {
    console.error('[cronTaskClient] startCronScheduler failed for task:', taskId, error);
    throw error;
  }
};

/** Mark a task as currently executing (called when execution starts) */
export const markTaskExecuting = (taskId: string): Promise<void> =>
  invokeCommand('cmd_mark_task_executing', { taskId });

/** Mark a task as no longer executing (called when execution completes) */
export const markTaskComplete = (taskId: string): Promise<void> =>
  invokeCommand('cmd_mark_task_complete', { taskId });

/** Check if a task is currently executing */
export const isTaskExecuting = (taskId: string): Promise<boolean> =>
  invokeCommandWithFallback('cmd_is_task_executing', { taskId }, false);

// ============= Cron Task Run History =============

/** Get execution history (run records) for a cron task */
export const getCronRuns = (taskId: string, limit?: number): Promise<CronRunRecord[]> =>
  invokeCommandWithFallback('cmd_get_cron_runs', { taskId, limit }, []);

// ============= Cron Task Field Updates =============

/** Update editable fields of a cron task */
export const updateCronTaskFields = (
  taskId: string,
  fields: {
    name?: string;
    prompt?: string;
    schedule?: CronSchedule;
    intervalMinutes?: number;
    endConditions?: CronEndConditions;
    notifyEnabled?: boolean;
    model?: string;
    permissionMode?: string;
    delivery?: CronDelivery;
    clearDelivery?: boolean;
  }
): Promise<CronTask> =>
  invokeCommand('cmd_update_cron_task_fields', { taskId, ...fields });
