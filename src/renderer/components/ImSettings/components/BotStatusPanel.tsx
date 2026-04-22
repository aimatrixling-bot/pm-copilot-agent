import React from 'react';
import type { ImBotStatus } from '../../../../shared/types/im';

export default function BotStatusPanel({ status }: { status: ImBotStatus | null }) {
    if (!status) return null;

    const dotColor = {
        online: 'bg-[var(--success)]',
        connecting: 'bg-[var(--warning)]',
        error: 'bg-[var(--error)]',
        stopped: 'bg-[var(--ink-subtle)]',
    }[status.status];

    const labelColor = {
        online: 'text-[var(--success)]',
        connecting: 'text-[var(--warning)]',
        error: 'text-[var(--error)]',
        stopped: 'text-[var(--ink-muted)]',
    }[status.status];

    const statusLabel = {
        online: '运行中',
        connecting: '连接中',
        error: '错误',
        stopped: '已停止',
    }[status.status];

    const formatUptime = (seconds: number): string => {
        if (seconds < 60) return `${seconds}s`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${h}h ${m}m`;
    };

    const isActive = status.status === 'online' || status.status === 'connecting';

    return (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] px-4 py-3 text-xs">
            {/* Status dot + label */}
            <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotColor}`} />
            <span className={`font-medium ${labelColor}`}>{statusLabel}</span>

            {isActive && (
                <>
                    <span className="text-[var(--line-strong)]">·</span>
                    <span className="text-[var(--ink-muted)]">{formatUptime(status.uptimeSeconds)}</span>
                    <span className="text-[var(--line-strong)]">·</span>
                    <span className="text-[var(--ink-muted)]">{status.activeSessions.length} 个会话</span>
                    {status.restartCount > 0 && (
                        <>
                            <span className="text-[var(--line-strong)]">·</span>
                            <span className="text-[var(--ink-muted)]">重启 {status.restartCount} 次</span>
                        </>
                    )}
                </>
            )}

            {status.errorMessage && (
                <>
                    <span className="text-[var(--line-strong)]">·</span>
                    <span className="truncate text-[var(--error)]">{status.errorMessage}</span>
                </>
            )}
        </div>
    );
}
