// Cron Task Settings Modal - Configure scheduled task parameters
// Redesigned for v0.1.42: adds execution mode (当前对话/新开对话) + ScheduleTypeTabs (3 schedule types)
import { X, Clock, Bell, Flag, MessageSquare, AlertCircle } from 'lucide-react';
import { useState, useCallback, useMemo } from 'react';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { CronEndConditions, CronRunMode, CronTaskConfig, CronSchedule } from '@/types/cronTask';
import { MIN_CRON_INTERVAL } from '@/types/cronTask';
import ScheduleTypeTabs from '@/components/scheduled-tasks/ScheduleTypeTabs';
import CustomSelect from '@/components/CustomSelect';
import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';

/** Toggle Switch */
function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}>
      <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${
        enabled ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

/** Checkbox */
function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 transition-colors ${
        checked ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--line-strong)] bg-transparent hover:border-[var(--accent-muted)]'
      }`}>
      {checked && (
        <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
          <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function SectionHeader({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-[var(--ink-muted)]" />
      <h3 className="text-[14px] font-semibold text-[var(--ink)]">{children}</h3>
    </div>
  );
}

function PillButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        selected ? 'bg-[var(--accent)] text-white' : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
      }`}>{children}</button>
  );
}

type EndMode = 'conditional' | 'forever';

/** Execution target: current chat session or new standalone task */
export type ExecutionTarget = 'current_session' | 'new_task';

/** Extended config returned by onConfirm — includes executionTarget and schedule */
export type CronSettingsResult = Omit<CronTaskConfig, 'workspacePath' | 'sessionId' | 'tabId'> & {
  executionTarget: ExecutionTarget;
};

/** Configuration that can be passed to restore previous settings */
type InitialConfig = {
  prompt: string;
  intervalMinutes: number;
  endConditions: CronEndConditions;
  runMode: CronRunMode;
  notifyEnabled: boolean;
  schedule?: CronSchedule;
  executionTarget?: ExecutionTarget;
  delivery?: import('@/types/cronTask').CronDelivery;
};

interface CronTaskSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (config: CronSettingsResult) => void;
  initialPrompt?: string;
  initialConfig?: InitialConfig | null;
  /** Current workspace path for delivery channel grouping */
  workspacePath?: string;
}

function toLocalDateTimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Inner form component - remounts when modal opens to reset state */
function CronTaskSettingsForm({
  initialPrompt,
  initialConfig,
  onClose,
  onConfirm,
  workspacePath,
}: Omit<CronTaskSettingsModalProps, 'isOpen'>) {
  // Execution target: current session (legacy behavior) or new standalone task
  const [executionTarget, setExecutionTarget] = useState<ExecutionTarget>(initialConfig?.executionTarget ?? 'current_session');

  // Schedule state
  const [schedule, setSchedule] = useState<CronSchedule | null>(initialConfig?.schedule ?? null);
  const [intervalMinutes, setIntervalMinutes] = useState(initialConfig?.intervalMinutes ?? 30);

  // Run mode: Loop forces single_session; otherwise current_session→single, new_task→new
  const runMode: CronRunMode = schedule?.kind === 'loop' ? 'single_session' : (executionTarget === 'current_session' ? 'single_session' : 'new_session');

  const [notifyEnabled, setNotifyEnabled] = useState(initialConfig?.notifyEnabled ?? true);
  const [deliveryBotId, setDeliveryBotId] = useState(initialConfig?.delivery?.botId ?? '');
  const { options: deliveryOptions, hasChannels, resolveDelivery } = useDeliveryChannels(workspacePath);

  // End conditions — pre-compute initial values to avoid purity issues
  const [endCondInit] = useState(() => {
    const ec = initialConfig?.endConditions;
    const hasCond = ec && (ec.deadline || ec.maxExecutions !== undefined || ec.aiCanExit);
    return {
      mode: (hasCond ? 'conditional' : 'forever') as EndMode,
      useDeadline: !!ec?.deadline,
      deadline: ec?.deadline ? toLocalDateTimeString(new Date(ec.deadline)) : toLocalDateTimeString(new Date(Date.now() + 86400000)),
      useMaxExec: ec?.maxExecutions !== undefined,
      maxExec: ec?.maxExecutions ?? 10,
      aiCanExit: ec?.aiCanExit ?? false,
    };
  });
  const [endMode, setEndMode] = useState<EndMode>(endCondInit.mode);
  const [useDeadline, setUseDeadline] = useState(endCondInit.useDeadline);
  const [deadline, setDeadline] = useState(endCondInit.deadline);
  const [useMaxExecutions, setUseMaxExecutions] = useState(endCondInit.useMaxExec);
  const [maxExecutions, setMaxExecutions] = useState(endCondInit.maxExec);
  const [aiCanExit, setAiCanExit] = useState(endCondInit.aiCanExit);

  const isAtSchedule = schedule?.kind === 'at';
  const isLoopSchedule = schedule?.kind === 'loop';

  const handleScheduleChange = useCallback((s: CronSchedule | null, m: number) => {
    setSchedule(s);
    setIntervalMinutes(m);
  }, []);

  // Validation
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (!schedule && intervalMinutes < MIN_CRON_INTERVAL) errors.push(`间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
    if (schedule?.kind === 'cron') {
      const parts = schedule.expr.trim().split(/\s+/);
      if (parts.length !== 5) {
        errors.push('无效的 Cron 表达式');
      } else {
        const cronFieldRegex = /^[\d,\-*/]+$/;
        if (!parts.every(p => cronFieldRegex.test(p))) {
          errors.push('无效的 Cron 表达式');
        }
      }
    }
    if (schedule?.kind === 'at') {
      const atTime = new Date(schedule.at).getTime();
      // Validate at confirm time, not render time — just check if parseable here
      if (isNaN(atTime)) errors.push('请输入有效的执行时间');
    }
    if (endMode === 'conditional' && !isAtSchedule) {
      if (!useDeadline && !useMaxExecutions && !aiCanExit) {
        errors.push('请至少选择一个结束条件');
      }
    }
    return errors;
  }, [schedule, intervalMinutes, endMode, useDeadline, useMaxExecutions, aiCanExit, isAtSchedule]);

  const isValid = validationErrors.length === 0;

  const handleConfirm = useCallback(() => {
    if (!isValid) return;

    const endConditions: CronEndConditions = isAtSchedule
      ? { aiCanExit: false }
      : endMode === 'forever'
        ? { aiCanExit }
        : {
            deadline: useDeadline && deadline ? new Date(deadline).toISOString() : undefined,
            maxExecutions: useMaxExecutions ? maxExecutions : undefined,
            aiCanExit,
          };

    const delivery = (notifyEnabled && deliveryBotId) ? resolveDelivery(deliveryBotId) : undefined;
    onConfirm({
      prompt: (initialPrompt ?? '').trim(),
      intervalMinutes: schedule?.kind === 'every' ? schedule.minutes : intervalMinutes,
      endConditions,
      runMode,
      notifyEnabled,
      executionTarget,
      schedule: schedule ?? undefined,
      delivery,
    });
  }, [isValid, initialPrompt, schedule, intervalMinutes, runMode, notifyEnabled, deliveryBotId, resolveDelivery, endMode, aiCanExit, useDeadline, deadline, useMaxExecutions, maxExecutions, executionTarget, isAtSchedule, onConfirm]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} />

      <div className="relative z-10 flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">定时任务</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">

          {/* ── 执行模式 ── */}
          <div>
            <SectionHeader icon={MessageSquare}>执行模式</SectionHeader>
            <div className="mt-3">
              {isLoopSchedule ? (
                <p className="text-sm text-[var(--ink-muted)]">连续对话（保持上下文）— Ralph Loop 固定使用此模式</p>
              ) : (
              <div className="flex gap-2">
                <PillButton selected={executionTarget === 'current_session'} onClick={() => setExecutionTarget('current_session')}>当前对话</PillButton>
                <PillButton selected={executionTarget === 'new_task'} onClick={() => setExecutionTarget('new_task')}>新开对话</PillButton>
              </div>
              )}
              {!isLoopSchedule && (
              <p className="mt-1.5 text-[13px] text-[var(--ink-muted)]">
                {executionTarget === 'current_session'
                  ? '在当前对话中定时执行，保持上下文'
                  : '创建独立定时任务，不占用当前对话'}
              </p>
              )}
            </div>
          </div>

          <div className="border-t border-[var(--line)]" />

          {/* ── 执行计划 ── */}
          <div>
            <SectionHeader icon={Clock}>执行计划</SectionHeader>
            <div className="mt-3">
              <ScheduleTypeTabs value={schedule} intervalMinutes={intervalMinutes} onChange={handleScheduleChange} />
            </div>
          </div>

          <div className="border-t border-[var(--line)]" />

          {/* ── 结束条件 ── */}
          {!isAtSchedule && (
            <div>
              <SectionHeader icon={Flag}>结束条件</SectionHeader>
              <div className="mt-3 space-y-3">
                <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                  <button type="button" onClick={() => setEndMode('forever')}
                    className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      endMode === 'forever' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}>永久运行</button>
                  <button type="button" onClick={() => setEndMode('conditional')}
                    className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      endMode === 'conditional' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}>条件停止</button>
                </div>

                {endMode === 'conditional' && (
                  <>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
                      <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                        onClick={() => setUseDeadline(!useDeadline)}>
                        <div className="flex items-center gap-2.5">
                          <Checkbox checked={useDeadline} onChange={setUseDeadline} label="截止时间" />
                          <span className="text-sm text-[var(--ink)]">截止时间</span>
                        </div>
                        <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!useDeadline ? 'opacity-50' : ''}`} />
                      </div>
                      <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                        onClick={() => setUseMaxExecutions(!useMaxExecutions)}>
                        <div className="flex items-center gap-2.5">
                          <Checkbox checked={useMaxExecutions} onChange={setUseMaxExecutions} label="执行次数" />
                          <span className="text-sm text-[var(--ink)]">执行次数</span>
                        </div>
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                          <input type="number" value={maxExecutions} onChange={e => setMaxExecutions(parseInt(e.target.value, 10) || 1)}
                            min={1} max={999}
                            className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!useMaxExecutions ? 'opacity-50' : ''}`} />
                          <span className={`text-sm text-[var(--ink-secondary)] ${!useMaxExecutions ? 'opacity-50' : ''}`}>次</span>
                        </div>
                      </div>
                    </div>
                    <p className="text-[13px] text-[var(--ink-muted)]">可多选，满足任一条件时任务将自动停止</p>
                  </>
                )}

                {/* AI 自主结束 — 在永久运行和条件停止模式下都显示 */}
                {!isAtSchedule && (
                  <div className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5"
                    onClick={() => setAiCanExit(!aiCanExit)}>
                    <div className="flex items-center gap-2.5">
                      <Checkbox checked={aiCanExit} onChange={setAiCanExit} label="允许 AI 自主结束任务" />
                      <span className="text-sm text-[var(--ink)]">允许 AI 自主结束任务</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── 任务通知 ── */}
          <div>
            <SectionHeader icon={Bell}>任务通知</SectionHeader>
            <div className="mt-3 space-y-3">
              <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                <span className="text-sm text-[var(--ink)]">每次执行完即发送通知</span>
                <ToggleSwitch enabled={notifyEnabled} onChange={setNotifyEnabled} />
              </div>
              {notifyEnabled && hasChannels && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--ink)]">投递渠道</label>
                  <CustomSelect value={deliveryBotId} options={deliveryOptions} onChange={setDeliveryBotId} placeholder="桌面通知（默认）" />
                </div>
              )}
            </div>
          </div>

          {/* Validation Errors */}
          {validationErrors.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-[var(--error)]/30 bg-[var(--error)]/5 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--error)]" />
              <div className="text-xs text-[var(--error)]">
                {validationErrors.map((err, i) => <p key={i}>{err}</p>)}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-[var(--line)] px-6 py-3.5">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition hover:bg-[var(--paper-inset)]">取消</button>
          <button onClick={handleConfirm} disabled={!isValid}
            className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-warm-hover)] disabled:cursor-not-allowed disabled:opacity-50">
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CronTaskSettingsModal({
  isOpen,
  onClose,
  onConfirm,
  initialPrompt = '',
  initialConfig = null,
  workspacePath,
}: CronTaskSettingsModalProps) {
  useCloseLayer(() => { if (!isOpen) return false; onClose(); return true; }, 50);
  if (!isOpen) return null;

  return (
    <CronTaskSettingsForm
      initialPrompt={initialPrompt}
      initialConfig={initialConfig}
      onClose={onClose}
      onConfirm={onConfirm}
      workspacePath={workspacePath}
    />
  );
}
