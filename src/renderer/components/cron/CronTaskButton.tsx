// Cron Task Button - Heart pulse button to enable heartbeat loop mode
import { Timer } from 'lucide-react';

interface CronTaskButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
}

export default function CronTaskButton({ onClick, isActive = false, disabled = false }: CronTaskButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 items-center justify-center rounded-full border transition focus:ring-2 focus:outline-none ${
        isActive
          ? 'border-[var(--heartbeat-border)] bg-[var(--heartbeat-bg)] text-[var(--heartbeat)] hover:bg-[var(--heartbeat-bg)] focus:ring-[var(--heartbeat)]'
          : 'border-[var(--line)] bg-[var(--paper-elevated)] text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] focus:ring-[var(--line-strong)]'
      } disabled:cursor-not-allowed disabled:opacity-50`}
      title={isActive ? '定时模式已启用' : '定时'}
    >
      <Timer className="h-4 w-4" />
    </button>
  );
}
