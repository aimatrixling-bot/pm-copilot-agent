/**
 * WorkspaceSelector - Dropdown workspace selector for Launcher brand section
 * Opens upward with default/recent workspace groups
 */

import { ChevronUp, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import WorkspaceIcon from './WorkspaceIcon';

interface WorkspaceSelectorProps {
    projects: Project[];
    selectedProject: Project | null;
    defaultWorkspacePath?: string;
    onSelect: (project: Project) => void;
    onAddFolder: () => void;
}

export default function WorkspaceSelector({
    projects,
    selectedProject,
    defaultWorkspacePath,
    onSelect,
    onAddFolder,
}: WorkspaceSelectorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on click outside
    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleSelect = useCallback((project: Project) => {
        onSelect(project);
        setIsOpen(false);
    }, [onSelect]);

    // Split projects into default and recent (memoized to avoid re-sort on every render)
    const { defaultProject, recentProjects } = useMemo(() => {
        const def = defaultWorkspacePath
            ? projects.find(p => p.path === defaultWorkspacePath) ?? null
            : null;
        const recent = [...projects]
            .sort((a, b) => {
                const aTime = a.lastOpened ? new Date(a.lastOpened).getTime() : 0;
                const bTime = b.lastOpened ? new Date(b.lastOpened).getTime() : 0;
                return bTime - aTime;
            })
            .filter(p => p.path !== defaultWorkspacePath)
            .slice(0, 5);
        return { defaultProject: def, recentProjects: recent };
    }, [projects, defaultWorkspacePath]);

    if (projects.length === 0) {
        return (
            <button
                onClick={onAddFolder}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent)]"
            >
                <Plus className="h-3.5 w-3.5" />
                <span>选择工作区</span>
            </button>
        );
    }

    return (
        <div ref={containerRef} className="relative inline-block">
            {/* Trigger — toolbar-compatible style */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
            >
                <WorkspaceIcon icon={selectedProject?.icon} size={16} />
                <span className="max-w-[120px] truncate">
                    {selectedProject ? (selectedProject.displayName || getFolderName(selectedProject.path)) : '选择工作区'}
                </span>
                <ChevronUp className={`h-3 w-3 shrink-0 transition-transform ${isOpen ? '' : 'rotate-180'}`} />
            </button>

            {/* Dropdown - opens upward */}
            {isOpen && (
                <div className="absolute bottom-full left-0 mb-1.5 w-64 max-h-72 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--paper)] py-1 shadow-xl">
                    {/* Default workspace group */}
                    {defaultProject && (
                        <>
                            <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">
                                默认
                            </div>
                            <button
                                onClick={() => handleSelect(defaultProject)}
                                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                                    selectedProject?.id === defaultProject.id
                                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                                        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                                }`}
                            >
                                <WorkspaceIcon icon={defaultProject.icon} size={16} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate font-medium">{defaultProject.displayName || getFolderName(defaultProject.path)}</div>
                                    <div className="truncate text-[11px] text-[var(--ink-muted)]">
                                        {shortenPathForDisplay(defaultProject.path)}
                                    </div>
                                </div>
                            </button>
                        </>
                    )}

                    {/* Recent workspaces group */}
                    {recentProjects.length > 0 && (
                        <>
                            <div className={`px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60 ${defaultProject ? 'mt-1 border-t border-[var(--line)]' : ''}`}>
                                最近打开
                            </div>
                            {recentProjects.map(project => (
                                <button
                                    key={project.id}
                                    onClick={() => handleSelect(project)}
                                    className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${
                                        selectedProject?.id === project.id
                                            ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                                            : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                                    }`}
                                >
                                    <WorkspaceIcon icon={project.icon} size={16} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-medium">{project.displayName || getFolderName(project.path)}</div>
                                        <div className="truncate text-[11px] text-[var(--ink-muted)]">
                                            {shortenPathForDisplay(project.path)}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </>
                    )}

                    {/* Divider + add folder */}
                    <div className="mt-1 border-t border-[var(--line)]">
                        <button
                            onClick={() => {
                                setIsOpen(false);
                                onAddFolder();
                            }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                            <Plus className="h-3.5 w-3.5" />
                            <span>选择文件夹...</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
