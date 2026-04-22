/**
 * SkillsCommandsList - Component for displaying Skills and Commands list
 *
 * Uses Tab-scoped API when in Tab context (WorkspaceConfigPanel),
 * falls back to global API when not in Tab context (GlobalSkillsPanel in Settings).
 */
import { Plus, Sparkles, Terminal, Loader2, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState, useMemo, useRef } from 'react';

import { apiGetJson as globalApiGet, apiPostJson as globalApiPost, apiDelete as globalApiDelete } from '@/api/apiFetch';
import { useTabApiOptional } from '@/context/TabContext';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import { CreateDialog, NewSkillChooser } from './SkillDialogs';
import type { SkillItem, CommandItem } from '../../shared/skillsTypes';
import { CUSTOM_EVENTS } from '../../shared/constants';

interface SkillsCommandsListProps {
    scope: 'user' | 'project';
    agentDir?: string;
    onSelectSkill: (name: string, scope: 'user' | 'project', isNewSkill?: boolean) => void;
    onSelectCommand: (name: string, scope: 'user' | 'project') => void;
    refreshKey?: number;
    /** Callback to close parent modal (used when navigating to Settings) */
    onClose?: () => void;
}

export default function SkillsCommandsList({
    scope,
    agentDir,
    onSelectSkill,
    onSelectCommand,
    refreshKey = 0,
    onClose
}: SkillsCommandsListProps) {
    const toast = useToast();
    // Stabilize toast reference to avoid unnecessary effect re-runs
    const toastRef = useRef(toast);
    toastRef.current = toast;

    // Use Tab-scoped API when available (in project workspace context)
    // Fall back to global API when not in Tab context (Settings page)
    const tabState = useTabApiOptional();

    // Create stable API functions - only depend on the specific functions, not the whole tabState
    // This prevents re-creating the api object when unrelated tabState properties change
    const apiGet = tabState?.apiGet;
    const apiPost = tabState?.apiPost;
    const apiDeleteFn = tabState?.apiDelete;

    const api = useMemo(() => {
        if (apiGet && apiPost && apiDeleteFn) {
            return { get: apiGet, post: apiPost, delete: apiDeleteFn };
        }
        return { get: globalApiGet, post: globalApiPost, delete: globalApiDelete };
    }, [apiGet, apiPost, apiDeleteFn]);

    // Track if we're in tab context (stable boolean that won't change)
    const isInTabContext = !!tabState;
    const [loading, setLoading] = useState(true);
    const [skills, setSkills] = useState<SkillItem[]>([]);
    const [commands, setCommands] = useState<CommandItem[]>([]);
    const [showNewSkillDialog, setShowNewSkillDialog] = useState(false);
    const [showNewCommandDialog, setShowNewCommandDialog] = useState(false);
    const [newItemName, setNewItemName] = useState('');
    const [newItemDescription, setNewItemDescription] = useState('');
    const [creating, setCreating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<{ type: 'skill' | 'command'; name: string; scope: 'user' | 'project' } | null>(null);
    const [deleting, setDeleting] = useState(false);

    // Build endpoint with optional agentDir (same pattern as SystemPromptsPanel)
    const buildEndpoint = useCallback((path: string) => {
        if (isInTabContext) return path;
        if (!agentDir) return path;
        const sep = path.includes('?') ? '&' : '?';
        return `${path}${sep}agentDir=${encodeURIComponent(agentDir)}`;
    }, [isInTabContext, agentDir]);

    // Load skills and commands
    // When scope is 'project', only load project-level data (user-level shown in Settings)
    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [skillsRes, commandsRes] = await Promise.all([
                api.get<{ success: boolean; skills: SkillItem[] }>(buildEndpoint(`/api/skills?scope=${scope}`)),
                api.get<{ success: boolean; commands: CommandItem[] }>(buildEndpoint(`/api/command-items?scope=${scope}`))
            ]);

            if (skillsRes.success) {
                setSkills(skillsRes.skills);
            }
            if (commandsRes.success) {
                setCommands(commandsRes.commands);
            }
        } catch {
            toastRef.current.error('加载失败');
        } finally {
            setLoading(false);
        }
    }, [scope, api, buildEndpoint]);

    useEffect(() => {
        loadData();
    }, [loadData, refreshKey]);


    // 快速创建技能并立即进入编辑模式
    const handleQuickCreateSkill = useCallback(async (tempName: string) => {
        try {
            // When using Tab API, no need to pass agentDir (sidecar already has it)
            // When using global API, pass agentDir for project scope
            const payload = isInTabContext
                ? { name: tempName, scope, description: '' }
                : { name: tempName, scope, description: '', ...(scope === 'project' && agentDir ? { agentDir } : {}) };

            const response = await api.post<{ success: boolean; error?: string; folderName?: string }>('/api/skill/create', payload);
            if (response.success) {
                // 创建成功后直接进入详情页(编辑模式由详情页处理)
                // 使用返回的 folderName（sanitized）而非 tempName
                onSelectSkill(response.folderName || tempName, scope, true);
                loadData();
                // Notify SimpleChatInput to refresh slash commands
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName: response.folderName || tempName } }));
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        }
    }, [scope, agentDir, loadData, onSelectSkill, api, isInTabContext]);

    // 上传技能文件
    const handleUploadSkill = useCallback(async (file: File) => {
        try {
            // 读取文件为 base64
            const reader = new FileReader();
            reader.onload = async () => {
                const base64Content = (reader.result as string).split(',')[1]; // 去除 data:xxx;base64, 前缀
                try {
                    const response = await api.post<{
                        success: boolean;
                        folderName?: string;
                        message?: string;
                        error?: string;
                    }>('/api/skill/upload', {
                        filename: file.name,
                        content: base64Content,
                        scope
                    });

                    if (response.success) {
                        toastRef.current.success(response.message || '技能导入成功');
                        setShowNewSkillDialog(false);
                        loadData();
                        // 进入新创建的技能详情页
                        if (response.folderName) {
                            onSelectSkill(response.folderName, scope, true);
                        }
                        // Notify SimpleChatInput to refresh slash commands
                        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName: response.folderName } }));
                    } else {
                        toastRef.current.error(response.error || '导入失败');
                    }
                } catch (err) {
                    toastRef.current.error(err instanceof Error ? err.message : '导入失败');
                }
            };
            reader.onerror = () => {
                toastRef.current.error('读取文件失败');
            };
            reader.readAsDataURL(file);
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : '上传失败');
        }
    }, [scope, loadData, onSelectSkill, api]);

    // 导入文件夹
    const handleImportFolder = useCallback(async (folderPath: string) => {
        try {
            const response = await api.post<{
                success: boolean;
                folderName?: string;
                message?: string;
                error?: string;
            }>('/api/skill/import-folder', {
                folderPath,
                scope
            });

            if (response.success) {
                toastRef.current.success(response.message || '技能导入成功');
                setShowNewSkillDialog(false);
                loadData();
                // 进入新创建的技能详情页
                if (response.folderName) {
                    onSelectSkill(response.folderName, scope, true);
                }
                // Notify SimpleChatInput to refresh slash commands
                window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.SKILL_COPIED_TO_PROJECT, { detail: { skillName: response.folderName } }));
            } else {
                toastRef.current.error(response.error || '导入失败');
            }
        } catch (err) {
            toastRef.current.error(err instanceof Error ? err.message : '导入失败');
        }
    }, [scope, loadData, onSelectSkill, api]);

    const handleCreateCommand = useCallback(async () => {
        if (!newItemName.trim()) return;
        setCreating(true);
        try {
            const response = await api.post<{ success: boolean; error?: string }>('/api/command-item/create', {
                name: newItemName.trim(),
                scope,
                description: newItemDescription.trim() || undefined
            });
            if (response.success) {
                toastRef.current.success('指令创建成功');
                setShowNewCommandDialog(false);
                setNewItemName('');
                setNewItemDescription('');
                loadData();
            } else {
                toastRef.current.error(response.error || '创建失败');
            }
        } catch {
            toastRef.current.error('创建失败');
        } finally {
            setCreating(false);
        }
    }, [newItemName, newItemDescription, scope, loadData, api]);

    const handleDelete = useCallback(async () => {
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            const endpoint = buildEndpoint(
                deleteTarget.type === 'skill'
                    ? `/api/skill/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
                    : `/api/command-item/${encodeURIComponent(deleteTarget.name)}?scope=${deleteTarget.scope}`
            );

            const response = await api.delete<{ success: boolean; error?: string }>(endpoint);
            if (response.success) {
                toastRef.current.success('删除成功');
                setDeleteTarget(null);
                loadData();
            } else {
                toastRef.current.error(response.error || '删除失败');
            }
        } catch {
            toastRef.current.error('删除失败');
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, loadData, api, buildEndpoint]);

    // Open Settings tab with Skills section (close modal first if in modal context)
    const handleOpenUserSkills = useCallback(() => {
        // Close parent modal first so user can see the Settings page
        onClose?.();
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
            detail: { section: 'skills' }
        }));
    }, [onClose]);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--ink-muted)]" />
            </div>
        );
    }

    return (
        <div className="p-6">
            {/* Skills Section */}
            <div className="mb-8">
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Sparkles className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">
                            {scope === 'project' ? '项目技能' : '技能 Skills'}
                        </h3>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {skills.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewSkillDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>

                {/* Skills List */}
                {skills.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {skills.map(skill => (
                            <SkillCard
                                key={`${skill.scope}-${skill.folderName}`}
                                skill={skill}
                                onClick={() => onSelectSkill(skill.folderName, skill.scope)}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={<Sparkles className="h-12 w-12" />}
                        title={scope === 'project' ? '还没有项目技能' : '还没有技能'}
                        description="创建你的第一个技能来扩展 Claude 的能力"
                    />
                )}

                {/* Link to user skills (only in project scope) */}
                {scope === 'project' && (
                    <button
                        type="button"
                        onClick={handleOpenUserSkills}
                        className="mt-4 flex w-full items-center justify-center gap-1.5 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--accent)]"
                    >
                        <span>查看用户技能</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* Commands Section */}
            <div>
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Terminal className="h-5 w-5 text-[var(--ink-muted)]" />
                        <h3 className="text-base font-semibold text-[var(--ink)]">
                            {scope === 'project' ? '项目指令' : '指令 Commands'}
                        </h3>
                        <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
                            {commands.length}
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowNewCommandDialog(true)}
                        className="flex items-center gap-1 rounded-lg bg-[var(--button-primary-bg)] px-3 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
                    >
                        <Plus className="h-4 w-4" />
                        新建
                    </button>
                </div>

                {/* Commands List */}
                {commands.length > 0 ? (
                    <div className="grid grid-cols-2 gap-3">
                        {commands.map(cmd => (
                            <CommandCard
                                key={`${cmd.scope}-${cmd.fileName}`}
                                command={cmd}
                                onClick={() => onSelectCommand(cmd.fileName, cmd.scope)}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={<Terminal className="h-12 w-12" />}
                        title={scope === 'project' ? '还没有项目指令' : '还没有指令'}
                        description="创建你的第一个指令来定义工作流"
                    />
                )}

                {/* Link to user commands (only in project scope) */}
                {scope === 'project' && (
                    <button
                        type="button"
                        onClick={handleOpenUserSkills}
                        className="mt-4 flex w-full items-center justify-center gap-1.5 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--accent)]"
                    >
                        <span>查看用户指令</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {/* New Skill Dialog - Choice Mode */}
            {showNewSkillDialog && (
                <NewSkillChooser
                    onWriteSkill={() => {
                        // 直接进入编辑模式创建新技能
                        setShowNewSkillDialog(false);
                        // 创建临时技能并进入编辑模式
                        const tempName = `new-skill-${Date.now()}`;
                        handleQuickCreateSkill(tempName);
                    }}
                    onUploadSkill={handleUploadSkill}
                    onImportFolder={handleImportFolder}
                    onCancel={() => setShowNewSkillDialog(false)}
                />
            )}

            {/* New Command Dialog */}
            {showNewCommandDialog && (
                <CreateDialog
                    title="新建指令"
                    name={newItemName}
                    description={newItemDescription}
                    onNameChange={setNewItemName}
                    onDescriptionChange={setNewItemDescription}
                    onConfirm={handleCreateCommand}
                    onCancel={() => {
                        setShowNewCommandDialog(false);
                        setNewItemName('');
                        setNewItemDescription('');
                    }}
                    loading={creating}
                />
            )}

            {/* Delete Confirmation */}
            {deleteTarget && (
                <ConfirmDialog
                    title={`删除${deleteTarget.type === 'skill' ? '技能' : '指令'}`}
                    message={`确定要删除「${deleteTarget.name}」吗？此操作无法撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleDelete}
                    onCancel={() => setDeleteTarget(null)}
                    loading={deleting}
                />
            )}
        </div>
    );
}

