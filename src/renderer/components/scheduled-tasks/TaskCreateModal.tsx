/**
 * TaskCreateModal — Full-featured modal for creating scheduled tasks independently.
 * Design language aligned with CronTaskSettingsModal and Agent Settings panels.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { X, Clock, Bell, Check, Flag, FileText, MessageSquare } from 'lucide-react';
import { v4 as uuid } from 'uuid';

import ScheduleTypeTabs from './ScheduleTypeTabs';
import CustomSelect from '@/components/CustomSelect';
import WorkspaceIcon from '@/components/launcher/WorkspaceIcon';
import { useConfig } from '@/hooks/useConfig';
import { useToast } from '@/components/Toast';
import * as cronClient from '@/api/cronTaskClient';
import { getSessions, type SessionMetadata } from '@/api/sessionClient';
import type { CronSchedule, CronEndConditions, CronRunMode } from '@/types/cronTask';
import { MIN_CRON_INTERVAL } from '@/types/cronTask';
import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

function toLocalDateTimeString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface TaskCreateModalProps {
  onClose: () => void;
  onCreated?: () => void;
}

const INPUT_CLS = 'w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

/** Toggle Switch — matches existing ToggleSwitch in CronTaskSettingsModal */
function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
      }`}
    >
      <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${
        enabled ? 'translate-x-4' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

/** Checkbox — matches existing checkbox style */
function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-[13px] text-[var(--ink)]">
      <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line-strong)] bg-transparent'
      }`}>
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {label}
    </button>
  );
}

/** Section title — matches Agent settings style (14px, icon optional) */
function SectionHeader({ icon: Icon, children }: { icon?: typeof Clock; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="h-4 w-4 text-[var(--ink-muted)]" />}
      <h3 className="text-[14px] font-semibold text-[var(--ink)]">{children}</h3>
    </div>
  );
}

