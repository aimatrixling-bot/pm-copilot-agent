import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Quote, Sparkles } from 'lucide-react';
import { useCloseLayer } from '@/hooks/useCloseLayer';

/**
 * Floating menu that appears when user selects text within assistant messages.
 * Shows「引用」(quote) and「深入讲讲」(elaborate) actions.
 *
 * Renders once at the Chat page level. Listens for mouseup/selectionchange events
 * on the document, checks whether the selection is inside an assistant message
 * (via data-role="assistant"), and positions itself at the start of the selection range.
 */

interface SelectionCommentMenuProps {
  /** Append quoted text to input */
  onQuote: (selectedText: string) => void;
  /** Quote + auto-send */
  onElaborate: (selectedText: string) => void;
}

/** Check if a node is inside an assistant message text area (select-text region) */
function isInsideAssistantText(node: Node | null): boolean {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : node?.parentElement ?? null;
  while (el) {
    // Stop at message boundary
    const role = el.getAttribute?.('data-role');
    if (role === 'user') return false;
    if (role === 'assistant') return true;
    el = el.parentElement;
  }
  return false;
}

const SelectionCommentMenu = memo(function SelectionCommentMenu({
  onQuote,
  onElaborate,
}: SelectionCommentMenuProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [above, setAbove] = useState(true); // true = show above selection, false = below
  const selectedTextRef = useRef('');
  const menuRef = useRef<HTMLDivElement>(null);

  const hideMenu = useCallback(() => {
    setVisible(false);
    selectedTextRef.current = '';
  }, []);

  // Cmd+W dismissal: when menu is visible, close it instead of closing the tab.
  useCloseLayer(() => {
    if (!visible) return false;
    window.getSelection()?.removeAllRanges();
    hideMenu();
    return true;
  }, 300);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // Ignore clicks on the menu itself
      if (menuRef.current?.contains(e.target as Node)) return;

      // Small delay to let browser finalize selection
      requestAnimationFrame(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
          hideMenu();
          return;
        }

        const text = selection.toString().trim();
        if (!text) {
          hideMenu();
          return;
        }

        const range = selection.getRangeAt(0);

        // Check that selection is inside assistant message text
        if (!isInsideAssistantText(range.startContainer) || !isInsideAssistantText(range.endContainer)) {
          hideMenu();
          return;
        }

        selectedTextRef.current = text;

        // Position at the START of the selection (top-left), above the text
        const rects = range.getClientRects();
        if (!rects.length) {
          hideMenu();
          return;
        }
        // First rect = start of selection, clamped to viewport
        const firstRect = rects[0];
        const MENU_WIDTH = 180; // approximate menu width
        const MENU_HEIGHT = 36; // approximate menu height + gap
        const x = Math.max(8, Math.min(firstRect.left, window.innerWidth - MENU_WIDTH - 8));
        const showAbove = firstRect.top >= MENU_HEIGHT + 8;
        const y = showAbove ? firstRect.top : firstRect.bottom + 6;
        setPos({ x, y });
        setAbove(showAbove);
        setVisible(true);
      });
    };

    // Hide when selection is cleared (e.g. clicking elsewhere)
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        hideMenu();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [hideMenu]);

  const handleQuote = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = selectedTextRef.current;
    if (text) onQuote(text);
    // Clear selection and hide
    window.getSelection()?.removeAllRanges();
    hideMenu();
  }, [onQuote, hideMenu]);

  const handleElaborate = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const text = selectedTextRef.current;
    if (text) onElaborate(text);
    window.getSelection()?.removeAllRanges();
    hideMenu();
  }, [onElaborate, hideMenu]);

  if (!visible) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[300] flex items-center gap-0.5 rounded-lg border border-[var(--line-strong)] bg-[var(--paper-elevated)] px-1 py-0.5 shadow-md"
      style={{
        left: pos.x,
        top: pos.y,
        transform: above ? 'translateY(calc(-100% - 6px))' : undefined,
      }}
      onMouseDown={(e) => {
        // Prevent mousedown from clearing text selection
        e.preventDefault();
      }}
    >
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        onClick={handleQuote}
      >
        <Quote className="h-3 w-3" />
        引用
      </button>
      <div className="h-3.5 w-px bg-[var(--line)]" />
      <button
        type="button"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        onClick={handleElaborate}
      >
        <Sparkles className="h-3 w-3" />
        深入讲讲
      </button>
    </div>
  );
});

export default SelectionCommentMenu;
