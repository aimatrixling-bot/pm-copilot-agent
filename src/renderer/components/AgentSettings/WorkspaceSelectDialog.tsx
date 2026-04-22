// Dialog for selecting a workspace to upgrade to Agent
import { useMemo } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { Project } from '@/config/types';
import { getFolderName } from '@/types/tab';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface WorkspaceSelectDialogProps {
  projects: Project[];
  onSelect: (project: Project) => void;
  onClose: () => void;
}

export default function WorkspaceSelectDialog({ projects, onSelect, onClose }: WorkspaceSelectDialogProps) {
  useCloseLayer(() => { onClose(); return true; }, 50);

  const eligibleProjects = useMemo(
    () => projects.filter(p => !p.isAgent && !p.internal),
    [projects],
  );

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-50">
      <div className="w-full max-w-md rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--ink)]">
            选择工作区
          </h2>
          <button onClick={onClose} className="rounded p-1 text-[var(--ink-subtle)] hover:text-[var(--ink-muted)] transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-[var(--ink-muted)]">
          选择一个尚未升级的工作区，将其转化为 Agent。
        </p>

        {eligibleProjects.length === 0 ? (
          <p className="py-8 text-center text-sm text-[var(--ink-subtle)]">
            所有工作区已升级为 Agent。
          </p>
        ) : (
          <div className="max-h-[300px] space-y-2 overflow-y-auto">
            {eligibleProjects.map(project => (
              <button
                key={project.id}
                className="flex w-full items-center gap-3 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-3 text-left transition-all hover:border-[var(--line-strong)] hover:bg-[var(--paper-elevated)]"
                onClick={() => onSelect(project)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--ink)]">
                    {project.displayName || getFolderName(project.path)}
                  </div>
                  <div className="text-xs text-[var(--ink-subtle)]">
                    {shortenPathForDisplay(project.path)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}
