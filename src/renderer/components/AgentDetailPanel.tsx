/**
 * AgentDetailPanel - Component for viewing and editing a Sub-Agent
 * Supports preview/edit mode with save confirmation
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalAgentsPanel).
 */
import { Loader2, ChevronDown, ChevronUp, Trash2, Edit2, X, Check, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, useImperativeHandle, forwardRef, useRef, useMemo } from 'react';

import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { track } from '@/analytics';
import { apiGetJson as globalApiGet, apiPutJson as globalApiPut, apiDelete as globalApiDelete, apiPostJson as globalApiPost } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import type { SelectOption } from '@/components/CustomSelect';
import Markdown from '@/components/Markdown';
import MonacoEditor from '@/components/MonacoEditor';
import type { AgentFrontmatter, AgentDetail } from '../../shared/agentTypes';
import { sanitizeFolderName } from '../../shared/utils';
import { PERMISSION_MODES } from '@/config/types';

// Common SDK tools available for sub-agents
const COMMON_TOOLS = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Task',
    'WebSearch', 'WebFetch', 'NotebookEdit',
];

/** Tag input component for tools/skills with keyboard navigation */
function TagInput({
    tags,
    onChange,
    suggestions,
    placeholder,
    emptyHint,
}: {
    tags: string[];
    onChange: (tags: string[]) => void;
    suggestions?: string[];
    placeholder: string;
    emptyHint: string;
}) {
    const [inputValue, setInputValue] = useState('');
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const filteredSuggestions = useMemo(() => {
        if (!suggestions) return [];
        const lower = inputValue.toLowerCase();
        return suggestions.filter(s =>
            !tags.includes(s) && (lower === '' || s.toLowerCase().includes(lower))
        );
    }, [suggestions, tags, inputValue]);

    const addTag = useCallback((tag: string) => {
        const trimmed = tag.trim();
        if (trimmed && !tags.includes(trimmed)) {
            onChange([...tags, trimmed]);
        }
        setInputValue('');
        setShowSuggestions(false);
        setHighlightIndex(-1);
        inputRef.current?.focus();
    }, [tags, onChange]);

    const removeTag = useCallback((tag: string) => {
        onChange(tags.filter(t => t !== tag));
    }, [tags, onChange]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        const suggestionsVisible = showSuggestions && filteredSuggestions.length > 0;

        if (e.key === 'ArrowDown' && suggestionsVisible) {
            e.preventDefault();
            setHighlightIndex(prev =>
                prev < filteredSuggestions.length - 1 ? prev + 1 : 0
            );
        } else if (e.key === 'ArrowUp' && suggestionsVisible) {
            e.preventDefault();
            setHighlightIndex(prev =>
                prev > 0 ? prev - 1 : filteredSuggestions.length - 1
            );
        } else if (e.key === 'Escape' && suggestionsVisible) {
            e.preventDefault();
            setShowSuggestions(false);
            setHighlightIndex(-1);
        } else if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            if (highlightIndex >= 0 && highlightIndex < filteredSuggestions.length) {
                addTag(filteredSuggestions[highlightIndex]);
            } else if (inputValue.trim()) {
                addTag(inputValue);
            }
        } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
            onChange(tags.slice(0, -1));
        }
    }, [inputValue, tags, addTag, onChange, showSuggestions, filteredSuggestions, highlightIndex]);

    // Scroll highlighted item into view
    useEffect(() => {
        if (highlightIndex < 0 || !listRef.current) return;
        const item = listRef.current.children[highlightIndex] as HTMLElement | undefined;
        item?.scrollIntoView({ block: 'nearest' });
    }, [highlightIndex]);

    return (
        <div className="space-y-1.5">
            {/* Tags display */}
            {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {tags.map(tag => (
                        <span
                            key={tag}
                            className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)]"
                        >
                            {tag}
                            <button
                                onClick={() => removeTag(tag)}
                                className="ml-0.5 rounded p-0.5 text-[var(--ink-muted)] hover:bg-[var(--line)] hover:text-[var(--ink)]"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <p className="text-xs text-[var(--ink-muted)]">{emptyHint}</p>
            )}

            {/* Input row */}
            <div className="relative flex items-center gap-1.5">
                <input
                    ref={inputRef}
                    type="text"
                    value={inputValue}
                    onChange={e => {
                        setInputValue(e.target.value);
                        setShowSuggestions(true);
                        setHighlightIndex(-1);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    onKeyDown={handleKeyDown}
                    className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                    placeholder={placeholder}
                    role="combobox"
                    aria-expanded={showSuggestions && filteredSuggestions.length > 0}
                    aria-activedescendant={highlightIndex >= 0 ? `tag-suggestion-${highlightIndex}` : undefined}
                />
                <button
                    onClick={() => { if (inputValue.trim()) addTag(inputValue); }}
                    disabled={!inputValue.trim()}
                    className="shrink-0 rounded-lg border border-[var(--line)] p-1.5 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-30"
                >
                    <Plus className="h-3.5 w-3.5" />
                </button>

                {/* Dropdown suggestions */}
                {showSuggestions && filteredSuggestions.length > 0 && (
                    <div
                        ref={listRef}
                        role="listbox"
                        className="absolute left-0 top-full z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-[var(--line)] bg-[var(--paper)] shadow-lg"
                    >
                        {filteredSuggestions.map((s, i) => (
                            <button
                                key={s}
                                id={`tag-suggestion-${i}`}
                                role="option"
                                aria-selected={i === highlightIndex}
                                onMouseDown={e => { e.preventDefault(); addTag(s); }}
                                onMouseEnter={() => setHighlightIndex(i)}
                                className={`block w-full px-3 py-1.5 text-left text-xs text-[var(--ink)] ${
                                    i === highlightIndex
                                        ? 'bg-[var(--paper-inset)]'
                                        : 'hover:bg-[var(--paper-inset)]'
                                }`}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/** Parse comma-separated string to tag array (pure, module-level) */
const parseToTags = (s: string): string[] =>
    s ? s.split(',').map(t => t.trim()).filter(Boolean) : [];

interface AgentDetailPanelProps {
    name: string;
    scope: 'user' | 'project';
    onBack: () => void;
    onSaved: (autoClose?: boolean) => void;
    onDeleted: () => void;
    startInEditMode?: boolean;
    agentDir?: string;
    /** When false, model selection is hidden (non-Anthropic providers) */
    isAnthropicProvider?: boolean;
}

export interface AgentDetailPanelRef {
    isEditing: () => boolean;
}

const AgentDetailPanel = forwardRef<AgentDetailPanelRef, AgentDetailPanelProps>(
    function AgentDetailPanel({ name, scope, onBack: _onBack, onSaved, onDeleted, startInEditMode = false, agentDir, isAnthropicProvider = true }, ref) {
        const toast = useToast();
        const toastRef = useRef(toast);
        useEffect(() => { toastRef.current = toast; }, [toast]);

        const tabState = useTabApiOptional();
        const apiGet = tabState?.apiGet;
        const apiPost = tabState?.apiPost;
        const apiPut = tabState?.apiPut;
        const apiDeleteFn = tabState?.apiDelete;

        const api = useMemo(() => {
            if (apiGet && apiPost && apiPut && apiDeleteFn) {
                return { get: apiGet, post: apiPost, put: apiPut, delete: apiDeleteFn };
            }
            return { get: globalApiGet, post: globalApiPost, put: globalApiPut, delete: globalApiDelete };
        }, [apiGet, apiPost, apiPut, apiDeleteFn]);

        const isInTabContext = !!tabState;
        const [loading, setLoading] = useState(true);
        const [saving, setSaving] = useState(false);
        const [agent, setAgent] = useState<AgentDetail | null>(null);
        const [showAdvanced, setShowAdvanced] = useState(false);
        const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
        const [deleting, setDeleting] = useState(false);
        const [isEditing, setIsEditing] = useState(false);
        const [isNewAgent, setIsNewAgent] = useState(startInEditMode);

        // Original values for cancel/restore
        const [originalAgentName, setOriginalAgentName] = useState('');
        const [originalDescription, setOriginalDescription] = useState('');
        const [originalBody, setOriginalBody] = useState('');
        const [originalModel, setOriginalModel] = useState('');
        const [originalTools, setOriginalTools] = useState<string[]>([]);
        const [originalDisallowedTools, setOriginalDisallowedTools] = useState<string[]>([]);
        const [originalMaxTurns, setOriginalMaxTurns] = useState('');
        const [originalPermissionMode, setOriginalPermissionMode] = useState('');
        const [originalMemory, setOriginalMemory] = useState('');
        const [originalSkills, setOriginalSkills] = useState<string[]>([]);
        const [originalHooksYaml, setOriginalHooksYaml] = useState('');

        // Editable fields
        const [agentName, setAgentName] = useState('');
        const [description, setDescription] = useState('');
        const [body, setBody] = useState('');
        const [model, setModel] = useState('');
        const [toolsTags, setToolsTags] = useState<string[]>([]);
        const [disallowedToolsTags, setDisallowedToolsTags] = useState<string[]>([]);
        const [maxTurns, setMaxTurns] = useState('');
        const [permissionMode, setPermissionMode] = useState('');
        const [memory, setMemory] = useState('');
        const [skillsTags, setSkillsTags] = useState<string[]>([]);
        const [hooksYaml, setHooksYaml] = useState('');

        const nameInputRef = useRef<HTMLInputElement>(null);
        const [focusField, setFocusField] = useState<'name' | 'description' | 'body' | null>(null);

        // Available skills for suggestion dropdown
        const [availableSkills, setAvailableSkills] = useState<string[]>([]);
        useEffect(() => {
            const fetchSkills = async () => {
                try {
                    // Workspace context: project + user skills; Global context: user only
                    const scopeParam = scope === 'project' ? 'all' : 'user';
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir)
                        ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const res = await api.get<{ success: boolean; skills: Array<{ name: string; folderName: string; enabled?: boolean }> }>(
                        `/api/skills?scope=${scopeParam}${agentDirParam}`
                    );
                    if (res.success && res.skills) {
                        setAvailableSkills(res.skills.filter(s => s.enabled !== false).map(s => s.folderName));
                    }
                } catch { /* ignore — suggestions are optional */ }
            };
            void fetchSkills();
        }, [api, scope, isInTabContext, agentDir]);

        // Model options for CustomSelect
        const modelOptions = useMemo<SelectOption[]>(() => [
            { value: '', label: '继承主模型 (inherit)' },
            { value: 'sonnet', label: 'Sonnet' },
            { value: 'opus', label: 'Opus' },
            { value: 'haiku', label: 'Haiku' },
        ], []);

        // Permission mode options for CustomSelect
        const permissionModeOptions = useMemo<SelectOption[]>(() => [
            { value: '', label: '默认' },
            ...PERMISSION_MODES.map(m => ({
                value: m.sdkValue,
                label: `${m.icon} ${m.label} (${m.sdkValue})`,
            })),
        ], []);

        useImperativeHandle(ref, () => ({
            isEditing: () => isEditing
        }), [isEditing]);

        // Load agent data
        useEffect(() => {
            const loadAgent = async () => {
                setLoading(true);
                try {
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    const response = await api.get<{ success: boolean; agent: AgentDetail; error?: string }>(
                        `/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                    );
                    if (response.success && response.agent) {
                        setAgent(response.agent);
                        const fm = response.agent.frontmatter;
                        const nameVal = fm.name || name;
                        const desc = fm.description || '';
                        const bd = response.agent.body || '';
                        const mdl = fm.model || '';
                        const tls = parseToTags(fm.tools || '');
                        const dtls = parseToTags(fm.disallowedTools || '');
                        const mt = fm.maxTurns !== undefined ? String(fm.maxTurns) : '';
                        const pm = fm.permissionMode || '';
                        const mem = fm.memory || '';
                        const sk = fm.skills || [];
                        const hk = fm.hooks ? yamlDump(fm.hooks, { lineWidth: -1 }).trim() : '';

                        setAgentName(nameVal); setOriginalAgentName(nameVal);
                        setDescription(desc); setOriginalDescription(desc);
                        setBody(bd); setOriginalBody(bd);
                        setModel(mdl); setOriginalModel(mdl);
                        setToolsTags(tls); setOriginalTools(tls);
                        setDisallowedToolsTags(dtls); setOriginalDisallowedTools(dtls);
                        setMaxTurns(mt); setOriginalMaxTurns(mt);
                        setPermissionMode(pm); setOriginalPermissionMode(pm);
                        setMemory(mem); setOriginalMemory(mem);
                        setSkillsTags(sk); setOriginalSkills(sk);
                        setHooksYaml(hk); setOriginalHooksYaml(hk);

                        if (startInEditMode) setIsEditing(true);
                    } else {
                        toastRef.current.error(response.error || '加载失败');
                    }
                } catch {
                    toastRef.current.error('加载失败');
                } finally {
                    setLoading(false);
                }
            };
            loadAgent();
        }, [name, scope, agentDir, startInEditMode, api, isInTabContext]);

        const handleEdit = useCallback((field?: 'name' | 'description' | 'body') => {
            setFocusField(field || 'name');
            setIsEditing(true);
        }, []);

        useEffect(() => {
            if (isEditing && focusField && focusField !== 'body') {
                const timer = setTimeout(() => {
                    if (focusField === 'name') nameInputRef.current?.focus();
                    setFocusField(null);
                }, 0);
                return () => clearTimeout(timer);
            }
        }, [isEditing, focusField]);

        const handleCancel = useCallback(async () => {
            if (isNewAgent) {
                try {
                    const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                    await api.delete<{ success: boolean }>(`/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`);
                } catch { /* ignore */ }
                onDeleted();
            } else {
                setAgentName(originalAgentName);
                setDescription(originalDescription);
                setBody(originalBody);
                setModel(originalModel);
                setToolsTags(originalTools);
                setDisallowedToolsTags(originalDisallowedTools);
                setMaxTurns(originalMaxTurns);
                setPermissionMode(originalPermissionMode);
                setMemory(originalMemory);
                setSkillsTags(originalSkills);
                setHooksYaml(originalHooksYaml);
                setIsEditing(false);
            }
        }, [isNewAgent, name, scope, agentDir, originalAgentName, originalDescription, originalBody, originalModel, originalTools, originalDisallowedTools, originalMaxTurns, originalPermissionMode, originalMemory, originalSkills, originalHooksYaml, onDeleted, api, isInTabContext]);

        const expectedFolderName = agentName.trim() ? sanitizeFolderName(agentName.trim()) : '';

        const handleSave = useCallback(async () => {
            if (!agent) return;
            if (!agentName.trim()) {
                toastRef.current.error('Agent 名称不能为空');
                return;
            }
            setSaving(true);
            try {
                const frontmatter: Partial<AgentFrontmatter> = {
                    name: agentName.trim(),
                    description,
                };

                if (model) frontmatter.model = model as AgentFrontmatter['model'];
                if (toolsTags.length > 0) frontmatter.tools = toolsTags.join(', ');
                if (disallowedToolsTags.length > 0) frontmatter.disallowedTools = disallowedToolsTags.join(', ');
                if (maxTurns) frontmatter.maxTurns = parseInt(maxTurns, 10) || undefined;
                if (permissionMode) frontmatter.permissionMode = permissionMode;
                if (memory) frontmatter.memory = memory;
                if (skillsTags.length > 0) frontmatter.skills = skillsTags;
                if (hooksYaml.trim()) {
                    try {
                        frontmatter.hooks = yamlLoad(hooksYaml) as Record<string, unknown>;
                    } catch {
                        toastRef.current.error('Hooks YAML 格式错误');
                        setSaving(false);
                        return;
                    }
                }

                const newFolderName = sanitizeFolderName(agentName.trim());
                const nameWasModified = agentName.trim() !== originalAgentName;
                const shouldRename = nameWasModified && newFolderName && newFolderName !== agent.folderName;

                const payload = isInTabContext
                    ? { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}) }
                    : { scope, frontmatter, body, ...(shouldRename ? { newFolderName } : {}), ...(scope === 'project' && agentDir ? { agentDir } : {}) };

                const response = await api.put<{
                    success: boolean;
                    error?: string;
                    folderName?: string;
                }>(`/api/agent/${encodeURIComponent(name)}`, payload);

                if (response.success) {
                    toastRef.current.success('保存成功');
                    setIsEditing(false);
                    setIsNewAgent(false);
                    setOriginalAgentName(agentName.trim());
                    setOriginalDescription(description);
                    setOriginalBody(body);
                    setOriginalModel(model);
                    setOriginalTools(toolsTags);
                    setOriginalDisallowedTools(disallowedToolsTags);
                    setOriginalMaxTurns(maxTurns);
                    setOriginalPermissionMode(permissionMode);
                    setOriginalMemory(memory);
                    setOriginalSkills(skillsTags);
                    setOriginalHooksYaml(hooksYaml);

                    if (shouldRename && response.folderName) {
                        onSaved(true);
                    } else {
                        onSaved();
                    }
                } else {
                    toastRef.current.error(response.error || '保存失败');
                }
            } catch {
                toastRef.current.error('保存失败');
            } finally {
                setSaving(false);
            }
        }, [agent, agentName, description, body, model, toolsTags, disallowedToolsTags, maxTurns, permissionMode, memory, skillsTags, hooksYaml, name, scope, agentDir, originalAgentName, onSaved, api, isInTabContext]);

        const handleDelete = useCallback(async () => {
            if (!agent) return;
            setDeleting(true);
            try {
                const agentDirParam = (!isInTabContext && scope === 'project' && agentDir) ? `&agentDir=${encodeURIComponent(agentDir)}` : '';
                const response = await api.delete<{ success: boolean; error?: string }>(
                    `/api/agent/${encodeURIComponent(name)}?scope=${scope}${agentDirParam}`
                );
                if (response.success) {
                    track('agent_remove', { scope });
                    toastRef.current.success('已删除');
                    onDeleted();
                } else {
                    toastRef.current.error(response.error || '删除失败');
                }
            } catch {
                toastRef.current.error('删除失败');
            } finally {
                setDeleting(false);
                setShowDeleteConfirm(false);
            }
        }, [agent, name, scope, agentDir, onDeleted, api, isInTabContext]);

        if (loading) {
            return (
                <div className="flex h-64 items-center justify-center">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
                </div>
            );
        }

        if (!agent) {
            return (
                <div className="flex h-64 items-center justify-center text-[var(--ink-muted)]">
                    Agent 未找到
                </div>
            );
        }

        // Preview mode
        if (!isEditing) {
            return (
                <div className="flex h-full flex-col">
                    {/* Header */}
                    <div className="border-b border-[var(--line)] px-6 py-4">
                        <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                                <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{agentName}</h2>
                                {description && (
                                    <p className="mt-1 text-sm text-[var(--ink-muted)]">{description}</p>
                                )}
                            </div>
                            <div className="ml-4 flex items-center gap-2">
                                <button
                                    onClick={() => handleEdit()}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                >
                                    <Edit2 className="h-3.5 w-3.5" />
                                    编辑
                                </button>
                                <button
                                    onClick={() => setShowDeleteConfirm(true)}
                                    className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--error)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                        {/* Badges */}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                            {model && isAnthropicProvider && (
                                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    模型: {model}
                                </span>
                            )}
                            {permissionMode && (
                                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    权限: {PERMISSION_MODES.find(m => m.sdkValue === permissionMode)?.label ?? permissionMode}
                                </span>
                            )}
                            {toolsTags.length > 0 && (
                                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    工具: {toolsTags.length}
                                </span>
                            )}
                            {skillsTags.length > 0 && (
                                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                                    Skills: {skillsTags.length}
                                </span>
                            )}
                        </div>
                    </div>
                    {/* Body preview */}
                    <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4">
                        {body ? (
                            <div className="prose prose-sm max-w-none text-[var(--ink)]" onClick={() => handleEdit('body')}>
                                <Markdown>{body}</Markdown>
                            </div>
                        ) : (
                            <p className="text-sm italic text-[var(--ink-muted)]">暂无 System Prompt</p>
                        )}
                    </div>

                    {showDeleteConfirm && (
                        <ConfirmDialog
                            title="删除 Agent"
                            message={scope === 'user'
                                ? `确定要删除 "${agentName}" 吗？引用此 Agent 的项目将受到影响，此操作不可恢复。`
                                : `确定要删除 "${agentName}" 吗？此操作不可恢复。`}
                            confirmText="删除"
                            cancelText="取消"
                            confirmVariant="danger"
                            onConfirm={handleDelete}
                            onCancel={() => setShowDeleteConfirm(false)}
                            loading={deleting}
                        />
                    )}
                </div>
            );
        }

        // Edit mode
        return (
            <div className="flex h-full flex-col">
                {/* Edit Header */}
                <div className="border-b border-[var(--line)] px-6 py-3">
                    <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-[var(--ink-muted)]">编辑子 Agent</span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleCancel}
                                className="flex items-center gap-1 rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
                            >
                                <X className="h-3.5 w-3.5" />
                                取消
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                            >
                                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                保存
                            </button>
                        </div>
                    </div>
                </div>

                {/* Edit Form */}
                <div className="flex-1 overflow-y-auto overscroll-contain px-6 py-4 space-y-4">
                    {/* Name */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">名称</label>
                        <input
                            ref={nameInputRef}
                            type="text"
                            value={agentName}
                            onChange={e => setAgentName(e.target.value)}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                            placeholder="Agent 名称"
                        />
                        {/* Folder name hint */}
                        {agentName.trim() && expectedFolderName !== name && (
                            <p className="mt-1 text-xs text-[var(--ink-muted)]">
                                文件夹将重命名为: {expectedFolderName}
                            </p>
                        )}
                    </div>

                    {/* Description */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">描述</label>
                        <textarea
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                            rows={2}
                            className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none resize-none"
                            placeholder="描述 Agent 的职责和使用场景（模型据此决定何时委派）"
                        />
                    </div>

                    {/* Model - only show for Anthropic providers */}
                    {isAnthropicProvider && (
                        <div>
                            <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">模型</label>
                            <CustomSelect
                                value={model}
                                options={modelOptions}
                                onChange={setModel}
                                placeholder="继承主模型 (inherit)"
                            />
                        </div>
                    )}

                    {/* System Prompt */}
                    <div>
                        <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">系统提示词 (System Prompt)</label>
                        <div className="overflow-hidden rounded-lg border border-[var(--line)]" style={{ height: '300px' }}>
                            <MonacoEditor
                                value={body}
                                onChange={setBody}
                                language="markdown"
                                autoFocus={focusField === 'body'}
                            />
                        </div>
                    </div>

                    {/* Advanced Section */}
                    <div className="border-t border-[var(--line)] pt-4">
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="flex w-full items-center justify-between text-sm font-medium text-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <span>高级设置</span>
                            {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        </button>

                        {showAdvanced && (
                            <div className="mt-4 space-y-4">
                                {/* Allowed Tools - Tag input */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">允许的工具</label>
                                    <TagInput
                                        tags={toolsTags}
                                        onChange={setToolsTags}
                                        suggestions={COMMON_TOOLS}
                                        placeholder="输入工具名或从列表选择"
                                        emptyHint="留空则继承主 Agent 的所有工具"
                                    />
                                </div>

                                {/* Disallowed Tools - Tag input */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">禁用的工具</label>
                                    <TagInput
                                        tags={disallowedToolsTags}
                                        onChange={setDisallowedToolsTags}
                                        suggestions={COMMON_TOOLS}
                                        placeholder="输入要禁用的工具名"
                                        emptyHint="留空则不禁用任何工具"
                                    />
                                </div>

                                {/* Skills - Tag input with available skills suggestions */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">预加载 Skills</label>
                                    <TagInput
                                        tags={skillsTags}
                                        onChange={setSkillsTags}
                                        suggestions={availableSkills}
                                        placeholder="输入 Skill 名称或从列表选择"
                                        emptyHint="留空则不预加载 Skill。添加后 Skill 完整内容将注入 Agent 上下文"
                                    />
                                </div>

                                {/* Permission Mode */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">权限模式</label>
                                    <CustomSelect
                                        value={permissionMode}
                                        options={permissionModeOptions}
                                        onChange={setPermissionMode}
                                        placeholder="默认"
                                    />
                                </div>

                                {/* Max Turns */}
                                <div>
                                    <label className="mb-1 block text-sm font-medium text-[var(--ink-muted)]">最大轮数</label>
                                    <input
                                        type="number"
                                        value={maxTurns}
                                        onChange={e => setMaxTurns(e.target.value)}
                                        className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] focus:border-[var(--accent-warm)] focus:outline-none"
                                        placeholder="留空使用默认值"
                                        min={1}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {showDeleteConfirm && (
                    <ConfirmDialog
                        title="删除 Agent"
                        message={scope === 'user'
                            ? `确定要删除 "${agentName}" 吗？引用此 Agent 的项目将受到影响，此操作不可恢复。`
                            : `确定要删除 "${agentName}" 吗？此操作不可恢复。`}
                        confirmText="删除"
                        cancelText="取消"
                        confirmVariant="danger"
                        onConfirm={handleDelete}
                        onCancel={() => setShowDeleteConfirm(false)}
                        loading={deleting}
                    />
                )}
            </div>
        );
    }
);

export default AgentDetailPanel;
