/**
 * WorkflowCards - PM Skill entry point
 * "Browse PM Skills" primary button + 5 quick-access skill chips
 */

import { memo, useCallback } from 'react';
import { Compass } from 'lucide-react';

import { QUICK_ACCESS_SKILLS, QUICK_ACCESS_COMMANDS, QUICK_ACCESS_LABELS } from './pmLifecycleMapping';

const QUICK_ITEMS = QUICK_ACCESS_SKILLS.map(name => ({
    id: name,
    label: QUICK_ACCESS_LABELS[name] ?? name,
    command: QUICK_ACCESS_COMMANDS[name] ?? `/${name}`,
}));

interface WorkflowCardsProps {
    onSend: (text: string) => void;
    onBrowseSkills: () => void;
    disabled?: boolean;
}

export default memo(function WorkflowCards({ onSend, onBrowseSkills, disabled }: WorkflowCardsProps) {
    const handleBrowse = useCallback(() => {
        if (!disabled) onBrowseSkills();
    }, [onBrowseSkills, disabled]);

    return (
        <div className="mt-6 flex flex-col items-center gap-3">
            {/* Primary browse button */}
            <button
                type="button"
                onClick={handleBrowse}
                disabled={disabled}
                className="group flex items-center gap-2 rounded-full bg-[var(--accent-warm)] px-5 py-2.5 text-[13px] font-medium text-white transition-all hover:bg-[var(--accent-warm)]/90 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-40"
            >
                <Compass className="h-4 w-4" />
                <span>浏览 PM 技能</span>
            </button>

            {/* Quick-access chips */}
            <div className="flex flex-wrap items-center justify-center gap-2">
                {QUICK_ITEMS.map(({ id, label, command }) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => { if (!disabled) onSend(command); }}
                        disabled={disabled}
                        className="workflow-card group flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--ink-muted)] transition-all hover:border-[var(--accent-warm-muted)] hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <span>{label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
});
