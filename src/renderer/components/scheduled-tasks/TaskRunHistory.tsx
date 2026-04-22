/**
 * TaskRunHistory — Execution history list for a cron task.
 * Shows recent runs with timestamp, status, duration, and content preview.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, ChevronDown, Loader2 } from 'lucide-react';
import * as cronClient from '@/api/cronTaskClient';
import type { CronRunRecord } from '@/types/cronTask';

interface TaskRunHistoryProps {
  taskId: string;
  /** Open a session in a new tab when clicking a history row */
  onOpenSession?: (sessionId: string) => void;
  /** Session ID to open (the task's internal session) */
  sessionId?: string;
}

export default function TaskRunHistory({ taskId, onOpenSession, sessionId }: TaskRunHistoryProps) {
  const [runs, setRuns] = useState<CronRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(10);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    cronClient.getCronRuns(taskId, limit).then(data => {
      if (isMountedRef.current) {
        setRuns(data);
        setLoading(false);
      }
    }).catch(() => {
      if (isMountedRef.current) setLoading(false);
    });
    return () => { isMountedRef.current = false; };
  }, [taskId, limit]);

  const handleLoadMore = useCallback(() => {
    setLimit(prev => prev + 20);
  }, []);

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]" />
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <p className="py-3 text-center text-xs text-[var(--ink-muted)]">暂无执行记录</p>
    );
  }

  return (
    <div className="space-y-0.5">
      {runs.map((run, i) => {
        const date = new Date(run.ts);
        const isExpanded = expandedIndex === i;
        const content = run.ok ? run.content : run.error;

        return (
          <button
            key={`${run.ts}-${i}`}
            type="button"
            onClick={() => {
              if (onOpenSession && sessionId) {
                onOpenSession(sessionId);
              } else {
                setExpandedIndex(isExpanded ? null : i);
              }
            }}
            className="flex w-full flex-col rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left hover:bg-[var(--hover-bg)] transition-colors"
          >
            <div className="flex w-full items-center gap-2">
              {/* Time */}
              <span className="w-24 flex-shrink-0 text-[11px] text-[var(--ink-muted)]/50">
                {date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
              {/* Status icon */}
              {run.ok ? (
                <CheckCircle className="h-3 w-3 flex-shrink-0 text-[var(--success)]" />
              ) : (
                <XCircle className="h-3 w-3 flex-shrink-0 text-[var(--error)]" />
              )}
              {/* Duration */}
              <span className="w-12 flex-shrink-0 text-[11px] text-[var(--ink-muted)]">
                {run.durationMs < 1000 ? `${run.durationMs}ms` : `${(run.durationMs / 1000).toFixed(1)}s`}
              </span>
              {/* Content preview */}
              <span className="min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]">
                {content ? content.slice(0, 50) : '—'}
              </span>
              {content && (
                <ChevronDown className={`h-3 w-3 flex-shrink-0 text-[var(--ink-subtle)] transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              )}
            </div>
            {/* Expanded content */}
            {isExpanded && content && (
              <div className="mt-1.5 w-full rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-2.5 py-2 text-xs leading-relaxed text-[var(--ink-muted)] whitespace-pre-wrap break-words">
                {content}
              </div>
            )}
          </button>
        );
      })}

      {/* Load more */}
      {runs.length >= limit && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="mt-1 w-full py-1.5 text-center text-xs text-[var(--ink-muted)] hover:text-[var(--accent)] transition-colors"
        >
          查看更多
        </button>
      )}
    </div>
  );
}
