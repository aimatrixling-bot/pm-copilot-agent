/**
 * SessionTagBadge - Tag badges for session sources (IM, Cron, Background)
 * Unified style: colored dot + label, matching WorkspaceCard channel tags
 */

import type { SessionTag } from '@/hooks/useTaskCenterData';

/** Tag color scheme: dot color + text color + bg color */
const TAG_STYLES = {
    /** IM Bot channels — green (matches WorkspaceCard online dot) */
    im: {
        dot: 'bg-[var(--success)]',
        text: 'text-[var(--success)]',
        bg: 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)]',
    },
    /** Cron/scheduled tasks — warm brown */
    cron: {
        dot: 'bg-[var(--accent-warm)]',
        text: 'text-[var(--accent-warm)]',
        bg: 'bg-[var(--accent-warm-subtle)]',
    },
    /** Background completions — muted blue */
    background: {
        dot: 'bg-[var(--accent)]',
        text: 'text-[var(--accent)]',
        bg: 'bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]',
    },
} as const;

/** Labels */
const TAG_LABELS: Record<string, string> = {
    cron: '定时',
    background: '后台',
};

export default function SessionTagBadge({ tag }: { tag: SessionTag }) {
    const style = TAG_STYLES[tag.type] ?? TAG_STYLES.im;
    const label = tag.type === 'im' ? tag.platform : (TAG_LABELS[tag.type] ?? tag.type);

    return (
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${style.text} ${style.bg}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {label}
        </span>
    );
}
