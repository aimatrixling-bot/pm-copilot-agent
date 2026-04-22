/**
 * AddWorkspaceMenu — dropdown menu for workspace "Add" button
 * Two options: add local folder, create from template
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, FolderPlus, LayoutTemplate } from 'lucide-react';

interface AddWorkspaceMenuProps {
    onAddFolder: () => void;
    onCreateFromTemplate: () => void;
}

export default memo(function AddWorkspaceMenu({
    onAddFolder,
    onCreateFromTemplate,
}: AddWorkspaceMenuProps) {
    const [open, setOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const toggle = useCallback(() => setOpen(prev => !prev), []);

    // Close on click-outside or Escape
    useEffect(() => {
        if (!open) return;
        const handleClick = (e: MouseEvent) => {
            if (
                menuRef.current && !menuRef.current.contains(e.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(e.target as Node)
            ) {
                setOpen(false);
            }
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [open]);

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                onClick={toggle}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
                <Plus className="h-3.5 w-3.5" />
                添加
            </button>

            {open && (
                <div
                    ref={menuRef}
                    className="absolute right-0 top-full z-50 mt-1 w-[180px] rounded-[10px] border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md"
                    role="menu"
                >
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setOpen(false); onAddFolder(); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <FolderPlus className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        添加本地文件夹
                    </button>
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setOpen(false); onCreateFromTemplate(); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                    >
                        <LayoutTemplate className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                        从模板创建 Agent
                    </button>
                </div>
            )}
        </div>
    );
});
