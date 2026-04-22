/**
 * BotPlatformRegistry — "聊天机器人 Bot" section in Settings
 *
 * Top: supported platform cards (built-in + promoted + community plugins)
 * Bottom: step-by-step guide for adding bots to agents
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Loader2, Puzzle, Trash2, RefreshCw } from 'lucide-react';
import { isTauriEnvironment } from '@/utils/browserMock';
import { useToast } from '@/components/Toast';
import ConfirmDialog from '@/components/ConfirmDialog';
import type { InstalledPlugin } from '../../../shared/types/im';
import { PROMOTED_PLUGINS } from './promotedPlugins';
import telegramIcon from './assets/telegram.png';
// feishuIcon import removed — old built-in Feishu hidden from this page (replaced by OpenClaw plugin)
import dingtalkIcon from './assets/dingtalk.svg';

// Guide images
import guide1_1 from './assets/Bot1-1.png';
import guide1_2 from './assets/Bot1-2.png';
import guide1_3 from './assets/Bot1-3.png';
import guide2_1 from './assets/Bot2-1.png';

interface PlatformEntry {
  id: string;
  name: string;
  description: string;
  icon?: string;
  iconElement?: React.ReactNode;
  badge: string;       // '内置' | '插件' | '插件·已安装'
  badgeVariant: 'builtin' | 'plugin';
  platformBadge?: 'builtin' | 'official' | 'deprecated' | 'plugin';
  deprecationNotice?: string;
  plugin?: InstalledPlugin;
}

const STATIC_PLATFORMS: PlatformEntry[] = [
  { id: 'telegram', name: 'Telegram', description: '通过 Telegram Bot 远程使用 AI Agent', icon: telegramIcon, badge: '内置', badgeVariant: 'builtin' },
  // Old built-in Feishu hidden from UI — replaced by official OpenClaw plugin (@larksuite/openclaw-lark).
  // Code retained for backward compatibility with existing channels; entry removed from display.
  // { id: 'feishu', name: '飞书', ... platformBadge: 'deprecated' },
  { id: 'dingtalk', name: '钉钉', description: '通过钉钉自建应用 Bot 远程使用 AI Agent', icon: dingtalkIcon, badge: '内置', badgeVariant: 'builtin' },
];

const GUIDE_STEPS_PATH1 = [
  { image: guide1_1, caption: '在启动页找到目标工作区，hover 出现设置按钮，点击进入 Agent 设置' },
  { image: guide1_2, caption: '在「通用」Tab 找到「主动 Agent 模式」，打开开关' },
  { image: guide1_3, caption: '开启后出现「聊天机器人 Channels」，点击「+ 添加」选择平台并配置凭证' },
];

const GUIDE_STEPS_PATH2 = [
  { image: guide2_1, caption: '在启动页点击「+ 添加」，选择「添加本地文件夹」或「从模板创建 Agent」，创建完成后按路径一的方式开启主动模式并添加聊天机器人' },
];

export default function BotPlatformRegistry() {
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledPlugin | null>(null);
  const [autoInstalling, setAutoInstalling] = useState<string | null>(null);
  const [installNpmSpec, setInstallNpmSpec] = useState('');
  const [showInstallInput, setShowInstallInput] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updatingSet, setUpdatingSet] = useState<Set<string>>(new Set()); // pluginIds being updated concurrently
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
      } catch (err) {
        console.warn('[BotPlatformRegistry] Failed to load plugins:', err);
      } finally { if (!cancelled) setLoading(false); }
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

  const handlePromotedInstall = useCallback(async (promoted: typeof PROMOTED_PLUGINS[number]) => {
    const existing = installedPlugins.find(p => p.pluginId === promoted.pluginId);
    if (existing) {
      toastRef.current.info(`${promoted.name} 已安装`);
      return;
    }
    if (!isTauriEnvironment()) return;
    setAutoInstalling(promoted.pluginId);
    toastRef.current.info('正在安装插件，请稍等…');
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: promoted.npmSpec });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => [...prev, result]);
      toastRef.current.success(`${promoted.name} 安装成功`);
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(`安装失败: ${err}`);
    } finally {
      if (isMountedRef.current) setAutoInstalling(null);
    }
  }, [installedPlugins]);

  const handleInstallPlugin = useCallback(async () => {
    if (!installNpmSpec.trim() || !isTauriEnvironment()) return;
    setInstalling(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec: installNpmSpec.trim() });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => [...prev, result]);
      toastRef.current.success(`已安装 ${result.manifest?.name || result.pluginId}`);
      setShowInstallInput(false);
      setInstallNpmSpec('');
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(`安装失败: ${err}`);
    } finally {
      if (isMountedRef.current) setInstalling(false);
    }
  }, [installNpmSpec]);

  const handleUpdatePlugin = useCallback(async (npmSpec: string, pluginId: string) => {
    if (!isTauriEnvironment()) return;
    setUpdatingSet(prev => new Set(prev).add(pluginId));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<InstalledPlugin>('cmd_install_openclaw_plugin', { npmSpec });
      if (!isMountedRef.current) return;
      setInstalledPlugins(prev => prev.map(p => p.pluginId === pluginId ? result : p));

      // Restart running channels that use this plugin
      const restart = await invoke<{ restarted: number; failed: number }>('cmd_restart_channels_using_plugin', { pluginId });
      if (!isMountedRef.current) return;
      const ver = `v${result.packageVersion || '最新版'}`;
      if (restart.failed > 0) {
        toastRef.current.error(`已更新至 ${ver}，但 ${restart.failed} 个 Bot 重启失败，请手动重启`);
      } else if (restart.restarted > 0) {
        toastRef.current.success(`已更新至 ${ver}，已重启 ${restart.restarted} 个相关 Bot`);
      } else {
        toastRef.current.success(`已更新至 ${ver}`);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      toastRef.current.error(`更新失败: ${err}`);
    } finally {
      if (isMountedRef.current) {
        setUpdatingSet(prev => { const next = new Set(prev); next.delete(pluginId); return next; });
      }
    }
  }, []);

  const promotedIds = new Set(PROMOTED_PLUGINS.map(p => p.pluginId));

  // Community plugins (exclude promoted)
  const pluginPlatforms: PlatformEntry[] = installedPlugins
    .filter(p => !promotedIds.has(p.pluginId))
    .map(p => ({
      id: `openclaw:${p.pluginId}`,
      name: p.manifest?.name || p.pluginId,
      description: p.manifest?.description || `社区插件 — ${p.npmSpec}`,
      iconElement: (
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)]">
          <Puzzle className="h-6 w-6 text-[var(--accent-warm)]" />
        </div>
      ),
      badge: '插件·已安装',
      badgeVariant: 'plugin' as const,
      plugin: p,
    }));

  const allPlatforms = [...STATIC_PLATFORMS, ...pluginPlatforms];

  return (
    <div className="space-y-10">
      {/* ── Section 1: Supported Platforms ── */}
      <div>
        <h2 className="text-lg font-semibold text-[var(--ink)]">聊天机器人 Bot</h2>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          以下平台可作为 Agent 的聊天渠道接入，让 AI Agent 通过即时通讯与你互动
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
          {/* Built-in + community plugins */}
          {allPlatforms.map(p => (
            <div key={p.id} className="group relative flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
              {p.icon ? (
                <img src={p.icon} alt={p.name} className="h-12 w-12 rounded-xl" />
              ) : p.iconElement ?? null}
              <div className="text-center">
                <div className="flex items-center justify-center gap-1.5">
                  <p className="text-sm font-medium text-[var(--ink)]">{p.name}</p>
                  {p.platformBadge === 'deprecated' && (
                    <span className="rounded-full bg-[var(--error)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--error)]">
                      即将下线
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{p.description}</p>
                {p.deprecationNotice && (
                  <p className="mt-1 flex items-center justify-center gap-1 text-[10px] text-[var(--warning)]">
                    <span>⚠</span>
                    <span>{p.deprecationNotice}</span>
                  </p>
                )}
              </div>
              {p.plugin ? (
                <div className="flex items-center gap-2">
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--success)]"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
                  >
                    {p.plugin.packageVersion ? `v${p.plugin.packageVersion}` : '已安装'}
                  </span>
                  <button
                    onClick={() => handleUpdatePlugin(p.plugin!.npmSpec, p.plugin!.pluginId)}
                    disabled={updatingSet.has(p.plugin.pluginId)}
                    className="rounded-full p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                    title="检查更新"
                  >
                    <RefreshCw className={`h-3 w-3 ${updatingSet.has(p.plugin.pluginId) ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              ) : (
                <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[10px] font-medium text-[var(--ink-subtle)]">
                  {p.badge}
                </span>
              )}
              {/* Uninstall for community plugins */}
              {p.plugin && (
                <button
                  onClick={() => setPendingUninstall(p.plugin!)}
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
            const installedPlugin = installedPlugins.find(p => p.pluginId === pp.pluginId);
            const isInstalled = !!installedPlugin;
            const isInstalling = autoInstalling === pp.pluginId;
            const isUpdating = updatingSet.has(pp.pluginId);
            return (
              <div
                key={`promoted-${pp.pluginId}`}
                className="group relative flex flex-col items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5"
              >
                <img src={pp.icon} alt={pp.name} className="h-12 w-12 rounded-xl" />
                <div className="text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <p className="text-sm font-medium text-[var(--ink)]">{pp.name}</p>
                    {pp.badge === 'official' && (
                      <span className="rounded-full bg-[#3370FF]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#3370FF]">
                        官方
                      </span>
                    )}
                    {pp.comingSoon && (
                      <span className="rounded-full bg-[var(--accent-warm)]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--accent-warm)]">
                        敬请期待
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--ink-muted)]">{pp.description}</p>
                </div>
                {isInstalled ? (
                  <div className="flex items-center gap-2">
                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-[var(--success)]"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--success) 12%, transparent)' }}
                    >
                      {installedPlugin.packageVersion ? `v${installedPlugin.packageVersion}` : '已安装'}
                    </span>
                    <button
                      onClick={() => handleUpdatePlugin(pp.npmSpec, pp.pluginId)}
                      disabled={isUpdating}
                      className="rounded-full p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
                      title="检查更新"
                    >
                      <RefreshCw className={`h-3 w-3 ${isUpdating ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                ) : (
                  pp.comingSoon ? (
                    <span className="rounded-full bg-[var(--accent-warm)]/8 px-3 py-1 text-[11px] font-medium text-[var(--accent-warm)]">
                      即将支持
                    </span>
                  ) : (
                    <button
                      onClick={() => handlePromotedInstall(pp)}
                      disabled={isInstalling || loading}
                      className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-warm-subtle)] disabled:opacity-50"
                      style={{ backgroundColor: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}
                    >
                      {isInstalling && <Loader2 className="h-3 w-3 animate-spin" />}
                      {isInstalling ? '安装中' : '点击安装'}
                    </button>
                  )
                )}
              </div>
            );
          })}

          {/* Install new community plugin */}
          <button
            onClick={() => setShowInstallInput(true)}
            disabled={loading}
            className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--line-strong)] bg-transparent p-5 transition-all hover:border-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
          >
            {loading ? (
              <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-[var(--ink-subtle)]">
                <Download className="h-6 w-6 text-[var(--ink-muted)]" />
              </div>
            )}
            <div className="text-center">
              <p className="text-sm font-medium text-[var(--ink-muted)]">安装社区插件</p>
              <p className="mt-0.5 text-xs text-[var(--ink-subtle)]">从 npm 安装 OpenClaw 插件</p>
            </div>
          </button>
        </div>

        {/* npm install input */}
        {showInstallInput && (
          <div className="mt-4 flex items-center gap-2">
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
      </div>

      {/* ── Section 2: How to add bots ── */}
      <div>
        <h3 className="text-base font-semibold text-[var(--ink)]">如何添加聊天机器人</h3>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          聊天机器人以渠道（Channel）的方式挂载在 Agent 上，以下是两种添加方式
        </p>

        {/* Path 1 */}
        <div className="mt-6 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h4 className="text-sm font-semibold text-[var(--ink)]">
            方式一：将已有工作区升级为主动型 Agent
          </h4>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            适合已经有项目文件夹、想为其增加 IM 聊天能力的场景
          </p>
          <div className="mt-4 space-y-4">
            {GUIDE_STEPS_PATH1.map((step, i) => (
              <div key={i}>
                <p className="mb-2 text-xs font-medium text-[var(--ink-subtle)]">
                  <span className="mr-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--accent-warm)] text-[10px] font-bold text-white">
                    {i + 1}
                  </span>
                  {step.caption}
                </p>
                <img
                  src={step.image}
                  alt={step.caption}
                  className="w-full rounded-lg border border-[var(--line)] shadow-sm"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Path 2 */}
        <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
          <h4 className="text-sm font-semibold text-[var(--ink)]">
            方式二：创建全新的 Agent 工作区
          </h4>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            适合从零开始、专门为聊天机器人创建一个独立 Agent 的场景
          </p>
          <div className="mt-4 space-y-4">
            {GUIDE_STEPS_PATH2.map((step, i) => (
              <div key={i}>
                <p className="mb-2 text-xs font-medium text-[var(--ink-subtle)]">
                  <span className="mr-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--accent-warm)] text-[10px] font-bold text-white">
                    {i + 1}
                  </span>
                  {step.caption}
                </p>
                <img
                  src={step.image}
                  alt={step.caption}
                  className="w-full rounded-lg border border-[var(--line)] shadow-sm"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Uninstall confirmation */}
      {pendingUninstall && (
        <ConfirmDialog
          title="卸载插件"
          message={`确定要卸载「${pendingUninstall.manifest?.name || pendingUninstall.pluginId}」吗？使用此插件的渠道将无法启动。`}
          confirmText="卸载"
          confirmVariant="danger"
          onConfirm={handleUninstall}
          onCancel={() => setPendingUninstall(null)}
        />
      )}
    </div>
  );
}
