/**
 * ModelManagementPanel - Unified overlay for managing provider models
 *
 * Upper section: Active models — hover "设为首选", delete any model, add custom ID
 * Lower section: Discover more — single-click "添加" per row, no multi-select
 */
import { X, Search, Loader2, RefreshCw, AlertCircle, Plus, Trash2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useCloseLayer } from '@/hooks/useCloseLayer';
import { type Provider, type ModelEntity, type AppConfig } from '@/config/types';
import {
  fetchProviderModels,
  toModelEntity,
  formatTokenCount,
  supportsModelDiscovery,
  type DiscoveredModel,
} from '@/config/services/modelDiscoveryService';
import { atomicModifyConfig } from '@/config/configService';
import OverlayBackdrop from '@/components/OverlayBackdrop';

interface ModelManagementPanelProps {
  provider: Provider;
  apiKey: string | undefined;
  config: AppConfig;
  onClose: () => void;
  onSaveCustomModels: (providerId: string, models: ModelEntity[]) => Promise<void>;
  onUpdateCustomProvider?: (provider: Provider) => Promise<void>;
  onSetPrimaryModel: (providerId: string, modelId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export default function ModelManagementPanel({
  provider,
  apiKey,
  config,
  onClose,
  onSaveCustomModels,
  onUpdateCustomProvider,
  onSetPrimaryModel,
  onRefresh,
}: ModelManagementPanelProps) {
  // ===== Discovery state =====
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  const primaryModel = provider.primaryModel;

  // Active model IDs set
  const activeModelIds = useMemo(
    () => new Set(provider.models.map(m => m.model)),
    [provider.models],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useCloseLayer(() => { onClose(); return true; }, 200);

  // ===== Discovery fetch =====
  const canDiscover = !!apiKey && supportsModelDiscovery(provider);

  const doFetch = useCallback(async () => {
    if (!canDiscover) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    const thisId = ++fetchIdRef.current;
    try {
      const result = await fetchProviderModels(provider, apiKey);
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveredModels(result);
    } catch (e) {
      if (!isMountedRef.current || thisId !== fetchIdRef.current) return;
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isMountedRef.current && thisId === fetchIdRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }, [provider, apiKey, canDiscover]);

  useEffect(() => { doFetch(); }, [doFetch]);

  // ===== Actions =====
  const handleSetPrimary = useCallback(async (modelId: string) => {
    await onSetPrimaryModel(provider.id, modelId);
    await onRefresh();
  }, [provider.id, onSetPrimaryModel, onRefresh]);

  const handleDeleteModel = useCallback(async (modelId: string) => {
    if (provider.isBuiltin) {
      // For preset models: add to presetRemovedModels
      // For user-added models: remove from presetCustomModels
      const customModels = config.presetCustomModels?.[provider.id] ?? [];
      const isUserAdded = customModels.some(m => m.model === modelId);
      if (isUserAdded) {
        await onSaveCustomModels(provider.id, customModels.filter(m => m.model !== modelId));
      } else {
        // Preset model — add to removed list
        await atomicModifyConfig(c => {
          const removed = c.presetRemovedModels?.[provider.id] ?? [];
          if (removed.includes(modelId)) return c;
          return {
            ...c,
            presetRemovedModels: { ...c.presetRemovedModels, [provider.id]: [...removed, modelId] },
          };
        });
      }
    } else if (onUpdateCustomProvider) {
      const updatedModels = provider.models.filter(m => m.model !== modelId);
      await onUpdateCustomProvider({ ...provider, models: updatedModels });
    }
    if (modelId === primaryModel) {
      const remaining = provider.models.filter(m => m.model !== modelId);
      if (remaining.length > 0) {
        await onSetPrimaryModel(provider.id, remaining[0].model);
      }
    }
    await onRefresh();
  }, [provider, config.presetCustomModels, primaryModel, onSaveCustomModels, onUpdateCustomProvider, onSetPrimaryModel, onRefresh]);

  const handleAddCustomModel = useCallback(async () => {
    const id = customInput.trim();
    if (!id || activeModelIds.has(id)) return;

    const entity: ModelEntity = {
      model: id, modelName: id,
      modelSeries: provider.vendor.toLowerCase(),
      source: 'manual',
    };

    if (provider.isBuiltin) {
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, [...existing, entity]);
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    setCustomInput('');
    await onRefresh();
  }, [customInput, activeModelIds, provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  const handleAddDiscoveredModel = useCallback(async (model: DiscoveredModel) => {
    if (activeModelIds.has(model.id)) return;
    const entity = toModelEntity(model, provider);

    if (provider.isBuiltin) {
      // Also remove from presetRemovedModels if re-adding a previously removed preset
      await atomicModifyConfig(c => {
        const removed = c.presetRemovedModels?.[provider.id];
        if (!removed?.includes(model.id)) return c;
        return {
          ...c,
          presetRemovedModels: {
            ...c.presetRemovedModels,
            [provider.id]: removed.filter(id => id !== model.id),
          },
        };
      });
      const existing = config.presetCustomModels?.[provider.id] ?? [];
      await onSaveCustomModels(provider.id, [...existing, entity]);
    } else if (onUpdateCustomProvider) {
      await onUpdateCustomProvider({ ...provider, models: [...provider.models, entity] });
    }
    await onRefresh();
  }, [activeModelIds, provider, config.presetCustomModels, onSaveCustomModels, onUpdateCustomProvider, onRefresh]);

  // ===== Filtered discovery (exclude already-added) =====
  const filteredDiscovered = useMemo(() => {
    let list = discoveredModels.filter(m => !activeModelIds.has(m.id));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(m =>
        m.id.toLowerCase().includes(q) ||
        m.displayName?.toLowerCase().includes(q) ||
        m.ownedBy?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [discoveredModels, activeModelIds, search]);

  const allAdded = discoveredModels.length > 0 && discoveredModels.every(m => activeModelIds.has(m.id));

  return createPortal(
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        className="relative flex h-[85vh] w-[620px] max-w-[90vw] flex-col overflow-hidden rounded-2xl bg-[var(--paper-elevated)] shadow-2xl"
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-[var(--ink)]">
            管理可用模型
            <span className="ml-2 text-sm font-normal text-[var(--ink-muted)]">{provider.name}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* ===== Upper: Active Models ===== */}
          <div className="border-b border-[var(--line-subtle)] px-5 py-4">
            <h3 className="mb-2.5 text-xs font-semibold text-[var(--ink-muted)]">
              可用模型
              {provider.models.length > 0 && (
                <span className="ml-1.5 font-normal text-[var(--ink-subtle)]">{provider.models.length}</span>
              )}
            </h3>

            {provider.models.length === 0 ? (
              <p className="py-4 text-center text-sm text-[var(--ink-muted)]">暂无模型，请在下方发现或手动添加</p>
            ) : (
              <div>
                {provider.models.map(model => (
                  <ActiveModelRow
                    key={model.model}
                    model={model}
                    isPrimary={model.model === primaryModel}
                    onSetPrimary={handleSetPrimary}
                    onDelete={handleDeleteModel}
                  />
                ))}
              </div>
            )}

            {/* Add custom model input */}
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); } }}
                placeholder="输入模型 ID，按 Enter 添加"
                className="flex-1 rounded-lg border border-[var(--line)] bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomModel}
                disabled={!customInput.trim() || activeModelIds.has(customInput.trim())}
                className="rounded-lg bg-[var(--paper-inset)] px-2.5 py-1.5 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)] disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* ===== Lower: Discover Models ===== */}
          <div className="px-5 py-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-[var(--ink-muted)]">
                发现更多模型
              </h3>
              {canDiscover && discoveredModels.length > 0 && (
                <button
                  type="button"
                  onClick={doFetch}
                  disabled={discoveryLoading}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${discoveryLoading ? 'animate-spin' : ''}`} />
                  刷新
                </button>
              )}
            </div>

            {/* Search — always visible once models have been loaded (avoids layout jump on refresh) */}
            {canDiscover && !discoveryError && discoveredModels.length > 0 && (
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ink-subtle)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full rounded-lg border border-[var(--line)] bg-transparent py-1.5 pl-8 pr-3 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--ink-muted)] focus:outline-none"
                />
              </div>
            )}

            {/* States */}
            {!canDiscover && !apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">请先配置 API Key</p>
            )}
            {!canDiscover && apiKey && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">当前供应商不支持发现模型</p>
            )}

            {canDiscover && discoveryLoading && discoveredModels.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-[var(--ink-muted)]">
                <Loader2 className="h-5 w-5 animate-spin" />
                <p className="mt-2 text-sm">正在拉取模型列表...</p>
              </div>
            )}

            {canDiscover && discoveryError && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <AlertCircle className="h-5 w-5 text-[var(--error)]" />
                <p className="mt-2 text-sm text-[var(--ink)]">无法拉取模型列表</p>
                <p className="mt-1 max-w-md text-xs text-[var(--ink-muted)]">{discoveryError}</p>
                <button
                  type="button"
                  onClick={doFetch}
                  className="mt-3 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重试
                </button>
              </div>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && allAdded && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">所有可用模型已在上方列表中</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && !allAdded && filteredDiscovered.length === 0 && search && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">没有匹配的模型</p>
            )}

            {canDiscover && !discoveryLoading && !discoveryError && discoveredModels.length === 0 && (
              <p className="py-6 text-center text-sm text-[var(--ink-muted)]">该供应商未返回可用模型</p>
            )}

            {/* Model list — no checkboxes, just rows with hover "添加" */}
            {filteredDiscovered.length > 0 && (
              <div>
                {filteredDiscovered.map(m => (
                  <DiscoveredModelRow
                    key={m.id}
                    model={m}
                    onAdd={handleAddDiscoveredModel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 items-center justify-end border-t border-[var(--line)] px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            完成
          </button>
        </div>
      </div>
    </OverlayBackdrop>,
    document.body,
  );
}

// ===== ActiveModelRow =====

const ActiveModelRow = React.memo(function ActiveModelRow({
  model,
  isPrimary,
  onSetPrimary,
  onDelete,
}: {
  model: ModelEntity;
  isPrimary: boolean;
  onSetPrimary: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const handleSetPrimary = useCallback(() => { if (!isPrimary) onSetPrimary(model.model); }, [isPrimary, onSetPrimary, model.model]);
  const handleDelete = useCallback(() => onDelete(model.model), [onDelete, model.model]);

  const displayName = model.modelName && model.modelName !== model.model ? model.modelName : null;

  const title = displayName ?? model.model;
  const subtitle = displayName ? model.model : null;

  return (
    <div className={`group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)] ${isPrimary ? 'bg-[var(--accent-warm-subtle)]' : ''}`}>
      {/* Model info — unified: title always same style, subtitle always same style */}
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-[11px] text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Context length */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-[10px] text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* Primary badge or hover action */}
      {isPrimary ? (
        <span className="flex-shrink-0 rounded-full bg-[var(--accent-warm-muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
          首选
        </span>
      ) : (
        <button
          type="button"
          onClick={handleSetPrimary}
          className="flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--ink-subtle)] opacity-0 transition-all hover:bg-[var(--paper-inset)] hover:text-[var(--accent)] group-hover:opacity-100"
        >
          设为首选
        </button>
      )}

      {/* Delete */}
      <button
        type="button"
        onClick={handleDelete}
        className="flex-shrink-0 rounded p-1 text-[var(--ink-subtle)] opacity-0 transition-all hover:text-[var(--error)] group-hover:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
});

// ===== DiscoveredModelRow (lower section — light row with hover "添加") =====

const DiscoveredModelRow = React.memo(function DiscoveredModelRow({
  model,
  onAdd,
}: {
  model: DiscoveredModel;
  onAdd: (model: DiscoveredModel) => void;
}) {
  const handleAdd = useCallback(() => onAdd(model), [onAdd, model]);
  const displayName = model.displayName && model.displayName !== model.id ? model.displayName : null;
  const title = displayName ?? model.id;
  const subtitle = displayName ? model.id : null;

  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--hover-bg)]">
      {/* Model info — same style as ActiveModelRow */}
      <div className="min-w-0 flex-1">
        <span className="text-[13px] font-medium text-[var(--ink)]">{title}</span>
        {subtitle && (
          <span className="ml-2 font-mono text-[11px] text-[var(--ink-subtle)]">{subtitle}</span>
        )}
      </div>

      {/* Metadata */}
      {model.contextLength ? (
        <span className="flex-shrink-0 text-[10px] text-[var(--ink-subtle)]">
          {formatTokenCount(model.contextLength)}
        </span>
      ) : null}

      {/* Add button — visible on hover */}
      <button
        type="button"
        onClick={handleAdd}
        className="flex-shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[var(--accent)] opacity-0 transition-all hover:bg-[var(--accent-warm-subtle)] group-hover:opacity-100"
      >
        添加
      </button>
    </div>
  );
});
