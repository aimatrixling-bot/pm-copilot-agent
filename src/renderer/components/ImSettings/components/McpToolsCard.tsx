import React from 'react';
import type { McpServerDefinition } from '@/config/types';

export default function McpToolsCard({
    availableMcpServers,
    enabledServerIds,
    onToggle,
}: {
    availableMcpServers: McpServerDefinition[];
    enabledServerIds: string[];
    onToggle: (serverId: string) => void;
}) {
    return (
        <div className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
            <h3 className="mb-4 text-sm font-semibold text-[var(--ink)]">MCP 工具</h3>
            <p className="mb-3 text-xs text-[var(--ink-muted)]">
                Bot 可使用的 MCP 工具（独立于客户端设置，仅显示全局已启用的 MCP 服务）
            </p>
            {availableMcpServers.length > 0 ? (
                <div className="space-y-2">
                    {availableMcpServers.map((server) => {
                        const checked = enabledServerIds.includes(server.id);
                        return (
                            <label
                                key={server.id}
                                className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--line)] p-3 transition-colors hover:border-[var(--line-strong)]"
                            >
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => onToggle(server.id)}
                                    className="h-4 w-4 rounded border-[var(--line)]"
                                />
                                <div>
                                    <p className="text-sm font-medium text-[var(--ink)]">{server.name}</p>
                                    {server.description && (
                                        <p className="text-xs text-[var(--ink-muted)]">{server.description}</p>
                                    )}
                                </div>
                            </label>
                        );
                    })}
                </div>
            ) : (
                <p className="text-xs text-[var(--ink-muted)]">
                    暂无全局已启用的 MCP 服务。请先在「设置 → MCP 工具」中启用。
                </p>
            )}
        </div>
    );
}
