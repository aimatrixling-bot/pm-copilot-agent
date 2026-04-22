/**
 * FeedbackPopover - Quick access popover for AI assistant and community QR code
 *
 * Drops down from the feedback button in the titlebar.
 * Two modules: "PM 助手" (opens BugReportOverlay) and "加入用户群" (shows QR code).
 */

import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Users, X } from 'lucide-react';
import { apiGetJson } from '@/api/apiFetch';
import { isTauriEnvironment } from '@/utils/browserMock';

interface FeedbackPopoverProps {
    onClose: () => void;
    onOpenBugReport: () => void;
    /** Ref to the trigger button — excluded from outside-click detection */
    triggerRef?: React.RefObject<HTMLElement | null>;
}

const QR_CDN_URL = 'https://download.pm-copilot.io/assets/feedback_qr_code.png';

export default function FeedbackPopover({ onClose, onOpenBugReport, triggerRef }: FeedbackPopoverProps) {
    const popoverRef = useRef<HTMLDivElement>(null);
    const isTauri = isTauriEnvironment();
    const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(isTauri ? null : QR_CDN_URL);
    const [qrLoading, setQrLoading] = useState(isTauri);

    // Load QR code from Sidecar in Tauri mode
    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;

        apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
            .then(result => {
                if (cancelled) return;
                if (result.success && result.dataUrl) {
                    setQrCodeUrl(result.dataUrl);
                }
            })
            .catch(() => { /* silent fail */ })
            .finally(() => { if (!cancelled) setQrLoading(false); });

        return () => { cancelled = true; };
    }, [isTauri]);

    // Click outside to close
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            const target = e.target as Node;
            if (popoverRef.current && !popoverRef.current.contains(target)
                && !(triggerRef?.current && triggerRef.current.contains(target))) {
                onClose();
            }
        };
        // Defer listener to avoid the opening click triggering immediate close
        const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClick);
        };
    }, [onClose, triggerRef]);

    // Escape to close
    useEffect(() => {
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [onClose]);

    return (
        <div
            ref={popoverRef}
            className="absolute right-0 top-full mt-1.5 z-[200] w-72 origin-top-right animate-[popoverIn_200ms_ease-out]
                rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    帮助与反馈
                </span>
                <button
                    onClick={onClose}
                    className="rounded-md p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* PM 助手 */}
            <div className="px-3 pb-2">
                <button
                    onClick={() => {
                        onClose();
                        onOpenBugReport();
                    }}
                    className="group w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5
                        text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                >
                    <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] transition-colors group-hover:bg-[var(--accent-warm-muted)]">
                            <Bot className="h-4 w-4 text-[var(--accent-warm)]" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium text-[var(--ink)]">PM 助手</p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-muted)]">
                                排查问题、提交反馈或功能建议
                            </p>
                        </div>
                    </div>
                </button>
            </div>

            {/* 加入用户群 */}
            {(qrLoading || qrCodeUrl) && (
                <div className="px-3 pb-3.5">
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5">
                        <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)]">
                                <Users className="h-4 w-4 text-[var(--accent-warm)]" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-[13px] font-medium text-[var(--ink)]">加入用户交流群</p>
                                <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--ink-muted)]">
                                    扫码加入，交流使用心得
                                </p>
                            </div>
                        </div>
                        <div className="mt-3 flex justify-center">
                            {qrLoading ? (
                                <div className="flex h-32 w-32 items-center justify-center">
                                    <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                </div>
                            ) : (
                                <img
                                    src={qrCodeUrl!}
                                    alt="用户交流群二维码"
                                    className="h-32 w-32 rounded-lg"
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
