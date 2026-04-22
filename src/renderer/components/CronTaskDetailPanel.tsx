/**
 * CronTaskDetailPanel — Detail + Edit view for a scheduled task.
 * Design language aligned with CronTaskSettingsModal and Agent Settings panels.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart2, Bell, Check, Clock, FileText, Flag, FolderOpen, History, MessageSquare, Pencil, Play, Square, Trash2, X } from 'lucide-react';

import type { CronTask, CronSchedule, CronEndConditions } from '@/types/cronTask';
import {
    getCronStatusText,
    getCronStatusColor,
    formatScheduleDescription,
    formatNextExecution,
    checkCanResume,
    MIN_CRON_INTERVAL,
} from '@/types/cronTask';
import { getFolderName } from '@/utils/taskCenterUtils';
import WorkspaceIcon from './launcher/WorkspaceIcon';
import { useToast } from './Toast';
import { useConfig } from '@/hooks/useConfig';
import ConfirmDialog from './ConfirmDialog';
import CustomSelect from './CustomSelect';
import TaskRunHistory from './scheduled-tasks/TaskRunHistory';
import ScheduleTypeTabs from './scheduled-tasks/ScheduleTypeTabs';
import * as cronClient from '@/api/cronTaskClient';
import { useDeliveryChannels } from '@/hooks/useDeliveryChannels';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface CronTaskDetailPanelProps {
    task: CronTask;
    botInfo?: { name: string; platform: string };
    onClose: () => void;
    onDelete: (taskId: string) => Promise<void>;
    onResume: (taskId: string) => Promise<void>;
    onStop?: (taskId: string) => Promise<void>;
    /** Open a session in a new tab (for execution history click) */
    onOpenSession?: (sessionId: string) => void;
}

const INPUT_CLS = 'w-full rounded-lg border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--accent)] focus:outline-none transition-colors';

function SectionHeader({ icon: Icon, children }: { icon?: typeof Clock; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2">
            {Icon && <Icon className="h-4 w-4 text-[var(--ink-muted)]" />}
            <h4 className="text-[14px] font-semibold text-[var(--ink)]">{children}</h4>
        </div>
    );
}

function DetailTag({ label }: { label: string }) {
    return <span className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-[12px] text-[var(--ink-muted)]">{label}</span>;
}

