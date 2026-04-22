/**
 * FilePreviewModal - File preview and edit modal for workspace files
 *
 * Two editing modes:
 * - **Code files** (non-Markdown): Open directly in writable Monaco with auto-save (VSCode-like).
 *   No Edit/Save/Cancel buttons — changes save automatically after 1s debounce.
 * - **Markdown files**: Preview (rendered HTML) ↔ Edit (Monaco) with manual Save.
 *
 * Edit capability comes from two sources (either is sufficient):
 * 1. Tab API (useTabApiOptional) — when rendered inside a Tab context
 * 2. Explicit onSave/onRevealFile props — when caller provides save logic directly
 */
import { Check, Edit2, Expand, Eye, FileText, FolderOpen, Loader2, Save, X } from 'lucide-react';
import Tip from './Tip';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useTabApiOptional } from '@/context/TabContext';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { getMonacoLanguage, isMarkdownFile } from '@/utils/languageUtils';
import { shortenPathForDisplay } from '@/utils/pathDetection';

import ConfirmDialog from './ConfirmDialog';
import Markdown from './Markdown';
import { useToast } from './Toast';
import OverlayBackdrop from '@/components/OverlayBackdrop';

// Lazy load Monaco Editor: the ~3MB bundle is only loaded when user first opens a file
const MonacoEditor = lazy(() => import('./MonacoEditor'));

// No-op change handler for read-only Monaco (stable reference avoids re-renders)
const noop = () => {};

// Static loading spinner (module-level to avoid allocation per render)
const monacoLoading = (
    <div className="flex h-full items-center justify-center bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" />
    </div>
);

// Auto-save debounce delay (ms)
const AUTO_SAVE_DELAY = 1000;


interface FilePreviewModalProps {
    /** File name to display */
    name: string;
    /** File content */
    content: string;
    /** File size in bytes */
    size: number;
    /** Relative path from agent directory (for saving) */
    path: string;
    /** Whether content is loading */
    isLoading?: boolean;
    /** Error message to display */
    error?: string | null;
    /** Callback when modal is closed */
    onClose: () => void;
    /** Callback after file is saved successfully */
    onSaved?: () => void;
    /** External save handler — enables editing even without Tab context */
    onSave?: (content: string) => Promise<void>;
    /** External reveal-in-finder handler — enables "Open in Finder" without Tab context */
    onRevealFile?: () => Promise<void>;
    /** When true, render inline (no portal/backdrop) for use in split-view panel */
    embedded?: boolean;
    /** Callback to open the fullscreen modal from embedded mode.
     *  Receives the current editor content so fullscreen opens with up-to-date text. */
    onFullscreen?: (currentContent?: string) => void;
    /** Switch to browser preview (only for HTML files with an active browser panel) */
    onSwitchToBrowser?: () => void;
}

// Files above this threshold use plaintext mode (skip tokenization) to prevent UI freeze
const LARGE_FILE_TOKENIZATION_THRESHOLD = 100 * 1024; // 100KB

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Auto-save status indicator shown for code files (non-Markdown) */
function AutoSaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
    if (status === 'idle') {
        return null;
    }
    if (status === 'saving') {
        return (
            <span className="flex items-center gap-1 text-[11px] text-[var(--ink-muted)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                保存中
            </span>
        );
    }
    if (status === 'saved') {
        return (
            <span className="flex items-center gap-1 text-[11px] text-[var(--success)]">
                <Check className="h-3 w-3" />
                已保存
            </span>
        );
    }
    // error
    return (
        <span className="flex items-center gap-1 text-[11px] text-[var(--error)]">
            <X className="h-3 w-3" />
            保存失败
        </span>
    );
}

