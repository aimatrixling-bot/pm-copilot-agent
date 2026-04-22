import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageSquare } from 'lucide-react';

export default function BindCodePanel({
    bindCode,
    hasWhitelistUsers,
    platformName = '飞书',
}: {
    bindCode: string;
    hasWhitelistUsers: boolean;
    platformName?: string;
}) {
    const [copied, setCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        return () => { if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current); };
    }, []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(bindCode);
            setCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, [bindCode]);

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <div className="flex items-center gap-2 mb-3">
                <MessageSquare className="h-4 w-4 text-[var(--ink-muted)]" />
                <h3 className="text-sm font-semibold text-[var(--ink)]">口令绑定</h3>
                {!hasWhitelistUsers && (
                    <span className="rounded-full bg-[var(--info-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--info)]">
                        推荐
                    </span>
                )}
            </div>

            <p className="mb-4 text-xs text-[var(--ink-muted)]">
                在{platformName}中私聊 Bot 发送以下口令，即可自动绑定你的账号到白名单。
            </p>

            {/* Bind code display */}
            <div className="flex items-center gap-3">
                <code className="flex-1 rounded-lg bg-[var(--paper-inset)] px-4 py-3 text-center text-lg font-mono font-bold text-[var(--ink)] tracking-wider">
                    {bindCode}
                </code>
                <button
                    onClick={handleCopy}
                    className="flex-shrink-0 rounded-lg border border-[var(--line)] p-2.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title="复制口令"
                >
                    {copied ? <Check className="h-4 w-4 text-[var(--success)]" /> : <Copy className="h-4 w-4" />}
                </button>
            </div>

            {/* Instructions */}
            <div className="mt-4 space-y-2 text-xs text-[var(--ink-muted)]">
                <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">1</span>
                    <span>在{platformName}中找到并打开 Bot 的私聊</span>
                </div>
                <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">2</span>
                    <span>发送上方口令（点击复制按钮）</span>
                </div>
                <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">3</span>
                    <span>绑定成功后即可开始对话</span>
                </div>
            </div>
        </div>
    );
}
