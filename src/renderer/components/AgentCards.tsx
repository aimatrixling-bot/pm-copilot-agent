/**
 * AgentCards - Reusable agent card components for list views
 */
import { Bot } from 'lucide-react';

import type { AgentItem } from '../../shared/agentTypes';

export function AgentCard({ agent, onClick }: { agent: AgentItem; onClick: () => void }) {
    return (
        <div
            className="group flex cursor-pointer flex-col rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
            onClick={onClick}
        >
            {/* Title with badge */}
            <div className="mb-2 flex items-center gap-1.5">
                <h4 className="truncate text-[15px] font-semibold text-[var(--ink)]">
                    {agent.name}
                </h4>
                <Bot className="h-4 w-4 shrink-0 text-violet-500" />
            </div>
            {/* Description - 2 lines */}
            <p className="mb-3 line-clamp-2 flex-1 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                {agent.description || '暂无描述'}
            </p>
            {/* Footer - scope badge + synced badge */}
            <div className="flex h-4 items-center gap-1.5 text-xs text-[var(--ink-muted)]/70">
                <span className="rounded bg-[var(--paper-inset)] px-1.5 py-0.5 text-[11px]">
                    {agent.scope === 'user' ? '全局' : '项目'}
                </span>
                {agent.synced && (
                    <span className="rounded bg-[var(--info-bg)] px-1.5 py-0.5 text-[11px] text-[var(--info)]">
                        Claude Code
                    </span>
                )}
            </div>
        </div>
    );
}