// Skill Card Component - Card style with title badge
// Exported for reuse in GlobalSkillsPanel
export function SkillCard({ skill, onClick, onToggleEnabled }: {
    skill: SkillItem;
    onClick: () => void;
    onToggleEnabled?: (folderName: string, enabled: boolean) => void;
}) {
    const isDisabled = skill.enabled === false;
    return (
        <div
            className={`group flex cursor-pointer flex-col rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px] ${isDisabled ? 'opacity-50' : ''}`}
            onClick={onClick}
        >
            {/* Title with badge */}
            <div className="mb-2 flex items-center gap-1.5">
                <h4 className="truncate text-[15px] font-semibold text-[var(--ink)]">
                    {skill.displayName || skill.name}
                </h4>
                <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
            </div>
            {/* Description - 2 lines */}
            <p className="mb-3 line-clamp-2 flex-1 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                {skill.displayDescription || skill.description || '暂无描述'}
            </p>
            {/* Footer - author + optional enable/disable toggle */}
            <div className="flex h-5 items-center justify-between text-xs text-[var(--ink-muted)]/70">
                <span>{skill.author || ''}</span>
                {onToggleEnabled && (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={!isDisabled}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleEnabled(skill.folderName, isDisabled);
                        }}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                            !isDisabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                        }`}
                    >
                        <span
                            className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-[var(--toggle-thumb)] shadow-sm ring-0 transition-transform ${
                                !isDisabled ? 'translate-x-4' : 'translate-x-0.5'
                            }`}
                        />
                    </button>
                )}
            </div>
        </div>
    );
}

