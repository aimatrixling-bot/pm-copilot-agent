import { useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface ConfirmDialogProps {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    confirmLabel?: string; // Deprecated, use confirmText
    cancelLabel?: string;  // Deprecated, use cancelText
    confirmVariant?: 'danger' | 'primary';
    danger?: boolean; // Deprecated, use confirmVariant
    loading?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

export default function ConfirmDialog({
    title,
    message,
    confirmText,
    cancelText,
    confirmLabel,
    cancelLabel,
    confirmVariant,
    danger = false,
    loading = false,
    onConfirm,
    onCancel
}: ConfirmDialogProps) {
    // Cmd+W dismissal: z-[300] matches the component's CSS z-index
    useCloseLayer(() => { onCancel(); return true; }, 300);

    // Support both old and new props
    const finalConfirmText = confirmText || confirmLabel || '确认';
    const finalCancelText = cancelText || cancelLabel || '取消';
    const isDanger = confirmVariant === 'danger' || danger;

    // Keyboard: Enter to confirm, Escape to cancel
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (loading) return;
        if (e.key === 'Enter') {
            e.preventDefault();
            onConfirm();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
        }
    }, [loading, onConfirm, onCancel]);

    useEffect(() => {
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [handleKeyDown]);

    return (
        <OverlayBackdrop onClose={loading ? undefined : onCancel} className="z-[300] px-4">
            <div className="glass-panel w-full max-w-sm">
                <div className="border-b border-[var(--line)] px-5 py-4">
                    <div className="text-[14px] font-semibold text-[var(--ink)]">{title}</div>
                </div>
                <div className="px-5 py-4">
                    <p className="text-[13px] leading-relaxed text-[var(--ink-muted)]">{message}</p>
                </div>
                <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-3">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={loading}
                        className="rounded-full bg-[var(--button-secondary-bg)] px-4 py-1.5 text-[12px] font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-50"
                    >
                        {finalCancelText}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={loading}
                        className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold text-white transition-colors disabled:opacity-50 ${isDanger
                            ? 'bg-[var(--error)] hover:brightness-110'
                            : 'bg-[var(--button-primary-bg)] hover:bg-[var(--button-primary-bg-hover)]'
                            }`}
                    >
                        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
                        {finalConfirmText}
                    </button>
                </div>
            </div>
        </OverlayBackdrop>
    );
}

