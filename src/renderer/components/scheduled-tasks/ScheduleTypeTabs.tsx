/**
 * ScheduleTypeTabs — Three schedule type tabs (固定间隔 / 定时执行 / 仅一次)
 * Each tab renders its own configuration area.
 */

import { useState, useCallback, useMemo } from 'react';
import { Clock, Calendar, Timer, Repeat } from 'lucide-react';
import type { CronSchedule } from '@/types/cronTask';
import { CRON_INTERVAL_PRESETS, MIN_CRON_INTERVAL } from '@/types/cronTask';
import CronExpressionInput from './CronExpressionInput';

/** Format a Date as local YYYY-MM-DDTHH:mm for datetime-local input */
function toLocalDateTimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type ScheduleKind = 'every' | 'cron' | 'at' | 'loop';

interface ScheduleTypeTabsProps {
  value: CronSchedule | null;
  intervalMinutes: number;
  onChange: (schedule: CronSchedule | null, intervalMinutes: number) => void;
  error?: string;
}

const TABS: { kind: ScheduleKind; label: string; icon: typeof Clock }[] = [
  { kind: 'every', label: '固定间隔', icon: Timer },
  { kind: 'cron', label: '定时执行', icon: Clock },
  { kind: 'at', label: '仅一次', icon: Calendar },
  { kind: 'loop', label: '无限循环', icon: Repeat },
];

