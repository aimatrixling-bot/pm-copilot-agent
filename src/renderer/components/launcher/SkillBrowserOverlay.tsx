/**
 * SkillBrowserOverlay — full-screen skill browser
 * Two-column layout: lifecycle stages (left) + skill grid with search (right)
 * Follows TemplateLibraryDialog pattern with OverlayBackdrop + useCloseLayer
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { track } from '@/analytics';
import { apiGetJson } from '@/api/apiFetch';
import type { SlashCommand } from '../../../shared/slashCommands';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import SkillCategoryGrid from './SkillCategoryGrid';
import { LIFECYCLE_STAGES, type LifecycleStage, getSkillStage } from './pmLifecycleMapping';

interface SkillBrowserOverlayProps {
    onSend: (command: string) => void;
    onClose: () => void;
}

export default memo(function SkillBrowserOverlay({ onSend, onClose }: SkillBrowserOverlayProps) {
    useCloseLayer(() => { onClose(); return true; }, 210);

    const [commands, setCommands] = useState<SlashCommand[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedStageId, setSelectedStageId] = useState<string>(LIFECYCLE_STAGES[0].id);
    const [searchQuery, setSearchQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);

    // Track open event
    useEffect(() => {
        track('skill_browser_open', { source: 'workflow_cards' });
    }, []);

    // Fetch commands on mount
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await apiGetJson<{ success: boolean; commands: SlashCommand[] }>('/api/commands');
                if (!cancelled && res.success) {
                    // Filter to PM skills only
                    const pmSkills = res.commands.filter(
                        cmd => cmd.source === 'skill' && cmd.name.startsWith('pm-')
                    );
                    setCommands(pmSkills);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : '加载失败');
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Group commands by lifecycle stage
    const stageGroups = useMemo(() => {
        const groups = new Map<string, SlashCommand[]>();
        const unmatched: SlashCommand[] = [];

        // Initialize all stages with empty arrays
        for (const stage of LIFECYCLE_STAGES) {
            groups.set(stage.id, []);
        }

        for (const cmd of commands) {
            const stage = getSkillStage(cmd.name);
            if (stage) {
                groups.get(stage.id)!.push(cmd);
            } else {
                unmatched.push(cmd);
            }
        }

        // Add "other" stage if there are unmatched skills
        if (unmatched.length > 0) {
            groups.set('other', unmatched);
        }

        return groups;
    }, [commands]);

    // Filtered skills for current stage or search
    const displayedSkills = useMemo(() => {
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            return commands.filter(cmd =>
                cmd.name.toLowerCase().includes(q) ||
                cmd.description.toLowerCase().includes(q)
            );
        }
        return stageGroups.get(selectedStageId) ?? [];
    }, [commands, searchQuery, selectedStageId, stageGroups]);

    // Handle skill selection
    const handleSelect = useCallback((cmd: SlashCommand) => {
        const stage = getSkillStage(cmd.name);
        track('skill_browser_select', {
            skill: cmd.name,
            stage: stage?.id ?? 'unknown',
        });
        onSend('/' + cmd.name);
        onClose();
    }, [onSend, onClose]);

    // Handle stage click
    const handleStageClick = useCallback((stageId: string) => {
        setSelectedStageId(stageId);
        setSearchQuery(''); // Clear search when switching stages
    }, []);

    // Handle search input
    const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setSearchQuery(value);
        if (value.trim()) {
            track('skill_browser_search', { query_length: value.length });
        }
    }, []);

    // Build stage list items (including "all" for search mode)
    const stageList = useMemo(() => {
        const items: Array<{ id: string; label: string; count: number; icon: LifecycleStage['icon'] }> = [];

        if (searchQuery.trim()) {
            // In search mode, show "all results"
            items.push({ id: '_search', label: '搜索结果', count: displayedSkills.length, icon: Search });
        } else {
            for (const stage of LIFECYCLE_STAGES) {
                const skills = stageGroups.get(stage.id);
                if (skills && skills.length > 0) {
                    items.push({ id: stage.id, label: stage.label, count: skills.length, icon: stage.icon });
                }
            }
            const otherSkills = stageGroups.get('other');
            if (otherSkills && otherSkills.length > 0) {
                items.push({ id: 'other', label: '其他', count: otherSkills.length, icon: Search });
            }
        }

        return items;
    }, [searchQuery, stageGroups, displayedSkills.length]);

    // Auto-focus search on open
    useEffect(() => {
        searchRef.current?.focus();
    }, []);

    return (
        <OverlayBackdrop onClose={onClose} className="z-[210]" style={{ animation: 'overlayFadeIn 200ms ease-out' }}>
            <div
                className="glass-panel flex h-[80vh] w-[800px] max-w-[90vw] overflow-hidden"
                style={{ animation: 'overlayPanelIn 250ms ease-out' }}
            >
                {/* Left: Stage list */}
                <nav className="flex w-[200px] flex-shrink-0 flex-col border-r border-[var(--line-subtle)] bg-[var(--paper-inset)] py-4">
                    <h2 className="px-4 pb-3 text-[12px] font-semibold tracking-wider text-[var(--ink-muted)]">
                        PM 工作流
                    </h2>
                    <div className="flex-1 overflow-y-auto overscroll-contain">
                        {stageList.map(item => {
                            const isActive = searchQuery.trim()
                                ? item.id === '_search'
                                : item.id === selectedStageId;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    onClick={() => {
                                        if (!searchQuery.trim()) handleStageClick(item.id);
                                    }}
                                    className={`flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors ${
                                        isActive
                                            ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)] font-medium'
                                            : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                                    }`}
                                >
                                    <item.icon className="h-3.5 w-3.5 flex-shrink-0" />
                                    <span className="flex-1 truncate">{item.label}</span>
                                    <span className="text-[10px] text-[var(--ink-muted)]">{item.count}</span>
                                </button>
                            );
                        })}
                    </div>
                </nav>

                {/* Right: Search + Skill grid */}
                <div className="flex flex-1 flex-col overflow-hidden">
                    {/* Search bar */}
                    <div className="flex-shrink-0 border-b border-[var(--line-subtle)] px-6 py-4">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
                            <input
                                ref={searchRef}
                                type="text"
                                value={searchQuery}
                                onChange={handleSearchChange}
                                placeholder="搜索 PM 技能..."
                                className="w-full rounded-lg border border-[var(--line-subtle)] bg-[var(--paper-inset)] py-2 pl-10 pr-4 text-[13px] text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm-muted)]"
                            />
                        </div>
                    </div>

                    {/* Skill grid */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
                                <p className="mt-4 text-[13px] text-[var(--ink-muted)]">加载技能列表...</p>
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center justify-center py-16">
                                <p className="text-[13px] text-[var(--error)]">{error}</p>
                            </div>
                        ) : (
                            <SkillCategoryGrid skills={displayedSkills} onSelect={handleSelect} />
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex-shrink-0 border-t border-[var(--line-subtle)] px-6 py-3">
                        <p className="text-[11px] text-[var(--ink-muted)]">
                            {commands.length} 个 PM 技能 · 按 Esc 关闭
                        </p>
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
});
