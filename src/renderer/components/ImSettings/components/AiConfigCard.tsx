import React from 'react';
import CustomSelect from '@/components/CustomSelect';

export default function AiConfigCard({
    providerId,
    model,
    providerOptions,
    modelOptions,
    onProviderChange,
    onModelChange,
}: {
    providerId: string;
    model: string;
    providerOptions: { value: string; label: string }[];
    modelOptions: { value: string; label: string }[];
    onProviderChange: (providerId: string) => void;
    onModelChange: (model: string) => void;
}) {
    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">AI 配置</h3>
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">供应商</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            Bot 使用的 AI 供应商（独立于客户端设置）
                        </p>
                    </div>
                    <CustomSelect
                        value={providerId}
                        options={providerOptions}
                        onChange={onProviderChange}
                        placeholder="选择供应商"
                        className="w-[240px]"
                    />
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex-1 pr-4">
                        <p className="text-sm font-medium text-[var(--ink)]">模型</p>
                        <p className="text-xs text-[var(--ink-muted)]">
                            可在 Telegram 中使用 <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[10px]">/model</code> 命令切换
                        </p>
                    </div>
                    <CustomSelect
                        value={model}
                        options={modelOptions}
                        onChange={onModelChange}
                        placeholder="选择模型"
                        className="w-[240px]"
                    />
                </div>
            </div>
        </div>
    );
}
