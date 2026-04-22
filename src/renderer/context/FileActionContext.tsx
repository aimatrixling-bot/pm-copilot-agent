/**
 * FileActionContext — provides inline-code path checking and context menu actions.
 *
 * Used by markdown InlineCode to detect real file/folder paths in AI output
 * and offer quick actions (preview, reference, open-in-finder).
 *
 * Only provided inside Chat; Settings / other pages get null from useFileAction().
 */
import { AtSign, ExternalLink, Eye, FolderOpen } from 'lucide-react';
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { getTabServerUrl, proxyFetch, isTauri } from '@/api/tauriClient';
import ContextMenu from '@/components/ContextMenu';
import type { ContextMenuItem } from '@/components/ContextMenu';
import { useImagePreview } from '@/context/ImagePreviewContext';
import { useTabApi } from '@/context/TabContext';
import { isImageFile, isPreviewable } from '../../shared/fileTypes';

// Lazy load FilePreviewModal (heavy: includes SyntaxHighlighter + Monaco)
const FilePreviewModal = lazy(() => import('@/components/FilePreviewModal'));

// ---------- Types ----------

interface PathInfo {
  exists: boolean;
  type: 'file' | 'dir';
}

export interface FileActionContextValue {
  /** Synchronous cache lookup. Returns cached result or null (pending / not yet requested). */
  checkPath: (path: string) => PathInfo | null;
  /** Incremented each time the cache is updated, so consumers can re-render. */
  cacheVersion: number;
  /** Open the context menu for a resolved path. */
  openFileMenu: (x: number, y: number, path: string, pathType: 'file' | 'dir') => void;
}

interface FileActionProviderProps {
  children: ReactNode;
  /** Callback to insert @-reference into the chat input. */
  onInsertReference?: (paths: string[]) => void;
  /** When this value changes, the path cache is cleared (e.g. toolCompleteCount). */
  refreshTrigger?: number;
  /** When provided, "预览" routes to this callback (split-view) instead of fullscreen modal. */
  onFilePreviewExternal?: (file: { name: string; content: string; size: number; path: string }) => void;
}

// ---------- Context ----------

const FileActionContext = createContext<FileActionContextValue | null>(null);

export function useFileAction(): FileActionContextValue | null {
  return useContext(FileActionContext);
}

// ---------- Provider ----------

const BATCH_DELAY_MS = 50;

