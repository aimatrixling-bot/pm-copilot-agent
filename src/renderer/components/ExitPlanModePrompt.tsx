import { FileCheck, X, Check, Terminal, CheckCircle, XCircle } from 'lucide-react';
import Markdown from '@/components/Markdown';

import type { ExitPlanModeRequest } from '../../shared/types/planMode';

interface ExitPlanModePromptProps {
    request: ExitPlanModeRequest;
    onApprove: () => void;
    onReject: () => void;
}

/**
 * ExitPlanMode prompt - AI submits a plan for user review
 */
export function ExitPlanModePrompt({ request, onApprove, onReject }: ExitPlanModePromptProps) {
    const isResolved = !!request.resolved;
    const isApproved = request.resolved === 'approved';

    return (
        <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className={`rounded-xl border p-4 shadow-sm ${
                isResolved && !isApproved
                    ? 'border-[var(--line)] bg-[var(--paper-inset)]/80'
                    : 'border-[var(--success)]/30 bg-[var(--success-bg)]/80'
            }`}>
                {/* Header */}
                <div className={`${isResolved ? '' : 'mb-3'} flex items-center gap-2`}>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                        isResolved && !isApproved
                            ? 'bg-[var(--paper-inset)]'
                            : 'bg-[var(--success-bg)]'
                    }`}>
                        <FileCheck className={`h-4.5 w-4.5 ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-muted)]'
                                : 'text-[var(--success)]'
                        }`} />
                    </div>
                    <div className="flex-1">
                        <h3 className={`text-sm font-semibold ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink)]'
                                : 'text-[var(--success)]'
                        }`}>方案审核</h3>
                        <p className={`text-xs ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-muted)]'
                                : 'text-[var(--success)]'
                        }`}>AI 完成了方案设计，请审核后决定是否执行</p>
                    </div>
                    {/* Resolved badge in header */}
                    {isResolved && (
                        <div className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                            isApproved
                                ? 'bg-[var(--success-bg)] text-[var(--success)]'
                                : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'
                        }`}>
                            {isApproved
                                ? <><CheckCircle className="h-3.5 w-3.5" />已批准</>
                                : <><XCircle className="h-3.5 w-3.5" />已拒绝</>
                            }
                        </div>
                    )}
                </div>

                {/* Plan content — always visible */}
                {request.plan && (
                    <div className={`mt-3 max-h-[26rem] overflow-y-auto rounded-lg border p-3 text-sm ${
                        isResolved && !isApproved
                            ? 'border-[var(--line)] bg-[var(--paper-inset)]/60'
                            : 'border-[var(--success)]/30 bg-[var(--paper-elevated)]/80'
                    }`}>
                        <Markdown>{request.plan}</Markdown>
                    </div>
                )}

                {/* Allowed prompts — always visible */}
                {request.allowedPrompts && request.allowedPrompts.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                        <p className={`text-xs font-medium ${
                            isResolved && !isApproved
                                ? 'text-[var(--ink-muted)]'
                                : 'text-[var(--success)]'
                        }`}>需要的权限：</p>
                        {request.allowedPrompts.map((ap, i) => (
                            <div key={i} className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${
                                isResolved && !isApproved
                                    ? 'bg-[var(--paper-inset)]/60 text-[var(--ink-muted)]'
                                    : 'bg-[var(--success-bg)]/60 text-[var(--success)]'
                            }`}>
                                <Terminal className="h-3.5 w-3.5 shrink-0" />
                                <span>{ap.prompt}</span>
                            </div>
                        ))}
                    </div>
                )}

                {/* Actions - only show when not resolved */}
                {!isResolved && (
                    <div className="mt-3 flex justify-end gap-2">
                        <button
                            onClick={onReject}
                            className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1.5 text-xs font-medium text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                        >
                            <X className="h-3.5 w-3.5" />
                            拒绝
                        </button>
                        <button
                            onClick={onApprove}
                            className="flex items-center gap-1.5 rounded-lg bg-[var(--success)] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:brightness-110"
                        >
                            <Check className="h-3.5 w-3.5" />
                            批准执行
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
