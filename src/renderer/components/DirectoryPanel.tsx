import {
  AtSign,
  ChevronRight,
  ChevronUp,
  Eye,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Upload,
  PanelRightClose,
  ExternalLink,
  TerminalSquare
} from 'lucide-react';
import Tip from '@/components/Tip';
import { forwardRef, lazy, memo, Suspense, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tree, type TreeApi } from 'react-arborist';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';

import { useTabApi } from '@/context/TabContext';
import { getTabServerUrl, proxyFetch, isTauri } from '@/api/tauriClient';
import type { DirectoryTreeNode, DirectoryTree, ExpandDirectoryResult } from '../../shared/dir-types';
import { isImageFile, isPreviewable } from '../../shared/fileTypes';
import { getFileIcon } from '@/utils/fileIcons';

import { useImagePreview } from '@/context/ImagePreviewContext';
import { useToast } from '@/components/Toast';
import { type Provider } from '@/config/types';
import { isDebugMode } from '@/utils/debug';
import { shortenPathForDisplay } from '@/utils/pathDetection';

import ConfirmDialog from './ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import RenameDialog from './RenameDialog';
import AgentCapabilitiesPanel from './AgentCapabilitiesPanel';
import WorkspaceIcon from './launcher/WorkspaceIcon';

// Lazy load FilePreviewModal - it includes heavy SyntaxHighlighter
const FilePreviewModal = lazy(() => import('./FilePreviewModal'));


/** Imperative handle for DirectoryPanel */
export interface DirectoryPanelHandle {
  /** Handle file drop from Tauri (takes absolute file paths) */
  handleFileDrop: (paths: string[]) => Promise<void>;
  /** Refresh the directory tree */
  refresh: () => void;
}

interface DirectoryPanelProps {
  agentDir: string;
  /** Workspace icon ID (Phosphor) from project config */
  projectIcon?: string;
  /** Custom display name from project config */
  projectDisplayName?: string;
  provider?: Provider | null;
  providers?: Provider[];
  onProviderChange?: (providerId: string, targetModel?: string) => void;
  /** Called when user clicks collapse button (only in wide mode) */
  onCollapse?: () => void;
  /** Called when user clicks "项目设置" button */
  onOpenConfig?: () => void;
  /** External trigger to refresh (incremented when file-modifying tools complete) */
  refreshTrigger?: number;
  /** Trigger full refresh (file tree + capabilities) — called from context menu */
  onRefreshAll?: () => void;
  /** Whether Tauri drag is active over this panel */
  isTauriDragActive?: boolean;
  /** Called when user clicks "引用" to insert @path reference into chat input */
  onInsertReference?: (paths: string[]) => void;
  /** Enabled sub-agent definitions (from Chat.tsx) */
  enabledAgents?: Record<string, { description: string; prompt?: string; model?: string; scope?: 'user' | 'project' }>;
  enabledSkills?: Array<{ name: string; description: string; scope?: 'user' | 'project'; folderName?: string }>;
  enabledCommands?: Array<{ name: string; description: string; scope?: 'user' | 'project' }>;
  /** Set of global skill folderNames (for hiding "sync to global" on already-global skills) */
  globalSkillFolderNames?: Set<string>;
  /** Insert /command into chat input */
  onInsertSlashCommand?: (command: string) => void;
  /** Open settings panel (skills tab) */
  onOpenSettings?: () => void;
  /** Copy a project skill to global skills */
  onSyncSkillToGlobal?: (folderName: string) => void;
  /** When provided, file clicks route to this callback instead of opening the modal.
   *  Used by split-view mode (experimentalSplitView) to open files in a side panel. */
  onFilePreviewExternal?: (file: { name: string; content: string; size: number; path: string }) => void;
  /** Open embedded terminal in split panel */
  onOpenTerminal?: () => void;
  /** Whether an embedded terminal is currently alive (for indicator display) */
  terminalAlive?: boolean;
}

type FilePreview = {
  name: string;
  content: string;
  size: number;
  path: string;
};

type ContextMenuState = {
  x: number;
  y: number;
  node: DirectoryTreeNode | null; // null means root directory
  isMultiSelect?: boolean; // true when multiple nodes are selected
} | null;

type DialogState = {
  type: 'rename' | 'delete' | 'new-file' | 'new-folder' | 'delete-multi';
  node: DirectoryTreeNode | null; // null means root directory for new-file/new-folder
  nodes?: DirectoryTreeNode[]; // for delete-multi
} | null;


function getFolderName(path: string): string {
  if (!path) return 'Workspace';
  // Normalize path separators (support both / and \) and trim trailing slashes
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'Workspace';
}

/** Tree row component — uses @dnd-kit hooks for drag (useDraggable) + drop (useDroppable) */
interface TreeNodeRowProps {
  data: DirectoryTreeNode;
  style: React.CSSProperties;
  isDir: boolean;
  isLoadingDir: boolean;
  isDropTarget: boolean;
  isInternalDropTarget: boolean;
  isDragging: boolean;
  isSelected: boolean;
  isOpen: boolean;
  isInternal: boolean;
  Icon: React.ElementType;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
}

const TreeNodeRow = memo(function TreeNodeRow({
  data, style, isDir, isLoadingDir, isDropTarget, isInternalDropTarget,
  isDragging, isSelected, isOpen, isInternal, Icon,
  onClick, onContextMenu, onDragEnter, onDragLeave,
}: TreeNodeRowProps) {
  // Every row is draggable
  const { attributes, listeners, setNodeRef: setDragRef } = useDraggable({
    id: `drag:${data.path}`,
    data,
  });

  // Only directories are droppable
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop:${data.path}`,
    disabled: !isDir,
  });

  // Merge refs: both drag source and drop target on same element
  const mergedRef = useCallback((el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
  }, [setDragRef, setDropRef]);

  const highlight = isDropTarget || isInternalDropTarget || (isOver && isDir);

  return (
    <div
      ref={mergedRef}
      style={style}
      data-tree-row
      {...attributes}
      {...listeners}
      className={`flex h-full cursor-pointer items-center gap-2 px-3 text-[13px] transition-colors select-none ${
        highlight
          ? 'ring-1 ring-inset ring-[var(--accent)]/40 bg-[var(--accent)]/8'
          : isDragging
            ? 'opacity-40'
            : isSelected
              ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
              : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
      }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--ink-muted)]">
        {isLoadingDir ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isInternal ? (
          <ChevronRight
            className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
        ) : null}
      </span>
      <Icon
        className={`h-3.5 w-3.5 flex-shrink-0 ${
          isDir
            ? 'text-[var(--accent-warm)]/70'
            : 'text-[var(--accent-warm)]'
        }`}
      />
      <span className="min-w-0 flex-1 truncate font-medium select-none">{data.name}</span>
    </div>
  );
});

