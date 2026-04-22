// Agent memory auto-update section (v0.1.43)
import { useState, useCallback, useRef, useEffect, Suspense, lazy } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { MemoryAutoUpdateConfig } from '../../../../shared/types/im';
import { DEFAULT_MEMORY_AUTO_UPDATE_CONFIG } from '../../../../shared/types/im';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { useToast } from '@/components/Toast';

const FilePreviewModal = lazy(() => import('../../FilePreviewModal'));

interface AgentMemoryUpdateSectionProps {
  agent: AgentConfig;
  onAgentChanged: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 24, label: '24 小时' },
  { value: 48, label: '48 小时' },
  { value: 72, label: '72 小时' },
] as const;

const DEFAULT_UPDATE_MEMORY_CONTENT = `---
description: >
  记忆维护指令 — PM Copilot 在夜间将会使用该指令自动注入到活跃 session 执行。
  此指令基于预设 Agent 模板 - Mino 的记忆结构设计。
  如果你的 Agent 的记忆机制不同，请自由修改为合适的指令。
---

整理你的记忆。不用赶时间，做仔细。

## 要做什么

1. **读近期日志** — 今天 + 上次维护以来的所有 \`memory/YYYY-MM-DD.md\`
2. **更新 topic 文件** — 最近工作过的项目，把新经验、状态变更、决策同步到 \`memory/topics/<name>.md\`
3. **更新核心记忆** — 提炼跨项目的新教训到 \`04-MEMORY.md\`；更新 Ongoing Context；清理过时信息
4. **整理工作区** — 把散落的临时文件归档整理
5. **Commit + push** — 如果工作区是 git 仓库，仅 git add 你本次更新的记忆相关文件，提交并推送。不要动工作区里其他未暂存的变更

## 原则

- 信息只存一处 — topic file 里写详细了，核心记忆只放指针
- 每条记忆带时间戳 \`(YYYY-MM-DD)\`
- 删比留更重要 — 过时信息是噪音
- topic file 不存在但该有？创建它
- 做完后在今天的日志里记一笔

记住：工作区是你的家，记忆是你持续进化的方式。
`;