export function FileActionProvider({ children, onInsertReference, refreshTrigger, onFilePreviewExternal }: FileActionProviderProps) {
  const { tabId, apiPost, apiGet } = useTabApi();
  const { openPreview: openImagePreview } = useImagePreview();

  // Stabilise callbacks via refs
  const onInsertReferenceRef = useRef(onInsertReference);
  onInsertReferenceRef.current = onInsertReference;

  const onFilePreviewExternalRef = useRef(onFilePreviewExternal);
  onFilePreviewExternalRef.current = onFilePreviewExternal;

  const apiPostRef = useRef(apiPost);
  apiPostRef.current = apiPost;
  const apiGetRef = useRef(apiGet);
  apiGetRef.current = apiGet;

  // Guard against setState after unmount
  const isMountedRef = useRef(true);
  useEffect(() => () => { isMountedRef.current = false; }, []);

  // ---------- Path cache ----------
  const pathCacheRef = useRef<Map<string, PathInfo>>(new Map());
  const pendingPathsRef = useRef<Set<string>>(new Set());
  const batchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);

  // Clear cache when refreshTrigger changes
  useEffect(() => {
    pathCacheRef.current.clear();
    pendingPathsRef.current.clear();
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
      batchTimerRef.current = null;
    }
    setCacheVersion(v => v + 1);
  }, [refreshTrigger]);

  // Clean up batch timer on unmount
  useEffect(() => {
    return () => {
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }
    };
  }, []);

  // Flush pending paths to the backend
  const flushPendingPaths = useCallback(() => {
    const paths = Array.from(pendingPathsRef.current);
    pendingPathsRef.current.clear();
    batchTimerRef.current = null;

    if (paths.length === 0) return;

    void (async () => {
      try {
        const resp = await apiPostRef.current<{ results: Record<string, PathInfo> }>(
          '/agent/check-paths',
          { paths },
        );
        if (!isMountedRef.current) return;
        if (resp?.results) {
          for (const [p, info] of Object.entries(resp.results)) {
            pathCacheRef.current.set(p, info);
          }
          setCacheVersion(v => v + 1);
        }
      } catch {
        // Silently ignore — paths will stay un-cached and remain as plain <code>
      }
    })();
  }, []);

  const checkPath = useCallback((path: string): PathInfo | null => {
    const cached = pathCacheRef.current.get(path);
    if (cached) return cached;

    // Already queued
    if (pendingPathsRef.current.has(path)) return null;

    // Enqueue
    pendingPathsRef.current.add(path);
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(flushPendingPaths, BATCH_DELAY_MS);
    }
    return null;
  }, [flushPendingPaths]);

  // ---------- Context menu ----------
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    path: string;
    pathType: 'file' | 'dir';
  } | null>(null);

  const openFileMenu = useCallback((x: number, y: number, path: string, pathType: 'file' | 'dir') => {
    setMenuState({ x, y, path, pathType });
  }, []);

  const closeMenu = useCallback(() => setMenuState(null), []);

  // ---------- Preview state ----------
  const [previewFile, setPreviewFile] = useState<{
    name: string;
    content: string;
    size: number;
    path: string;
    isLoading: boolean;
    error: string | null;
  } | null>(null);

  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const handlePreview = useCallback((path: string) => {
    const fileName = path.split('/').pop() ?? path;

    if (isImageFile(fileName)) {
      // Fetch image through the Tauri proxy (same approach as DirectoryPanel)
      const endpoint = `/agent/download?path=${encodeURIComponent(path)}`;
      void (async () => {
        try {
          let response: Response;
          if (isTauri()) {
            const baseUrl = await getTabServerUrl(tabIdRef.current);
            response = await proxyFetch(`${baseUrl}${endpoint}`);
          } else {
            response = await fetch(endpoint);
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          if (!isMountedRef.current) return;
          openImagePreview(dataUrl, fileName);
        } catch (err) {
          console.error('[FileAction] Failed to load image:', err);
        }
      })();
      return;
    }

    if (!isPreviewable(fileName)) return;

    // Route to split-view if external handler provided
    if (onFilePreviewExternalRef.current) {
      void (async () => {
        try {
          const resp = await apiGetRef.current<{ content: string; name: string; size: number; error?: string }>(
            `/agent/file?path=${encodeURIComponent(path)}`,
          );
          if (!isMountedRef.current || resp.error) return;
          onFilePreviewExternalRef.current?.({ name: resp.name, content: resp.content, size: resp.size, path });
        } catch { /* split-view fetch errors handled by DirectoryPanel toast */ }
      })();
      return;
    }

    // Fallback: show fullscreen modal immediately in loading state
    setPreviewFile({ name: fileName, content: '', size: 0, path, isLoading: true, error: null });

    void (async () => {
      try {
        const resp = await apiGetRef.current<{ content: string; name: string; size: number; error?: string }>(
          `/agent/file?path=${encodeURIComponent(path)}`,
        );
        if (!isMountedRef.current) return;
        if (resp.error) {
          setPreviewFile(prev => prev ? { ...prev, isLoading: false, error: resp.error ?? 'Unknown error' } : null);
        } else {
          setPreviewFile(prev => prev ? { ...prev, content: resp.content, size: resp.size, name: resp.name, isLoading: false } : null);
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        setPreviewFile(prev => prev ? { ...prev, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load file' } : null);
      }
    })();
  }, [openImagePreview]);

  const handleReference = useCallback((path: string) => {
    onInsertReferenceRef.current?.([path]);
  }, []);

  const handleOpenWithDefault = useCallback((path: string) => {
    void apiPostRef.current('/agent/open-with-default', { path });
  }, []);

  const handleOpenInFinder = useCallback((path: string) => {
    void apiPostRef.current('/agent/open-in-finder', { path });
  }, []);

  // Build menu items
  const menuItems = useMemo((): ContextMenuItem[] => {
    if (!menuState) return [];
    const { path, pathType } = menuState;
    const fileName = path.split('/').pop() ?? path;
    const items: ContextMenuItem[] = [];

    if (pathType === 'file') {
      const canPreview = isPreviewable(fileName) || isImageFile(fileName);
      items.push({
        label: '预览',
        icon: <Eye className="h-4 w-4" />,
        disabled: !canPreview,
        onClick: () => handlePreview(path),
      });
    }

    items.push({
      label: '引用',
      icon: <AtSign className="h-4 w-4" />,
      onClick: () => handleReference(path),
    });

    items.push({
      label: '打开',
      icon: <ExternalLink className="h-4 w-4" />,
      onClick: () => handleOpenWithDefault(path),
    });

    items.push({
      label: '打开所在文件夹',
      icon: <FolderOpen className="h-4 w-4" />,
      onClick: () => handleOpenInFinder(path),
    });

    return items;
  }, [menuState, handlePreview, handleReference, handleOpenWithDefault, handleOpenInFinder]);

  // ---------- Context value ----------
  const contextValue = useMemo<FileActionContextValue>(() => ({
    checkPath,
    cacheVersion,
    openFileMenu,
  }), [checkPath, cacheVersion, openFileMenu]);

  return (
    <FileActionContext.Provider value={contextValue}>
      {children}

      {/* Context menu */}
      {menuState && (
        <ContextMenu
          x={menuState.x}
          y={menuState.y}
          items={menuItems}
          onClose={closeMenu}
        />
      )}

      {/* File preview modal (lazy loaded) */}
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={previewFile.name}
            content={previewFile.content}
            size={previewFile.size}
            path={previewFile.path}
            isLoading={previewFile.isLoading}
            error={previewFile.error}
            onClose={() => setPreviewFile(null)}
          />
        </Suspense>
      )}
    </FileActionContext.Provider>
  );
}
