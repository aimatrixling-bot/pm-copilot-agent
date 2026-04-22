/**
 * IntroductionPanel — Manages INTRODUCTION.md for workspace welcome content.
 * Supports three states: file not found (with create CTA), preview, and editing.
 *
 * Uses Rust IPC (cmd_read/write/delete_workspace_file) — no Sidecar dependency.
 * Pattern follows SystemPromptsPanel (preview/edit toggle, isEditing guard, MonacoEditor).
 */
import { Save, Edit2, X, FileText, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useImperativeHandle, forwardRef, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { useToast } from '@/components/Toast';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import ConfirmDialog from '@/components/ConfirmDialog';

interface IntroductionPanelProps {
  agentDir: string;
}

export interface IntroductionPanelRef {
  isEditing: () => boolean;
}

const FILENAME = 'INTRODUCTION.md';

const IntroductionPanel = forwardRef<IntroductionPanelRef, IntroductionPanelProps>(
  function IntroductionPanel({ agentDir }, ref) {
    const toast = useToast();
    const toastRef = useRef(toast);
    useEffect(() => { toastRef.current = toast; }, [toast]);

    const isMountedRef = useRef(true);
    useEffect(() => () => { isMountedRef.current = false; }, []);

    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [content, setContent] = useState('');
    const [editContent, setEditContent] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [exists, setExists] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState(false);

    useImperativeHandle(ref, () => ({
      isEditing: () => isEditing,
    }), [isEditing]);

    const filePath = useMemo(() => {
      const sep = agentDir.includes('\\') ? '\\' : '/';
      return `${agentDir}${sep}${FILENAME}`;
    }, [agentDir]);

    // Load file content
    const loadContent = useCallback(async () => {
      setLoading(true);
      try {
        const result = await invoke<string | null>('cmd_read_workspace_file', { path: filePath });
        if (!isMountedRef.current) return;
        if (result !== null) {
          setContent(result);
          setEditContent(result);
          setExists(true);
        } else {
          setContent('');
          setEditContent('');
          setExists(false);
        }
      } catch {
        if (!isMountedRef.current) return;
        setContent('');
        setEditContent('');
        setExists(false);
      } finally {
        if (isMountedRef.current) setLoading(false);
      }
    }, [filePath]);

    // Initial load
    useEffect(() => { loadContent(); }, [loadContent]);

    // Edit mode handlers
    const handleEdit = useCallback(() => {
      setEditContent(content);
      setIsEditing(true);
    }, [content]);

    const handleCancel = useCallback(() => {
      setEditContent(content);
      setIsEditing(false);
    }, [content]);

    // Save
    const handleSave = useCallback(async () => {
      setSaving(true);
      try {
        await invoke('cmd_write_workspace_file', { path: filePath, content: editContent });
        if (!isMountedRef.current) return;
        setContent(editContent);
        setExists(true);
        setIsEditing(false);
        toastRef.current.success('使用指南保存成功');
      } catch (err) {
        if (!isMountedRef.current) return;
        toastRef.current.error(err instanceof Error ? err.message : '保存失败');
      } finally {
        if (isMountedRef.current) setSaving(false);
      }
    }, [editContent, filePath]);

    // Create (with default template)
    const handleCreate = useCallback(async () => {
      const template = '# Agent 名称\n\n在这里编写使用指南，用户打开新对话时将看到此内容。\n';
      setEditContent(template);
      setIsEditing(true);
    }, []);

    // Delete
    const handleDelete = useCallback(async () => {
      try {
        await invoke<boolean>('cmd_delete_workspace_file', { path: filePath });
        if (!isMountedRef.current) return;
        setContent('');
        setEditContent('');
        setExists(false);
        setIsEditing(false);
        setDeleteConfirm(false);
        toastRef.current.success('使用指南已删除');
      } catch (err) {
        if (!isMountedRef.current) return;
        toastRef.current.error(err instanceof Error ? err.message : '删除失败');
        setDeleteConfirm(false);
      }
    }, [filePath]);

    return (
      <div className="flex h-full flex-col">
        {/* Action Bar */}
        {!loading && (exists || isEditing) && (
          <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] bg-[var(--paper-inset)]/30 px-6 py-2">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-[var(--accent-warm)]" />
              <span className="text-sm font-medium text-[var(--ink)]">{FILENAME}</span>
            </div>
            <div className="flex items-center gap-2">
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                  >
                    <X className="h-3.5 w-3.5" />
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                    保存
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--error)]/10 hover:text-[var(--error)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    className="flex items-center gap-1 rounded-lg bg-[var(--button-dark-bg)] px-2.5 py-1 text-xs font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-dark-bg-hover)]"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    编辑
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
          ) : !exists && !isEditing ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
              <FileText className="h-16 w-16 text-[var(--ink-muted)]/30" />
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--ink-muted)]">
                  暂无使用指南
                </p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">
                  创建 INTRODUCTION.md 为你的 Agent 编写使用说明，用户打开新对话时将看到此内容
                </p>
              </div>
              <button
                type="button"
                onClick={handleCreate}
                className="mt-2 flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
              >
                <Edit2 className="h-4 w-4" />
                创建使用指南
              </button>
            </div>
          ) : isEditing ? (
            <div className="h-full bg-[var(--paper)]">
              <MonacoEditor
                value={editContent}
                onChange={setEditContent}
                language="markdown"
              />
            </div>
          ) : (
            <div className="h-full overflow-auto bg-[var(--paper-elevated)] p-6">
              {content.trim() ? (
                <div className="introduction-content">
                  <Markdown raw>{content}</Markdown>
                </div>
              ) : (
                <span className="text-sm text-[var(--ink-muted)]/60">
                  （无内容）
                </span>
              )}
            </div>
          )}
        </div>

        {/* Delete Confirmation */}
        {deleteConfirm && (
          <ConfirmDialog
            title="删除使用指南"
            message="确定删除使用指南？删除后，用户打开新对话时将不再看到使用指南内容。文件 INTRODUCTION.md 将从工作区中移除。"
            confirmText="删除"
            confirmVariant="danger"
            onConfirm={handleDelete}
            onCancel={() => setDeleteConfirm(false)}
          />
        )}
      </div>
    );
  },
);

export default IntroductionPanel;
