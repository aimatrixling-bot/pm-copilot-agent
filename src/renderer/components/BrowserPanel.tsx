/**
 * BrowserPanel — Embedded browser preview panel for the split view.
 *
 * Renders a navigation toolbar + a placeholder container. The actual
 * web content is rendered by a native Tauri child Webview positioned
 * over the placeholder using absolute coordinates (OS-level overlay).
 *
 * The toolbar always includes a close button (×), so the separate
 * single-view header in Chat.tsx is not needed — one row handles
 * both navigation and panel control.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronLeft, ChevronRight, Code2, RotateCw, ExternalLink, Loader2, Globe, X } from 'lucide-react';
import { openExternal } from '@/utils/openExternal';
import { useBrowserOverlayGuard } from '@/hooks/useBrowserOverlayGuard';
import Tip from '@/components/Tip';

interface BrowserPanelProps {
  tabId: string;
  url: string | null;
  /** Whether this panel should be visible (includes isActive + splitActiveView + splitPanelVisible) */
  isVisible: boolean;
  isDraggingSplit: boolean;
  browserAlive: boolean;
  /** When previewing a local file, stores its metadata for editor toggle */
  sourceFile?: { name: string; content: string; size: number; path: string } | null;
  onBrowserCreated: () => void;
  onCreateFailed: () => void;
  onClose: () => void;
  /** Switch to code editor view (only available when sourceFile is set) */
  onSwitchToEditor?: () => void;
}

