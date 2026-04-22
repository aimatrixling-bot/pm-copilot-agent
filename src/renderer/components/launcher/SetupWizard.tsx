/**
 * SetupWizard — full-screen onboarding wizard for new users
 * 3-step flow: select provider → enter API key → start using
 * Appears when hasAnyProvider === false
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, KeyRound, Loader2, Sparkles } from 'lucide-react';

import { track } from '@/analytics';
import { apiPostJson } from '@/api/apiFetch';
import type { Provider, ProviderVerifyStatus } from '@/config/types';
import { saveApiKey, saveProviderVerifyStatus } from '@/config/services/providerService';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import ProviderSetupCard from './ProviderSetupCard';
import { RECOMMENDED_PROVIDERS, QUICK_START_SKILLS } from './recommendedProviders';

type WizardStep = 'select' | 'configure' | 'ready';

interface SetupWizardProps {
    providers: Provider[];
    apiKeys: Record<string, string>;
    providerVerifyStatus?: Record<string, ProviderVerifyStatus>;
    onComplete: () => void;
    onSkip: () => void;
    /** Optional: pre-fill a skill command after setup */
    onSendCommand?: (command: string) => void;
}

export default memo(function SetupWizard({
    providers,
    apiKeys,
    providerVerifyStatus,
    onComplete,
    onSkip,
    onSendCommand,
}: SetupWizardProps) {
    const [step, setStep] = useState<WizardStep>('select');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [apiKey, setApiKey] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [verifyResult, setVerifyResult] = useState<'success' | 'error' | null>(null);
    const [errorMsg, setErrorMsg] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Track wizard open
    useEffect(() => {
        track('setup_wizard_open', { step: 'select' });
    }, []);

    // Build recommendation map with resolved Provider objects
    const recommendations = useMemo(() => {
        const result: Array<{ provider: Provider; rec: typeof RECOMMENDED_PROVIDERS[number] }> = [];
        for (const rec of RECOMMENDED_PROVIDERS) {
            const provider = providers.find(p => p.id === rec.id);
            if (provider) {
                result.push({ provider, rec });
            }
        }
        return result;
    }, [providers]);

    const selectedProvider = useMemo(
        () => providers.find(p => p.id === selectedId) ?? null,
        [providers, selectedId]
    );

    // Focus API key input when entering configure step
    useEffect(() => {
        if (step === 'configure') {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [step]);

    const handleSelectProvider = useCallback((id: string) => {
        setSelectedId(id);
        setApiKey('');
        setVerifyResult(null);
        setErrorMsg('');
    }, []);

    const handleNext = useCallback(() => {
        if (selectedId) {
            setStep('configure');
            track('setup_wizard_step', { step: 'configure', provider: selectedId });
        }
    }, [selectedId]);

    const handleBack = useCallback(() => {
        setStep('select');
        setVerifyResult(null);
        setErrorMsg('');
    }, []);

    const handleVerify = useCallback(async () => {
        if (!selectedProvider || !apiKey.trim()) return;

        setVerifying(true);
        setVerifyResult(null);
        setErrorMsg('');

        try {
            const result = await apiPostJson<{ success: boolean; error?: string }>(
                '/api/provider/verify',
                {
                    baseUrl: selectedProvider.config.baseUrl,
                    apiKey: apiKey.trim(),
                    model: selectedProvider.primaryModel,
                    authType: selectedProvider.authType,
                    apiProtocol: selectedProvider.apiProtocol,
                    maxOutputTokens: selectedProvider.maxOutputTokens,
                    maxOutputTokensParamName: selectedProvider.maxOutputTokensParamName,
                    upstreamFormat: selectedProvider.upstreamFormat,
                }
            );

            if (result.success) {
                await saveApiKey(selectedProvider.id, apiKey.trim());
                await saveProviderVerifyStatus(selectedProvider.id, 'valid');
                setVerifyResult('success');
                track('setup_wizard_verified', { provider: selectedProvider.id });
            } else {
                await saveProviderVerifyStatus(selectedProvider.id, 'invalid');
                setVerifyResult('error');
                setErrorMsg(result.error || '验证失败，请检查 API Key');
            }
        } catch (err) {
            setVerifyResult('error');
            setErrorMsg(err instanceof Error ? err.message : '网络错误，请重试');
        } finally {
            setVerifying(false);
        }
    }, [selectedProvider, apiKey]);

    const handleComplete = useCallback(() => {
        track('setup_wizard_complete', { provider: selectedId });
        onComplete();
    }, [onComplete, selectedId]);

    const handleQuickStart = useCallback((command: string) => {
        track('setup_wizard_quick_start', { command });
        onComplete();
        if (onSendCommand) {
            onSendCommand(command);
        }
    }, [onComplete, onSendCommand]);

    // ========== Render Steps ==========

    const renderSelectStep = () => (
        <>
            <div className="mb-8 text-center">
                <h2 className="text-[24px] font-bold text-[var(--ink)]">
                    开始使用 PM Copilot
                </h2>
                <p className="mt-2 text-[14px] text-[var(--ink-secondary)]">
                    选择一个 AI 服务商，2 分钟完成配置
                </p>
            </div>

            {/* Provider grid */}
            <div className="grid grid-cols-2 gap-4">
                {recommendations.map(({ provider, rec }) => (
                    <ProviderSetupCard
                        key={provider.id}
                        provider={provider}
                        recommendation={rec}
                        isSelected={selectedId === provider.id}
                        onSelect={() => handleSelectProvider(provider.id)}
                    />
                ))}
            </div>

            {/* Navigation */}
            <div className="mt-8 flex items-center justify-between">
                <button
                    type="button"
                    onClick={onSkip}
                    className="text-[13px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    稍后配置
                </button>
                <button
                    type="button"
                    onClick={handleNext}
                    disabled={!selectedId}
                    className="flex items-center gap-2 rounded-lg bg-[var(--accent-warm)] px-6 py-2.5 text-[14px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40"
                >
                    下一步
                    <ArrowRight className="h-4 w-4" />
                </button>
            </div>
        </>
    );

    const renderConfigureStep = () => (
        <>
            <div className="mb-8">
                <button
                    type="button"
                    onClick={handleBack}
                    className="mb-4 flex items-center gap-1 text-[13px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    返回选择
                </button>
                <h2 className="text-[20px] font-bold text-[var(--ink)]">
                    配置 {selectedProvider?.name}
                </h2>
                <p className="mt-2 text-[13px] text-[var(--ink-secondary)]">
                    输入你的 API Key 以验证连接
                </p>
            </div>

            {/* API Key input */}
            <div className="space-y-4">
                <div className="relative">
                    <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                    <input
                        ref={inputRef}
                        type="password"
                        value={apiKey}
                        onChange={e => { setApiKey(e.target.value); setVerifyResult(null); setErrorMsg(''); }}
                        placeholder="输入 API Key"
                        className="w-full rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] py-3 pl-10 pr-4 text-[14px] text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
                        onKeyDown={e => { if (e.key === 'Enter' && apiKey.trim()) handleVerify(); }}
                    />
                </div>

                {/* Get key link */}
                {selectedProvider && (() => {
                    const rec = RECOMMENDED_PROVIDERS.find(r => r.id === selectedProvider.id);
                    if (!rec) return null;
                    return (
                        <a
                            href={rec.signupUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[12px] text-[var(--accent-warm)] hover:underline"
                        >
                            还没有 Key？{rec.docLabel}
                            <ExternalLink className="h-3 w-3" />
                        </a>
                    );
                })()}

                {/* Verify button */}
                <button
                    type="button"
                    onClick={handleVerify}
                    disabled={!apiKey.trim() || verifying}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--accent-warm)] py-3 text-[14px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-40"
                >
                    {verifying ? (
                        <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            验证中...
                        </>
                    ) : verifyResult === 'success' ? (
                        <>
                            <Check className="h-4 w-4" />
                            验证成功
                        </>
                    ) : (
                        '验证并保存'
                    )}
                </button>

                {/* Result feedback */}
                {verifyResult === 'success' && (
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-center">
                        <div className="flex items-center justify-center gap-2 text-[14px] font-medium text-green-700">
                            <Check className="h-5 w-5" />
                            AI 模型已就绪
                        </div>
                        <p className="mt-1 text-[12px] text-green-600">
                            可以开始使用 PM Copilot 了
                        </p>
                    </div>
                )}
                {verifyResult === 'error' && errorMsg && (
                    <div className="rounded-lg border border-[var(--error)]/20 bg-[var(--error)]/5 p-3 text-[13px] text-[var(--error)]">
                        {errorMsg}
                    </div>
                )}
            </div>

            {/* Next step */}
            {verifyResult === 'success' && (
                <div className="mt-6 flex justify-end">
                    <button
                        type="button"
                        onClick={() => {
                            setStep('ready');
                            track('setup_wizard_step', { step: 'ready', provider: selectedId });
                        }}
                        className="flex items-center gap-2 rounded-lg bg-[var(--accent-warm)] px-6 py-2.5 text-[14px] font-medium text-white transition-colors hover:opacity-90"
                    >
                        开始使用
                        <ArrowRight className="h-4 w-4" />
                    </button>
                </div>
            )}
        </>
    );

    const renderReadyStep = () => (
        <>
            <div className="mb-8 text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-100">
                    <Check className="h-7 w-7 text-green-600" />
                </div>
                <h2 className="text-[24px] font-bold text-[var(--ink)]">
                    一切就绪
                </h2>
                <p className="mt-2 text-[14px] text-[var(--ink-secondary)]">
                    选择一个 PM 技能快速开始
                </p>
            </div>

            {/* Quick start skills */}
            <div className="space-y-3">
                {QUICK_START_SKILLS.map(skill => (
                    <button
                        key={skill.command}
                        type="button"
                        onClick={() => handleQuickStart(skill.command)}
                        className="group flex w-full items-center gap-4 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)] p-4 text-left transition-all hover:border-[var(--accent-warm-muted)] hover:bg-[var(--accent-warm-subtle)]"
                    >
                        <Sparkles className="h-5 w-5 flex-shrink-0 text-[var(--accent-warm-muted)] group-hover:text-[var(--accent-warm)]" />
                        <div className="flex-1">
                            <div className="text-[14px] font-medium text-[var(--ink)]">
                                {skill.command}
                            </div>
                            <div className="text-[12px] text-[var(--ink-secondary)]">
                                {skill.description}
                            </div>
                        </div>
                    </button>
                ))}
            </div>

            {/* Skip to main */}
            <div className="mt-6 text-center">
                <button
                    type="button"
                    onClick={handleComplete}
                    className="text-[13px] text-[var(--ink-muted)] hover:text-[var(--ink)]"
                >
                    跳过，直接进入
                </button>
            </div>
        </>
    );

    return (
        <OverlayBackdrop onClose={onSkip} className="z-[220]" style={{ animation: 'overlayFadeIn 200ms ease-out' }}>
            <div
                className="glass-panel flex w-[560px] max-w-[90vw] flex-col overflow-hidden"
                style={{ animation: 'overlayPanelIn 250ms ease-out' }}
            >
                <div className="flex-1 overflow-y-auto overscroll-contain px-8 py-8">
                    {/* Step indicator */}
                    <div className="mb-6 flex items-center justify-center gap-2">
                        {(['select', 'configure', 'ready'] as const).map((s, i) => (
                            <div
                                key={s}
                                className={`h-1.5 rounded-full transition-all ${
                                    step === s
                                        ? 'w-8 bg-[var(--accent-warm)]'
                                        : i < (step === 'select' ? 0 : step === 'configure' ? 1 : 2)
                                            ? 'w-8 bg-[var(--accent-warm-muted)]'
                                            : 'w-6 bg-[var(--line-subtle)]'
                                }`}
                            />
                        ))}
                    </div>

                    {step === 'select' && renderSelectStep()}
                    {step === 'configure' && renderConfigureStep()}
                    {step === 'ready' && renderReadyStep()}
                </div>

                {/* Footer */}
                <div className="flex-shrink-0 border-t border-[var(--line-subtle)] px-8 py-3">
                    <p className="text-[11px] text-[var(--ink-muted)]">
                        API Key 仅存储在本地，不会上传到任何服务器
                    </p>
                </div>
            </div>
        </OverlayBackdrop>
    );
});
