/**
 * CronExpressionInput — Visual schedule builder with advanced cron expression fallback.
 * Primary: frequency picker (每天/每周/每月) + time/day selectors
 * Advanced: raw cron expression input for power users
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { AlertCircle, Code2 } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';

interface CronExpressionInputProps {
  expr: string;
  tz: string;
  onChange: (expr: string, tz: string) => void;
}

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAY_CRON = [1, 2, 3, 4, 5, 6, 0]; // cron weekday values (0=Sun, 1=Mon...)

/** Parse a cron expression into visual state, or null if not parseable */
function parseCronToVisual(expr: string): { freq: Frequency; hour: number; minute: number; weekdays: number[]; monthDay: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;

  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m)) return null;

  // 0 8 * * * → daily
  if (dom === '*' && dow === '*') return { freq: 'daily', hour: h, minute: m, weekdays: [], monthDay: 1 };
  // 0 8 * * 1-5 → weekdays
  if (dom === '*' && dow === '1-5') return { freq: 'weekdays', hour: h, minute: m, weekdays: [1, 2, 3, 4, 5], monthDay: 1 };
  // 0 8 * * 1,3,5 → weekly (specific days)
  if (dom === '*' && /^[\d,]+$/.test(dow)) {
    const days = dow.split(',').map(Number).filter(n => !isNaN(n));
    return { freq: 'weekly', hour: h, minute: m, weekdays: days, monthDay: 1 };
  }
  // 0 8 * * 1 → weekly (single day)
  if (dom === '*' && /^\d$/.test(dow)) {
    return { freq: 'weekly', hour: h, minute: m, weekdays: [parseInt(dow, 10)], monthDay: 1 };
  }
  // 0 8 15 * * → monthly
  if (/^\d+$/.test(dom) && dow === '*') {
    return { freq: 'monthly', hour: h, minute: m, weekdays: [], monthDay: parseInt(dom, 10) };
  }

  return null;
}

/** Build a cron expression from visual state */
function buildCronFromVisual(freq: Frequency, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  switch (freq) {
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(',') : '1';
      return `${minute} ${hour} * * ${days}`;
    }
    case 'monthly': return `${minute} ${hour} ${monthDay} * *`;
    default: return `${minute} ${hour} * * *`;
  }
}

const FREQ_OPTIONS: { value: Frequency; label: string }[] = [
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i), label: String(i).padStart(2, '0'),
}));
const MINUTE_OPTIONS = [0, 5, 10, 15, 20, 30, 45].map(m => ({
  value: String(m), label: String(m).padStart(2, '0'),
}));
const MONTHDAY_OPTIONS = Array.from({ length: 28 }, (_, i) => ({
  value: String(i + 1), label: `${i + 1} 号`,
}));

