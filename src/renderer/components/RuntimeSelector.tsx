// RuntimeSelector — dropdown to switch between Agent Runtime types (v0.1.59)
// Appears in SimpleChatInput toolbar (left of permission mode) and WorkspaceBasicsSection

import { memo, useCallback, useRef, useState } from 'react';
import { ChevronUp, Settings } from 'lucide-react';
import type { RuntimeType, RuntimeDetections } from '../../shared/types/runtime';

// Runtime types that have backend implementations (not just type definitions)
const IMPLEMENTED_RUNTIMES = new Set<RuntimeType>(['builtin', 'claude-code', 'codex']);
import { useCloseLayer } from '@/hooks/useCloseLayer';

// ─── Runtime icon assets ───
import pmCopilotIcon from '@/assets/runtime-icons/pm-copilot.png';
import claudeCodeIcon from '@/assets/runtime-icons/claude-code.png';
import codexIcon from '@/assets/runtime-icons/codex.png';

const RUNTIME_ICON_MAP: Record<RuntimeType, string> = {
  builtin: pmCopilotIcon,
  'claude-code': claudeCodeIcon,
  codex: codexIcon,
};

// ─── Runtime display metadata ───

const RUNTIME_OPTIONS: {
  type: RuntimeType;
  name: string;
}[] = [
    { type: 'builtin', name: 'PM Copilot (Claude Agent SDK)' },
    { type: 'claude-code', name: 'Claude Code CLI' },
    { type: 'codex', name: 'Codex CLI' },
  ];

function RuntimeIcon({ type, size = 14 }: { type: RuntimeType; size?: number }) {
  return (
    <img
      src={RUNTIME_ICON_MAP[type]}
      alt=""
      className="shrink-0 rounded-[3px]"
      style={{ width: size, height: size }}
      draggable={false}
    />
  );
}

// ─── Component ───

interface RuntimeSelectorProps {
  value: RuntimeType;
  detections: RuntimeDetections;
  onChange: (runtime: RuntimeType) => void;
  variant?: 'toolbar' | 'panel';
  onOpenSettings?: () => void;
}

export default memo(function RuntimeSelector({
  value,
  detections,
  onChange,
  variant = 'toolbar',
  onOpenSettings,
}: RuntimeSelectorProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Register with close layer system so Cmd+W dismisses dropdown before closing Tab
  useCloseLayer(() => {
    if (open) { setOpen(false); return true; }
    return false;
  }, open ? 10 : -1);

  const handleSelect = useCallback((type: RuntimeType) => {
    if (type === value) {
      setOpen(false);
      return;
    }
    const detection = detections[type];
    if (!detection?.installed) return; // Can't select uninstalled runtime
    setOpen(false);
    onChange(type);
  }, [value, detections, onChange]);

  const currentOption = RUNTIME_OPTIONS.find(o => o.type === value) ?? RUNTIME_OPTIONS[0];

  if (variant === 'panel') {
    // Panel variant: full-width button like other WorkspaceBasicsSection fields
    return (
      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--ink)] hover:bg-[var(--hover-bg)] transition-colors"
        >
          <span className="flex items-center gap-2">
            <RuntimeIcon type={value} size={16} />
            {currentOption.name}
          </span>
          <ChevronUp className={`h-3.5 w-3.5 text-[var(--ink-muted)] transition-transform ${open ? '' : 'rotate-180'}`} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <div className="absolute left-0 bottom-full z-20 mb-1 w-72 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl py-1">
              {RUNTIME_OPTIONS.map((opt) => {
                const detection = detections[opt.type];
                const installed = opt.type === 'builtin' || (detection?.installed && IMPLEMENTED_RUNTIMES.has(opt.type));
                return (
                  <button
                    key={opt.type}
                    type="button"
                    onClick={() => installed && handleSelect(opt.type)}
                    disabled={!installed}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left whitespace-nowrap transition-colors ${installed
                      ? opt.type === value
                        ? 'bg-[var(--accent-warm-subtle)]'
                        : 'hover:bg-[var(--hover-bg)]'
                      : 'opacity-40 cursor-not-allowed'
                      }`}
                  >
                    <RuntimeIcon type={opt.type} size={20} />
                    <span className={`text-sm font-medium ${opt.type === value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                      {opt.name}
                    </span>
                    {!installed && (
                      <span className="ml-auto text-[var(--ink-subtle)] text-xs">
                        {detection?.installed && !IMPLEMENTED_RUNTIMES.has(opt.type) ? '即将支持' : '未安装'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  }

  // Toolbar variant: compact icon button
  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex items-center gap-1 rounded-lg px-1.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
        title={`Runtime: ${currentOption.name}`}
      >
        <RuntimeIcon type={value} size={16} />
        <ChevronUp className={`h-2.5 w-2.5 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 bottom-full z-20 mb-1 w-72 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl py-1">
            <div className="flex items-center justify-between px-3 pb-0.5 pt-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ink-muted)]/60">运行环境</span>
              {onOpenSettings && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setOpen(false); onOpenSettings(); }}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                  <Settings className="h-2.5 w-2.5" />
                  设置
                </button>
              )}
            </div>
            {RUNTIME_OPTIONS.map((opt) => {
              const detection = detections[opt.type];
              const installed = opt.type === 'builtin' || (detection?.installed && IMPLEMENTED_RUNTIMES.has(opt.type));
              return (
                <button
                  key={opt.type}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (installed) handleSelect(opt.type);
                  }}
                  disabled={!installed}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left whitespace-nowrap transition-colors ${installed
                    ? opt.type === value
                      ? 'bg-[var(--accent-warm-subtle)]'
                      : 'hover:bg-[var(--hover-bg)]'
                    : 'opacity-40 cursor-not-allowed'
                    }`}
                >
                  <RuntimeIcon type={opt.type} size={20} />
                  <span className={`text-sm font-medium ${opt.type === value ? 'text-[var(--accent)]' : 'text-[var(--ink)]'}`}>
                    {opt.name}
                  </span>
                  {!installed && (
                    <span className="ml-auto text-[var(--ink-subtle)] text-xs">未安装</span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});