export default function AgentMemoryUpdateSection({ agent, onAgentChanged }: AgentMemoryUpdateSectionProps) {
  const config = agent.memoryAutoUpdate;

  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  const [previewFile, setPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);

  const updateConfig = useCallback(async (patch: Partial<MemoryAutoUpdateConfig>) => {
    const current = agent.memoryAutoUpdate ?? { ...DEFAULT_MEMORY_AUTO_UPDATE_CONFIG, enabled: false };
    await patchAgentConfig(agent.id, {
      memoryAutoUpdate: { ...current, ...patch },
    });
    onAgentChanged();
  }, [agent.id, agent.memoryAutoUpdate, onAgentChanged]);

  // Resolve file path (cross-platform separator)
  const filePath = `${agent.workspacePath}${agent.workspacePath.includes('\\') ? '\\' : '/'}UPDATE_MEMORY.md`;

  // Read or create file via Rust invoke (bypasses Tauri fs plugin scope)
  const ensureFile = useCallback(async (): Promise<{ ok: boolean; content: string }> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const existing = await invoke<string | null>('cmd_read_workspace_file', { path: filePath });
      if (existing !== null) return { ok: true, content: existing };
      // File doesn't exist — create with default content
      await invoke('cmd_write_workspace_file', { path: filePath, content: DEFAULT_UPDATE_MEMORY_CONTENT });
      toastRef.current.success('已创建 UPDATE_MEMORY.md');
      return { ok: true, content: DEFAULT_UPDATE_MEMORY_CONTENT };
    } catch (e) {
      console.warn('[AgentMemoryUpdateSection] File operation failed:', e);
      toastRef.current.error('无法读写 UPDATE_MEMORY.md，请检查工作区路径');
      return { ok: false, content: '' };
    }
  }, [filePath]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !(config?.enabled ?? false);
    if (newEnabled) {
      const { ok } = await ensureFile();
      if (!ok) return;
    }
    await updateConfig({ enabled: newEnabled });
  }, [config?.enabled, ensureFile, updateConfig]);

  const handleOpenFile = useCallback(async () => {
    const { ok, content } = await ensureFile();
    if (!ok) return;
    setPreviewFile({ name: 'UPDATE_MEMORY.md', content, size: new TextEncoder().encode(content).length, path: filePath });
  }, [ensureFile, filePath]);

  const handleDirectSave = useCallback(async (content: string) => {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_write_workspace_file', { path: filePath, content });
  }, [filePath]);

  const handleRevealFile = useCallback(async () => {
    if (!previewFile) return;
    const parentDir = previewFile.path.substring(0, previewFile.path.lastIndexOf('/'))
      || previewFile.path.substring(0, previewFile.path.lastIndexOf('\\'));
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parentDir);
  }, [previewFile]);

  const enabled = config?.enabled ?? false;
  const intervalHours = config?.intervalHours ?? 24;
  const queryThreshold = config?.queryThreshold ?? 5;
  const windowStart = config?.updateWindowStart ?? '00:00';
  const windowEnd = config?.updateWindowEnd ?? '06:00';

  // Last batch info
  const lastBatchAt = config?.lastBatchAt;
  const lastBatchCount = config?.lastBatchSessionCount;
  let lastBatchLabel = '';
  if (lastBatchAt) {
    const dt = new Date(lastBatchAt);
    const diffMs = Date.now() - dt.getTime();
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH < 1) lastBatchLabel = '不到 1 小时前';
    else if (diffH < 24) lastBatchLabel = `${diffH} 小时前`;
    else lastBatchLabel = `${Math.floor(diffH / 24)} 天前`;
    if (lastBatchCount !== undefined && lastBatchCount !== null) {
      lastBatchLabel += ` · ${lastBatchCount} 个 session 已更新`;
    }
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header + Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-medium text-[var(--ink)]">记忆更新 Memory</h3>
            <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
              在夜间自动读取{' '}
              <button
                type="button"
                onClick={handleOpenFile}
                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
              >
                UPDATE_MEMORY.md
              </button>
              {' '}中的指令，对各活跃 session 执行记忆维护
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
              enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
            }`}
          >
            <span
              className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {enabled && (
          <div className="space-y-4 pl-0">
            {/* Interval */}
            <div>
              <label className="block text-sm font-medium text-[var(--ink)] mb-2">更新间隔</label>
              <div className="flex gap-2">
                {INTERVAL_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => updateConfig({ intervalHours: opt.value as 24 | 48 | 72 })}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      intervalHours === opt.value
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--paper-inset)] text-[var(--ink-muted)] hover:bg-[var(--paper-hover)]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Update Window */}
            <div>
              <label className="block text-sm font-medium text-[var(--ink)] mb-2">更新时间窗口</label>
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  value={windowStart}
                  onChange={e => updateConfig({ updateWindowStart: e.target.value })}
                  className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
                <span className="text-xs text-[var(--ink-muted)]">—</span>
                <input
                  type="time"
                  value={windowEnd}
                  onChange={e => updateConfig({ updateWindowEnd: e.target.value })}
                  className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                />
                <span className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)]">
                  {config?.updateWindowTimezone || agent.heartbeat?.activeHours?.timezone || 'Asia/Shanghai'}
                </span>
              </div>
            </div>

            {/* Threshold */}
            <div>
              <label className="block text-sm font-medium text-[var(--ink)] mb-2">触发阈值</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--ink-muted)]">自上次更新后至少</span>
                <input
                  type="number"
                  min={3}
                  max={50}
                  value={queryThreshold}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (v >= 3 && v <= 50) updateConfig({ queryThreshold: v });
                  }}
                  className="w-14 rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink)] text-center border border-[var(--line)]"
                />
                <span className="text-xs text-[var(--ink-muted)]">条新对话才会触发</span>
              </div>
            </div>

            {/* Last batch info */}
            {lastBatchLabel && (
              <div className="border-t border-dashed border-[var(--line)] pt-3">
                <span className="text-xs text-[var(--ink-muted)]">
                  上次更新{'  '}{lastBatchLabel}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* FilePreviewModal */}
      {previewFile && (
        <Suspense fallback={null}>
          <FilePreviewModal
            name={previewFile.name}
            content={previewFile.content}
            size={previewFile.size}
            path={previewFile.path}
            onClose={() => setPreviewFile(null)}
            onSave={handleDirectSave}
            onRevealFile={handleRevealFile}
          />
        </Suspense>
      )}
    </>
  );
}
