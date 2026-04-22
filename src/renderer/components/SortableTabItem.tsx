/**
 * SortableTabItem - Individual sortable tab component
 * Uses @dnd-kit for high-performance drag-and-drop
 *
 * Drag listeners are bound to the title span only (not the entire tab div)
 * to prevent dnd-kit's document-level click capture from swallowing
 * clicks on the close button.
 */

import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';

import { type Tab, getFolderName } from '@/types/tab';

interface SortableTabItemProps {
    tab: Tab;
    isActive: boolean;
    /** Stable callback — receives tabId so parent doesn't need inline closures */
    onSelectTab: (tabId: string) => void;
    /** Stable callback — receives tabId so parent doesn't need inline closures */
    onCloseTab: (tabId: string) => void;
}

export default memo(function SortableTabItem({
    tab,
    isActive,
    onSelectTab,
    onCloseTab,
}: SortableTabItemProps) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: tab.id });

    const style = {
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 100 : undefined,
        opacity: isDragging ? 0.8 : 1,
    };

    // Prefer session title (auto/user) over folder name, fallback to folder name or tab.title
    const hasSessionTitle = tab.title && tab.title !== 'New Tab' && tab.title !== 'New Chat';
    const displayTitle = hasSessionTitle
        ? tab.title
        : (tab.agentDir ? getFolderName(tab.agentDir) : tab.title);
    const tooltipTitle = tab.agentDir ? getFolderName(tab.agentDir) : undefined;

    return (
        <div
            ref={setNodeRef}
            style={style}
            data-tab-id={tab.id}
            title={tooltipTitle}
            className={`
                group/tab relative flex h-8 min-w-[100px] max-w-[200px] cursor-default items-center
                rounded-lg px-3 transition-colors duration-150 flex-shrink-0
                ${isDragging ? 'shadow-lg ring-2 ring-[var(--accent)]/30' : ''}
                ${isActive
                    ? 'bg-[var(--paper-inset)] text-[var(--ink)] shadow-sm'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]/60 hover:text-[var(--ink)]'
                }
            `}
            onMouseDown={(e) => {
                // Select tab immediately on pointer press (not click/release)
                // This fires before dnd-kit's PointerSensor can intercept
                if (e.button !== 0) return; // Left click only
                if ((e.target as HTMLElement).closest('button')) return; // Skip close button
                onSelectTab(tab.id);
            }}
            {...attributes}
        >
            {/* Tab title — drag handle is bound here, not on the entire tab */}
            <span
                className="flex-1 truncate text-[12px] font-medium select-none cursor-grab active:cursor-grabbing"
                {...listeners}
            >
                {displayTitle}
            </span>

            {/* Status dot indicator — streaming (pulsing green, always visible) or unread (static warm, non-active only) */}
            {tab.isGenerating && (
                <>
                    <span className="relative ml-1 flex h-1.5 w-1.5 flex-shrink-0" aria-hidden="true">
                        <span className="absolute inset-0 rounded-full bg-[var(--success)]" />
                        <span className="absolute inset-0 rounded-full bg-[var(--success)] animate-[tab-dot-pulse_1.6s_cubic-bezier(.22,.61,.36,1)_infinite]" />
                    </span>
                    <span className="sr-only">AI 正在输出</span>
                </>
            )}
            {!isActive && !tab.isGenerating && tab.hasUnread && (
                <>
                    <span className="ml-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--accent-warm)]" aria-hidden="true" />
                    <span className="sr-only">有未读消息</span>
                </>
            )}

            {/* Close button — enlarged hit area (24×24) with visual icon (12×12) */}
            <button
                className={`
                    -mr-1.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full
                    transition-all duration-150
                    ${isActive
                        ? 'opacity-60 hover:bg-[var(--ink)]/10 hover:opacity-100'
                        : 'opacity-0 group-hover/tab:opacity-60 hover:!bg-[var(--ink)]/10 hover:!opacity-100'
                    }
                `}
                onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                }}
                title="关闭标签页"
            >
                <X className="h-3 w-3" />
            </button>

            {/* Active indicator */}
            {isActive && (
                <div className="absolute bottom-0.5 left-3 right-3 h-0.5 rounded-full bg-[var(--accent)]" />
            )}

        </div>
    );
});
