/**
 * ProviderSetupCard — single provider card for the Setup Wizard
 * Shows provider name, recommendation reason, and signup link
 */

import { memo, useCallback } from 'react';
import { ExternalLink, Check } from 'lucide-react';

import type { Provider } from '@/config/types';
import { type RecommendedProvider } from './recommendedProviders';

interface ProviderSetupCardProps {
    provider: Provider;
    recommendation: RecommendedProvider;
    isSelected: boolean;
    onSelect: () => void;
}

export default memo(function ProviderSetupCard(
    { provider, recommendation, isSelected, onSelect }: ProviderSetupCardProps
) {
    const handleClick = useCallback(() => onSelect(), [onSelect]);

    return (
        <button
            type="button"
            onClick={handleClick}
            className={`group flex flex-col gap-3 rounded-xl border p-5 text-left transition-all ${
                isSelected
                    ? 'border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)] shadow-sm'
                    : 'border-[var(--line-subtle)] bg-[var(--paper)] hover:border-[var(--accent-warm-muted)] hover:shadow-sm'
            }`}
        >
            {/* Header: name + selected indicator */}
            <div className="flex items-center gap-3">
                <span className={`text-[15px] font-semibold ${isSelected ? 'text-[var(--accent-warm)]' : 'text-[var(--ink)]'}`}>
                    {provider.name}
                </span>
                {isSelected && (
                    <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-warm)]">
                        <Check className="h-3 w-3 text-white" />
                    </span>
                )}
            </div>

            {/* Reason */}
            <p className="text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                {recommendation.reason}
            </p>

            {/* Signup link */}
            <a
                href={recommendation.signupUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-[11px] text-[var(--accent-warm)] hover:underline"
            >
                {recommendation.docLabel}
                <ExternalLink className="h-3 w-3" />
            </a>
        </button>
    );
});
