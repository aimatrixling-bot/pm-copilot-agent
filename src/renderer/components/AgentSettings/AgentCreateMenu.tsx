// Agent create menu — dropdown for creating a new Agent from Settings page
// Two options: upgrade existing workspace, create from template
import { useState, useCallback, useEffect, useRef, memo } from 'react';
import { Plus, FolderUp, LayoutTemplate } from 'lucide-react';

interface AgentCreateMenuProps {
  onUpgradeWorkspace: () => void;
  onCreateFromTemplate: () => void;
}

export default memo(function AgentCreateMenu({
  onUpgradeWorkspace,
  onCreateFromTemplate,
}: AgentCreateMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => setOpen(prev => !prev), []);

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
        className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-3 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
      >
        <Plus className="h-3.5 w-3.5" />
        创建 Agent
      </button>

      {open && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-50 mt-1 w-[200px] rounded-[10px] border border-[var(--line)] bg-[var(--paper-elevated)] py-1 shadow-md"
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onUpgradeWorkspace(); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            <FolderUp className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
            从现有工作区升级
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onCreateFromTemplate(); }}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)]"
          >
            <LayoutTemplate className="h-3.5 w-3.5 text-[var(--ink-subtle)]" />
            从模板创建
          </button>
        </div>
      )}
    </div>
  );
});
