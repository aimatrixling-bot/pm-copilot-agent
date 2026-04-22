// Channel platform selector — matches original PlatformSelect 2-column grid style
// Includes promoted plugins and "install new plugin" dashed card
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Puzzle, Trash2 } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { ChannelType } from '../../../../shared/types/agent';
import type { InstalledPlugin } from '../../../../shared/types/im';
import { PROMOTED_PLUGINS } from '../../ImSettings/promotedPlugins';
import telegramIcon from '../../ImSettings/assets/telegram.png';
import dingtalkIcon from '../../ImSettings/assets/dingtalk.svg';

interface PlatformEntry {
  id: ChannelType;
  name: string;
  description: string;
  icon?: string;
  iconElement?: React.ReactNode;
  plugin?: InstalledPlugin;
}

const STATIC_PLATFORMS: PlatformEntry[] = [
  { id: 'telegram', name: 'Telegram', description: '通过 Telegram Bot 远程使用 AI Agent', icon: telegramIcon },
  // 内置飞书已被官方 OpenClaw 插件替代（在 PROMOTED_PLUGINS 中），新用户不再显示
  { id: 'dingtalk', name: '钉钉', description: '通过钉钉自建应用 Bot 远程使用 AI Agent', icon: dingtalkIcon },
];

interface ChannelPlatformSelectProps {
  onSelect: (platform: ChannelType) => void;
  onCancel?: () => void;
}

