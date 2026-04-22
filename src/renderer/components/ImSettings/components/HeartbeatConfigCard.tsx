import { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { HeartbeatConfig, ActiveHoursConfig } from '../../../../shared/types/im';
import { DEFAULT_HEARTBEAT_CONFIG } from '../../../../shared/types/im';

const FilePreviewModal = lazy(() => import('../../FilePreviewModal'));

const INTERVAL_PRESETS = [
    { label: '5 分钟', value: 5 },
    { label: '15 分钟', value: 15 },
    { label: '30 分钟', value: 30 },
    { label: '1 小时', value: 60 },
    { label: '4 小时', value: 240 },
];

const COMMON_TIMEZONES = [
    { label: 'Asia/Shanghai (UTC+8)', value: 'Asia/Shanghai' },
    { label: 'Asia/Tokyo (UTC+9)', value: 'Asia/Tokyo' },
    { label: 'America/New_York (UTC-5)', value: 'America/New_York' },
    { label: 'America/Los_Angeles (UTC-8)', value: 'America/Los_Angeles' },
    { label: 'Europe/London (UTC+0)', value: 'Europe/London' },
    { label: 'Europe/Berlin (UTC+1)', value: 'Europe/Berlin' },
    { label: 'UTC', value: 'UTC' },
];

export default function HeartbeatConfigCard({
    heartbeat,
    onChange,
    flat,
    workspacePath,
}: {
    heartbeat: HeartbeatConfig | undefined;
    onChange: (config: HeartbeatConfig | undefined) => void;
    /** When true, renders without card border/bg — parent handles container styling */
    flat?: boolean;
    /** Workspace path — used to open HEARTBEAT.md in built-in preview/editor */
    workspacePath?: string;
}) {
    const config = useMemo(
        () => heartbeat ?? DEFAULT_HEARTBEAT_CONFIG,
        [heartbeat],
    );

    const [tzOpen, setTzOpen] = useState(false);

    const update = useCallback(
        (patch: Partial<HeartbeatConfig>) => {
            onChange({ ...config, ...patch });
        },
        [config, onChange],
    );

    const toggleEnabled = useCallback(() => {
        if (!heartbeat) {
            // First enable: create with defaults, including active hours on by default
            onChange({
                ...DEFAULT_HEARTBEAT_CONFIG,
                enabled: true,
                activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' },
            });
        } else {
            update({ enabled: !config.enabled });
        }
    }, [heartbeat, config.enabled, onChange, update]);

    const toggleActiveHours = useCallback(() => {
        if (config.activeHours) {
            update({ activeHours: undefined });
        } else {
            update({
                activeHours: {
                    start: '08:00',
                    end: '22:00',
                    timezone: 'Asia/Shanghai',
                },
            });
        }
    }, [config.activeHours, update]);

    const updateActiveHours = useCallback(
        (patch: Partial<ActiveHoursConfig>) => {
            if (!config.activeHours) return;
            update({ activeHours: { ...config.activeHours, ...patch } });
        },
        [config.activeHours, update],
    );

    const [previewFile, setPreviewFile] = useState<{ name: string; content: string; size: number; path: string } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const handleOpenHeartbeatFile = useCallback(async () => {
        if (!workspacePath) return;
        setPreviewLoading(true);
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const sep = workspacePath.includes('\\') ? '\\' : '/';
            const filePath = `${workspacePath}${sep}HEARTBEAT.md`;
            // Use Rust command to bypass Tauri fs scope (which only covers ~/.pm-copilot)
            const content: string = await invoke('cmd_read_workspace_file', { path: filePath }) ?? '';
            setPreviewFile({ name: 'HEARTBEAT.md', content, size: new TextEncoder().encode(content).length, path: filePath });
        } catch (e) {
            console.warn('[HeartbeatConfigCard] Failed to open HEARTBEAT.md:', e);
        } finally {
            setPreviewLoading(false);
        }
    }, [workspacePath]);

    // Direct file save via Rust command — bypasses Tauri fs scope (which only covers ~/.pm-copilot)
    const handleDirectSave = useCallback(async (content: string) => {
        if (!previewFile) return;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cmd_write_workspace_file', { path: previewFile.path, content });
    }, [previewFile]);

    // Reveal file in system file manager via Tauri shell
    const handleRevealFile = useCallback(async () => {
        if (!previewFile) return;
        const parentDir = previewFile.path.substring(0, previewFile.path.lastIndexOf('/'))
            || previewFile.path.substring(0, previewFile.path.lastIndexOf('\\'));
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(parentDir);
    }, [previewFile]);

    const isCustomInterval = !INTERVAL_PRESETS.some(p => p.value === config.intervalMinutes);
    const selectedTz = COMMON_TIMEZONES.find(tz => tz.value === config.activeHours?.timezone);

    return (
        <>
        <div className={flat ? '' : 'rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5'}>
            {/* Header with toggle */}
            <div className={`flex items-center justify-between${config.enabled ? ' mb-4' : ''}`}>
                <div>
                    <h3 className="text-base font-medium text-[var(--ink)]">心跳感知 Heartbeat</h3>
                    <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                        心跳感知赋予 Agent 按心跳间隔时间苏醒，检查一下心跳清单{' '}
                        {workspacePath ? (
                            <button
                                type="button"
                                onClick={handleOpenHeartbeatFile}
                                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
                            >
                                HEARTBEAT.md
                            </button>
                        ) : (
                            <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)]">HEARTBEAT.md</code>
                        )}
                        {' '}里面的任务，如果为空则会跳过。你可以直接编辑心跳清单{' '}
                        {workspacePath ? (
                            <button
                                type="button"
                                onClick={handleOpenHeartbeatFile}
                                className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)] hover:underline cursor-pointer"
                            >
                                HEARTBEAT.md
                            </button>
                        ) : (
                            <code className="rounded bg-[var(--paper-inset)] px-1 py-0.5 text-[var(--accent)]">HEARTBEAT.md</code>
                        )}
                        {' '}的内容。
                    </p>
                </div>
                <button
                    type="button"
                    onClick={toggleEnabled}
                    className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                        config.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                    }`}
                >
                    <span
                        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                            config.enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                    />
                </button>
            </div>

            {config.enabled && (
                <div className="space-y-4">
                    {/* Interval */}
                    <div>
                        <p className="mb-2 text-sm font-medium text-[var(--ink)]">心跳间隔</p>
                        <div className="flex flex-wrap gap-2">
                            {INTERVAL_PRESETS.map(preset => (
                                <button
                                    key={preset.value}
                                    type="button"
                                    onClick={() => update({ intervalMinutes: preset.value })}
                                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        config.intervalMinutes === preset.value
                                            ? 'bg-[var(--accent)] text-white'
                                            : 'bg-[var(--paper-inset)] text-[var(--ink-secondary)] hover:bg-[var(--ink-faint)]'
                                    }`}
                                >
                                    {preset.label}
                                </button>
                            ))}
                            {/* Custom interval input */}
                            <div className="flex items-center gap-1">
                                <input
                                    type="number"
                                    min={5}
                                    max={1440}
                                    value={isCustomInterval ? config.intervalMinutes : ''}
                                    placeholder="自定义"
                                    onChange={e => {
                                        const val = parseInt(e.target.value, 10);
                                        if (!isNaN(val) && val >= 5) {
                                            update({ intervalMinutes: val });
                                        }
                                    }}
                                    className={`w-20 rounded-lg border px-2 py-1.5 text-xs ${
                                        isCustomInterval
                                            ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                                            : 'border-[var(--line)] bg-[var(--paper)]'
                                    } text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]`}
                                />
                                <span className="text-xs text-[var(--ink-muted)]">分钟</span>
                            </div>
                        </div>
                    </div>

                    {/* Active hours */}
                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-[var(--ink)]">活跃时段</p>
                                <p className="text-xs text-[var(--ink-muted)]">
                                    仅在指定时间范围内执行心跳
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={toggleActiveHours}
                                className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                    config.activeHours ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                                }`}
                            >
                                <span
                                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                        config.activeHours ? 'translate-x-5' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </div>

                        {config.activeHours && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                                <input
                                    type="time"
                                    value={config.activeHours.start}
                                    onChange={e => updateActiveHours({ start: e.target.value })}
                                    className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                />
                                <span className="text-xs text-[var(--ink-muted)]">至</span>
                                <input
                                    type="time"
                                    value={config.activeHours.end}
                                    onChange={e => updateActiveHours({ end: e.target.value })}
                                    className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                />
                                {/* Custom timezone dropdown */}
                                <div className="relative">
                                    <button
                                        type="button"
                                        onClick={() => setTzOpen(!tzOpen)}
                                        className="flex items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2 py-1.5 text-xs text-[var(--ink)] hover:border-[var(--line-strong)] focus:border-[var(--accent)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]"
                                    >
                                        <span>{selectedTz?.label || config.activeHours.timezone}</span>
                                        <ChevronDown className="h-3 w-3 text-[var(--ink-subtle)]" />
                                    </button>
                                    {tzOpen && (
                                        <>
                                            <div className="fixed inset-0 z-40" onClick={() => setTzOpen(false)} />
                                            <div className="absolute left-0 top-8 z-50 w-56 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1 shadow-lg">
                                                {COMMON_TIMEZONES.map(tz => (
                                                    <button
                                                        key={tz.value}
                                                        type="button"
                                                        onClick={() => {
                                                            updateActiveHours({ timezone: tz.value });
                                                            setTzOpen(false);
                                                        }}
                                                        className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                                                            config.activeHours?.timezone === tz.value
                                                                ? 'bg-[var(--accent-warm-muted)] text-[var(--accent)]'
                                                                : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]'
                                                        }`}
                                                    >
                                                        {tz.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
        {previewFile && (
            <Suspense fallback={null}>
                <FilePreviewModal
                    name={previewFile.name}
                    content={previewFile.content}
                    size={previewFile.size}
                    path={previewFile.path}
                    isLoading={previewLoading}
                    onClose={() => setPreviewFile(null)}
                    onSave={handleDirectSave}
                    onRevealFile={handleRevealFile}
                />
            </Suspense>
        )}
        </>
    );
}
