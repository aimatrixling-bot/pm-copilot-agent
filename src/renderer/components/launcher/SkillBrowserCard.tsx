/**
 * SkillBrowserCard — single skill card in the Skill Browser
 * Shows skill name, description, and stage badge
 */

import { memo, useCallback } from 'react';
import { Sparkles } from 'lucide-react';

import type { SlashCommand } from '../../../shared/slashCommands';
import { getSkillStageLabel } from './pmLifecycleMapping';

interface SkillBrowserCardProps {
    command: SlashCommand;
    onClick: () => void;
}

export default memo(function SkillBrowserCard({ command, onClick }: SkillBrowserCardProps) {
    const handleClick = useCallback(() => onClick(), [onClick]);
    const stageLabel = getSkillStageLabel(command.name);

    return (
        <button
            type="button"
            onClick={handleClick}
            className="group flex flex-col gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper)] p-4 text-left transition-all hover:border-[var(--accent-warm-muted)] hover:bg-[var(--accent-warm-subtle)] hover:shadow-sm"
        >
            {/* Header: skill name + badge */}
            <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm-muted)]" />
                <span className="text-[13px] font-medium text-[var(--accent-warm)]">
                    {command.displayName || command.name}
                </span>
                {command.displayName && (
                    <span className="text-[11px] text-[var(--ink-muted)]">/{command.name}</span>
                )}
                {stageLabel && (
                    <span className="ml-auto rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[10px] text-[var(--ink-muted)]">
                        {stageLabel}
                    </span>
                )}
            </div>

            {/* Description — 2 line clamp */}
            <p className="line-clamp-2 text-[12px] leading-relaxed text-[var(--ink-muted)]">
                {command.displayDescription || command.description}
            </p>
        </button>
    );
});
