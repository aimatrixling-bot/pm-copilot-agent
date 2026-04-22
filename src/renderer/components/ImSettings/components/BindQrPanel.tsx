import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2, QrCode } from 'lucide-react';
import QRCode from 'qrcode';

export default function BindQrPanel({
    bindUrl,
    hasWhitelistUsers,
}: {
    bindUrl: string;
    hasWhitelistUsers: boolean;
}) {
    const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

    useEffect(() => {
        let cancelled = false;
        QRCode.toDataURL(bindUrl, {
            width: 200,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' },
        }).then((url) => {
            if (!cancelled) setQrDataUrl(url);
        }).catch(() => {
            // QR generation failed — fallback to link only
        });
        return () => { cancelled = true; };
    }, [bindUrl]);

    useEffect(() => {
        return () => { if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current); };
    }, []);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(bindUrl);
            setCopied(true);
            if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
            copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard not available
        }
    }, [bindUrl]);

    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <div className="flex items-center gap-2 mb-3">
                <QrCode className="h-4 w-4 text-[var(--ink-muted)]" />
                <h3 className="text-sm font-semibold text-[var(--ink)]">快速绑定</h3>
                {!hasWhitelistUsers && (
                    <span className="rounded-full bg-[var(--info-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--info)]">
                        推荐
                    </span>
                )}
            </div>

            <p className="mb-4 text-xs text-[var(--ink-muted)]">
                手机相机 或 Telegram 扫描二维码，即可自动绑定你的账号到白名单。无需手动查找 User ID。
            </p>

            <div className="flex items-start gap-5">
                {/* QR Code */}
                <div className="flex-shrink-0 rounded-lg border border-[var(--line)] bg-white p-2">
                    {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Telegram bind QR" className="h-[160px] w-[160px]" />
                    ) : (
                        <div className="flex h-[160px] w-[160px] items-center justify-center">
                            <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                        </div>
                    )}
                </div>

                {/* Instructions */}
                <div className="flex-1 space-y-3">
                    <div className="space-y-2 text-xs text-[var(--ink-muted)]">
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">1</span>
                            <span>手机相机 或 Telegram 扫描二维码</span>
                        </div>
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">2</span>
                            <span>点击「Start」发送绑定指令</span>
                        </div>
                        <div className="flex items-start gap-2">
                            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-[var(--button-primary-bg)] text-[10px] font-bold text-[var(--button-primary-text)]">3</span>
                            <span>绑定成功后即可开始对话</span>
                        </div>
                    </div>

                    {/* Deep link for desktop Telegram users */}
                    <div className="pt-1">
                        <p className="mb-1 text-[10px] text-[var(--ink-muted)]">或在桌面版 Telegram 中直接打开：</p>
                        <div className="flex items-center gap-1.5 overflow-hidden">
                            <code className="min-w-0 flex-1 truncate rounded bg-[var(--paper-inset)] px-2 py-1 text-[11px] text-[var(--ink)]">
                                {bindUrl}
                            </code>
                            <button
                                onClick={handleCopy}
                                className="flex-shrink-0 rounded p-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                                title="复制链接"
                            >
                                {copied ? <Check className="h-3.5 w-3.5 text-[var(--success)]" /> : <Copy className="h-3.5 w-3.5" />}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