export default function ScheduleTypeTabs({ value, intervalMinutes, onChange, error }: ScheduleTypeTabsProps) {
  const activeKind: ScheduleKind = value?.kind ?? 'every';
  const [customMinutes, setCustomMinutes] = useState<string>(
    CRON_INTERVAL_PRESETS.some(p => p.value === intervalMinutes) ? '' : String(intervalMinutes)
  );
  const [isCustom, setIsCustom] = useState(
    !CRON_INTERVAL_PRESETS.some(p => p.value === intervalMinutes) && activeKind === 'every'
  );

  // Start time for "every" mode
  const [startMode, setStartMode] = useState<'now' | 'scheduled'>(
    value?.kind === 'every' && value.startAt ? 'scheduled' : 'now'
  );
  const [startAt, setStartAt] = useState(
    value?.kind === 'every' && value.startAt ? toLocalDateTimeString(new Date(value.startAt)) : ''
  );

  // Cron state
  const [cronExpr, setCronExpr] = useState(value?.kind === 'cron' ? value.expr : '0 8 * * *');
  const [cronTz, setCronTz] = useState(value?.kind === 'cron' ? (value.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone) : Intl.DateTimeFormat().resolvedOptions().timeZone);

  // At state
  const getDefaultAtTime = useCallback(() => {
    const d = new Date(Date.now() + 3600000);
    d.setMinutes(0, 0, 0);
    return toLocalDateTimeString(d);
  }, []);
  const [atDateTime, setAtDateTime] = useState(
    value?.kind === 'at' ? toLocalDateTimeString(new Date(value.at)) : getDefaultAtTime()
  );

  /** Build the schedule value for "every" mode, including startAt if scheduled */
  const buildEverySchedule = useCallback((mins: number): CronSchedule | null => {
    if (startMode === 'scheduled' && startAt) {
      return { kind: 'every', minutes: mins, startAt: new Date(startAt).toISOString() };
    }
    return null; // null = use legacy intervalMinutes path (immediate start)
  }, [startMode, startAt]);

  const handleTabChange = useCallback((kind: ScheduleKind) => {
    if (kind === 'every') {
      onChange(buildEverySchedule(intervalMinutes), intervalMinutes);
    } else if (kind === 'cron') {
      onChange({ kind: 'cron', expr: cronExpr, tz: cronTz }, intervalMinutes);
    } else if (kind === 'loop') {
      onChange({ kind: 'loop' }, intervalMinutes);
    } else {
      onChange({ kind: 'at', at: new Date(atDateTime).toISOString() }, intervalMinutes);
    }
  }, [onChange, intervalMinutes, buildEverySchedule, cronExpr, cronTz, atDateTime]);

  const handlePresetClick = useCallback((minutes: number) => {
    setIsCustom(false);
    onChange(buildEverySchedule(minutes), minutes);
  }, [onChange, buildEverySchedule]);

  const handleCustomMinutesChange = useCallback((val: string) => {
    setCustomMinutes(val);
    const num = parseInt(val, 10);
    if (!isNaN(num) && num >= MIN_CRON_INTERVAL) {
      onChange(buildEverySchedule(num), num);
    }
  }, [onChange, buildEverySchedule]);

  const handleCronChange = useCallback((expr: string, tz: string) => {
    setCronExpr(expr);
    setCronTz(tz);
    onChange({ kind: 'cron', expr, tz }, intervalMinutes);
  }, [onChange, intervalMinutes]);

  const handleAtChange = useCallback((dateTime: string) => {
    setAtDateTime(dateTime);
    if (!dateTime) return; // Guard empty datetime-local (would throw RangeError)
    const d = new Date(dateTime);
    if (isNaN(d.getTime())) return; // Guard invalid date
    onChange({ kind: 'at', at: d.toISOString() }, intervalMinutes);
  }, [onChange, intervalMinutes]);

  // Min datetime for "at" type (now + 1 minute)
  const minDateTime = useMemo(() => {
    return toLocalDateTimeString(new Date(Date.now() + 60000));
  }, []);

  return (
    <div>
      {/* Tab buttons */}
      <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeKind === tab.kind;
          return (
            <button
              key={tab.kind}
              type="button"
              onClick={() => handleTabChange(tab.kind)}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                isActive
                  ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="mt-3">
        {activeKind === 'every' && (
          <div>
            <div className="flex flex-wrap gap-2">
              {CRON_INTERVAL_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => handlePresetClick(preset.value)}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                    !isCustom && intervalMinutes === preset.value
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setIsCustom(true);
                  setCustomMinutes(String(intervalMinutes));
                }}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                  isCustom
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                }`}
              >
                自定义
              </button>
            </div>
            {isCustom && (
              <div className="mt-2.5 flex items-center gap-2">
                <input
                  type="number"
                  min={MIN_CRON_INTERVAL}
                  value={customMinutes}
                  onChange={e => handleCustomMinutesChange(e.target.value)}
                  className="w-24 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                  placeholder={String(MIN_CRON_INTERVAL)}
                />
                <span className="text-[13px] text-[var(--ink-muted)]">分钟（最少 {MIN_CRON_INTERVAL} 分钟）</span>
              </div>
            )}

            {/* Start time */}
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-[var(--ink-muted)]">开始时间</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStartMode('now');
                    setStartAt('');
                    onChange(null, intervalMinutes);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                    startMode === 'now'
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                  }`}
                >
                  立刻
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStartMode('scheduled');
                    const defaultStart = toLocalDateTimeString(new Date(Date.now() + 3600000));
                    setStartAt(defaultStart);
                    onChange({ kind: 'every', minutes: intervalMinutes, startAt: new Date(defaultStart).toISOString() }, intervalMinutes);
                  }}
                  className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                    startMode === 'scheduled'
                      ? 'bg-[var(--accent)] text-white'
                      : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                  }`}
                >
                  指定时间
                </button>
              </div>
              {startMode === 'scheduled' && (
                <input
                  type="datetime-local"
                  value={startAt}
                  min={toLocalDateTimeString(new Date(Date.now() + 60000))}
                  onChange={e => {
                    setStartAt(e.target.value);
                    if (e.target.value) {
                      onChange({ kind: 'every', minutes: intervalMinutes, startAt: new Date(e.target.value).toISOString() }, intervalMinutes);
                    }
                  }}
                  className="rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-1 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
                />
              )}
            </div>
          </div>
        )}

        {activeKind === 'cron' && (
          <CronExpressionInput
            expr={cronExpr}
            tz={cronTz}
            onChange={handleCronChange}
          />
        )}

        {activeKind === 'loop' && (
          <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
            <p className="text-sm font-medium text-[var(--ink)]">Ralph Loop 无限循环</p>
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-muted)]">
              让 AI 持续无限运行的模式。每次 AI 完成回复后，自动发起下一轮执行，不受时间调度约束。
              适用于需要 AI 持续工作直到任务完成的场景。连续失败 10 次将自动停止。
            </p>
          </div>
        )}

        {activeKind === 'at' && (
          <div>
            <input
              type="datetime-local"
              value={atDateTime}
              min={minDateTime}
              onChange={e => handleAtChange(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
            />
            {atDateTime && (
              <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                距现在约{' '}
                {(() => {
                  const diffMs = new Date(atDateTime).getTime() - Date.now();
                  if (diffMs <= 0) return '已过期';
                  const mins = Math.floor(diffMs / 60000);
                  if (mins < 60) return `${mins} 分钟`;
                  const hrs = Math.floor(mins / 60);
                  if (hrs < 24) return `${hrs} 小时`;
                  return `${Math.floor(hrs / 24)} 天`;
                })()}
              </p>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs text-[var(--error)]">{error}</p>
      )}
    </div>
  );
}