export default function BrowserPanel({
  tabId,
  url,
  isVisible,
  isDraggingSplit,
  browserAlive,
  sourceFile,
  onBrowserCreated,
  onCreateFailed,
  onClose,
  onSwitchToEditor,
}: BrowserPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const creatingRef = useRef(false);

  // ── Editable URL bar state ──
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Overlay detection
  const overlayDetected = useBrowserOverlayGuard(browserAlive);

  // Track the last URL we told the webview to load
  const lastRequestedUrlRef = useRef<string | null>(null);

  // ── Create or navigate webview when url prop changes ──
  useEffect(() => {
    if (!url) return;
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    if (!browserAlive && !creatingRef.current) {
      creatingRef.current = true;
      lastRequestedUrlRef.current = url;
      const rect = el.getBoundingClientRect();

      invoke('cmd_browser_create', {
        tabId, url,
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
      })
        .then(() => {
          if (cancelled) {
            invoke('cmd_browser_close', { tabId }).catch(() => {});
            return;
          }
          onBrowserCreated();
        })
        .catch((err) => {
          console.error('[browser] Create failed:', err);
          if (!cancelled) onCreateFailed();
        })
        .finally(() => { creatingRef.current = false; });
    } else if (browserAlive && url !== lastRequestedUrlRef.current) {
      lastRequestedUrlRef.current = url;
      invoke('cmd_browser_navigate', { tabId, url }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [url, browserAlive, tabId, onBrowserCreated, onCreateFailed]);

  // ── Listen for URL/loading events from Rust ──
  useEffect(() => {
    if (!browserAlive) return;

    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    (async () => {
      const u1 = await listen<string>(`browser:url-changed:${tabId}`, (event) => {
        if (!cancelled) setCurrentUrl(event.payload);
      });
      if (cancelled) { u1(); return; }
      unlisteners.push(u1);

      const u2 = await listen<boolean>(`browser:loading:${tabId}`, (event) => {
        if (!cancelled) setIsLoading(event.payload);
      });
      if (cancelled) { u2(); return; }
      unlisteners.push(u2);
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [browserAlive, tabId]);

  // ── ResizeObserver ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !browserAlive) return;

    const syncBounds = () => {
      const rect = el.getBoundingClientRect();
      invoke('cmd_browser_resize', {
        tabId, x: rect.x, y: rect.y,
        width: rect.width, height: rect.height,
      }).catch(() => {});
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);
    window.addEventListener('resize', syncBounds);
    syncBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [browserAlive, tabId]);

  // ── Consolidated show/hide ──
  useEffect(() => {
    if (!browserAlive) return;
    const shouldShow = isVisible && !isDraggingSplit && !overlayDetected;
    if (shouldShow) {
      invoke('cmd_browser_show', { tabId }).catch(() => {});
      const el = containerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        invoke('cmd_browser_resize', {
          tabId, x: rect.x, y: rect.y,
          width: rect.width, height: rect.height,
        }).catch(() => {});
      }
    } else {
      invoke('cmd_browser_hide', { tabId }).catch(() => {});
    }
  }, [isVisible, isDraggingSplit, overlayDetected, browserAlive, tabId]);

  // ── Cleanup on unmount ──
  useEffect(() => {
    const tid = tabId;
    return () => { invoke('cmd_browser_close', { tabId: tid }).catch(() => {}); };
  }, [tabId]);

  // ── Navigation handlers ──
  const handleGoBack = useCallback(() => {
    invoke('cmd_browser_go_back', { tabId }).catch(() => {});
  }, [tabId]);

  const handleGoForward = useCallback(() => {
    invoke('cmd_browser_go_forward', { tabId }).catch(() => {});
  }, [tabId]);

  const handleReload = useCallback(() => {
    invoke('cmd_browser_reload', { tabId }).catch(() => {});
  }, [tabId]);

  const handleOpenExternal = useCallback(() => {
    // For local file previews, open the file path (not file:// URL) so Tauri
    // shell.open() launches the system default app (same as right-click → Open).
    if (sourceFile?.path) {
      // sourceFile.path is relative — reconstruct absolute path from the file:// URL
      const fileUrl = currentUrl || url || '';
      if (fileUrl.startsWith('file://')) {
        try { openExternal(decodeURIComponent(new URL(fileUrl).pathname)); return; } catch { /* fall through */ }
      }
    }
    if (currentUrl) openExternal(currentUrl);
  }, [currentUrl, url, sourceFile]);

  // ── URL bar editing ──
  const handleUrlClick = useCallback(() => {
    setUrlDraft(currentUrl);
    setUrlEditing(true);
    // Focus will happen after render via autoFocus
  }, [currentUrl]);

  const handleUrlSubmit = useCallback(() => {
    setUrlEditing(false);
    let trimmed = urlDraft.trim();
    if (!trimmed) return;
    // Auto-add https:// if no protocol
    if (!/^https?:\/\//i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    if (trimmed !== currentUrl) {
      invoke('cmd_browser_navigate', { tabId, url: trimmed }).catch(() => {});
      lastRequestedUrlRef.current = trimmed;
    }
  }, [urlDraft, currentUrl, tabId]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlSubmit();
    } else if (e.key === 'Escape') {
      setUrlEditing(false);
    }
  }, [handleUrlSubmit]);

  // Extract display hostname
  const displayUrl = currentUrl
    ? (() => { try { return new URL(currentUrl).hostname || currentUrl; } catch { return currentUrl; } })()
    : '';

  // No `transition-colors` — let global `button { transition-property: ...transform... }` handle it,
  // so the unified active:scale(0.98) animates smoothly instead of snapping.
  const navBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';

  return (
    <div className="flex h-full flex-col">
      {/* Navigation toolbar — always includes close button (single row for all states) */}
      <div className="relative flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper)] px-2">
        <Tip label="后退" position="bottom">
          <button type="button" className={navBtn} onClick={handleGoBack}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label="前进" position="bottom">
          <button type="button" className={navBtn} onClick={handleGoForward}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={isLoading ? '停止' : '刷新'} position="bottom">
          <button type="button" className={navBtn} onClick={handleReload}>
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
          </button>
        </Tip>

        {/* Editable URL bar */}
        {urlEditing ? (
          <input
            ref={urlInputRef}
            autoFocus
            className="ml-1.5 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-0.5 text-[12px] text-[var(--ink)] outline-none focus:border-[var(--accent)]"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onBlur={() => setUrlEditing(false)}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            onClick={handleUrlClick}
            className="ml-1.5 min-w-0 flex-1 cursor-text truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-left text-[12px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)]"
            title={currentUrl}
          >
            {currentUrl}
          </button>
        )}

        {/* Edit Source — only for local file previews */}
        {sourceFile && onSwitchToEditor && (
          <Tip label="编辑源码" position="bottom" align="end">
            <button type="button" className={navBtn} onClick={onSwitchToEditor}>
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}

        <Tip label="在浏览器中打开" position="bottom" align="end">
          <button
            type="button"
            className={navBtn}
            onClick={handleOpenExternal}
            disabled={!currentUrl}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Close button — always present */}
        <Tip label="关闭浏览器" position="bottom" align="end">
          <button type="button" className={navBtn} onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Loading progress indicator */}
        {isLoading && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <div className="animate-indeterminate h-full w-1/3 bg-[var(--accent-warm)]" />
          </div>
        )}
      </div>

      {/* Placeholder container — native Webview overlays this area */}
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--paper)]">
        {!browserAlive && (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-6 w-6" />
              <span className="text-[12px]">{url ? '加载中...' : ''}</span>
            </div>
          </div>
        )}

        {isDraggingSplit && browserAlive && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-md">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-5 w-5" />
              <span className="text-[12px]">{displayUrl}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