export default function FilePreviewModal({
    name,
    content,
    size,
    path,
    isLoading = false,
    error = null,
    onClose,
    onSaved,
    onSave,
    onRevealFile,
    embedded = false,
    onFullscreen,
    onSwitchToBrowser,
}: FilePreviewModalProps) {
    // Cmd+W dismissal: only register for fullscreen mode (z-[210]).
    // Embedded mode (split-panel) has no z-index overlay and is handled separately.
    useCloseLayer(() => { if (embedded) return false; onClose(); return true; }, 210);

    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    const tabApi = useTabApiOptional();
    const apiPost = tabApi?.apiPost;

    // Edit: Tab API OR explicit onSave prop.  Reveal: Tab API OR explicit onRevealFile prop.
    const canEdit = !!(apiPost || onSave);
    const canReveal = !!(apiPost || onRevealFile);

    const isMarkdown = useMemo(() => isMarkdownFile(name), [name]);
    const monacoLanguage = useMemo(() => getMonacoLanguage(name), [name]);

    // Direct edit mode: non-Markdown code files open directly as writable editor with auto-save
    const isDirectEdit = canEdit && !isMarkdown;

    // ─── State ───────────────────────────────────────────────────────────────
    // Markdown manual-edit state (not used for code files)
    const [isMdEditing, setIsMdEditing] = useState(false);
    const [editContent, setEditContent] = useState(content);
    const [savedContent, setSavedContent] = useState(content); // Last saved baseline
    const [isSaving, setIsSaving] = useState(false);
    const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);

    // Auto-save state (for direct-edit code files)
    const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isSavingRef = useRef(false); // guard against concurrent saves
    const inFlightPromiseRef = useRef<Promise<void> | null>(null); // track in-flight save for close coordination
    const savedIndicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Sync content when prop changes (e.g., when file is reloaded externally)
    useEffect(() => {
        // Cancel any pending auto-save — the external content is now the source of truth
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        setEditContent(content);
        setSavedContent(content);
    }, [content]);

    // Derived state — Markdown manual-edit unsaved changes
    const hasMdUnsavedChanges = useMemo(() => {
        return isMdEditing && editContent !== savedContent;
    }, [isMdEditing, editContent, savedContent]);

    // Large files: force plaintext to skip tokenization
    const effectiveMonacoLanguage = useMemo(() => {
        if (size > LARGE_FILE_TOKENIZATION_THRESHOLD) return 'plaintext';
        return monacoLanguage;
    }, [size, monacoLanguage]);

    // ─── Save logic (shared by auto-save and manual save) ────────────────────
    // Stable refs for save dependencies to avoid re-creating callbacks
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const apiPostRef = useRef(apiPost);
    apiPostRef.current = apiPost;
    const pathRef = useRef(path);
    pathRef.current = path;
    const onSavedRef = useRef(onSaved);
    onSavedRef.current = onSaved;

    /** Core save function — saves the given content string */
    const executeSave = useCallback(async (contentToSave: string) => {
        if (onSaveRef.current) {
            await onSaveRef.current(contentToSave);
        } else if (apiPostRef.current) {
            const response = await apiPostRef.current<{ success: boolean; error?: string }>(
                '/agent/save-file',
                { path: pathRef.current, content: contentToSave }
            );
            if (!response.success) {
                throw new Error(response.error ?? '保存失败');
            }
        }
    }, []); // stable — all deps via refs

    // We need ref-accessible versions for async save callbacks
    const editContentRef = useRef(editContent);
    editContentRef.current = editContent;
    const savedContentRef = useRef(savedContent);
    savedContentRef.current = savedContent;

    // ─── Auto-save for direct-edit code files ─────────────────────────────────

    /** Persist the given content to disk, update status indicator, and call onSaved.
     *  Includes retry-after-busy: if a save is already in-flight, reschedules after it finishes. */
    const doAutoSave = useCallback((contentToSave: string) => {
        if (isSavingRef.current) {
            // Already saving — reschedule so this edit isn't lost
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = setTimeout(() => {
                void doAutoSave(editContentRef.current);
            }, AUTO_SAVE_DELAY);
            return;
        }
        isSavingRef.current = true;
        setAutoSaveStatus('saving');
        const savePromise = (async () => {
            try {
                await executeSave(contentToSave);
                setSavedContent(contentToSave);
                savedContentRef.current = contentToSave;
                setAutoSaveStatus('saved');
                onSavedRef.current?.();
                // Clear "saved" indicator after 2s
                if (savedIndicatorTimerRef.current) clearTimeout(savedIndicatorTimerRef.current);
                savedIndicatorTimerRef.current = setTimeout(() => setAutoSaveStatus('idle'), 2000);
                // After save completes, check if content changed during the save (user kept typing)
                if (editContentRef.current !== contentToSave) {
                    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
                    debounceTimerRef.current = setTimeout(() => {
                        void doAutoSave(editContentRef.current);
                    }, AUTO_SAVE_DELAY);
                }
            } catch {
                setAutoSaveStatus('error');
            } finally {
                isSavingRef.current = false;
                inFlightPromiseRef.current = null;
            }
        })();
        inFlightPromiseRef.current = savePromise;
        void savePromise;
    }, [executeSave]);

    const handleDirectEditChange = useCallback((newValue: string) => {
        setEditContent(newValue);

        // Clear previous debounce
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        debounceTimerRef.current = setTimeout(() => {
            void doAutoSave(newValue);
        }, AUTO_SAVE_DELAY);
    }, [doAutoSave]);

    const flushAndClose = useCallback(async () => {
        // Cancel pending debounce
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        // Wait for any in-flight save to finish before checking dirty state
        if (inFlightPromiseRef.current) {
            try { await inFlightPromiseRef.current; } catch { /* ignore — error already handled */ }
        }
        // If there are STILL unsaved direct-edit changes after in-flight completed, save now
        if (isDirectEdit && editContentRef.current !== savedContentRef.current) {
            try {
                await executeSave(editContentRef.current);
                onSavedRef.current?.();
            } catch {
                // Save failed on close — don't block the close
                toastRef.current.error('关闭时自动保存失败');
            }
        }
        onClose();
    }, [isDirectEdit, executeSave, onClose]);

    /** Cmd+S handler for direct-edit mode — flush debounce and save immediately */
    const handleManualFlush = useCallback(() => {
        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = null;
        }
        if (editContentRef.current === savedContentRef.current) return; // nothing to save
        void doAutoSave(editContentRef.current);
    }, [doAutoSave]);

    // Cleanup on unmount: clear timers and fire best-effort save if dirty
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            if (savedIndicatorTimerRef.current) clearTimeout(savedIndicatorTimerRef.current);
            // Best-effort flush: if there are unsaved edits, fire a save (async, not awaited)
            if (editContentRef.current !== savedContentRef.current) {
                void executeSave(editContentRef.current).catch(() => {});
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs + stable executeSave; cleanup must only run on unmount
    }, []);

    // ─── Markdown manual-edit handlers ────────────────────────────────────────
    const handleMdEdit = useCallback(() => {
        setEditContent(savedContent);
        setIsMdEditing(true);
    }, [savedContent]);

    const handleMdCancel = useCallback(() => {
        if (hasMdUnsavedChanges) {
            setShowUnsavedConfirm(true);
        } else {
            setIsMdEditing(false);
        }
    }, [hasMdUnsavedChanges]);

    const handleMdDiscardChanges = useCallback(() => {
        setShowUnsavedConfirm(false);
        setEditContent(savedContent);
        setIsMdEditing(false);
    }, [savedContent]);

    const handleMdSave = useCallback(async () => {
        if (!canEdit) return;
        setIsSaving(true);
        try {
            await executeSave(editContent);
            toastRef.current.success('文件保存成功');
            setSavedContent(editContent);
            setIsMdEditing(false);
            onSavedRef.current?.();
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : '保存失败');
        } finally {
            setIsSaving(false);
        }
    }, [canEdit, executeSave, editContent]);

    // ─── Close handler ────────────────────────────────────────────────────────
    const handleClose = useCallback(() => {
        if (isDirectEdit) {
            // Auto-save mode: flush pending save and close
            void flushAndClose();
        } else if (hasMdUnsavedChanges) {
            // Markdown with unsaved changes: confirm
            setShowUnsavedConfirm(true);
        } else {
            onClose();
        }
    }, [isDirectEdit, hasMdUnsavedChanges, flushAndClose, onClose]);


    const handleOpenInFinder = useCallback(async () => {
        if (!canReveal) return;
        try {
            if (onRevealFile) {
                await onRevealFile();
            } else if (apiPost) {
                await apiPost('/agent/open-in-finder', { path });
            }
        } catch {
            toastRef.current.error('无法打开目录');
        }
    }, [canReveal, onRevealFile, apiPost, path]);

    // ─── Render content ───────────────────────────────────────────────────────
    const renderPreviewContent = () => {
        if (isLoading) {
            return monacoLoading;
        }

        if (error) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--error)]">
                    <X className="h-8 w-8" />
                    <span className="text-sm">{error}</span>
                </div>
            );
        }

        // Markdown: editing mode (manual)
        if (isMarkdown && isMdEditing) {
            return (
                <Suspense fallback={monacoLoading}>
                    <div className="h-full bg-[var(--paper-elevated)]">
                        <MonacoEditor
                            value={editContent}
                            onChange={setEditContent}
                            language={effectiveMonacoLanguage}
                        />
                    </div>
                </Suspense>
            );
        }

        // Markdown: preview mode (rendered HTML)
        if (isMarkdown) {
            // Empty markdown: show placeholder
            if (!savedContent.trim()) {
                return (
                    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--paper-elevated)] text-[var(--ink-muted)]">
                        <FileText className="h-10 w-10 opacity-20" />
                        <p className="text-sm">文档内容为空</p>
                        {canEdit && (
                            <button type="button" onClick={handleMdEdit}
                                className="text-sm text-[var(--accent)] hover:underline">
                                点击开始编辑
                            </button>
                        )}
                    </div>
                );
            }
            return (
                <div className="h-full overflow-auto overscroll-contain p-6 bg-[var(--paper-elevated)]">
                    <div className="prose prose-stone max-w-none dark:prose-invert">
                        <Markdown raw basePath={path ? path.substring(0, path.lastIndexOf('/')) : undefined}>{savedContent}</Markdown>
                    </div>
                </div>
            );
        }

        // Code files: direct writable Monaco with auto-save (or read-only if no edit capability)
        return (
            <Suspense fallback={monacoLoading}>
                <div className="h-full bg-[var(--paper-elevated)]">
                    <MonacoEditor
                        value={isDirectEdit ? editContent : savedContent}
                        onChange={isDirectEdit ? handleDirectEditChange : noop}
                        language={effectiveMonacoLanguage}
                        readOnly={!isDirectEdit}
                        onSave={isDirectEdit ? handleManualFlush : undefined}
                    />
                </div>
            </Suspense>
        );
    };

    // ─── Embedded mode ────────────────────────────────────────────────────────
    if (embedded) {
        return (
            <div className="flex h-full flex-col overflow-hidden">
                {/* Inline header with gradient fade (matches Chat header style) */}
                <div className="relative z-10 flex flex-shrink-0 items-center justify-between gap-2 px-4 py-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-6 after:bg-gradient-to-b after:from-[var(--paper-elevated)] after:to-transparent">
                    <div className="flex min-w-0 items-center gap-2">
                        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-[var(--accent-warm-muted)]">
                            <FileText className="h-3.5 w-3.5 text-[var(--accent)]" />
                        </div>
                        <span className="truncate text-[13px] font-medium text-[var(--ink)]">{name}</span>
                        <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                        {/* Auto-save indicator for code files */}
                        {isDirectEdit && <AutoSaveIndicator status={autoSaveStatus} />}

                        {/* Switch to browser preview — only for HTML files with an active browser */}
                        {onSwitchToBrowser && (
                            <Tip label="网页预览" position="bottom">
                                <button type="button" onClick={() => {
                                    if (isDirectEdit) handleManualFlush();
                                    onSwitchToBrowser();
                                }}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <Eye className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}

                        {/* Fullscreen button — always available (not gated by editing state for code files) */}
                        {onFullscreen && !(isMarkdown && isMdEditing) && (
                            <Tip label="全屏预览" position="bottom">
                                <button type="button" onClick={() => {
                                    // For direct-edit files, flush pending auto-save and pass current content
                                    if (isDirectEdit) {
                                        handleManualFlush();
                                        onFullscreen(editContentRef.current);
                                    } else {
                                        onFullscreen();
                                    }
                                }}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                    <Expand className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}

                        {/* Markdown: Edit / Cancel+Save buttons */}
                        {isMarkdown && canEdit && !isMdEditing && (
                            <Tip label="编辑" position="bottom">
                                <button type="button" onClick={handleMdEdit} disabled={isLoading || !!error}
                                    className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-40">
                                    <Edit2 className="h-3.5 w-3.5" />
                                </button>
                            </Tip>
                        )}
                        {isMarkdown && canEdit && isMdEditing && (
                            <>
                                <button type="button" onClick={handleMdCancel}
                                    className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]">
                                    取消
                                </button>
                                <button type="button" onClick={handleMdSave} disabled={isSaving || !hasMdUnsavedChanges}
                                    className="rounded-md bg-[var(--accent)] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-40">
                                    {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : '保存'}
                                </button>
                            </>
                        )}

                        <Tip label="关闭" position="bottom">
                            <button type="button" onClick={handleClose}
                                className="rounded-md p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </Tip>
                    </div>
                </div>
                {/* Content */}
                <div className="flex-1 overflow-hidden">
                    {renderPreviewContent()}
                </div>
                {showUnsavedConfirm && (
                    <ConfirmDialog
                        title="未保存的更改"
                        message="您有未保存的更改，确定要放弃吗？"
                        confirmText="放弃更改"
                        cancelText="继续编辑"
                        confirmVariant="danger"
                        onConfirm={handleMdDiscardChanges}
                        onCancel={() => setShowUnsavedConfirm(false)}
                    />
                )}
            </div>
        );
    }

    // ─── Fullscreen mode (portal) ─────────────────────────────────────────────
    return createPortal(
        <>
            {/* Modal backdrop */}
            <OverlayBackdrop onClose={handleClose} className="z-[210]" style={{ padding: '3vh 3vw' }}>
                {/* Modal content */}
                <div
                    className="glass-panel flex h-full w-full max-w-7xl flex-col overflow-hidden"
                    onWheel={(e) => e.stopPropagation()}
                >
                    {/* Header */}
                    <div
                        className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-5 py-4 bg-[var(--paper-elevated)]"
                    >
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-muted)]">
                                <FileText className="h-4 w-4 text-[var(--accent)]" />
                            </div>
                            <div className="min-w-0">
                                <div className="flex items-center gap-3 truncate">
                                    <span className="truncate text-[13px] font-semibold text-[var(--ink)]">{name}</span>
                                    <span className="flex-shrink-0 text-[11px] text-[var(--ink-muted)]">{formatFileSize(size)}</span>
                                    {/* Markdown editing badge */}
                                    {isMarkdown && isMdEditing && (
                                        <span className="flex-shrink-0 text-[11px] text-[var(--accent)]">
                                            {hasMdUnsavedChanges ? '编辑中（未保存）' : '编辑中'}
                                        </span>
                                    )}
                                    {/* Auto-save indicator for code files */}
                                    {isDirectEdit && <AutoSaveIndicator status={autoSaveStatus} />}
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <span className="max-w-[400px] truncate text-[11px] text-[var(--ink-muted)]" title={path}>
                                        {shortenPathForDisplay(path)}
                                    </span>
                                    {canReveal && (
                                        <button
                                            type="button"
                                            onClick={handleOpenInFinder}
                                            className="flex-shrink-0 rounded p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            title="打开所在文件夹"
                                        >
                                            <FolderOpen className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            {/* Markdown: Edit / Cancel+Save */}
                            {isMarkdown && canEdit && (isMdEditing ? (
                                <div key="md-editing" className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={handleMdCancel}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                        取消
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleMdSave}
                                        disabled={isSaving || !hasMdUnsavedChanges}
                                        className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-[var(--accent-warm-hover)] hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                    >
                                        {isSaving ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Save className="h-3.5 w-3.5" />
                                        )}
                                        保存
                                    </button>
                                </div>
                            ) : (
                                <button
                                    key="md-view"
                                    type="button"
                                    onClick={handleMdEdit}
                                    disabled={isLoading || !!error}
                                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[var(--button-dark-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--button-primary-text)] shadow-sm transition-all duration-150 hover:bg-[var(--button-dark-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                            ))}

                            {/* Code files: no Edit/Save buttons — auto-save handles it */}

                            <button
                                type="button"
                                onClick={handleClose}
                                className="inline-flex items-center justify-center rounded-md border border-[var(--line-strong)] bg-[var(--button-secondary-bg)] px-3 py-1.5 text-[11px] font-semibold text-[var(--ink)] shadow-sm transition-all duration-150 hover:bg-[var(--button-secondary-bg-hover)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 active:scale-[0.98]"
                            >
                                关闭
                            </button>
                        </div>
                    </div>

                    {/* Content area */}
                    <div className="flex-1 overflow-hidden">
                        {renderPreviewContent()}
                    </div>
                </div>
            </OverlayBackdrop>

            {/* Unsaved changes confirmation dialog (Markdown only) */}
            {showUnsavedConfirm && (
                <ConfirmDialog
                    title="未保存的更改"
                    message="您有未保存的更改，确定要放弃吗？"
                    confirmText="放弃更改"
                    cancelText="继续编辑"
                    confirmVariant="danger"
                    onConfirm={handleMdDiscardChanges}
                    onCancel={() => setShowUnsavedConfirm(false)}
                />
            )}
        </>,
        document.body
    );
}
