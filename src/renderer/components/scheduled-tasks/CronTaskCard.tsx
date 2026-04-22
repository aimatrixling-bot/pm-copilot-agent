/**
 * CronTaskCard — Rendered in chat conversation flow when cron tool creates a task.
 * Displays task name, schedule, next execution, and a "查看详情" link.
 */

import { useState, useCallback } from 'react';
import { Clock, ArrowRight } from 'lucide-react';
import { formatNextExecution } from '@/types/cronTask';
import type { CronTask } from '@/types/cronTask';
import * as cronClient from '@/api/cronTaskClient';

interface CronTaskCardProps {
  /** Parsed result from the cron tool add action */
  taskId: string;
  name?: string;
  scheduleDesc?: string;
  nextExecutionAt?: string;
  /** Callback to open detail panel */
  onOpenDetail?: (task: CronTask) => void;
}

export default function CronTaskCard({ taskId, name, scheduleDesc, nextExecutionAt, onOpenDetail }: CronTaskCardProps) {
  const [loading, setLoading] = useState(false);

  const handleClick = useCallback(async () => {
    if (loading || !onOpenDetail) return;
    setLoading(true);
    try {
      const task = await cronClient.getCronTask(taskId);
      onOpenDetail(task);
    } catch {
      // Task may have been deleted
    } finally {
      setLoading(false);
    }
  }, [taskId, onOpenDetail, loading]);

  return (
    <div className="my-2 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5 shadow-xs">
      {/* Header */}
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-warm-subtle)]">
          <Clock className="h-3.5 w-3.5 text-[var(--accent)]" />
        </div>
        <span className="text-xs font-medium text-[var(--accent)]">定时任务已创建</span>
      </div>

      {/* Body */}
      <p className="text-sm font-medium text-[var(--ink)]">{name || '未命名任务'}</p>
      <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
        {scheduleDesc}
        {nextExecutionAt && (
          <span className="ml-1.5">· 下次: {formatNextExecution(nextExecutionAt, 'running')}</span>
        )}
      </p>

      {/* Action */}
      {onOpenDetail && (
        <button
          onClick={handleClick}
          disabled={loading}
          className="mt-2.5 flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:text-[var(--accent-warm-hover)] transition-colors disabled:opacity-50"
        >
          查看详情
          <ArrowRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
