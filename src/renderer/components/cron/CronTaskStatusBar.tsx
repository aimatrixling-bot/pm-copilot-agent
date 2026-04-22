// Cron Task Status Bar - Shows above input when cron mode is enabled
import { Timer, Settings2, X } from 'lucide-react';
import { formatCronInterval, type CronSchedule } from '@/types/cronTask';

interface CronTaskStatusBarProps {
  intervalMinutes: number;
  schedule?: CronSchedule | null;
  onSettings: () => void;
  onCancel: () => void;
}

function formatStatusBarSchedule(schedule: CronSchedule | null | undefined, intervalMinutes: number): string {
  if (schedule) {
    switch (schedule.kind) {
      case 'at':
        return `${new Date(schedule.at).toLocaleString('zh-CN')} 执行一次`;
      case 'every':
        return `每 ${formatCronInterval(schedule.minutes)} 执行一次`;
      case 'cron':
        return `Cron: ${schedule.expr}`;
      case 'loop':
        return 'Ralph Loop 无限循环';
    }
  }
  return `每 ${formatCronInterval(intervalMinutes)} 执行一次`;
}

export default function CronTaskStatusBar({
  intervalMinutes,
  schedule,
  onSettings,
  onCancel
}: CronTaskStatusBarProps) {
  return (
    <div
      className="flex items-center justify-between rounded-t-lg border border-b-0 border-[var(--heartbeat-border)] px-3 py-2"
      style={{ backgroundColor: 'color-mix(in srgb, var(--paper) 92%, var(--heartbeat))' }}
    >
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-[var(--heartbeat)]" />
        <span className="text-sm font-medium text-[var(--heartbeat)]">
          定时模式
        </span>
        <span className="text-sm text-[var(--ink-muted)]">
          {formatStatusBarSchedule(schedule, intervalMinutes)}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onSettings}
          className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
          title="修改设置"
        >
          <Settings2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--heartbeat-bg)] hover:text-[var(--heartbeat)]"
          title="取消定时"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