// Command Card Component - Card style with title badge
// Exported for reuse in GlobalSkillsPanel
export function CommandCard({ command, onClick }: { command: CommandItem; onClick: () => void }) {
    return (
        <div
            className="group flex cursor-pointer flex-col rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
            onClick={onClick}
        >
            {/* Title with badge */}
            <div className="mb-2 flex items-center gap-1.5">
                <h4 className="truncate text-[15px] font-semibold text-[var(--ink)]">
                    {command.name}
                </h4>
                <Terminal className="h-4 w-4 shrink-0 text-sky-500" />
            </div>
            {/* Description - 2 lines */}
            <p className="mb-3 line-clamp-2 flex-1 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                {command.description || '暂无描述'}
            </p>
            {/* Footer - only show content when author exists, but maintain height */}
            <div className="flex h-4 items-center text-xs text-[var(--ink-muted)]/70">
                {command.author && <span>{command.author}</span>}
            </div>
        </div>
    );
}

// Empty State Component
function EmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
    return (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-inset)]/30 py-8">
            <div className="text-[var(--ink-muted)]/30">{icon}</div>
            <p className="mt-3 text-sm font-medium text-[var(--ink-muted)]">{title}</p>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">{description}</p>
        </div>
    );
}

// CreateDialog and NewSkillChooser are imported from SkillDialogs.tsx