export default function CronExpressionInput({ expr, tz, onChange }: CronExpressionInputProps) {
  // Try to parse existing expr into visual mode
  const initial = useMemo(() => parseCronToVisual(expr), []);  // eslint-disable-line react-hooks/exhaustive-deps

  const [mode, setMode] = useState<'visual' | 'custom'>(initial ? 'visual' : 'custom');
  const [freq, setFreq] = useState<Frequency>(initial?.freq ?? 'daily');
  const [hour, setHour] = useState(initial?.hour ?? 8);
  const [minute, setMinute] = useState(initial?.minute ?? 0);
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? [1]);
  const [monthDay, setMonthDay] = useState(initial?.monthDay ?? 1);
  const [customExpr, setCustomExpr] = useState(expr);

  // Description + next times (for both modes)
  const [description, setDescription] = useState('');
  const [parseError, setParseError] = useState('');
  const [nextTimes, setNextTimes] = useState<string[]>([]);

  // When visual state changes, build cron and notify parent
  const syncVisualToParent = useCallback(() => {
    if (mode !== 'visual') return;
    const newExpr = buildCronFromVisual(freq, hour, minute, weekdays, monthDay);
    onChange(newExpr, tz);
  }, [mode, freq, hour, minute, weekdays, monthDay, tz, onChange]);

  useEffect(() => { syncVisualToParent(); }, [syncVisualToParent]);

  // Parse cron for preview
  useEffect(() => {
    let cancelled = false;
    const currentExpr = mode === 'custom' ? customExpr : buildCronFromVisual(freq, hour, minute, weekdays, monthDay);

    async function parse() {
      try {
        const cronstrueModule = await import('cronstrue/i18n');
        const toStr = cronstrueModule.toString as (e: string, o?: Record<string, unknown>) => string;
        const desc = toStr(currentExpr, { locale: 'zh_CN' });
        if (!cancelled) { setDescription(desc); setParseError(''); }
      } catch {
        if (!cancelled) { setDescription(''); setParseError('无效的 Cron 表达式'); setNextTimes([]); return; }
      }

      try {
        const { CronExpressionParser } = await import('cron-parser');
        const interval = CronExpressionParser.parse(currentExpr, { tz });
        const times: string[] = [];
        for (let i = 0; i < 3; i++) {
          const next = interval.next();
          times.push(next.toDate().toLocaleString('zh-CN', {
            month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
          }));
        }
        if (!cancelled) setNextTimes(times);
      } catch {
        if (!cancelled) setNextTimes([]);
      }
    }
    parse();
    return () => { cancelled = true; };
  }, [mode, customExpr, freq, hour, minute, weekdays, monthDay, tz]);

  const handleFreqChange = useCallback((f: Frequency) => {
    setFreq(f);
  }, []);

  const toggleWeekday = useCallback((day: number) => {
    setWeekdays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day];
      return next.length > 0 ? next : [day]; // At least one day
    });
  }, []);

  const handleCustomExprChange = useCallback((val: string) => {
    setCustomExpr(val);
    onChange(val, tz);
  }, [onChange, tz]);

  const handleSwitchToCustom = useCallback(() => {
    const currentExpr = buildCronFromVisual(freq, hour, minute, weekdays, monthDay);
    setCustomExpr(currentExpr);
    setMode('custom');
    onChange(currentExpr, tz);
  }, [freq, hour, minute, weekdays, monthDay, onChange, tz]);

  const [canSwitchToVisual, setCanSwitchToVisual] = useState(true);

  // Check if custom expr can be parsed to visual whenever it changes
  useEffect(() => {
    setCanSwitchToVisual(parseCronToVisual(customExpr) !== null);
  }, [customExpr]);

  const handleSwitchToVisual = useCallback(() => {
    const parsed = parseCronToVisual(customExpr);
    if (!parsed) return; // Can't represent this expression visually — stay in custom mode
    setFreq(parsed.freq);
    setHour(parsed.hour);
    setMinute(parsed.minute);
    setWeekdays(parsed.weekdays);
    setMonthDay(parsed.monthDay);
    setMode('visual');
  }, [customExpr]);

  const userTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const tzOptions = useMemo(() => {
    const zones = [userTimezone, 'Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'];
    return [...new Set(zones)].map(z => ({ value: z, label: z }));
  }, [userTimezone]);

  return (
    <div className="space-y-3">
      {mode === 'visual' ? (
        <>
          {/* Frequency selector */}
          <div className="flex flex-wrap gap-1.5">
            {FREQ_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleFreqChange(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
                  freq === opt.value
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Time picker */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--ink-muted)]">时间</span>
            <CustomSelect value={String(hour)} options={HOUR_OPTIONS} onChange={v => setHour(Number(v))} compact className="w-20" />
            <span className="text-sm text-[var(--ink-muted)]">:</span>
            <CustomSelect value={String(minute)} options={MINUTE_OPTIONS} onChange={v => setMinute(Number(v))} compact className="w-20" />
          </div>

          {/* Weekly: day picker */}
          {freq === 'weekly' && (
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-xs text-[var(--ink-muted)]">周几</span>
              {WEEKDAY_LABELS.map((label, i) => {
                const cronDay = WEEKDAY_CRON[i];
                const isSelected = weekdays.includes(cronDay);
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleWeekday(cronDay)}
                    className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--paper)] border border-[var(--line)] text-[var(--ink-muted)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Monthly: day picker */}
          {freq === 'monthly' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--ink-muted)]">日期</span>
              <CustomSelect value={String(monthDay)} options={MONTHDAY_OPTIONS} onChange={v => setMonthDay(Number(v))} compact className="w-24" />
            </div>
          )}

          {/* Switch to custom */}
          <button
            type="button"
            onClick={handleSwitchToCustom}
            className="flex items-center gap-1 text-[11px] text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)] transition-colors"
          >
            <Code2 className="h-3 w-3" />
            使用 Cron 表达式
          </button>
        </>
      ) : (
        <>
          {/* Raw cron input */}
          <div>
            <input
              type="text"
              value={customExpr}
              onChange={e => handleCustomExprChange(e.target.value)}
              placeholder="0 8 * * 1-5"
              className={`w-full rounded-[var(--radius-sm)] border bg-transparent px-3 py-2 font-mono text-sm text-[var(--ink)] focus:outline-none transition-colors ${
                parseError ? 'border-[var(--error)]' : 'border-[var(--line)] focus:border-[var(--accent)]'
              }`}
            />
            {parseError && (
              <div className="mt-1.5 flex items-center gap-1 text-xs text-[var(--error)]">
                <AlertCircle className="h-3 w-3" />
                {parseError}
              </div>
            )}
          </div>

          {/* Switch back to visual */}
          <button
            type="button"
            onClick={handleSwitchToVisual}
            disabled={!canSwitchToVisual}
            className={`flex items-center gap-1 text-[11px] transition-colors ${
              canSwitchToVisual
                ? 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                : 'text-[var(--ink-subtle)] cursor-not-allowed'
            }`}
          >
            {canSwitchToVisual ? '返回可视化设置' : '当前表达式不支持可视化编辑'}
          </button>
        </>
      )}

      {/* Preview (always shown) */}
      {description && !parseError && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--line)] px-3 py-2">
          <p className="text-[13px] font-medium text-[var(--ink-secondary)]">{description}</p>
          {nextTimes.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
              {nextTimes.map((time, i) => (
                <span key={i} className="text-[11px] text-[var(--ink-muted)]">• {time}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timezone */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--ink-muted)]">时区</span>
        <CustomSelect value={tz} options={tzOptions} onChange={v => onChange(mode === 'custom' ? customExpr : buildCronFromVisual(freq, hour, minute, weekdays, monthDay), v)} compact className="w-48" />
      </div>
    </div>
  );
}
