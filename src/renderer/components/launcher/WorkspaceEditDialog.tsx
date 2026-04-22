/**
 * WorkspaceEditDialog — edit workspace display name & icon
 * Shown from workspace card right-click "Edit" option
 */

import { memo, useCallback, useEffect, useState } from 'react';
import type { Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { ALL_WORKSPACE_ICON_IDS, DEFAULT_WORKSPACE_ICON } from '@/assets/workspace-icons';
import WorkspaceIcon from './WorkspaceIcon';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface WorkspaceEditDialogProps {
    project: Project;
    onSave: (projectId: string, updates: { displayName?: string; icon?: string }) => Promise<void>;
    onClose: () => void;
}

export default memo(function WorkspaceEditDialog({
    project,
    onSave,
    onClose,
}: WorkspaceEditDialogProps) {
    useCloseLayer(() => { onClose(); return true; }, 200);

    // Escape to close
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    const [name, setName] = useState(project.displayName || getFolderName(project.path));
    const [icon, setIcon] = useState(project.icon || '');
    const [saving, setSaving] = useState(false);
    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            const folderName = getFolderName(project.path);
            await onSave(project.id, {
                displayName: name !== folderName ? name : undefined,
                icon: icon || undefined,
            });
            onClose();
        } catch (err) {
            console.error('[WorkspaceEditDialog] Save failed:', err);
        } finally {
            setSaving(false);
        }
    }, [project.id, project.path, name, icon, onSave, onClose]);

    return (
        <OverlayBackdrop onClose={onClose} className="z-[200]">
            <div className="w-[420px] rounded-2xl bg-[var(--paper-elevated)] p-6 shadow-lg">
                <h3 className="mb-5 text-lg font-semibold text-[var(--ink)]">编辑工作区</h3>

                {/* Icon selector — flat grid, same size as workspace cards */}
                <div className="mb-4">
                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">图标</label>
                    <div className="max-h-[260px] overflow-y-auto overscroll-contain rounded-xl border border-[var(--line)] p-2">
                        <div className="flex flex-wrap gap-1.5">
                            {/* Default icon */}
                            <button
                                type="button"
                                onClick={() => setIcon('')}
                                className={`flex h-11 w-11 items-center justify-center rounded-xl transition-all ${
                                    !icon
                                        ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
                                        : 'hover:bg-[var(--hover-bg)]'
                                }`}
                                title="默认图标"
                            >
                                <WorkspaceIcon icon={DEFAULT_WORKSPACE_ICON} size={26} />
                            </button>
                            {/* All icons */}
                            {ALL_WORKSPACE_ICON_IDS.filter(id => id !== 'folder-open' && id !== DEFAULT_WORKSPACE_ICON).map((iconId) => (
                                <button
                                    key={iconId}
                                    type="button"
                                    onClick={() => setIcon(iconId)}
                                    className={`flex h-11 w-11 items-center justify-center rounded-xl transition-all ${
                                        icon === iconId
                                            ? 'bg-[var(--accent-warm-muted)] ring-1 ring-[var(--accent-warm)]'
                                            : 'hover:bg-[var(--hover-bg)]'
                                    }`}
                                    title={iconId}
                                >
                                    <WorkspaceIcon icon={iconId} size={26} />
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Name input */}
                <div className="mb-6">
                    <label className="mb-2 block text-sm font-medium text-[var(--ink)]">名称</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full rounded-[6px] border border-[var(--line)] bg-transparent px-3 py-2.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:border-[var(--focus-border)] focus:outline-none transition-colors"
                        placeholder="工作区名称"
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void handleSave(); }}
                    />
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg bg-[var(--button-secondary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                    >
                        取消
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={!name.trim() || saving}
                        className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                    >
                        {saving ? '保存中...' : '保存'}
                    </button>
                </div>
            </div>
        </OverlayBackdrop>
    );
});
