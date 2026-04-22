/**
 * WorkspaceCard - Compact clickable project card for the launcher
 * Single-click to launch, right-click context menu for edit/remove
 *
 * Proactive Agent cards show per-channel status tags below the path
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Trash2, Settings2, HeartPulse, SlidersHorizontal } from 'lucide-react';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import type { Project } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';
import { getChannelTypeLabel } from '@/utils/taskCenterUtils';

// ─── Proactive status helpers ─────────────────────────────────────

type ProactiveState = 'basic' | 'pending' | 'active' | 'paused' | 'error';

function deriveState(p: Project, a?: AgentConfig, s?: AgentStatusData): ProactiveState {
    if (!p.isAgent || !a) return 'basic';
    if (!a.enabled) return 'basic';
    if (!(a.channels?.length)) return 'pending';
    if (s) {
        if (s.channels.some(c => c.status === 'online' || c.status === 'connecting')) return 'active';
        if (s.channels.some(c => c.status === 'error')) return 'error';
    }
    return 'paused';
}


// ─── Component ────────────────────────────────────────────────────

interface WorkspaceCardProps {
    project: Project;
    agent?: AgentConfig;
    agentStatus?: AgentStatusData;
    onLaunch: (project: Project) => void;
    onRemove: (project: Project) => void;
    onAgentSettings: (project: Project) => void;
    isLoading?: boolean;
}

export default memo(function WorkspaceCard({
    project,
    agent,
    agentStatus,
    onLaunch,
    onRemove,
    onAgentSettings,
    isLoading,
}: WorkspaceCardProps) {
    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        // Clamp position so the menu stays within the viewport
        const menuWidth = 140;
        const menuHeight = 76;
        const x = Math.min(e.clientX, window.innerWidth - menuWidth);
        const y = Math.min(e.clientY, window.innerHeight - menuHeight);
        setContextMenu({ x, y });
    }, []);

    // Cmd+W dismissal: when context menu is open, close it instead of closing the tab.
    useCloseLayer(() => {
        if (!contextMenu) return false;
        setContextMenu(null);
        return true;
    }, 50);

    // Close context menu on click-outside or Escape
    useEffect(() => {
        if (!contextMenu) return;
        const handleClose = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setContextMenu(null);
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setContextMenu(null);
        };
        document.addEventListener('mousedown', handleClose);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClose);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [contextMenu]);

    const displayName = project.displayName || getFolderName(project.path);
    const state = deriveState(project, agent, agentStatus);
    const isProactive = state !== 'basic';

    return (
        <>
            <button
                type="button"
                onClick={() => !isLoading && onLaunch(project)}
                onContextMenu={handleContextMenu}
                disabled={isLoading}
                className={`group flex w-full items-center gap-3 rounded-xl bg-[var(--paper-elevated)] px-4 py-3 text-left transition-all duration-150 ease-out hover:bg-[var(--hover-bg)] active:scale-[0.98] ${
                    isLoading ? 'pointer-events-none opacity-60' : 'cursor-pointer'
                }`}
            >
                {/* Icon */}
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                    {isLoading ? (
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-subtle)]" />
                    ) : (
                        <WorkspaceIcon icon={project.icon} size={28} />
                    )}
                </div>

                {/* Text + channel tags */}
                <div className="min-w-0 flex-1">
                    <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--ink)]">
                        <span className="truncate">{displayName}</span>
                        {isProactive && <HeartPulse className="h-3 w-3 shrink-0 text-[var(--heartbeat)]" />}
                    </h3>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">
                        {shortenPathForDisplay(project.path)}
                    </p>
                    {isProactive && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                            {state === 'pending' ? (
                                <span className="text-[11px] text-[var(--accent-warm)]">待配置聊天机器人</span>
                            ) : (agent?.channels ?? []).map(ch => {
                                const runtime = agentStatus?.channels.find(c => c.channelId === ch.id);
                                const isOn = runtime?.status === 'online' || runtime?.status === 'connecting';
                                const isErr = runtime?.status === 'error';
                                return (
                                    <span
                                        key={ch.id}
                                        className={`inline-flex items-center gap-[3px] rounded-[3px] px-1 py-[1px] text-[10px] leading-[14px] ${
                                            isErr
                                                ? 'text-[var(--error)]'
                                                : isOn
                                                    ? 'text-[var(--success)]'
                                                    : 'bg-[var(--paper-inset)] text-[var(--ink-subtle)]'
                                        }`}
                                        style={isErr
                                            ? { backgroundColor: 'color-mix(in srgb, var(--error) 12%, transparent)' }
                                            : isOn
                                                ? { backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }
                                                : undefined
                                        }
                                    >
                                        <span className={`h-[5px] w-[5px] rounded-full ${
                                            isErr
                                                ? 'bg-[var(--error)]'
                                                : isOn
                                                    ? 'bg-[var(--success)]'
                                                    : 'bg-[var(--ink-faint)]'
                                        }`} />
                                        {getChannelTypeLabel(ch.type)}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Settings shortcut — visible on hover, custom tooltip */}
                {!isLoading && (
                    <div
                        className="group/btn relative shrink-0 rounded-lg p-2 text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] group-hover:opacity-100"
                        role="button"
                        tabIndex={-1}
                        onClick={(e) => {
                            e.stopPropagation();
                            onAgentSettings(project);
                        }}
                    >
                        <SlidersHorizontal className="h-4 w-4" strokeWidth={2.2} />
                        <span className="pointer-events-none absolute -bottom-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--button-dark-bg)] px-2 py-0.5 text-[11px] text-[var(--button-primary-text)] opacity-0 shadow-lg transition-opacity group-hover/btn:opacity-100">
                            Agent 设置
                        </span>
                    </div>
                )}
            </button>

            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={menuRef}
                    className="fixed z-50 rounded-[10px] border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    role="menu"
                    aria-label="工作区操作菜单"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setContextMenu(null);
                            onAgentSettings(project);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <Settings2 className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        Agent 设置
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setContextMenu(null);
                            onRemove(project);
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--error)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                        移除
                    </button>
                </div>
            )}
        </>
    );
});
