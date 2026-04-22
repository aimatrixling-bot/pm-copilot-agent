/**
 * TemplateLibraryDialog — create workspace from template
 * Shows template list, target directory, and project name
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Loader2, Trash2, ChevronRight, AlertCircle } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { homeDir, join, basename } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';

import type { WorkspaceTemplate } from '@/config/types';
import { PRESET_TEMPLATES } from '@/config/types';
import { loadUserTemplates, addUserTemplate, removeUserTemplate, updateUserTemplate } from '@/config/services/templateService';
import { ALL_WORKSPACE_ICON_IDS, DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import { isBrowserDevMode } from '@/utils/browserMock';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface TemplateLibraryDialogProps {
    onCreateWorkspace: (path: string, icon?: string, displayName?: string) => Promise<void>;
    onClose: () => void;
}

export default memo(function TemplateLibraryDialog({
    onCreateWorkspace,
    onClose,
}: TemplateLibraryDialogProps) {
    useCloseLayer(() => { onClose(); return true; }, 200);

    // State
    const [templates, setTemplates] = useState<WorkspaceTemplate[]>([...PRESET_TEMPLATES]);
    const [selectedId, setSelectedId] = useState<string>(PRESET_TEMPLATES[0]?.id ?? '');
    const [targetDir, setTargetDir] = useState('');
    const [projectName, setProjectName] = useState('');
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [addingTemplate, setAddingTemplate] = useState(false);
    const [templateToRemove, setTemplateToRemove] = useState<WorkspaceTemplate | null>(null);
    const [pathExists, setPathExists] = useState(false);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState('');
    const [editingDesc, setEditingDesc] = useState(false);
    const [descDraft, setDescDraft] = useState('');

    const pathCheckTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const iconPickerRef = useRef<HTMLDivElement>(null);

    // Load templates and default target dir on mount
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const userTemplates = await loadUserTemplates();
                if (!cancelled) {
                    setTemplates([...PRESET_TEMPLATES, ...userTemplates]);
                }
            } catch (err) {
                console.warn('[TemplateLibrary] Failed to load templates:', err);
            }

            // Set default target dir
            try {
                const home = await homeDir();
                const defaultDir = await join(home, '.pm-copilot', 'projects');
                if (!cancelled) setTargetDir(defaultDir);
            } catch {
                // Fallback
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Sync project name & reset inline editors when selected template changes
    useEffect(() => {
        const tpl = templates.find(t => t.id === selectedId);
        if (tpl) {
            setProjectName(tpl.name.toLowerCase().replace(/\s+/g, '-').replace(/[/\\]/g, ''));
        }
        setShowIconPicker(false);
        setEditingName(false);
        setEditingDesc(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync on template selection change, not when templates array updates
    }, [selectedId]);

    const selectedTemplate = templates.find(t => t.id === selectedId);

    // Debounced check: does targetDir/projectName already exist?
    useEffect(() => {
        clearTimeout(pathCheckTimerRef.current);
        if (!targetDir || !projectName.trim()) {
            setPathExists(false);
            return;
        }
        pathCheckTimerRef.current = setTimeout(() => {
            void (async () => {
                try {
                    const fullPath = await join(targetDir, projectName.trim());
                    const result = await exists(fullPath);
                    setPathExists(result);
                } catch {
                    setPathExists(false);
                }
            })();
        }, 300);
        return () => clearTimeout(pathCheckTimerRef.current);
    }, [targetDir, projectName]);

    // Change target directory
    const handleChangeDir = useCallback(async () => {
        if (isBrowserDevMode()) return;
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择工作区地址',
            });
            if (selected && typeof selected === 'string') {
                setTargetDir(selected);
            }
        } catch (err) {
            console.warn('[TemplateLibrary] Failed to pick directory:', err);
        }
    }, []);

    // Add user template from local folder
    const handleAddTemplate = useCallback(async () => {
        if (isBrowserDevMode()) return;
        setAddingTemplate(true);
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择文件夹作为模板（将复制到模板库）',
            });
            if (!selected || typeof selected !== 'string') {
                setAddingTemplate(false);
                return;
            }

            const folderName = await basename(selected);

            // Copy folder to templates via Rust
            const destPath: string = await invoke('cmd_copy_folder_to_templates', {
                sourcePath: selected,
                templateName: folderName,
            });

            // Extract actual folder name from dest path
            const actualName = await basename(destPath);

            // Save template metadata
            const newTemplate = await addUserTemplate({
                id: actualName,
                name: folderName,
                description: '',
                path: destPath,
            });

            setTemplates(prev => [...prev, newTemplate]);
            setSelectedId(newTemplate.id);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`添加模板失败: ${msg}`);
        } finally {
            setAddingTemplate(false);
        }
    }, []);

    // Remove user template — delete folder first, then metadata
    const handleRemoveTemplate = useCallback(async () => {
        if (!templateToRemove) return;
        try {
            // Delete folder from disk first
            if (templateToRemove.path) {
                await invoke('cmd_remove_template_folder', { templatePath: templateToRemove.path });
            }

            // Then remove metadata
            await removeUserTemplate(templateToRemove.id);

            setTemplates(prev => prev.filter(t => t.id !== templateToRemove.id));
            if (selectedId === templateToRemove.id) {
                setSelectedId(PRESET_TEMPLATES[0]?.id ?? '');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`删除模板失败: ${msg}`);
        } finally {
            setTemplateToRemove(null);
        }
    }, [templateToRemove, selectedId]);

    // Find an available path, appending numeric suffix on collision
    const findAvailablePath = useCallback(async (dir: string, name: string): Promise<string> => {
        const first = await join(dir, name);
        if (!(await exists(first))) return first;
        for (let i = 2; i <= 100; i++) {
            const candidate = await join(dir, `${name}-${i}`);
            if (!(await exists(candidate))) return candidate;
        }
        return join(dir, `${name}-${Date.now()}`);
    }, []);

    // Create workspace from selected template
    const handleCreate = useCallback(async () => {
        if (!selectedTemplate || !targetDir || !projectName.trim()) return;
        setCreating(true);
        setError(null);

        try {
            const destPath = await findAvailablePath(targetDir, projectName.trim());

            if (selectedTemplate.isBuiltin) {
                await invoke('cmd_create_workspace_from_bundled_template', {
                    templateId: selectedTemplate.id,
                    destPath,
                });
            } else if (selectedTemplate.path) {
                await invoke('cmd_create_workspace_from_template', {
                    sourcePath: selectedTemplate.path,
                    destPath,
                });
            } else {
                throw new Error('Template has no source path');
            }

            // displayName = user's project name input (not template name)
            await onCreateWorkspace(destPath, selectedTemplate.icon, projectName);
            onClose();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setError(`创建失败: ${msg}`);
        } finally {
            setCreating(false);
        }
    }, [selectedTemplate, targetDir, projectName, findAvailablePath, onCreateWorkspace, onClose]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            if (showIconPicker) { setShowIconPicker(false); return; }
            onClose();
        }
    }, [onClose, showIconPicker]);

    // Close icon picker on outside click
    useEffect(() => {
        if (!showIconPicker) return;
        const handleClick = (e: MouseEvent) => {
            if (iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
                setShowIconPicker(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [showIconPicker]);

    // Update template metadata (user templates only)
    const handleUpdateTemplate = useCallback(async (field: 'icon' | 'description' | 'name', value: string) => {
        if (!selectedTemplate || selectedTemplate.isBuiltin) return;
        const updates = { [field]: value };
        try {
            await updateUserTemplate(selectedTemplate.id, updates);
            setTemplates(prev => prev.map(t =>
                t.id === selectedTemplate.id ? { ...t, ...updates } : t
            ));
        } catch (err) {
            console.warn('[TemplateLibrary] Failed to update template:', err);
        }
    }, [selectedTemplate]);

    return (
        <OverlayBackdrop onClose={onClose} className="z-[200]">
            <div className="flex w-[640px] max-h-[80vh] flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-lg" onKeyDown={handleKeyDown}>
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <h2 className="text-lg font-semibold text-[var(--ink)]">从模板创建 Agent</h2>
                    <button
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Body */}
                <div className="flex flex-1 overflow-hidden">
                    {/* Left: Template list */}
                    <div className="flex w-[220px] flex-col border-r border-[var(--line)]">
                        <div className="flex-1 overflow-y-auto overscroll-contain p-3">
                            <div className="mb-2 px-1">
                                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                                    模板库
                                </span>
                            </div>
                            {templates.map((tpl) => (
                                <div
                                    key={tpl.id}
                                    role="option"
                                    aria-selected={selectedId === tpl.id}
                                    tabIndex={0}
                                    onClick={() => setSelectedId(tpl.id)}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(tpl.id); } }}
                                    className={`group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                                        selectedId === tpl.id
                                            ? 'bg-[var(--accent-warm-muted)] text-[var(--ink)]'
                                            : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                                    }`}
                                >
                                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg">
                                        <WorkspaceIcon icon={tpl.icon} size={20} />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-[13px] font-medium leading-tight">{tpl.name}</p>
                                        {tpl.description ? (
                                            <p className="mt-0.5 truncate text-[11px] leading-tight text-[var(--ink-muted)]">{tpl.description}</p>
                                        ) : tpl.isBuiltin ? (
                                            <p className="mt-0.5 text-[11px] leading-tight text-[var(--ink-muted)]">内置</p>
                                        ) : null}
                                    </div>
                                    {/* Remove button for user templates */}
                                    {!tpl.isBuiltin && (
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); setTemplateToRemove(tpl); }}
                                            className="rounded p-1 text-[var(--ink-muted)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100"
                                            title="删除模板"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>

                        {/* Add template button */}
                        <div className="border-t border-[var(--line)] p-3">
                            <button
                                type="button"
                                onClick={handleAddTemplate}
                                disabled={addingTemplate}
                                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
                            >
                                {addingTemplate ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Plus className="h-3.5 w-3.5" />
                                )}
                                添加模板
                            </button>
                        </div>
                    </div>

                    {/* Right: Template details & create form */}
                    <div className="flex min-h-[420px] flex-1 flex-col p-6">
                        {selectedTemplate ? (
                            <>
                                {/* Template preview — icon, name & description editable for user templates */}
                                <div className="mb-6">
                                    <div className="flex items-start gap-3">
                                        {/* Icon — clickable for user templates */}
                                        <div className="relative" ref={iconPickerRef}>
                                            <button
                                                type="button"
                                                onClick={() => { if (!selectedTemplate.isBuiltin) setShowIconPicker(v => !v); }}
                                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all ${
                                                    selectedTemplate.isBuiltin
                                                        ? ''
                                                        : 'cursor-pointer hover:bg-[var(--hover-bg)] hover:ring-1 hover:ring-[var(--line)]'
                                                }`}
                                                title={selectedTemplate.isBuiltin ? undefined : '点击更换图标'}
                                            >
                                                <WorkspaceIcon icon={selectedTemplate.icon} size={28} />
                                            </button>
                                            {/* Icon picker popover */}
                                            {showIconPicker && (
                                                <div className="absolute left-0 top-full z-10 mt-1.5 w-[280px] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-lg">
                                                    <div className="max-h-[200px] overflow-y-auto overscroll-contain">
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {ALL_WORKSPACE_ICON_IDS.filter(id => id !== 'folder-open').map((iconId) => (
                                                                <button
                                                                    key={iconId}
                                                                    type="button"
                                                                    onClick={() => {
                                                                        void handleUpdateTemplate('icon', iconId === DEFAULT_WORKSPACE_ICON ? '' : iconId);
                                                                        setShowIconPicker(false);
                                                                    }}
                                                                    className={`flex h-10 w-10 items-center justify-center rounded-xl transition-all ${
                                                                        (selectedTemplate.icon || DEFAULT_WORKSPACE_ICON) === iconId
                                                                            ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
                                                                            : 'hover:bg-[var(--hover-bg)]'
                                                                    }`}
                                                                >
                                                                    <WorkspaceIcon icon={iconId} size={24} />
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            {/* Name — inline editable for user templates */}
                                            {!selectedTemplate.isBuiltin && editingName ? (
                                                <input
                                                    type="text"
                                                    value={nameDraft}
                                                    onChange={(e) => setNameDraft(e.target.value)}
                                                    onBlur={() => {
                                                        setEditingName(false);
                                                        const trimmed = nameDraft.trim();
                                                        if (trimmed && trimmed !== selectedTemplate.name) {
                                                            void handleUpdateTemplate('name', trimmed);
                                                        }
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                                                        if (e.key === 'Escape') { setEditingName(false); }
                                                    }}
                                                    className="w-full rounded border border-[var(--line)] bg-transparent px-1.5 py-0.5 text-[15px] font-semibold text-[var(--ink)] focus:border-[var(--ink-muted)] focus:outline-none"
                                                    autoFocus
                                                />
                                            ) : (
                                                <h3
                                                    className={`text-[15px] font-semibold leading-tight text-[var(--ink)] ${
                                                        selectedTemplate.isBuiltin ? '' : 'cursor-pointer rounded px-1.5 py-0.5 -ml-1.5 transition-colors hover:bg-[var(--hover-bg)]'
                                                    }`}
                                                    onClick={() => {
                                                        if (!selectedTemplate.isBuiltin) {
                                                            setNameDraft(selectedTemplate.name);
                                                            setEditingName(true);
                                                        }
                                                    }}
                                                    title={selectedTemplate.isBuiltin ? undefined : '点击编辑名称'}
                                                >
                                                    {selectedTemplate.name}
                                                </h3>
                                            )}
                                            {/* Description — inline editable for user templates */}
                                            {selectedTemplate.isBuiltin ? (
                                                <p className="mt-1 min-h-[20px] text-[13px] leading-snug text-[var(--ink-muted)]">
                                                    {selectedTemplate.description}
                                                </p>
                                            ) : editingDesc ? (
                                                <input
                                                    type="text"
                                                    value={descDraft}
                                                    onChange={(e) => setDescDraft(e.target.value)}
                                                    onBlur={() => {
                                                        setEditingDesc(false);
                                                        if (descDraft !== (selectedTemplate.description || '')) {
                                                            void handleUpdateTemplate('description', descDraft);
                                                        }
                                                    }}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
                                                        if (e.key === 'Escape') { setEditingDesc(false); }
                                                    }}
                                                    className="mt-1 w-full rounded border border-[var(--line)] bg-transparent px-1.5 py-0.5 text-[13px] text-[var(--ink-muted)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                                                    placeholder="添加模板描述..."
                                                    autoFocus
                                                />
                                            ) : (
                                                <p
                                                    className="mt-1 min-h-[20px] cursor-pointer rounded px-1.5 py-0.5 -ml-1.5 text-[13px] leading-snug text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)]"
                                                    onClick={() => {
                                                        setDescDraft(selectedTemplate.description || '');
                                                        setEditingDesc(true);
                                                    }}
                                                    title="点击编辑描述"
                                                >
                                                    {selectedTemplate.description || '点击添加描述...'}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Project name */}
                                <div className="mb-4">
                                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">Agent 名称</label>
                                    <input
                                        type="text"
                                        value={projectName}
                                        onChange={(e) => setProjectName(e.target.value.replace(/[/\\]/g, ''))}
                                        className="w-full rounded-[6px] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--focus-border)] focus:outline-none transition-colors"
                                        placeholder="输入 Agent 名称"
                                    />
                                </div>

                                {/* Target directory */}
                                <div className="mb-6">
                                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">工作区地址</label>
                                    <div className="flex items-center gap-2">
                                        <div className="flex min-w-0 flex-1 items-center rounded-[6px] border border-[var(--line)] bg-[var(--paper)] px-3 py-2.5">
                                            <span className="truncate text-sm text-[var(--ink-muted)]">
                                                {shortenPathForDisplay(targetDir)}
                                            </span>
                                            {projectName && (
                                                <>
                                                    <ChevronRight className="mx-1 h-3 w-3 shrink-0 text-[var(--ink-subtle)]" />
                                                    <span className="shrink-0 text-sm font-medium text-[var(--ink)]">
                                                        {projectName}
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleChangeDir}
                                            className="shrink-0 rounded-lg bg-[var(--button-secondary-bg)] px-3 py-2.5 text-[13px] font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                                        >
                                            更换
                                        </button>
                                    </div>
                                </div>

                                {/* Path exists warning */}
                                {pathExists && !error && (
                                    <div className="mb-4 flex items-center gap-1.5 text-xs text-[var(--warning)]">
                                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                        <span>该目录已存在，创建时将自动添加数字后缀</span>
                                    </div>
                                )}

                                {/* Error */}
                                {error && (
                                    <p className="mb-4 text-xs text-[var(--error)]">{error}</p>
                                )}

                                {/* Create button */}
                                <div className="mt-auto flex justify-end">
                                    <button
                                        type="button"
                                        onClick={handleCreate}
                                        disabled={creating || !projectName.trim()}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--button-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--button-primary-text)] transition-all hover:bg-[var(--button-primary-bg-hover)] hover:shadow-sm disabled:opacity-50"
                                    >
                                        {creating ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Plus className="h-3.5 w-3.5" />
                                        )}
                                        创建 Agent
                                    </button>
                                </div>
                            </>
                        ) : (
                            <div className="flex flex-1 items-center justify-center text-[var(--ink-muted)]">
                                选择一个模板
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Remove template confirmation */}
            {templateToRemove && (
                <ConfirmDialog
                    title="删除模板"
                    message={`确定要从模板库中删除「${templateToRemove.name}」吗？模板文件将被永久删除。`}
                    confirmText="删除"
                    cancelText="取消"
                    confirmVariant="danger"
                    onConfirm={handleRemoveTemplate}
                    onCancel={() => setTemplateToRemove(null)}
                />
            )}
        </OverlayBackdrop>
    );
});
