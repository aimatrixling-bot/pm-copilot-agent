// Cron Task Overlay - Covers input area when heartbeat loop task is running
// Follows design_guide.md: warm paper tones, elegant and unobtrusive
import { useState, useEffect } from 'react';
import { Timer, Pencil } from 'lucide-react';
import type { CronTaskStatus, CronSchedule } from '@/types/cronTask';
import { formatCronInterval } from '@/types/cronTask';

interface CronTaskOverlayProps {
  status: CronTaskStatus;
  intervalMinutes: number;
  schedule?: CronSchedule | null;
  executionCount: number;
  maxExecutions?: number; // For showing progress like "1/3"
  nextExecutionTime?: Date;
  onStop: () => void;
  onSettings: () => void;
}

// Animated heart pulse icon for running state
function AnimatedHeartIcon({ isRunning }: { isRunning: boolean }) {
  return (
    <div className="relative">
      <Timer className={`h-4 w-4 text-[var(--heartbeat)] ${isRunning ? '' : 'opacity-60'}`} />
      {isRunning && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--heartbeat)] opacity-40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--heartbeat)]" />
        </span>
      )}
    </div>
  );
}

export default function CronTaskOverlay({
  status,
  intervalMinutes,
  schedule,
  executionCount,
  maxExecutions,
  nextExecutionTime,
  onStop,
  onSettings,
}: CronTaskOverlayProps) {
  const isRunning = status === 'running';

  // State to force re-render for countdown update
  const [, setTick] = useState(0);

  // Update countdown every second when running
  useEffect(() => {
    if (!isRunning || !nextExecutionTime) return;

    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [isRunning, nextExecutionTime]);

  // Calculate time until next execution
  const getTimeDisplay = (): { text: string; isCountdown: boolean } | null => {
    if (!nextExecutionTime || !isRunning) return null;

    const now = new Date();
    const diff = nextExecutionTime.getTime() - now.getTime();

    if (diff <= 0) {
      return { text: '执行中...', isCountdown: false };
    }

    const totalSeconds = Math.floor(diff / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return {
        text: `${hours}:${mins.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`,
        isCountdown: true
      };
    }

    return {
      text: `${minutes}:${seconds.toString().padStart(2, '0')}`,
      isCountdown: true
    };
  };

  const timeDisplay = getTimeDisplay();

  // Format execution count with progress
  const getExecutionText = () => {
    if (maxExecutions) {
      return `已执行 ${executionCount}/${maxExecutions} 次`;
    }
    return `已执行 ${executionCount} 次`;
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-between gap-4 rounded-2xl border border-[var(--heartbeat-border)] bg-[var(--paper-elevated)]/95 px-5 py-4 backdrop-blur-sm">
      {/* Left: Status Info */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Status Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--heartbeat-bg)]">
          <AnimatedHeartIcon isRunning={isRunning} />
        </div>

        {/* Status Text */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--ink)]">
              定时运行中
            </span>
            {timeDisplay && (
              <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs ${
                timeDisplay.isCountdown
                  ? 'bg-[var(--heartbeat-bg)] text-[var(--heartbeat)]'
                  : 'bg-[var(--paper-inset)] text-[var(--ink-secondary)]'
              }`}>
                {timeDisplay.isCountdown && (
                  <span className="text-[10px] font-normal text-[var(--ink-muted)]">下次</span>
                )}
                {timeDisplay.text}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--ink-muted)]">
            <span>{schedule?.kind === 'at'
              ? `仅一次 (${new Date(schedule.at).toLocaleString('zh-CN')})`
              : schedule?.kind === 'cron'
                ? `Cron: ${schedule.expr}`
                : schedule?.kind === 'loop'
                  ? 'Ralph Loop 无限循环'
                  : `每 ${formatCronInterval(schedule?.kind === 'every' ? schedule.minutes : intervalMinutes)}`
            }</span>
            <span className="text-[var(--line-strong)]">·</span>
            <span>{getExecutionText()}</span>
          </div>
        </div>
      </div>

      {/* Right: Control Buttons - consistent styling with rounded borders */}
      <div className="flex shrink-0 items-center gap-2">
        {/* Settings Button */}
        <button
          onClick={onSettings}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
        >
          <Pencil className="h-3.5 w-3.5" />
          修改
        </button>

        {/* Stop Button */}
        <button
          onClick={onStop}
          className="flex items-center gap-1.5 rounded-lg border border-[var(--heartbeat-border)] px-3 py-1.5 text-xs font-medium text-[var(--heartbeat)] transition-colors hover:bg-[var(--heartbeat-bg)]"
        >
          <span className="h-3 w-3 rounded-[2px] bg-current" />
          停止
        </button>
      </div>
    </div>
  );
}
