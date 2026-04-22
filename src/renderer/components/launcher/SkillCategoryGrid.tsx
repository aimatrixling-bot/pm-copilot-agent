/**
 * SkillCategoryGrid — grid of SkillBrowserCards for a lifecycle stage
 */

import { memo } from 'react';

import type { SlashCommand } from '../../../shared/slashCommands';
import SkillBrowserCard from './SkillBrowserCard';

interface SkillCategoryGridProps {
    skills: SlashCommand[];
    onSelect: (cmd: SlashCommand) => void;
}

export default memo(function SkillCategoryGrid({ skills, onSelect }: SkillCategoryGridProps) {
    if (skills.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <p className="text-[13px] text-[var(--ink-muted)]">
                    此阶段暂无技能
                </p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-3">
            {skills.map(cmd => (
                <SkillBrowserCard
                    key={cmd.name}
                    command={cmd}
                    onClick={() => onSelect(cmd)}
                />
            ))}
        </div>
    );
});