export default function ChannelPlatformSelect({ onSelect }: ChannelPlatformSelectProps) {
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
  const [autoInstalling, setAutoInstalling] = useState<string | null>(null);
  const [installNpmSpec, setInstallNpmSpec] = useState('');
  const [showInstallInput, setShowInstallInput] = useState(false);
  const [installing, setInstalling] = useState(false);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const isMountedRef = useRef(true);
  useEffect(() => { return () => { isMountedRef.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauriEnvironment()) { setLoading(false); return; }
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const plugins = await invoke<InstalledPlugin[]>('cmd_list_openclaw_plugins');
        if (!cancelled) setInstalledPlugins(plugins);
      } catch { /* ignore */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleUninstall = useCallback(async () => {
    if (!pendingUninstall || !isTauriEnvironment()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('cmd_uninstall_openclaw_plugin', { pluginId: pendingUninstall.pluginId });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => prev.filter(p => p.pluginId !== pendingUninstall.pluginId));
      toastRef.current.success(`已卸载 ${pendingUninstall.manifest?.name || pendingUninstall.pluginId}`);
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(String(err));
    } finally {
      if (isMountedRef.current) setPendingUninstall(null);
    }
  }, [pendingUninstall]);

  const handlePromotedClick = useCallback(async (promoted: typeof PROMOTED_PLUGINS[number]) => {
    const existing = installedPlugins.find(p => p.pluginId === promoted.pluginId);
    if (existing) {
      onSelect(`openclaw:${existing.pluginId}` as ChannelType);
      return;
    }
    if (!isTauriEnvironment()) return;
    setAutoInstalling(promoted.pluginId);
    toastRef.current.info('首次启动正在安装插件，请稍等…');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: promoted.npmSpec });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => [...prev, result]);
      onSelect(`openclaw:${result.pluginId}` as ChannelType);
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(`安装失败: ${err}`);
    } finally {
      if (isMountedRef.current) setAutoInstalling(null);
    }
  }, [installedPlugins, onSelect]);

  const handleInstallPlugin = useCallback(async () => {
    if (!installNpmSpec.trim() || !isTauriEnvironment()) return;
    setInstalling(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: installNpmSpec.trim() });
      setInstalledPlugins(prev => [...prev, result]);
      toastRef.current.success(`已安装 ${result.manifest?.name || result.pluginId}`);
      setShowInstallInput(false);
      setInstallNpmSpec('');
    } catch (err) {
      toastRef.current.error(`安装失败: ${err}`);
    } finally {
      setInstalling(false);
    }
  }, [installNpmSpec]);

  const promotedIds = new Set(PROMOTED_PLUGINS.map(p => p.pluginId));

  const pluginPlatforms: PlatformEntry[] = installedPlugins
    .filter(p => !promotedIds.has(p.pluginId))
    .map(p => ({
      id: `openclaw:${p.pluginId}` as ChannelType,
      name: p.manifest?.name || p.pluginId,
      description: p.manifest?.description || `社区插件 — ${p.npmSpec}`,
      iconElement: (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
          <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
        </div>
      ),
      plugin: p,
    }));

  const allPlatforms = [...STATIC_PLATFORMS, ...pluginPlatforms];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--ink)]">选择平台</h2>
        <p className="mt-0.5 text-xs text-[var(--ink-muted)]">选择要接入的聊天平台</p>
      </div>

      {/* Platform cards — 2-column grid matching original PlatformSelect */}
      <div className="grid grid-cols-2 gap-4">
        {allPlatforms.map(p => (
          <div key={p.id} className="group relative">
            <button
              onClick={() => onSelect(p.id)}
              className="flex w-full flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px]"
            >
              {p.icon ? (
                <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
              ) : p.iconElement ? (
                p.iconElement
              ) : null}
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">{p.description}</p>
              </div>
            </button>
            {p.plugin && (
              <button
                onClick={e => { e.stopPropagation(); setPendingUninstall(p.plugin!); }}
                title="卸载插件"
                className="absolute right-2 top-2 rounded-md p-1.5 text-[var(--ink-muted)] opacity-0 transition-all hover:bg-[var(--error-bg)] hover:text-[var(--error)] group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

        {/* Promoted plugins */}
        {PROMOTED_PLUGINS.map(pp => {
          const isInstalling = autoInstalling === pp.pluginId;
          return (
            <button
              key={`promoted-${pp.pluginId}`}
              onClick={() => handlePromotedClick(pp)}
              disabled={isInstalling || loading}
              className="flex w-full flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 transition-all hover:border-[var(--line-strong)] hover:shadow-sm hover:translate-y-[-1px] disabled:opacity-70"
            >
              <div className="relative">
                <img src={pp.icon} alt={pp.name} className={`h-12 w-12 rounded-xl${isInstalling ? ' opacity-40' : ''}`} />
                {isInstalling && (
                  <Loader2 className="absolute inset-0 m-auto h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                )}
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[var(--ink)]">{pp.name}</p>
                <p className="mt-1 text-xs text-[var(--ink-muted)]">{pp.description}</p>
              </div>
            </button>
          );
        })}

        {/* Install new plugin */}
        <button
          onClick={() => setShowInstallInput(true)}
          disabled={loading}
          className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] bg-transparent p-6 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
        >
          {loading ? (
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
              <Download className="h-6 w-6 text-[var(--ink-muted)]" />
            </div>
          )}
          <div className="text-center">
            <p className="text-sm font-medium text-[var(--ink-muted)]">安装新插件</p>
            <p className="mt-1 text-xs text-[var(--ink-subtle)]">从 npm 安装 OpenClaw 社区插件</p>
          </div>
        </button>
      </div>

      {/* npm install input */}
      {showInstallInput && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={installNpmSpec}
            onChange={e => setInstallNpmSpec(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleInstallPlugin(); }}
            placeholder="npm 包名，例如 @openclaw/plugin-xxx"
            className="flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent)] focus:outline-none"
            autoFocus
          />
          <button
            onClick={handleInstallPlugin}
            disabled={!installNpmSpec.trim() || installing}
            className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
          >
            {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : '安装'}
          </button>
          <button
            onClick={() => { setShowInstallInput(false); setInstallNpmSpec(''); }}
            className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm text-[var(--ink-muted)] hover:bg-[var(--paper-inset)]"
          >
            取消
          </button>
        </div>
      )}

      {/* Uninstall confirmation */}
      {pendingUninstall && (
        <ConfirmDialog
          title="卸载插件"
          message={`确定要卸载「${pendingUninstall.manifest?.name || pendingUninstall.pluginId}」吗？`}
          confirmText="卸载"
          confirmVariant="danger"
          onConfirm={handleUninstall}
          onCancel={() => setPendingUninstall(null)}
        />
      )}
    </div>
  );
}