const DirectoryPanel = memo(forwardRef<DirectoryPanelHandle, DirectoryPanelProps>(function DirectoryPanel({
  agentDir,
  projectIcon,
  projectDisplayName,
  provider: _provider,
  providers: _providers = [],
  onProviderChange: _onProviderChange,
  onCollapse,
  onOpenConfig,
  refreshTrigger,
  onRefreshAll,
  isTauriDragActive = false,
  onInsertReference,
  enabledAgents,
  enabledSkills,
  enabledCommands,
  globalSkillFolderNames,
  onInsertSlashCommand,
  onOpenSettings,
  onSyncSkillToGlobal,
  onFilePreviewExternal,
  onOpenTerminal,
  terminalAlive,
}, ref) {
  const [directoryInfo, setDirectoryInfo] = useState<DirectoryTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Multi-selection support
  const [selectedNodes, setSelectedNodes] = useState<DirectoryTreeNode[]>([]);
  const lastClickedNodeRef = useRef<DirectoryTreeNode | null>(null); // Anchor for shift-select
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(240);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Context menu and dialog states
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [importTargetDir, setImportTargetDir] = useState<string>('');

  // External drag-drop state
  const [isExternalDrop, setIsExternalDrop] = useState(false);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const dragCounterRef = useRef(0);

  // Internal drag-drop state (@dnd-kit pointer-events based)
  const [activeDragItem, setActiveDragItem] = useState<{ paths: string[]; name: string; icon: React.ElementType } | null>(null);
  const [internalDropTarget, setInternalDropTarget] = useState<string | null>(null);
  const internalDropTargetRef = useRef<string | null>(null);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeApiRef = useRef<TreeApi<DirectoryTreeNode> | undefined>(undefined);

  // Sticky header: ancestor breadcrumbs for current scroll position
  const [stickyAncestors, setStickyAncestors] = useState<{ id: string; name: string; depth: number }[]>([]);
  const ROW_HEIGHT = 26;
  const MAX_STICKY_DEPTH = 3;

  const handleTreeScroll = useCallback(({ scrollOffset }: { scrollOffset: number }) => {
    const tree = treeApiRef.current;
    if (!tree || scrollOffset <= 0) {
      setStickyAncestors(prev => prev.length > 0 ? [] : prev);
      return;
    }
    const firstVisibleIndex = Math.floor(scrollOffset / ROW_HEIGHT);
    const node = tree.visibleNodes[firstVisibleIndex];
    if (!node) { setStickyAncestors(prev => prev.length > 0 ? [] : prev); return; }

    // Walk up to collect open ancestor directories (skip root)
    const ancestors: { id: string; name: string; depth: number }[] = [];
    let cur = node.parent;
    while (cur && cur.level >= 0 && ancestors.length < MAX_STICKY_DEPTH) {
      const ancestorIndex = tree.idToIndex[cur.id];
      if (ancestorIndex !== undefined && ancestorIndex < firstVisibleIndex) {
        ancestors.unshift({ id: cur.id, name: (cur.data as DirectoryTreeNode).name, depth: cur.level });
      }
      cur = cur.parent;
    }
    // Only update if different (avoid re-renders on every scroll tick)
    setStickyAncestors(prev => {
      if (prev.length !== ancestors.length) return ancestors;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].id !== ancestors[i].id) return ancestors;
      }
      return prev;
    });
  }, []); // stable — no dependencies, uses functional updater throughout

  // Git branch state
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  // Lazy loading state - track directories currently being loaded
  // Use ref to store actual data, state only for triggering UI updates
  const loadingDirsRef = useRef<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());

  // Image preview context
  const { openPreview } = useImagePreview();

  // Toast for notifications
  const toast = useToast();

  // Get Tab-scoped API functions and tabId
  const { apiGet, apiPost, tabId } = useTabApi();

  // Narrow mode collapse state (for responsive layout)
  const [isNarrowMode, setIsNarrowMode] = useState(false);

  // ── Vertical drag: tree / capabilities ratio ──
  // Default 0.6 = tree 60%, capabilities 40%. Resets on tab close (local state).
  const [capRatio, setCapRatio] = useState(0.4);
  const capRatioRef = useRef(0.4);
  capRatioRef.current = capRatio;
  const isDraggingCapRef = useRef(false);
  const capDragMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const capDragUpRef = useRef<(() => void) | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(true); // Default collapsed in narrow mode
  const panelRef = useRef<HTMLDivElement>(null);

  // Detect narrow mode (when panel becomes full width, i.e. stacked layout)
  useEffect(() => {
    const checkNarrowMode = () => {
      // Check if we're in stacked/narrow layout by checking window width
      // Use CSS custom property --breakpoint-mobile (768px) for consistency
      const breakpoint = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--breakpoint-mobile') || '768', 10);
      const narrow = window.innerWidth < breakpoint;
      setIsNarrowMode(narrow);
      if (!narrow) {
        setIsCollapsed(false); // Always show in wide mode
      } else {
        setIsCollapsed(true); // Default collapsed in narrow mode
      }
    };

    checkNarrowMode();
    window.addEventListener('resize', checkNarrowMode);
    return () => window.removeEventListener('resize', checkNarrowMode);
  }, []);


  const folderName = getFolderName(agentDir);

  // Track previous item count to only log when changed
  const prevItemCountRef = useRef(-1);

  // Raw refresh — fetches full directory tree from backend.
  // Not debounced; used for initial load and explicit user actions (manual refresh button).
  const rawRefresh = useCallback(() => {
    setError(null);
    apiGet<DirectoryTree>('/agent/dir')
      .then((data) => {
        const newCount = data.tree?.children?.length || 0;
        if (newCount !== prevItemCountRef.current) {
          console.log(`[DirectoryPanel] Directory tree refreshed: ${newCount} items`);
          prevItemCountRef.current = newCount;
        }
        setDirectoryInfo(data);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load directory info');
        console.error('[DirectoryPanel] Failed to refresh:', err);
      });
  }, [apiGet]);

  // Debounced refresh — coalesces rapid triggers (file watcher + tool completion
  // can fire within 500ms of each other) into a single API call.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      rawRefresh();
    }, 300);
  }, [rawRefresh]);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Stable ref for refresh to avoid timer recreation
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // Helper to update a specific node in the tree
  const updateNodeInTree = useCallback((
    nodes: DirectoryTreeNode[],
    targetPath: string,
    updater: (node: DirectoryTreeNode) => DirectoryTreeNode
  ): DirectoryTreeNode[] => {
    return nodes.map(node => {
      if (node.path === targetPath) {
        return updater(node);
      }
      if (node.children && node.type === 'dir') {
        return {
          ...node,
          children: updateNodeInTree(node.children, targetPath, updater)
        };
      }
      return node;
    });
  }, []);

  // Expand a directory that hasn't been fully loaded
  const expandDir = useCallback(async (dirPath: string) => {
    // Use ref to check loading status (stable reference, avoids dependency issues)
    if (loadingDirsRef.current.has(dirPath)) return; // Already loading

    // Update both ref and state
    loadingDirsRef.current.add(dirPath);
    setLoadingDirs(new Set(loadingDirsRef.current));

    try {
      const result = await apiGet<ExpandDirectoryResult>(
        `/agent/dir/expand?path=${encodeURIComponent(dirPath)}`
      );

      setDirectoryInfo((prev: DirectoryTree | null) => {
        if (!prev) return prev;
        const updatedChildren = updateNodeInTree(
          prev.tree.children ?? [],
          dirPath,
          (node) => ({
            ...node,
            children: result.children,
            loaded: result.loaded
          })
        );
        return {
          ...prev,
          tree: {
            ...prev.tree,
            children: updatedChildren
          }
        };
      });
    } catch (err) {
      console.error('[DirectoryPanel] Failed to expand directory:', err);
    } finally {
      // Update both ref and state
      loadingDirsRef.current.delete(dirPath);
      setLoadingDirs(new Set(loadingDirsRef.current));
    }
  }, [apiGet, updateNodeInTree]);

  useEffect(() => {
    rawRefresh(); // Initial load — no debounce needed
    // Clear old branch first to avoid flash, then fetch new
    setGitBranch(null);
    apiGet<{ branch: string | null }>('/api/git/branch')
      .then((data) => setGitBranch(data.branch))
      .catch(() => setGitBranch(null));
  }, [agentDir, apiGet, rawRefresh]);

  // Respond to external refresh trigger (file watcher SSE + tool completion fast-path).
  // Uses debounced refresh to coalesce rapid triggers.
  useEffect(() => {
    if (refreshTrigger && refreshTrigger > 0) {
      refresh();
    }
  }, [refreshTrigger, refresh]);

  // Safety-net polling: catch anything the file watcher might miss.
  // With the watcher active, this is a fallback — 120s is sufficient.
  useEffect(() => {
    const interval = setInterval(() => refreshRef.current(), 120_000);
    return () => clearInterval(interval);
  }, []);

  const updateTreeHeight = () => {
    const element = treeContainerRef.current;
    if (!element) {
      return;
    }
    const nextHeight = Math.max(180, Math.floor(element.getBoundingClientRect().height));
    setTreeHeight(nextHeight);
  };

  useLayoutEffect(() => {
    updateTreeHeight();
  }, [directoryInfo]);

  // Vertical divider drag handler (tree ↔ capabilities)
  const handleCapDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingCapRef.current = true;
    const startY = e.clientY;
    const startRatio = capRatioRef.current;
    const containerHeight = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().height;
    if (containerHeight <= 0) return; // Guard against zero-height container (collapsed/hidden)

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingCapRef.current) return;
      const dy = ev.clientY - startY;
      // dy > 0 = mouse moves down = capabilities shrinks
      const newRatio = Math.max(0.15, Math.min(0.65, startRatio - dy / containerHeight));
      setCapRatio(newRatio);
    };
    const onMouseUp = () => {
      isDraggingCapRef.current = false;
      capDragMoveRef.current = null;
      capDragUpRef.current = null;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Final tree height update after drag ends
      requestAnimationFrame(updateTreeHeight);
    };
    capDragMoveRef.current = onMouseMove;
    capDragUpRef.current = onMouseUp;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []); // stable — uses refs

  // Cleanup cap drag listeners on unmount (match Chat.tsx pattern: reset body styles too)
  useEffect(() => {
    return () => {
      if (capDragMoveRef.current) document.removeEventListener('mousemove', capDragMoveRef.current);
      if (capDragUpRef.current) document.removeEventListener('mouseup', capDragUpRef.current);
      isDraggingCapRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  // Re-run when directoryInfo changes because the tree container is conditionally rendered
  // and may not exist on initial mount (the ref would be null with [] deps)
  useEffect(() => {
    const element = treeContainerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(updateTreeHeight);
    });

    observer.observe(element);
    window.addEventListener('resize', updateTreeHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateTreeHeight);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Re-attach observer when tree container first appears
  }, [!!directoryInfo]);

  const treeData = useMemo(() => {
    return directoryInfo?.tree.children ?? [];
  }, [directoryInfo]);

  // Flatten tree for shift-select range selection
  const flattenedNodes = useMemo(() => {
    const result: DirectoryTreeNode[] = [];
    const flatten = (nodes: DirectoryTreeNode[]) => {
      for (const node of nodes) {
        result.push(node);
        if (node.type === 'dir' && node.children) {
          flatten(node.children);
        }
      }
    };
    flatten(treeData);
    return result;
  }, [treeData]);

  // Helper to check if a node is selected
  const isNodeSelected = useCallback((node: DirectoryTreeNode) => {
    return selectedNodes.some(n => n.path === node.path);
  }, [selectedNodes]);

  const handlePreview = async (node: DirectoryTreeNode) => {
    if (node.type !== 'file' || isPreviewLoading) {
      return;
    }

    setIsPreviewLoading(true);

    try {
      const payload = await apiGet<Omit<FilePreview, 'path'>>(`/agent/file?path=${encodeURIComponent(node.path)}`);
      const fileData = { ...payload, path: node.path };
      // Route to external handler (split view) if provided, otherwise open modal
      if (onFilePreviewExternal) {
        onFilePreviewExternal(fileData);
      } else {
        setPreview(fileData);
        setPreviewError(null);
      }
    } catch (err) {
      if (onFilePreviewExternal) {
        toast.error('文件预览失败');
      } else {
        setPreview(null);
        setPreviewError(err instanceof Error ? err.message : 'Failed to preview file.');
      }
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const handleImagePreview = async (node: DirectoryTreeNode) => {
    if (node.type !== 'file') return;
    try {
      const endpoint = `/agent/download?path=${encodeURIComponent(node.path)}`;
      let response: Response;
      if (isTauri()) {
        const baseUrl = await getTabServerUrl(tabId);
        response = await proxyFetch(`${baseUrl}${endpoint}`);
      } else {
        response = await fetch(endpoint);
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      openPreview(dataUrl, node.name);
    } catch (err) {
      console.error('[DirectoryPanel] Failed to load image:', err);
      toast.error('图片加载失败');
    }
  };

  const handleImport = async (files: FileList | null) => {
    if (!files || files.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach((file) => {
        formData.append('files', file, file.name);
      });
      const url = importTargetDir
        ? `/agent/import?targetDir=${encodeURIComponent(importTargetDir)}`
        : '/agent/import';
      const response = await fetch(url, {
        method: 'POST',
        body: formData
      });
      if (!response.ok) {
        throw new Error('Import failed');
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsUploading(false);
      setImportTargetDir('');
    }
  };

  // Helper function to convert File to base64
  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  // External file import for drag-drop
  const handleExternalFileDrop = useCallback(async (files: File[], targetDir: string = '') => {
    if (files.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      // Convert files to base64 for JSON upload (works in Tauri)
      const base64Files = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          content: await fileToBase64(file),
        }))
      );

      // Upload via base64 API endpoint
      const result = await apiPost<{ success: boolean; files: string[]; error?: string }>(
        '/api/files/import-base64',
        { files: base64Files, targetDir }
      );

      if (!result.success) {
        throw new Error(result.error || 'Import failed');
      }

      refresh();
    } catch (err) {
      console.error('[DirectoryPanel] File upload error:', err);
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setIsUploading(false);
    }
  }, [isUploading, refresh, apiPost, fileToBase64]);

  // Handle file paths from Tauri drag-drop (copies from OS paths)
  const handleTauriFileDrop = useCallback(async (paths: string[], targetDir: string = '') => {
    if (paths.length === 0 || isUploading) {
      return;
    }

    setIsUploading(true);
    try {
      // Use /api/files/copy which handles copying from OS paths
      const result = await apiPost<{
        success: boolean;
        copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }>;
        error?: string;
      }>('/api/files/copy', {
        sourcePaths: paths,
        targetDir: targetDir,
        autoRename: true,
      });

      if (!result.success) {
        throw new Error(result.error || 'Copy failed');
      }

      if (isDebugMode()) {
        console.log('[DirectoryPanel] Tauri drop copied files:', result.copiedFiles);
      }
      refresh();
    } catch (err) {
      console.error('[DirectoryPanel] Tauri file drop error:', err);
      setError(err instanceof Error ? err.message : 'Copy failed');
    } finally {
      setIsUploading(false);
    }
  }, [isUploading, refresh, apiPost]);

  // Expose imperative handle for parent to call
  useImperativeHandle(ref, () => ({
    handleFileDrop: async (paths: string[]) => {
      // Determine target directory based on selection (use first selected item)
      let targetDir = '';
      const firstSelected = selectedNodes[0];
      if (firstSelected) {
        if (firstSelected.type === 'dir') {
          targetDir = firstSelected.path;
        } else {
          // For files, use parent directory
          const parts = firstSelected.path.split('/');
          parts.pop();
          targetDir = parts.join('/');
        }
      }
      await handleTauriFileDrop(paths, targetDir);
    },
    refresh,
  }), [selectedNodes, handleTauriFileDrop, refresh]);

  // Check if a drag event contains external files
  const isExternalFileDrag = useCallback((e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types ?? [];
    return types.includes('Files');
  }, []);

  // Tree container drag handlers
  const handleTreeDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isExternalFileDrag(e)) {
      return;
    }

    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsExternalDrop(true);
    }
  }, [isExternalFileDrag]);

  const handleTreeDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isExternalFileDrag(e)) return;

    e.dataTransfer.dropEffect = 'copy';
  }, [isExternalFileDrag]);

  const handleTreeDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsExternalDrop(false);
      setDropTargetPath(null);
    }
  }, []);

  const handleTreeDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current = 0;
    setIsExternalDrop(false);

    const targetPath = dropTargetPath ?? '';
    setDropTargetPath(null);

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) {
      if (isDebugMode()) {
        console.log('[DirectoryPanel] Dropped', files.length, 'files to:', targetPath || 'root');
      }
      void handleExternalFileDrop(files, targetPath);
    }
  }, [dropTargetPath, handleExternalFileDrop]);

  // Row-level drag handlers for directory highlighting
  const handleRowDragEnter = useCallback((e: React.DragEvent, nodePath: string, isDir: boolean) => {
    e.stopPropagation();
    if (!isExternalFileDrag(e)) return;

    // Only highlight directories
    if (isDir) {
      setDropTargetPath(nodePath);
    }
  }, [isExternalFileDrag]);

  const handleRowDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    // Don't clear dropTargetPath here - let tree level handler or drop handler do it
  }, []);

  // Move handler (used by both internal DnD and context menu)
  const handleMove = useCallback(async (sourcePaths: string[], targetDir: string) => {
    try {
      await apiPost('/agent/move', { sourcePaths, targetDir });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Move failed');
    }
  }, [apiPost, refresh]);

  // --- Internal DnD via @dnd-kit (pointer-events based, reliable in Tauri WebView) ---
  const updateDropTarget = useCallback((val: string | null) => {
    internalDropTargetRef.current = val;
    setInternalDropTarget(val);
  }, []);

  const clearAutoExpandTimer = useCallback(() => {
    if (autoExpandTimerRef.current !== null) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
  }, []);

  // Lookup map for hit-testing during drag
  const nodeByPath = useMemo(() => {
    const map = new Map<string, DirectoryTreeNode>();
    flattenedNodes.forEach(n => map.set(n.path, n));
    return map;
  }, [flattenedNodes]);

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDndDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as DirectoryTreeNode | undefined;
    if (!data) return;
    // Multi-select: if dragged item is selected and there are multiple selections, drag all
    const paths = selectedNodes.some(n => n.path === data.path) && selectedNodes.length > 1
      ? selectedNodes.map(n => n.path)
      : [data.path];
    const icon = data.type === 'dir' ? Folder : getFileIcon(data.name);
    setActiveDragItem({ paths, name: data.name, icon });
  }, [selectedNodes]);

  const handleDndDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) {
      // Over empty space — target root
      if (internalDropTargetRef.current !== '') {
        updateDropTarget('');
        clearAutoExpandTimer();
      }
      return;
    }
    // Drop targets have id = "drop:{path}"
    const targetPath = overId.startsWith('drop:') ? overId.slice(5) : null;
    if (targetPath === null) return;

    if (internalDropTargetRef.current !== targetPath) {
      updateDropTarget(targetPath);
      clearAutoExpandTimer();
      // Auto-expand closed folder after 600ms hover
      const nodeData = nodeByPath.get(targetPath);
      autoExpandTimerRef.current = setTimeout(() => {
        if (nodeData?.loaded === false) {
          void expandDir(targetPath);
        }
        treeApiRef.current?.open(targetPath);
      }, 600);
    }
  }, [updateDropTarget, clearAutoExpandTimer, nodeByPath, expandDir]);

  const handleDndDragEnd = useCallback((_event: DragEndEvent) => {
    const dragItem = activeDragItem;
    const targetPath = internalDropTargetRef.current;
    // Clean up state first
    setActiveDragItem(null);
    updateDropTarget(null);
    clearAutoExpandTimer();

    if (!dragItem || targetPath === null) return;
    const sourcePaths = dragItem.paths;
    // Don't drop on itself or into descendant
    if (sourcePaths.includes(targetPath)) return;
    if (targetPath && sourcePaths.some(p => targetPath.startsWith(p + '/'))) return;
    void handleMove(sourcePaths, targetPath);
  }, [activeDragItem, handleMove, updateDropTarget, clearAutoExpandTimer]);

  const handleDndDragCancel = useCallback(() => {
    setActiveDragItem(null);
    updateDropTarget(null);
    clearAutoExpandTimer();
  }, [updateDropTarget, clearAutoExpandTimer]);

  // Clean up auto-expand timer on unmount
  useEffect(() => clearAutoExpandTimer, [clearAutoExpandTimer]);

  // Keyboard paste handler (Cmd/Ctrl+V)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      // Check if DirectoryPanel is focused or its children
      if (!panelRef.current?.contains(document.activeElement) &&
          document.activeElement !== panelRef.current) {
        return;
      }

      // Check if it's a text input/textarea - don't intercept paste there
      const activeElement = document.activeElement as HTMLElement;
      if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') {
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) {
        return;
      }

      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length === 0) {
        return;
      }

      e.preventDefault();

      // Determine target directory based on selection (use first selected item)
      let targetDir = '';
      const firstSelected = selectedNodes[0];
      if (firstSelected) {
        if (firstSelected.type === 'dir') {
          targetDir = firstSelected.path;
        } else {
          // For files, use parent directory
          const parts = firstSelected.path.split('/');
          parts.pop();
          targetDir = parts.join('/');
        }
      }

      if (isDebugMode()) {
        console.log('[DirectoryPanel] Pasting', files.length, 'files to:', targetDir || 'root');
      }
      await handleExternalFileDrop(files, targetDir);
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [selectedNodes, handleExternalFileDrop]);

  const handleOpenInFinder = async (path: string) => {
    try {
      await apiPost('/agent/open-in-finder', { path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open');
    }
  };

  const handleOpenWithDefault = async (path: string) => {
    try {
      await apiPost('/agent/open-with-default', { path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open');
    }
  };

  const handleRename = async (oldPath: string, newName: string) => {
    try {
      await apiPost('/agent/rename', { oldPath, newName });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  };

  const handleDelete = async (path: string) => {
    try {
      await apiPost('/agent/delete', { path });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleNewFile = async (parentDir: string, name: string) => {
    try {
      await apiPost('/agent/new-file', { parentDir, name });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const handleNewFolder = async (parentDir: string, name: string) => {
    try {
      await apiPost('/agent/new-folder', { parentDir, name });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  };

  const handleContextMenu = (e: React.MouseEvent, node: DirectoryTreeNode | null) => {
    e.preventDefault();
    e.stopPropagation();

    // If right-clicking on empty area, clear selection and show root menu
    if (!node) {
      setSelectedNodes([]);
      setContextMenu({ x: e.clientX, y: e.clientY, node: null, isMultiSelect: false });
      return;
    }

    // If the clicked node is already in selection and we have multiple selections,
    // show multi-select menu
    const isAlreadySelected = selectedNodes.some(n => n.path === node.path);
    if (isAlreadySelected && selectedNodes.length > 1) {
      setContextMenu({ x: e.clientX, y: e.clientY, node, isMultiSelect: true });
    } else {
      // Single selection - select only this node
      setSelectedNodes([node]);
      lastClickedNodeRef.current = node;
      setContextMenu({ x: e.clientX, y: e.clientY, node, isMultiSelect: false });
    }
  };

  const handleTreeContainerContextMenu = (e: React.MouseEvent) => {
    // Only trigger if clicking on empty area (not on a tree item)
    const target = e.target as HTMLElement;
    if (target === treeContainerRef.current || target.closest('[data-tree-root]')) {
      handleContextMenu(e, null);
    }
  };

  // Get unique parent directories for multi-select "open in finder"
  const getUniqueParentDirs = (nodes: DirectoryTreeNode[]): string[] => {
    const parentDirs = new Set<string>();
    for (const node of nodes) {
      if (node.type === 'dir') {
        parentDirs.add(node.path);
      } else {
        const parts = node.path.split('/');
        parts.pop();
        parentDirs.add(parts.join('/') || '.');
      }
    }
    return Array.from(parentDirs);
  };

  // Handle multi-select delete
  const handleDeleteMultiple = async (nodes: DirectoryTreeNode[]) => {
    try {
      // Filter out nodes whose parent is also selected (avoid deleting already-deleted paths)
      const nodePaths = new Set(nodes.map(n => n.path));
      const filteredNodes = nodes.filter(node => {
        // Check if any other selected node is a parent of this node
        const parts = node.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const parentPath = parts.slice(0, i).join('/');
          if (nodePaths.has(parentPath)) {
            return false; // Skip this node, its parent will be deleted
          }
        }
        return true;
      });

      for (const node of filteredNodes) {
        await apiPost('/agent/delete', { path: node.path });
      }
      setSelectedNodes([]);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const getContextMenuItems = (node: DirectoryTreeNode | null, isMultiSelect?: boolean): ContextMenuItem[] => {
    // Multi-select menu
    if (isMultiSelect && selectedNodes.length > 1) {
      const uniqueParentDirs = getUniqueParentDirs(selectedNodes);
      return [
        {
          label: `打开所在文件夹 (${uniqueParentDirs.length})`,
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => {
            for (const dir of uniqueParentDirs) {
              void handleOpenInFinder(dir);
            }
          }
        },
        {
          label: `引用 (${selectedNodes.length})`,
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => {
            onInsertReference?.(selectedNodes.map(n => n.path));
          }
        },
        {
          label: `删除 (${selectedNodes.length})`,
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete-multi', node: null, nodes: selectedNodes })
        }
      ];
    }

    // Root directory menu (empty area)
    if (!node) {
      return [
        {
          label: '导入文件',
          icon: <Upload className="h-4 w-4" />,
          onClick: () => {
            setImportTargetDir('');
            importInputRef.current?.click();
          }
        },
        {
          label: '新建文件',
          icon: <FilePlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-file', node: null })
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-folder', node: null })
        },
        {
          label: '刷新',
          icon: <RefreshCw className="h-4 w-4" />,
          onClick: () => { refresh(); onRefreshAll?.(); }
        }
      ];
    }

    const isDir = node.type === 'dir';
    const canPreview = !isDir && (isPreviewable(node.name) || isImageFile(node.name));

    if (isDir) {
      return [
        {
          label: '新建文件',
          icon: <FilePlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-file', node })
        },
        {
          label: '新建文件夹',
          icon: <FolderPlus className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'new-folder', node })
        },
        {
          label: '导入文件',
          icon: <Upload className="h-4 w-4" />,
          onClick: () => {
            setImportTargetDir(node.path);
            importInputRef.current?.click();
          }
        },
        {
          label: '打开所在文件夹',
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => handleOpenInFinder(node.path)
        },
        {
          label: '引用',
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => onInsertReference?.([node.path])
        },
        {
          label: '重命名',
          icon: <Pencil className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'rename', node })
        },
        {
          label: '删除',
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete', node })
        },
        { separator: true },
        {
          label: '刷新',
          icon: <RefreshCw className="h-4 w-4" />,
          onClick: () => { refresh(); onRefreshAll?.(); }
        }
      ];
    } else {
      return [
        {
          label: '预览',
          icon: <Eye className="h-4 w-4" />,
          disabled: !canPreview,
          onClick: () => {
            if (isImageFile(node.name)) {
              void handleImagePreview(node);
            } else if (isPreviewable(node.name)) {
              void handlePreview(node);
            }
          }
        },
        {
          label: '引用',
          icon: <AtSign className="h-4 w-4" />,
          onClick: () => onInsertReference?.([node.path])
        },
        {
          label: '打开',
          icon: <ExternalLink className="h-4 w-4" />,
          onClick: () => handleOpenWithDefault(node.path)
        },
        {
          label: '打开所在文件夹',
          icon: <FolderOpen className="h-4 w-4" />,
          onClick: () => handleOpenInFinder(node.path)
        },
        {
          label: '重命名',
          icon: <Pencil className="h-4 w-4" />,
          onClick: () => setDialog({ type: 'rename', node })
        },
        {
          label: '删除',
          icon: <Trash2 className="h-4 w-4" />,
          danger: true,
          onClick: () => setDialog({ type: 'delete', node })
        }
      ];
    }
  };

  // Get parent directory path for new file/folder creation
  const getParentDirForCreate = (node: DirectoryTreeNode | null): string => {
    if (!node) return ''; // root directory
    if (node.type === 'dir') return node.path;
    // For files, get parent directory
    const parts = node.path.split('/');
    parts.pop();
    return parts.join('/');
  };

  return (
    <div
      ref={panelRef}
      tabIndex={0}
      className={`flex flex-col bg-[var(--paper-elevated)] outline-none overscroll-none ${isNarrowMode && isCollapsed ? 'h-12' : 'h-full'
        }`}
    >
      {/* Title bar - aligned with left panel header */}
      <div
        className={`flex h-12 flex-shrink-0 items-center justify-between px-4 select-none ${isNarrowMode ? 'cursor-pointer hover:bg-[var(--hover-bg)]' : ''
          }`}
        onClick={isNarrowMode ? () => setIsCollapsed(!isCollapsed) : undefined}
      >
        <div className="flex items-center gap-2">
          {/* Collapse toggle button - in wide mode, calls onCollapse */}
          {!isNarrowMode && onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title="收起工作区"
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          )}
          <span className="text-base font-semibold text-[var(--ink)]">项目工作区</span>
          {/* Terminal button — next to title */}
          {onOpenTerminal && (
            <Tip label={terminalAlive ? '显示终端' : '打开终端'} position="bottom">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTerminal();
                }}
                className={`relative flex h-5 w-5 items-center justify-center rounded transition-colors ${
                  terminalAlive
                    ? 'text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]'
                    : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                }`}
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                {/* Alive indicator dot */}
                {terminalAlive && (
                  <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                )}
              </button>
            </Tip>
          )}
        </div>
        {/* Right side buttons */}
        <div className="flex items-center gap-1">
          {onOpenConfig && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenConfig();
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
              title="打开 Agent 设置"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Agent 设置
            </button>
          )}
          {/* Collapse toggle button - only in narrow mode, positioned at far right */}
          {isNarrowMode && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsCollapsed(!isCollapsed);
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              title={isCollapsed ? '展开工作区' : '折叠工作区'}
            >
              <ChevronUp className={`h-4 w-4 transition-transform ${isCollapsed ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* Collapsible content - hidden in narrow mode when collapsed */}
      {!(isNarrowMode && isCollapsed) && (
        <>
          {/* Inset divider: header → folder info */}
          <div className="mx-4 border-b border-[var(--line-subtle)]" />

          {/* Folder header — icon left, two-row text right (matches Launcher card layout) */}
          <div className="flex items-center gap-3 px-4 pb-2 pt-3">
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center">
              <WorkspaceIcon icon={projectIcon} size={28} />
            </span>
            <div className="min-w-0 flex-1">
              {/* First row: name, git branch, stats */}
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-[var(--ink)]">{projectDisplayName || folderName}</span>
                {gitBranch && (
                  <span className="flex items-center gap-0.5 rounded-md bg-[var(--accent-warm-subtle)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--ink-muted)]">
                    <GitBranch className="h-3 w-3" />
                    {gitBranch}
                  </span>
                )}
                {directoryInfo && (
                  <span className="ml-auto flex-shrink-0 text-[11px] text-[var(--ink-muted)]">
                    {directoryInfo.summary.totalFiles} 文件 · {directoryInfo.summary.totalDirs} 文件夹
                  </span>
                )}
              </div>
              {/* Second row: path */}
              <div className="mt-0.5 truncate text-[11px] text-[var(--ink-muted)]">{shortenPathForDisplay(agentDir)}</div>
            </div>
            {/* Hidden file input for import functionality */}
            <input
              ref={importInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => handleImport(event.target.files)}
              disabled={isUploading}
            />
          </div>

          {/* Tree + Capabilities container (60/40 split) */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Tree container */}
            <div
              ref={treeContainerRef}
              className={`relative min-h-0 flex-1 overflow-hidden overscroll-none ${isExternalDrop || isTauriDragActive ? 'ring-2 ring-inset ring-[var(--accent)]/30' : ''}`}
              onContextMenu={handleTreeContainerContextMenu}
              onDragEnter={handleTreeDragEnter}
              onDragOver={handleTreeDragOver}
              onDragLeave={handleTreeDragLeave}
              onDrop={handleTreeDrop}
              onClick={(e) => {
                // Clear selection when clicking empty area in tree container
                const target = e.target as HTMLElement;
                const isTreeRow = target.closest('[data-tree-row]');
                if (!isTreeRow) {
                  setSelectedNodes([]);
                  lastClickedNodeRef.current = null;
                }
              }}
              data-tree-root
            >
              {/* Sticky ancestor breadcrumbs — floats above the virtualized tree */}
              {stickyAncestors.length > 0 && (
                <div className="absolute left-0 right-0 top-0 z-10 border-b border-[var(--line-subtle)] bg-[var(--paper-elevated)] shadow-xs">
                  {stickyAncestors.map((ancestor) => (
                    <button
                      key={ancestor.id}
                      type="button"
                      className="flex w-full cursor-pointer items-center gap-2 px-3 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                      style={{ height: ROW_HEIGHT, paddingLeft: `${12 + ancestor.depth * 16}px` }}
                      onClick={() => {
                        const tree = treeApiRef.current;
                        if (tree) {
                          tree.close(ancestor.id);
                        }
                      }}
                    >
                      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                        <ChevronRight className="h-3 w-3 rotate-90 transition-transform" />
                      </span>
                      <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
                      <span className="min-w-0 flex-1 truncate">{ancestor.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {error && <div className="px-4 py-3 text-xs text-[var(--error)]">{error}</div>}
              {!error && !directoryInfo && (
                <div className="px-4 py-3 text-xs text-[var(--ink-muted)]">Loading...</div>
              )}
              {directoryInfo && (
                <DndContext
                  sensors={dndSensors}
                  onDragStart={handleDndDragStart}
                  onDragOver={handleDndDragOver}
                  onDragEnd={handleDndDragEnd}
                  onDragCancel={handleDndDragCancel}
                >
                <Tree
                  ref={treeApiRef}
                  data={treeData}
                  openByDefault={false}
                  disableMultiSelection
                  disableEdit
                  disableDrag
                  disableDrop
                  rowHeight={ROW_HEIGHT}
                  indent={16}
                  paddingTop={stickyAncestors.length * ROW_HEIGHT}
                  height={treeHeight}
                  width="100%"
                  className="overscroll-none"
                  onScroll={handleTreeScroll}
                >
                {({ node, style }) => {
                  const data = node.data as DirectoryTreeNode;
                  const isDir = data.type === 'dir';
                  // Check if this is the pm_copilot_files folder (special folder for imported files)
                  const _isPmCopilotFiles = data.path === 'pm_copilot_files' && isDir;
                  const Icon =
                    isDir ?
                      node.isOpen ?
                        FolderOpen
                        : Folder
                      : getFileIcon(data.name);

                  const isLoadingDir = isDir && loadingDirs.has(data.path);
                  const isDropTarget = isDir && dropTargetPath === data.path && isExternalDrop;
                  const isSelected = isNodeSelected(data);

                  // Helper to execute file preview (extracted for reuse)
                  const executeFilePreview = async () => {
                    // Update selection immediately for visual feedback, even if preview is loading
                    setSelectedNodes([data]);
                    lastClickedNodeRef.current = data;

                    if (isPreviewLoading) return;

                    // Preview based on file type
                    if (isImageFile(data.name)) {
                      setIsPreviewLoading(true);
                      try {
                        // Use Tab-scoped fetch to ensure correct Sidecar in multi-Tab scenarios
                        const endpoint = `/agent/download?path=${encodeURIComponent(data.path)}`;
                        let response: Response;
                        if (isTauri()) {
                          const baseUrl = await getTabServerUrl(tabId);
                          response = await proxyFetch(`${baseUrl}${endpoint}`);
                        } else {
                          response = await fetch(endpoint);
                        }
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        const blob = await response.blob();
                        const dataUrl = await new Promise<string>((resolve, reject) => {
                          const reader = new FileReader();
                          reader.onload = () => resolve(reader.result as string);
                          reader.onerror = () => reject(reader.error);
                          reader.readAsDataURL(blob);
                        });
                        openPreview(dataUrl, data.name);
                      } catch (err) {
                        console.error('[DirectoryPanel] Failed to load image:', err);
                        toast.error('图片加载失败');
                      } finally {
                        setIsPreviewLoading(false);
                      }
                    } else if (isPreviewable(data.name)) {
                      void handlePreview(data);
                    } else {
                      // File type not supported for preview
                      toast.info('暂不支持预览此文件类型，可右键进入文件夹打开');
                    }
                  };

                  const handleRowClick = (e: React.MouseEvent) => {
                    const isMeta = e.metaKey || e.ctrlKey;
                    const isShift = e.shiftKey;

                    if (isMeta) {
                      // Ctrl/Cmd + click: toggle multi-select (files & folders)
                      setSelectedNodes(prev =>
                        prev.some(n => n.path === data.path)
                          ? prev.filter(n => n.path !== data.path)
                          : [...prev, data]
                      );
                      lastClickedNodeRef.current = data;
                    } else if (isShift && lastClickedNodeRef.current) {
                      // Shift + click: range selection
                      const startIdx = flattenedNodes.findIndex(n => n.path === lastClickedNodeRef.current!.path);
                      const endIdx = flattenedNodes.findIndex(n => n.path === data.path);
                      if (startIdx !== -1 && endIdx !== -1) {
                        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                        setSelectedNodes(flattenedNodes.slice(from, to + 1));
                      }
                    } else if (isDir) {
                      // Directory plain click: select
                      setSelectedNodes([data]);
                      lastClickedNodeRef.current = data;
                    } else {
                      // File plain click: select + preview
                      // executeFilePreview() already calls setSelectedNodes([data])
                      void executeFilePreview();
                    }

                    // Toggle directory expand/collapse (immediate for better UX)
                    if (isDir) {
                      if (!node.isOpen && data.loaded === false) {
                        void expandDir(data.path);
                      }
                      node.toggle();
                    }
                  };

                  // @dnd-kit: check if this node is a drop target or being dragged
                  const isInternalDropTarget = isDir && internalDropTarget === data.path;
                  const isDragging = !!activeDragItem?.paths.includes(data.path);

                  return (
                    <TreeNodeRow
                      key={data.id}
                      data={data}
                      style={style}
                      isDir={isDir}
                      isLoadingDir={isLoadingDir}
                      isDropTarget={isDropTarget}
                      isInternalDropTarget={isInternalDropTarget}
                      isDragging={isDragging}
                      isSelected={isSelected}
                      isOpen={node.isOpen}
                      isInternal={node.isInternal}
                      Icon={Icon}
                      onClick={handleRowClick}
                      onContextMenu={(e) => handleContextMenu(e, data)}
                      onDragEnter={(e) => handleRowDragEnter(e, data.path, isDir)}
                      onDragLeave={handleRowDragLeave}
                    />
                  );
                }}
                </Tree>
                {/* Drag overlay — floating preview that follows cursor */}
                <DragOverlay dropAnimation={null}>
                  {activeDragItem && (
                    <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1 text-[13px] shadow-lg">
                      <activeDragItem.icon className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]" />
                      <span className="font-medium text-[var(--ink)]">{activeDragItem.name}</span>
                      {activeDragItem.paths.length > 1 && (
                        <span className="text-xs text-[var(--ink-muted)]">+{activeDragItem.paths.length - 1}</span>
                      )}
                    </div>
                  )}
                </DragOverlay>
                </DndContext>
              )}
            </div>

            {/* Vertical drag divider — tree ↔ capabilities
                Outer div: invisible hit area (py-1.5 = 12px), cursor hint
                Inner div: thin visual line, hover changes color via group */}
            <div
              className="group/cap-divider mx-4 cursor-row-resize py-1.5"
              onMouseDown={handleCapDividerMouseDown}
            >
              <div className="border-b border-[var(--line-subtle)] transition-colors group-hover/cap-divider:border-[var(--accent)]/40" />
            </div>

            {/* Agent Capabilities Panel */}
            <AgentCapabilitiesPanel
              enabledAgents={enabledAgents}
              enabledSkills={enabledSkills}
              enabledCommands={enabledCommands}
              globalSkillFolderNames={globalSkillFolderNames}
              onInsertSlashCommand={onInsertSlashCommand}
              onOpenSettings={onOpenSettings}
              onSyncSkillToGlobal={onSyncSkillToGlobal}
              onRefresh={() => { refresh(); onRefreshAll?.(); }}
              onExpandChange={updateTreeHeight}
              heightRatio={capRatio}
            />
          </div>
        </>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.node, contextMenu.isMultiSelect)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Rename Dialog */}
      {dialog?.type === 'rename' && dialog.node && (
        <RenameDialog
          currentName={dialog.node.name}
          itemType={dialog.node.type === 'dir' ? 'folder' : 'file'}
          onRename={(newName) => {
            void handleRename(dialog.node!.path, newName);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* New File Dialog */}
      {dialog?.type === 'new-file' && (
        <RenameDialog
          currentName=""
          itemType="file"
          onRename={(name) => {
            void handleNewFile(getParentDirForCreate(dialog.node), name);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* New Folder Dialog */}
      {dialog?.type === 'new-folder' && (
        <RenameDialog
          currentName=""
          itemType="folder"
          onRename={(name) => {
            void handleNewFolder(getParentDirForCreate(dialog.node), name);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Delete Confirm Dialog */}
      {dialog?.type === 'delete' && dialog.node && (
        <ConfirmDialog
          title={`删除${dialog.node.type === 'dir' ? '文件夹' : '文件'}`}
          message={`确定要删除 "${dialog.node.name}" 吗？此操作无法撤销。`}
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={() => {
            void handleDelete(dialog.node!.path);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Multi-Delete Confirm Dialog */}
      {dialog?.type === 'delete-multi' && dialog.nodes && dialog.nodes.length > 0 && (
        <ConfirmDialog
          title={`删除 ${dialog.nodes.length} 个项目`}
          message={`确定要删除选中的 ${dialog.nodes.length} 个文件/文件夹吗？此操作无法撤销。`}
          confirmLabel="全部删除"
          cancelLabel="取消"
          danger
          onConfirm={() => {
            void handleDeleteMultiple(dialog.nodes!);
            setDialog(null);
          }}
          onCancel={() => setDialog(null)}
        />
      )}

      {/* Preview modal - lazy loaded. Skip when split-view handles previews externally. */}
      {!onFilePreviewExternal && (preview || previewError || isPreviewLoading) && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={preview?.name ?? 'Preview'}
            content={preview?.content ?? ''}
            size={preview?.size ?? 0}
            path={preview?.path ?? ''}
            isLoading={isPreviewLoading}
            error={previewError}
            onClose={() => {
              setPreview(null);
              setPreviewError(null);
            }}
            onSaved={refresh}
          />
        </Suspense>
      )}
    </div>
  );
}));

export default DirectoryPanel;