/** Filled pill button — selected: accent fill + white text, unselected: paper bg */
function PillButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        selected
          ? 'bg-[var(--accent)] text-white'
          : 'bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--paper-inset)]'
      }`}
    >
      {children}
    </button>
  );
}

export default function TaskCreateModal({ onClose, onCreated }: TaskCreateModalProps) {
  useCloseLayer(() => { onClose(); return true; }, 200);

  const { projects } = useConfig();
  const toast = useToast();

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedProjectPath, setSelectedProjectPath] = useState<string>(projects[0]?.path ?? '');
  const [schedule, setSchedule] = useState<CronSchedule | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [deliveryBotId, setDeliveryBotId] = useState('');
  const [runMode, setRunMode] = useState<CronRunMode>('new_session');
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [workspaceSessions, setWorkspaceSessions] = useState<SessionMetadata[]>([]);
  const isMountedRef = useRef(true);

  const [endConditionMode, setEndConditionMode] = useState<'conditional' | 'forever'>('forever');
  const [deadline, setDeadline] = useState('');
  const [maxExecutions, setMaxExecutions] = useState('');
  const [aiCanExit, setAiCanExit] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  const { options: deliveryOptions, hasChannels, resolveDelivery } = useDeliveryChannels(selectedProjectPath);
  const isAtSchedule = schedule?.kind === 'at';
  const isLoopSchedule = schedule?.kind === 'loop';

  useEffect(() => {
    isMountedRef.current = true;
    if (runMode !== 'single_session' || !selectedProjectPath) { setWorkspaceSessions([]); setSelectedSessionId(''); return; }
    setSelectedSessionId(''); // Reset on project change
    getSessions(selectedProjectPath).then(sessions => {
      if (!isMountedRef.current) return;
      setWorkspaceSessions(
        sessions.filter(s => !s.cronTaskId && s.source !== 'telegram_private' && s.source !== 'feishu_private')
          .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
          .slice(0, 10)
      );
    }).catch(() => { if (isMountedRef.current) setWorkspaceSessions([]); });
    return () => { isMountedRef.current = false; };
  }, [runMode, selectedProjectPath]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const projectOptions = useMemo(() =>
    projects.map(p => ({
      value: p.path,
      label: p.name || p.path.split('/').pop() || p.path,
      icon: <WorkspaceIcon icon={p.icon} size={16} />,
    })),
    [projects]
  );

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!prompt.trim()) errs.push('请输入 AI 指令');
    if (!selectedProjectPath) errs.push('请选择工作区');
    if (!schedule && intervalMinutes < MIN_CRON_INTERVAL) errs.push(`间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
    if (schedule?.kind === 'cron') {
      const parts = schedule.expr.trim().split(/\s+/);
      if (parts.length !== 5) {
        errs.push('无效的 Cron 表达式');
      } else {
        // Validate each field has valid cron characters
        const cronFieldRegex = /^[\d,\-*/]+$/;
        if (!parts.every(p => cronFieldRegex.test(p))) {
          errs.push('无效的 Cron 表达式');
        }
      }
    }
    if (schedule?.kind === 'at') {
      const atTime = new Date(schedule.at).getTime();
      if (isNaN(atTime) || atTime <= Date.now()) errs.push('执行时间必须在未来');
    }
    if (endConditionMode === 'conditional' && !isAtSchedule && !deadline && !maxExecutions && !aiCanExit) {
      errs.push('请至少设置一个结束条件');
    }
    return errs;
  }, [prompt, selectedProjectPath, schedule, intervalMinutes, endConditionMode, deadline, maxExecutions, aiCanExit, isAtSchedule]);

  const handleScheduleChange = useCallback((newSchedule: CronSchedule | null, newInterval: number) => {
    setSchedule(newSchedule);
    setIntervalMinutes(newInterval);
  }, []);

  const handleCreate = useCallback(async () => {
    if (errors.length > 0 || isCreating) return;
    setIsCreating(true);
    try {
      const sessionId = (runMode === 'single_session' && selectedSessionId) ? selectedSessionId : `cron-standalone-${uuid()}`;
      const endConditions: CronEndConditions = isAtSchedule
        ? { aiCanExit: false }
        : endConditionMode === 'forever'
          ? { aiCanExit }
          : { deadline: deadline ? new Date(deadline).toISOString() : undefined, maxExecutions: maxExecutions ? parseInt(maxExecutions, 10) : undefined, aiCanExit };

      const delivery = (notifyEnabled && deliveryBotId) ? resolveDelivery(deliveryBotId) : undefined;
      const task = await cronClient.createCronTask({
        workspacePath: selectedProjectPath, sessionId, prompt: prompt.trim(),
        intervalMinutes: schedule?.kind === 'every' ? schedule.minutes : intervalMinutes,
        endConditions, runMode: isLoopSchedule ? 'single_session' : runMode, notifyEnabled, schedule: schedule ?? undefined, name: name.trim() || undefined,
        delivery,
      });
      await cronClient.startCronTask(task.id);
      await cronClient.startCronScheduler(task.id);
      toast.success('定时任务已创建');
      onCreated?.();
      onClose();
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally { setIsCreating(false); }
  }, [errors, isCreating, name, prompt, selectedProjectPath, schedule, intervalMinutes, endConditionMode, deadline, maxExecutions, aiCanExit, notifyEnabled, deliveryBotId, resolveDelivery, runMode, selectedSessionId, onClose, onCreated, toast, isAtSchedule, isLoopSchedule]);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div className="flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg">

        {/* ── Header ── */}
        <div className="flex shrink-0 items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 text-[var(--accent)]" />
            <h2 className="text-[15px] font-semibold text-[var(--ink)]">新建定时任务</h2>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">

          {/* ── 基本信息 ── */}
          <div>
            <SectionHeader icon={FileText}>基本信息</SectionHeader>
            <div className="mt-3 space-y-4">
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">
                  任务名称<span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span>
                </label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} maxLength={50}
                  placeholder="例如: 每日新闻摘要" className={INPUT_CLS} />
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">执行 Agent</label>
                <CustomSelect value={selectedProjectPath} options={projectOptions} onChange={setSelectedProjectPath} placeholder="选择工作区" />
                <p className="mt-1.5 text-[13px] text-[var(--ink-muted)]">使用该 Agent 的默认模型与权限配置</p>
              </div>
              <div>
                <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">AI 指令</label>
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5}
                  placeholder="描述你希望 AI 定时执行的任务..." className={`${INPUT_CLS} resize-none`} />
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--line)]" />

          {/* ── 执行模式 ── */}
          <div>
            <SectionHeader icon={MessageSquare}>执行模式</SectionHeader>
            <div className="mt-3">
              {isLoopSchedule ? (
                <p className="text-sm text-[var(--ink-muted)]">连续对话（保持上下文）— Ralph Loop 固定使用此模式</p>
              ) : (
              <div className="flex gap-2">
                <PillButton selected={runMode === 'new_session'} onClick={() => { setRunMode('new_session'); setSelectedSessionId(''); }}>新开对话</PillButton>
                <PillButton selected={runMode === 'single_session'} onClick={() => setRunMode('single_session')}>连续对话</PillButton>
              </div>
              )}
              {!isLoopSchedule && (
              <p className="mt-1.5 text-[13px] text-[var(--ink-muted)]">
                {runMode === 'new_session' ? '每次执行创建新对话，无记忆' : '所有执行共用同一对话，AI 能记住之前内容'}
              </p>
              )}
              {!isLoopSchedule && runMode === 'single_session' && (
                <div className="mt-3">
                  <label className="mb-1 block text-[13px] text-[var(--ink-muted)]">选择对话</label>
                  <CustomSelect value={selectedSessionId}
                    options={[{ value: '', label: '新对话' }, ...workspaceSessions.map(s => ({ value: s.id, label: s.title || s.lastMessagePreview?.slice(0, 30) || s.id.slice(0, 8) }))]}
                    onChange={setSelectedSessionId} placeholder="选择对话" compact />
                </div>
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

          {/* Divider */}
          <div className="border-t border-[var(--line)]" />

          {/* 结束条件 */}
          {!isAtSchedule && (
            <div>
              <SectionHeader icon={Flag}>结束条件</SectionHeader>
              <div className="mt-3 space-y-3">
                {/* Segmented control — equal width, matches 循环设置 */}
                {/* Segmented control — 永久运行 first (default) */}
                <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                  <button type="button" onClick={() => setEndConditionMode('forever')}
                    className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      endConditionMode === 'forever'
                        ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}>永久运行</button>
                  <button type="button" onClick={() => setEndConditionMode('conditional')}
                    className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      endConditionMode === 'conditional'
                        ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs'
                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                    }`}>条件停止</button>
                </div>

                {/* Condition options — only visible when "条件停止" */}
                {endConditionMode === 'conditional' && (
                  <>
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
                      <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                        onClick={() => setDeadline(deadline ? '' : toLocalDateTimeString(new Date(Date.now() + 86400000)))}>
                        <Checkbox checked={!!deadline} onChange={v => setDeadline(v ? toLocalDateTimeString(new Date(Date.now() + 86400000)) : '')} label="截止时间" />
                        <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)}
                          onClick={e => e.stopPropagation()}
                          className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!deadline ? 'opacity-50' : ''}`} />
                      </div>
                      <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5"
                        onClick={() => setMaxExecutions(maxExecutions ? '' : '10')}>
                        <Checkbox checked={!!maxExecutions} onChange={v => setMaxExecutions(v ? '10' : '')} label="执行次数" />
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                          <input type="number" min={1} max={999} value={maxExecutions || 10} onChange={e => setMaxExecutions(e.target.value)}
                            className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!maxExecutions ? 'opacity-50' : ''}`} />
                          <span className={`text-sm text-[var(--ink-secondary)] ${!maxExecutions ? 'opacity-50' : ''}`}>次</span>
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
                    <Checkbox checked={aiCanExit} onChange={setAiCanExit} label="允许 AI 自主结束任务" />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 任务通知 */}
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
        </div>

        {/* ── Footer ── */}
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-3.5">
          {errors.length > 0 ? <p className="text-xs text-[var(--error)]">{errors[0]}</p> : <div />}
          <div className="flex items-center gap-2.5">
            <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors">取消</button>
            <button onClick={handleCreate} disabled={errors.length > 0 || isCreating}
              className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-warm-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
              {isCreating ? '创建中...' : '创建并启动'}
            </button>
          </div>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
