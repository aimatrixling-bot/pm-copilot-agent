/**
 * UsageStatsPanel - Global token usage statistics panel for Settings page
 */
import { ArrowDownLeft, ArrowUpRight, BarChart2, Database, Loader2, MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getGlobalStats, type GlobalStats } from '@/api/sessionClient';
import { getAllProviders } from '@/config/services/providerService';
import { formatTokens } from '@/utils/formatTokens';

type TimeRange = '7d' | '30d' | '60d';

const RANGE_LABELS: Record<TimeRange, string> = {
    '7d': '7天',
    '30d': '30天',
    '60d': '60天',
};

export default function UsageStatsPanel() {
    const [stats, setStats] = useState<GlobalStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [range, setRange] = useState<TimeRange>('30d');
    const [modelVendorMap, setModelVendorMap] = useState<Record<string, string>>({});

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);
        setError(null);

        const load = async () => {
            try {
                const [data, providers] = await Promise.all([
                    getGlobalStats(range),
                    getAllProviders(),
                ]);
                if (cancelled) return;

                // Build modelId → vendor mapping
                const mapping: Record<string, string> = {};
                for (const provider of providers) {
                    for (const m of provider.models) {
                        if (!mapping[m.model]) {
                            mapping[m.model] = provider.vendor;
                        }
                    }
                }
                setModelVendorMap(mapping);

                if (data) {
                    setStats(data);
                } else {
                    setError('无法加载统计数据');
                }
            } catch {
                if (!cancelled) {
                    setError('加载失败');
                }
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        };
        load();
        return () => { cancelled = true; };
    }, [range]);

    const totalTokens = (stats?.summary.totalInputTokens ?? 0) + (stats?.summary.totalOutputTokens ?? 0);

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--ink)]">使用统计</h2>
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">全局 Token 消耗统计</p>
                </div>
                <div className="flex gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
                    {(Object.keys(RANGE_LABELS) as TimeRange[]).map((r) => (
                        <button
                            key={r}
                            onClick={() => setRange(r)}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                range === r
                                    ? 'bg-[var(--accent)] text-white'
                                    : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                            }`}
                        >
                            {RANGE_LABELS[r]}
                        </button>
                    ))}
                </div>
            </div>

            {isLoading ? (
                <div className="flex h-48 items-center justify-center gap-2 text-[var(--ink-muted)]">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-sm">加载中...</span>
                </div>
            ) : error ? (
                <div className="flex h-48 items-center justify-center text-[var(--error)]">
                    {error}
                </div>
            ) : stats ? (
                <>
                    {/* Summary Cards */}
                    <SummaryCards stats={stats} totalTokens={totalTokens} />

                    {/* Daily Trend Chart */}
                    <DailyTrendChart daily={stats.daily} totalTokens={totalTokens} />

                    {/* Model Distribution Table */}
                    <ModelTable byModel={stats.byModel} totalTokens={totalTokens} modelVendorMap={modelVendorMap} />
                </>
            ) : null}
        </div>
    );
}

// ============= Summary Cards =============

function SummaryCards({ stats, totalTokens }: { stats: GlobalStats; totalTokens: number }) {
    const cards = [
        {
            label: '总 Token',
            value: formatTokens(totalTokens),
            icon: BarChart2,
        },
        {
            label: '输入 Token',
            value: formatTokens(stats.summary.totalInputTokens),
            icon: ArrowUpRight,
        },
        {
            label: '输出 Token',
            value: formatTokens(stats.summary.totalOutputTokens),
            icon: ArrowDownLeft,
        },
        {
            label: '输入缓存',
            value: formatTokens(stats.summary.totalCacheReadTokens + stats.summary.totalCacheCreationTokens),
            icon: Database,
        },
        {
            label: '对话轮次',
            value: String(stats.summary.messageCount),
            icon: MessageSquare,
        },
    ];

    return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {cards.map((card) => (
                <div
                    key={card.label}
                    className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
                >
                    <div className="flex items-center gap-2 text-[var(--ink-muted)]">
                        <card.icon className="h-4 w-4" />
                        <span className="text-xs">{card.label}</span>
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-[var(--ink)]">
                        {card.value}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ============= Daily Trend Chart =============

interface TooltipState {
    x: number;
    y: number;
    containerWidth: number;
    date: string;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
}

function DailyTrendChart({ daily, totalTokens }: { daily: GlobalStats['daily']; totalTokens: number }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [tooltip, setTooltip] = useState<TooltipState | null>(null);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const handleMouseLeave = useCallback(() => {
        setTooltip(null);
        setHoveredIndex(null);
    }, []);

    const handleBarHover = useCallback((e: React.MouseEvent<SVGRectElement>, index: number, day: GlobalStats['daily'][number]) => {
        const containerEl = containerRef.current;
        if (!containerEl) return;
        const rect = containerEl.getBoundingClientRect();
        setTooltip({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top - 10,
            containerWidth: containerEl.clientWidth,
            date: day.date,
            inputTokens: day.inputTokens,
            outputTokens: day.outputTokens,
            messageCount: day.messageCount,
        });
        setHoveredIndex(index);
    }, []);

    if (daily.length === 0) {
        return (
            <div>
                <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-[var(--ink)]">每日用量趋势</h3>
                </div>
                <div className="flex h-48 items-center justify-center rounded-lg border border-[var(--line)] text-sm text-[var(--ink-muted)]">
                    暂无数据
                </div>
            </div>
        );
    }

    const maxTotal = Math.max(...daily.map(d => d.inputTokens + d.outputTokens), 1);

    const chartHeight = 200;
    const chartPaddingTop = 16;
    const chartPaddingBottom = 28;
    const chartPaddingX = 12;
    const barAreaHeight = chartHeight - chartPaddingTop - chartPaddingBottom;

    // Use a fixed viewBox width; bars scale proportionally with xMidYMax meet
    const svgWidth = 800;
    const dayCount = daily.length;
    const barGap = Math.max(2, Math.min(8, (svgWidth - chartPaddingX * 2) / dayCount * 0.15));
    const barWidth = Math.max(4, ((svgWidth - chartPaddingX * 2) - (dayCount - 1) * barGap) / dayCount);

    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--ink)]">每日用量趋势</h3>
                <span className="text-xs text-[var(--ink-muted)]">
                    总消耗: {formatTokens(totalTokens)} tokens
                </span>
            </div>
            <div
                ref={containerRef}
                className="relative rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4"
                onMouseLeave={handleMouseLeave}
            >
                <svg
                    width="100%"
                    height={chartHeight}
                    viewBox={`0 0 ${svgWidth} ${chartHeight}`}
                    preserveAspectRatio="xMidYMax meet"
                    className="w-full"
                >
                    {daily.map((day, i) => {
                        const x = chartPaddingX + i * (barWidth + barGap);
                        const total = day.inputTokens + day.outputTokens;
                        const totalH = Math.max((total / maxTotal) * barAreaHeight, 2);
                        const inputH = total > 0 ? (day.inputTokens / total) * totalH : totalH / 2;
                        const outputH = totalH - inputH;
                        const barY = chartPaddingTop + barAreaHeight - totalH;
                        const isHovered = hoveredIndex === i;
                        const dateLabel = day.date.slice(5); // "MM-DD"

                        return (
                            <g key={day.date}>
                                {/* Hover hitbox */}
                                <rect
                                    x={x}
                                    y={chartPaddingTop}
                                    width={barWidth}
                                    height={barAreaHeight}
                                    fill="transparent"
                                    onMouseMove={(e) => handleBarHover(e, i, day)}
                                    style={{ cursor: 'pointer' }}
                                />
                                {/* Input (bottom) */}
                                <rect
                                    x={x}
                                    y={barY + outputH}
                                    width={barWidth}
                                    height={inputH}
                                    rx={0}
                                    fill={isHovered ? 'var(--accent)' : 'var(--accent-warm-muted)'}
                                    pointerEvents="none"
                                    style={{ transition: 'fill 0.15s' }}
                                />
                                {/* Output (top) */}
                                <rect
                                    x={x}
                                    y={barY}
                                    width={barWidth}
                                    height={outputH}
                                    rx={barWidth > 4 ? 3 : 1}
                                    fill={isHovered ? 'var(--accent)' : 'var(--accent)'}
                                    opacity={isHovered ? 0.7 : 0.4}
                                    pointerEvents="none"
                                    style={{ transition: 'opacity 0.15s' }}
                                />
                                {/* X-axis label */}
                                <text
                                    x={x + barWidth / 2}
                                    y={chartHeight - 6}
                                    textAnchor="middle"
                                    fill="var(--ink-muted)"
                                    fontSize="9"
                                    fontFamily="inherit"
                                    pointerEvents="none"
                                >
                                    {dateLabel}
                                </text>
                            </g>
                        );
                    })}
                </svg>

                {/* Tooltip */}
                {tooltip && (
                    <div
                        className="pointer-events-none absolute z-10 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 shadow-lg"
                        style={{
                            left: Math.min(tooltip.x, (tooltip.containerWidth || 300) - 180),
                            top: Math.max(tooltip.y - 70, 4),
                        }}
                    >
                        <div className="text-xs font-medium text-[var(--ink)]">{tooltip.date}</div>
                        <div className="mt-1 space-y-0.5 text-xs text-[var(--ink-muted)]">
                            <div>输入: {formatTokens(tooltip.inputTokens)}</div>
                            <div>输出: {formatTokens(tooltip.outputTokens)}</div>
                            <div>对话: {tooltip.messageCount} 轮</div>
                        </div>
                    </div>
                )}

                {/* Legend */}
                <div className="mt-2 flex items-center justify-center gap-4 text-xs text-[var(--ink-muted)]">
                    <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: 'var(--accent-warm-muted)' }} />
                        <span>输入</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-sm opacity-40" style={{ backgroundColor: 'var(--accent)' }} />
                        <span>输出</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ============= Model Distribution Table =============

const ALL_VENDOR = '全部';
const OTHER_VENDOR = '其他';

function ModelTable({ byModel, totalTokens, modelVendorMap }: {
    byModel: GlobalStats['byModel'];
    totalTokens: number;
    modelVendorMap: Record<string, string>;
}) {
    const [selectedVendor, setSelectedVendor] = useState(ALL_VENDOR);

    const models = Object.entries(byModel);

    if (models.length === 0) {
        return null;
    }

    // Sort by total tokens descending
    models.sort((a, b) => {
        const totalA = a[1].inputTokens + a[1].outputTokens;
        const totalB = b[1].inputTokens + b[1].outputTokens;
        return totalB - totalA;
    });

    // Derive vendor list from models that have data
    const vendorSet = new Set<string>();
    let hasOther = false;
    for (const [modelId] of models) {
        const vendor = modelVendorMap[modelId];
        if (vendor) {
            vendorSet.add(vendor);
        } else {
            hasOther = true;
        }
    }
    const vendors = [ALL_VENDOR, ...Array.from(vendorSet).sort()];
    if (hasOther) vendors.push(OTHER_VENDOR);

    // Filter models by selected vendor
    const filteredModels = selectedVendor === ALL_VENDOR
        ? models
        : models.filter(([modelId]) => {
            const vendor = modelVendorMap[modelId];
            if (selectedVendor === OTHER_VENDOR) return !vendor;
            return vendor === selectedVendor;
        });

    // Compute filtered total
    const filteredTotal = filteredModels.reduce(
        (sum, [, data]) => sum + data.inputTokens + data.outputTokens, 0,
    );

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="mr-1 text-sm font-semibold text-[var(--ink)]">模型用量分布</h3>
                {vendors.length > 2 && (
                    <div className="flex gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1">
                        {vendors.map((v) => (
                            <button
                                key={v}
                                onClick={() => setSelectedVendor(v)}
                                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                    selectedVendor === v
                                        ? 'bg-[var(--accent)] text-white'
                                        : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
                                }`}
                            >
                                {v}
                            </button>
                        ))}
                    </div>
                )}
                <span className="ml-auto text-xs text-[var(--ink-muted)]">
                    总消耗: {formatTokens(selectedVendor === ALL_VENDOR ? totalTokens : filteredTotal)} tokens
                </span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-[var(--line)]">
                <table className="w-full text-sm">
                    <thead className="bg-[var(--paper-elevated)]">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ink-muted)]">
                                模型
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                总 Token
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                输入
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                输出
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                输入缓存
                            </th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ink-muted)]">
                                次数
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line)]">
                        {filteredModels.map(([model, data]) => (
                            <tr key={model}>
                                <td className="px-4 py-2 text-[var(--ink)]">
                                    {model}
                                </td>
                                <td className="px-4 py-2 text-right font-medium text-[var(--ink)]">
                                    {formatTokens(data.inputTokens + data.outputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.inputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.outputTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {formatTokens(data.cacheReadTokens + data.cacheCreationTokens)}
                                </td>
                                <td className="px-4 py-2 text-right text-[var(--ink-muted)]">
                                    {data.count}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
