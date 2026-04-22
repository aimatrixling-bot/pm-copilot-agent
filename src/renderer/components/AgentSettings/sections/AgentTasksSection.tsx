// Agent tasks section — display cron tasks associated with this agent, clickable to open detail
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import { getWorkspaceCronTasks, deleteCronTask, startCronTask, stopCronTask, startCronScheduler } from '@/api/cronTaskClient';
import type { CronTask } from '@/types/cronTask';
import { getCronStatusText, formatScheduleDescription } from '@/types/cronTask';
import { useToast } from '@/components/Toast';
import CronTaskDetailPanel from '@/components/CronTaskDetailPanel';

function formatRelativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) return '刚刚';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function cronStatusDotColor(status: string): string {
  if (status === 'running') return 'var(--success)';
  return 'var(--ink-subtle)';
}

interface AgentTasksSectionProps {
  agent: AgentConfig;
}

export default function AgentTasksSection({ agent }: AgentTasksSectionProps) {
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [selectedTask, setSelectedTask] = useState<CronTask | null>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  const isMountedRef = useRef(true);

  useEffect(() => { toastRef.current = toast; }, [toast]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const tasks = await getWorkspaceCronTasks(agent.workspacePath);
      if (!isMountedRef.current) return;
      setTasks(tasks);
    } catch {
      // Silent — tasks are optional
    }
  }, [agent.workspacePath]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadTasks fetches from external API then sets state, which is the correct pattern for effects
    void loadTasks();
  }, [loadTasks]);

  const handleDelete = useCallback(async (taskId: string) => {
    try {
      await deleteCronTask(taskId);
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success('定时任务已删除');
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(`删除失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [loadTasks]);

  const handleResume = useCallback(async (taskId: string) => {
    try {
      await startCronTask(taskId);
      await startCronScheduler(taskId);
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success('任务已恢复运行');
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        setSelectedTask(null);
        void loadTasks();
        return;
      }
      toastRef.current.error(`恢复失败: ${msg}`);
    }
  }, [loadTasks]);

  const handleStop = useCallback(async (taskId: string) => {
    try {
      await stopCronTask(taskId, '手动停止');
      if (!isMountedRef.current) return;
      setSelectedTask(null);
      toastRef.current.success('任务已停止');
      void loadTasks();
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) {
        setSelectedTask(null);
        void loadTasks();
        return;
      }
      toastRef.current.error(`停止失败: ${msg}`);
    }
  }, [loadTasks]);

  // Only show active (running) tasks, sorted by date descending (newest first)
  const activeTasks = useMemo(() =>
    tasks
      .filter(t => t.status === 'running')
      .sort((a, b) => {
        const dateA = new Date(a.updatedAt ?? a.createdAt).getTime();
        const dateB = new Date(b.updatedAt ?? b.createdAt).getTime();
        return dateB - dateA;
      }),
    [tasks],
  );

  return (
    <div className="space-y-3">
      <h3 className="text-base font-medium text-[var(--ink)]">
        定时任务
      </h3>

      {activeTasks.length === 0 ? (
        <p className="text-xs text-[var(--ink-subtle)]">
          暂无运行中的定时任务。
        </p>
      ) : (
        <div className="space-y-2">
          {activeTasks.map(task => (
            <button
              key={task.id}
              type="button"
              onClick={() => setSelectedTask(task)}
              className="flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]"
            >
              <div
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: cronStatusDotColor(task.status) }}
              />
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium truncate text-[var(--ink)]">
                  {task.name || '未命名任务'}
                </span>
                <div className="text-xs text-[var(--ink-subtle)]">
                  {formatScheduleDescription(task)} · {getCronStatusText(task.status)}
                </div>
              </div>
              {task.lastExecutedAt && (
                <span className="shrink-0 text-xs text-[var(--ink-subtle)]">
                  {formatRelativeTime(task.lastExecutedAt)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {selectedTask && (
        <CronTaskDetailPanel
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
          onDelete={handleDelete}
          onResume={handleResume}
          onStop={handleStop}
        />
      )}
    </div>
  );
}
