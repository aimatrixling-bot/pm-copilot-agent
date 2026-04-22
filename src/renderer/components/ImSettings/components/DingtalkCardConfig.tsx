import React, { useCallback, useEffect, useRef, useState } from 'react';

export default function DingtalkCardConfig({
    useAiCard,
    cardTemplateId,
    onUseAiCardChange,
    onCardTemplateIdChange,
}: {
    useAiCard: boolean;
    cardTemplateId: string;
    onUseAiCardChange: (value: boolean) => void;
    onCardTemplateIdChange: (value: string) => void;
}) {
    const [localTemplateId, setLocalTemplateId] = useState(cardTemplateId);
    const debounceRef = useRef<NodeJS.Timeout>(undefined);

    useEffect(() => { setLocalTemplateId(cardTemplateId); }, [cardTemplateId]);

    useEffect(() => {
        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, []);

    const handleTemplateIdChange = useCallback((value: string) => {
        setLocalTemplateId(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => onCardTemplateIdChange(value), 500);
    }, [onCardTemplateIdChange]);

    return (
        <div className="space-y-4">
            {/* AI Card toggle */}
            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm font-medium text-[var(--ink)]">AI Card 流式回复</p>
                    <p className="text-xs text-[var(--ink-muted)]">
                        使用钉钉 AI 卡片实现流式更新效果，需额外配置卡片模板
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onUseAiCardChange(!useAiCard)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        useAiCard ? 'bg-[var(--accent)]' : 'bg-[var(--ink-faint)]'
                    }`}
                >
                    <span
                        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-[var(--toggle-thumb)] shadow ring-0 transition duration-200 ease-in-out ${
                            useAiCard ? 'translate-x-4' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>

            {/* Card Template ID (only when AI Card enabled) */}
            {useAiCard && (
                <div>
                    <label className="mb-1.5 block text-xs font-medium text-[var(--ink-muted)]">
                        卡片模板 ID
                    </label>
                    <input
                        type="text"
                        value={localTemplateId}
                        onChange={(e) => handleTemplateIdChange(e.target.value)}
                        placeholder="请填入卡片模板 ID"
                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder-[var(--ink-subtle)] outline-none transition-colors focus:border-[var(--button-primary-bg)]"
                    />
                    <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
                        需在钉钉开放平台创建 AI 卡片模板后填入模板 ID。未填写时将自动降级为普通 Markdown 消息。
                    </p>
                </div>
            )}
        </div>
    );
}