function ToggleSwitch({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
    return (
        <button type="button" role="switch" aria-checked={enabled} onClick={() => onChange(!enabled)}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}>
            <span className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
    );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2.5 text-[13px] text-[var(--ink)]">
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${checked ? 'border-[var(--accent)] bg-[var(--accent)] text-white' : 'border-[var(--line-strong)] bg-transparent'}`}>
                {checked && <Check className="h-2.5 w-2.5" />}
            </span>
            {label}
        </button>
    );
}

export default function CronTaskDetailPanel({ task, botInfo, onClose, onDelete, onResume, onStop, onOpenSession }: CronTaskDetailPanelProps) {
    useCloseLayer(() => { onClose(); return true; }, 50);

    const toast = useToast();
    const { projects } = useConfig();
    const isMountedRef = useRef(true);
    useEffect(() => () => { isMountedRef.current = false; }, []);
    const project = useMemo(() => projects.find(p => p.path === task.workspacePath), [projects, task.workspacePath]);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showStopConfirm, setShowStopConfirm] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isResuming, setIsResuming] = useState(false);
    const [isStopping, setIsStopping] = useState(false);

    // Edit mode
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [editName, setEditName] = useState(task.name || '');
    const [editPrompt, setEditPrompt] = useState(task.prompt);
    const [editSchedule, setEditSchedule] = useState<CronSchedule | null>(task.schedule ?? null);
    const [editInterval, setEditInterval] = useState(task.intervalMinutes);
    const [editEndMode, setEditEndMode] = useState<'conditional' | 'forever'>(
        (task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever'
    );
    const [editDeadline, setEditDeadline] = useState(task.endConditions.deadline || '');
    const [editMaxExec, setEditMaxExec] = useState(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
    const [editAiCanExit, setEditAiCanExit] = useState(task.endConditions.aiCanExit);
    const [editNotify, setEditNotify] = useState(task.notifyEnabled);
    const [editDeliveryBotId, setEditDeliveryBotId] = useState(task.delivery?.botId ?? '');
    const { options: deliveryOptions, hasChannels, resolveDelivery, getChannelInfo } = useDeliveryChannels(task.workspacePath);
    const isAtSchedule = editSchedule?.kind === 'at';

    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (isEditing) setIsEditing(false); else onClose(); } };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose, isEditing]);

    const startEditing = useCallback(() => {
        setEditName(task.name || ''); setEditPrompt(task.prompt);
        setEditSchedule(task.schedule ?? null); setEditInterval(task.intervalMinutes);
        setEditEndMode((task.endConditions.deadline || task.endConditions.maxExecutions) ? 'conditional' : 'forever');
        setEditDeadline(task.endConditions.deadline || '');
        setEditMaxExec(task.endConditions.maxExecutions ? String(task.endConditions.maxExecutions) : '');
        setEditAiCanExit(task.endConditions.aiCanExit); setEditNotify(task.notifyEnabled);
        setEditDeliveryBotId(task.delivery?.botId ?? '');
        setIsEditing(true);
    }, [task]);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const endConditions: CronEndConditions = isAtSchedule ? { aiCanExit: false }
                : editEndMode === 'forever' ? { aiCanExit: editAiCanExit }
                : { deadline: editDeadline ? new Date(editDeadline).toISOString() : undefined, maxExecutions: editMaxExec ? parseInt(editMaxExec, 10) : undefined, aiCanExit: editAiCanExit };
            // Delivery update logic: set if resolved, clear if user chose default, preserve if unchanged
            const deliveryFields: { delivery?: import('@/types/cronTask').CronDelivery; clearDelivery?: boolean } = {};
            if (editDeliveryBotId) {
                const resolved = resolveDelivery(editDeliveryBotId);
                if (resolved) {
                    deliveryFields.delivery = resolved;
                }
                // If channel was removed and can't resolve, don't touch delivery (preserve existing)
            } else {
                // User explicitly selected "桌面通知" (empty value) — clear delivery
                deliveryFields.clearDelivery = true;
            }
            await cronClient.updateCronTaskFields(task.id, {
                name: editName.trim() || undefined, prompt: editPrompt.trim(),
                schedule: editSchedule ?? undefined, intervalMinutes: editSchedule?.kind === 'every' ? editSchedule.minutes : editInterval,
                endConditions, notifyEnabled: editNotify,
                ...deliveryFields,
            });
            if (!isMountedRef.current) return;
            toast.success('任务已更新'); onClose(); // Close to refresh — cron:task-updated event triggers parent list reload
        } catch (err) { if (!isMountedRef.current) return; toast.error(`更新失败: ${err instanceof Error ? err.message : String(err)}`); }
        finally { if (isMountedRef.current) setIsSaving(false); }
    }, [task.id, editName, editPrompt, editSchedule, editInterval, editEndMode, editDeadline, editMaxExec, editAiCanExit, editNotify, editDeliveryBotId, resolveDelivery, isAtSchedule, toast, onClose]);

    const handleDelete = useCallback(async () => {
        setIsDeleting(true); try { await onDelete(task.id); onClose(); } catch { /* caller handles */ } finally { if (isMountedRef.current) { setIsDeleting(false); setShowDeleteConfirm(false); } }
    }, [task.id, onDelete, onClose]);
    const handleResume = useCallback(async () => { setIsResuming(true); try { await onResume(task.id); } finally { if (isMountedRef.current) setIsResuming(false); } }, [task.id, onResume]);
    const handleStop = useCallback(async () => { if (!onStop) return; setIsStopping(true); try { await onStop(task.id); } catch { /* caller handles */ } finally { if (isMountedRef.current) { setIsStopping(false); setShowStopConfirm(false); } } }, [task.id, onStop]);

    const resumeCheck = checkCanResume(task);
    const displayName = task.name || task.prompt.slice(0, 40) + (task.prompt.length > 40 ? '...' : '');
    const scheduleDesc = formatScheduleDescription(task);
    const nextExec = formatNextExecution(task.nextExecutionAt, task.status);
    const runModeLabel = task.runMode === 'single_session' ? '连续对话（保持上下文）' : '新开对话（无记忆）';

    const editErrors = useMemo(() => {
        if (!isEditing) return [];
        const errs: string[] = [];
        if (!editPrompt.trim()) errs.push('请输入 AI 指令');
        if (!editSchedule && editInterval < MIN_CRON_INTERVAL) errs.push(`间隔不能小于 ${MIN_CRON_INTERVAL} 分钟`);
        return errs;
    }, [isEditing, editPrompt, editSchedule, editInterval]);

    return (
        <>
            {showDeleteConfirm && <ConfirmDialog title="删除定时任务" message={`确定要删除「${displayName}」吗？此操作不可撤销。`} confirmText="删除" cancelText="取消" confirmVariant="danger" loading={isDeleting} onConfirm={handleDelete} onCancel={() => setShowDeleteConfirm(false)} />}
            {showStopConfirm && <ConfirmDialog title="停止定时任务" message={`确定要停止「${displayName}」吗？停止后可以重新恢复。`} confirmText="停止" cancelText="取消" confirmVariant="danger" loading={isStopping} onConfirm={handleStop} onCancel={() => setShowStopConfirm(false)} />}

            <OverlayBackdrop onClose={onClose} className="z-50" style={{ animation: 'overlayFadeIn 200ms ease-out' }}>
                <div className="flex h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg"
                    style={{ animation: 'overlayPanelIn 250ms ease-out' }}>

                    {/* Header */}
                    <div className="flex shrink-0 items-center justify-between px-6 py-4">
                        <div className="flex min-w-0 items-center gap-2.5">
                            <Clock className="h-4 w-4 shrink-0 text-[var(--accent)]" />
                            <h3 className="min-w-0 truncate text-[15px] font-semibold text-[var(--ink)]">
                                {isEditing ? '编辑定时任务' : displayName}
                            </h3>
                            {!isEditing && <span className={`shrink-0 text-[12px] font-medium ${getCronStatusColor(task.status)}`}>{getCronStatusText(task.status)}</span>}
                        </div>
                        <button onClick={() => isEditing ? setIsEditing(false) : onClose()} className="ml-2 shrink-0 rounded-lg p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] transition-colors">
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                        {isEditing ? (
                            /* ====== EDIT MODE ====== */
                            <>
                                <div>
                                    <SectionHeader icon={FileText}>基本信息</SectionHeader>
                                    <div className="mt-3 space-y-4">
                                        <div>
                                            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">任务名称<span className="ml-1 font-normal text-[var(--ink-muted)]">（可选）</span></label>
                                            <input type="text" value={editName} onChange={e => setEditName(e.target.value)} maxLength={50} placeholder="例如: 每日新闻摘要" className={INPUT_CLS} />
                                        </div>
                                        <div>
                                            <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">AI 指令</label>
                                            <textarea value={editPrompt} onChange={e => setEditPrompt(e.target.value)} rows={5} placeholder="描述你希望 AI 定时执行的任务..." className={`${INPUT_CLS} resize-none`} />
                                        </div>
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                <div>
                                    <SectionHeader icon={Clock}>执行计划</SectionHeader>
                                    <div className="mt-3"><ScheduleTypeTabs value={editSchedule} intervalMinutes={editInterval} onChange={(s, m) => { setEditSchedule(s); setEditInterval(m); }} /></div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {!isAtSchedule && (
                                    <div>
                                        <SectionHeader icon={Flag}>结束条件</SectionHeader>
                                        <div className="mt-3 space-y-3">
                                            <div className="flex gap-1.5 rounded-[var(--radius-md)] bg-[var(--paper-inset)] p-1">
                                                <button type="button" onClick={() => setEditEndMode('forever')} className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${editEndMode === 'forever' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>永久运行</button>
                                                <button type="button" onClick={() => setEditEndMode('conditional')} className={`flex flex-1 items-center justify-center rounded-[var(--radius-sm)] px-3 py-1.5 text-[13px] font-medium transition-colors ${editEndMode === 'conditional' ? 'bg-[var(--paper-elevated)] text-[var(--ink)] shadow-xs' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}>条件停止</button>
                                            </div>
                                            {editEndMode === 'conditional' && (
                                            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)]">
                                                <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5" onClick={() => setEditDeadline(editDeadline ? '' : new Date(Date.now() + 86400000).toISOString().slice(0, 16))}>
                                                    <Checkbox checked={!!editDeadline} onChange={v => setEditDeadline(v ? new Date(Date.now() + 86400000).toISOString().slice(0, 16) : '')} label="截止时间" />
                                                    <input type="datetime-local" value={editDeadline.slice(0, 16)} onChange={e => setEditDeadline(e.target.value)} onClick={e => e.stopPropagation()}
                                                        className={`w-44 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!editDeadline ? 'opacity-50' : ''}`} />
                                                </div>
                                                <div className="flex cursor-pointer items-center justify-between border-b border-[var(--line)] px-3 py-2.5" onClick={() => setEditMaxExec(editMaxExec ? '' : '10')}>
                                                    <Checkbox checked={!!editMaxExec} onChange={v => setEditMaxExec(v ? '10' : '')} label="执行次数" />
                                                    <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                                                        <input type="number" min={1} max={999} value={editMaxExec || 10} onChange={e => setEditMaxExec(e.target.value)}
                                                            className={`w-16 rounded-md border border-[var(--line)] bg-[var(--paper)] px-2 py-1 text-center text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none ${!editMaxExec ? 'opacity-50' : ''}`} />
                                                        <span className={`text-sm text-[var(--ink-secondary)] ${!editMaxExec ? 'opacity-50' : ''}`}>次</span>
                                                    </div>
                                                </div>
                                            </div>
                                            )}

                                            {/* AI 自主结束 — 在永久运行和条件停止模式下都显示 */}
                                            <div className="flex cursor-pointer items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5" onClick={() => setEditAiCanExit(!editAiCanExit)}>
                                                <Checkbox checked={editAiCanExit} onChange={setEditAiCanExit} label="允许 AI 自主结束任务" />
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* 任务通知 */}
                                <div>
                                    <SectionHeader icon={Bell}>任务通知</SectionHeader>
                                    <div className="mt-2 space-y-3">
                                        <div className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3">
                                            <span className="text-sm text-[var(--ink)]">每次执行完即发送通知</span>
                                            <ToggleSwitch enabled={editNotify} onChange={setEditNotify} />
                                        </div>
                                        {editNotify && hasChannels && (
                                            <div className="space-y-2">
                                                <label className="text-sm font-medium text-[var(--ink)]">投递渠道</label>
                                                <CustomSelect value={editDeliveryBotId} options={deliveryOptions} onChange={setEditDeliveryBotId} placeholder="桌面通知（默认）" />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            /* ====== DETAIL MODE ====== */
                            <>
                                {/* 基本信息 — compact left-right rows */}
                                <div>
                                    <SectionHeader icon={FolderOpen}>基本信息</SectionHeader>
                                    <div className="mt-2 space-y-1.5">
                                        <div className="flex items-center justify-between py-1">
                                            <span className="text-[13px] text-[var(--ink-muted)]">任务名称</span>
                                            <span className="text-[13px] text-[var(--ink)]">{displayName}</span>
                                        </div>
                                        <div className="flex items-center justify-between py-1">
                                            <span className="text-[13px] text-[var(--ink-muted)]">执行 Agent</span>
                                            <div className="flex items-center gap-1.5">
                                                <WorkspaceIcon icon={project?.icon} size={14} />
                                                <span className="text-[13px] text-[var(--ink)]">{getFolderName(task.workspacePath)}</span>
                                            </div>
                                        </div>
                                        {botInfo && (
                                            <div className="flex items-center justify-between py-1">
                                                <span className="text-[13px] text-[var(--ink-muted)]">来源</span>
                                                <span className="text-[13px] text-[var(--ink)]">{botInfo.name} ({botInfo.platform})</span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* AI 指令 */}
                                {task.prompt && (
                                    <>
                                        <div>
                                            <SectionHeader icon={FileText}>AI 指令</SectionHeader>
                                            <div className="mt-2 rounded-lg border border-[var(--line)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--ink-secondary)] whitespace-pre-wrap break-words">{task.prompt}</div>
                                        </div>
                                        <div className="border-t border-[var(--line)]" />
                                    </>
                                )}

                                {/* 执行模式 */}
                                <div>
                                    <SectionHeader icon={MessageSquare}>执行模式</SectionHeader>
                                    <p className="mt-2 text-sm text-[var(--ink)]">{runModeLabel}</p>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 执行计划 */}
                                <div>
                                    <SectionHeader icon={Clock}>执行计划</SectionHeader>
                                    <div className="mt-2 flex items-center justify-between rounded-lg border border-[var(--line)] px-3.5 py-3">
                                        <span className="text-sm font-medium text-[var(--ink)]">{scheduleDesc}</span>
                                        <span className={`text-[12px] ${task.status === 'running' ? 'text-[var(--ink-secondary)]' : 'text-[var(--ink-muted)]/50'}`}>
                                            {task.status === 'running' ? `下次: ${nextExec}` : '已停止'}
                                        </span>
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 结束条件 */}
                                <div>
                                    <SectionHeader icon={Flag}>结束条件</SectionHeader>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <DetailTag label={task.endConditions.deadline ? `截止 ${new Date(task.endConditions.deadline).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '无截止'} />
                                        <DetailTag label={task.endConditions.maxExecutions ? `最多 ${task.endConditions.maxExecutions} 次` : '无限次'} />
                                        <DetailTag label={task.endConditions.aiCanExit ? 'AI 可退出' : 'AI 不可退出'} />
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 任务通知 */}
                                <div>
                                    <SectionHeader icon={Bell}>任务通知</SectionHeader>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <DetailTag label={task.notifyEnabled ? '通知开启' : '通知关闭'} />
                                        {(() => {
                                            if (!task.delivery) return <DetailTag label="桌面通知" />;
                                            const info = getChannelInfo(task.delivery.botId);
                                            if (!info) return <DetailTag label={`${task.delivery.botId} · 已移除`} />;
                                            return <DetailTag label={`${info.agentName}: ${info.name}`} />;
                                        })()}
                                    </div>
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 运行统计 */}
                                <div>
                                    <SectionHeader icon={BarChart2}>运行统计</SectionHeader>
                                    <div className="mt-2 grid grid-cols-3 gap-3">
                                        <div>
                                            <span className="text-[12px] text-[var(--ink-muted)]">执行次数</span>
                                            <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.endConditions.maxExecutions ? `${task.executionCount} / ${task.endConditions.maxExecutions}` : `${task.executionCount} 次`}</p>
                                        </div>
                                        <div>
                                            <span className="text-[12px] text-[var(--ink-muted)]">上次执行</span>
                                            <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.lastExecutedAt ? new Date(task.lastExecutedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</p>
                                        </div>
                                        {task.exitReason && (
                                            <div>
                                                <span className="text-[12px] text-[var(--ink-muted)]">退出原因</span>
                                                <p className="mt-0.5 text-sm font-medium text-[var(--ink)]">{task.exitReason}</p>
                                            </div>
                                        )}
                                    </div>
                                    {task.lastError && <p className="mt-2 text-[12px] text-[var(--error)]">{task.lastError}</p>}
                                </div>

                                <div className="border-t border-[var(--line)]" />

                                {/* 执行历史 */}
                                <div>
                                    <SectionHeader icon={History}>执行历史</SectionHeader>
                                    <div className="mt-2"><TaskRunHistory taskId={task.id} sessionId={task.internalSessionId || task.sessionId} onOpenSession={onOpenSession ? (sid) => { onOpenSession(sid); onClose(); } : undefined} /></div>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex shrink-0 items-center justify-between border-t border-[var(--line)] px-6 py-3.5">
                        {isEditing ? (
                            <>
                                {editErrors.length > 0 ? <p className="text-xs text-[var(--error)]">{editErrors[0]}</p> : <div />}
                                <div className="flex items-center gap-2.5">
                                    <button onClick={() => setIsEditing(false)} className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors">取消</button>
                                    <button onClick={handleSave} disabled={editErrors.length > 0 || isSaving}
                                        className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent-warm-hover)] disabled:opacity-50 disabled:cursor-not-allowed">
                                        {isSaving ? '保存中...' : '保存'}
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <button onClick={() => setShowDeleteConfirm(true)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium text-[var(--error)] hover:bg-[var(--error-bg)] transition-colors">
                                    <Trash2 className="h-3.5 w-3.5" />删除
                                </button>
                                <div className="flex items-center gap-2.5">
                                    <button onClick={startEditing} className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-4 py-2 text-[13px] font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:text-[var(--ink)] transition-colors">
                                        <Pencil className="h-3.5 w-3.5" />编辑
                                    </button>
                                    {task.status === 'running' && onStop && (
                                        <button onClick={() => setShowStopConfirm(true)} disabled={isStopping}
                                            className="flex items-center gap-1.5 rounded-lg border border-[var(--error)]/30 px-4 py-2 text-[13px] font-medium text-[var(--error)] hover:bg-[var(--error-bg)] disabled:opacity-50 transition-colors">
                                            <Square className="h-3.5 w-3.5" />{isStopping ? '停止中...' : '停止'}
                                        </button>
                                    )}
                                    {task.status === 'stopped' && (resumeCheck.canResume ? (
                                        <button onClick={handleResume} disabled={isResuming}
                                            className="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-5 py-2 text-[13px] font-medium text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50 transition-colors">
                                            <Play className="h-3.5 w-3.5" />{isResuming ? '恢复中...' : '恢复'}
                                        </button>
                                    ) : <span className="text-[12px] text-[var(--ink-muted)]/50">{resumeCheck.reason}</span>)}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </OverlayBackdrop>
        </>
    );
}
