import { appendFileSync, copyFileSync, cpSync, existsSync, linkSync, readlinkSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, extname, sep } from 'path';
import { tmpdir, homedir } from 'os';
import AdmZip from 'adm-zip';
import {
  BUILTIN_SLASH_COMMANDS,
  parseSkillFrontmatter,
  extractCommandName,
  parseFullSkillContent,
  parseFullCommandContent,
  serializeSkillContent,
  serializeCommandContent,
  type SlashCommand,
  type SkillFrontmatter,
  type CommandFrontmatter
} from '../shared/slashCommands';
import { sanitizeFolderName, isWindowsReservedName } from '../shared/utils';
import { isPreviewable } from '../shared/fileTypes';
import { parseAgentFrontmatter, parseFullAgentContent, serializeAgentContent } from '../shared/agentCommands';
import { scanAgents, readWorkspaceConfig, writeWorkspaceConfig, loadEnabledAgents, readAgentMeta, writeAgentMeta } from './agents/agent-loader';
import type { AgentFrontmatter, AgentMeta, AgentWorkspaceConfig } from '../shared/agentTypes';
import type { McpServerDefinition } from '../renderer/config/types';
import {
  setCronTaskContext,
  clearCronTaskContext,
  CRON_TASK_COMPLETE_PATTERN,
  CRON_TASK_EXIT_TEXT,
  CRON_TASK_EXIT_REASON_PATTERN,
} from './tools/cron-tools';
import { setImCronContext } from './tools/im-cron-tool';
import {
  handleMcpList, handleMcpAdd, handleMcpRemove, handleMcpEnable, handleMcpDisable, handleMcpEnv, handleMcpTest,
  handleMcpOAuthDiscover, handleMcpOAuthStart, handleMcpOAuthStatus, handleMcpOAuthRevoke,
  handleModelList, handleModelAdd, handleModelRemove, handleModelSetKey, handleModelSetDefault, handleModelVerify,
  handleAgentList, handleAgentEnable, handleAgentDisable, handleAgentSet,
  handleAgentChannelList, handleAgentChannelAdd, handleAgentChannelRemove,
  handleConfigGet, handleConfigSet, handleStatus, handleReload, handleHelp,
  handleVersion,
  handleCronList, handleCronCreate, handleCronStop, handleCronStart, handleCronDelete, handleCronUpdate, handleCronRuns, handleCronStatus,
  handlePluginList, handlePluginInstall, handlePluginUninstall,
  handleAgentRuntimeStatus,
} from './admin-api';
import { setImMediaContext } from './tools/im-media-tool';
import { setImBridgeToolsContext } from './tools/im-bridge-tools';
import { getBuiltinMcp } from './tools/builtin-mcp-registry';
// NOTE: builtin MCP side-effect imports (registerBuiltinMcp calls) live in agent-session.ts,
// which is imported by this file — no need to duplicate them here.

// ============= CRASH DIAGNOSTICS =============
// File-based logging to capture crashes before process dies
const CRASH_LOG = join(tmpdir(), 'pm-copilot-crash.log');

function crashLog(prefix: string, ...args: unknown[]) {
  try {
    const msg = args.map(a => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object') return JSON.stringify(a);
      return String(a);
    }).join(' ');
    appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${prefix} ${msg}\n`);
  } catch { /* ignore */ }
}

// Top-level beacon: fires BEFORE main(), proves JS module loading succeeded
try { process.stderr.write(`[startup] module loaded, pid=${process.pid}\n`); } catch { /* ignore */ }

process.on('exit', (code) => {
  crashLog('EXIT', `code=${code}`);
});

process.on('beforeExit', (code) => {
  crashLog('BEFORE_EXIT', `code=${code}`);
});

process.on('uncaughtException', (err) => {
  crashLog('UNCAUGHT_EXCEPTION', err);
  console.error('[process] uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  crashLog('UNHANDLED_REJECTION', reason);
  console.error('[process] unhandledRejection:', reason);
});

process.on('SIGTERM', () => {
  crashLog('SIGNAL', 'SIGTERM');
  console.error('[process] SIGTERM received, shutting down...');
  process.exit(0);  // Trigger SDK's process.on('exit') handler → SIGTERM CLI subprocess
});

process.on('SIGINT', () => {
  crashLog('SIGNAL', 'SIGINT');
  console.error('[process] SIGINT received, shutting down...');
  process.exit(0);
});

crashLog('STARTUP', 'Server starting...');
// ============= END CRASH DIAGNOSTICS =============


import {
  enqueueUserMessage,
  cancelQueueItem,
  forceExecuteQueueItem,
  getQueueStatus,
  getAgentState,
  getLogLines,
  getMessages,
  getSessionId,
  getSystemInitInfo,
  initializeAgent,
  interruptCurrentResponse,
  getStreamingAssistantId,
  switchToSession,
  setMcpServers,
  getMcpServers,
  setAgents,
  setSessionModel,
  resetSession,
  waitForSessionIdle,
  setImStreamCallback,
  setGroupToolsDeny,
  setInteractionScenario,
  resetInteractionScenario,
  rewindSession,
  forkSession,
  getPendingInteractiveRequests,
  stripPlaywrightResults,
  setSidecarPort,
  getOpenAiBridgeConfig,
  getSessionModel,
  getSessionProviderEnv,
  syncProjectUserConfig,
  setProxyConfig,
  initSocksBridgeFromEnv,
  getHistoricalSessionMessages,
  type ProviderEnv,
} from './agent-session';
import { getHomeDirOrNull, isSkillBlockedOnPlatform } from './utils/platform';
import { getScriptDir, getAgentBrowserCliPath, getBundledRuntimePath, getPackageManagerPath } from './utils/runtime';
import { ensureBrowserStealthConfig } from './utils/browser-stealth';
import { buildDirectoryTree, expandDirectory } from './dir-info';
import {
  createSession,
  deleteSession,
  getAllSessionMetadata,
  getSessionData,
  getSessionMetadata,
  getSessionsByAgentDir,
  updateSessionMetadata,
  getAttachmentDataUrl,
} from './SessionStore';
import { initLogger, getLoggerDiagnostics } from './logger';
import { cleanupOldLogs } from './AgentLogger';
import { cleanupOldUnifiedLogs, appendUnifiedLogBatch } from './UnifiedLogger';
import { broadcast, createSseClient, getClients } from './sse';
import { checkAnthropicSubscription, getGitBranch, verifyProviderViaSdk, verifySubscription } from './provider-verify';
import { createBridgeHandler } from './openai-bridge';
import { registerBridgeSeedFn } from './bridge-cache';
import { generateTitle } from './title-generator';
import {
  shouldUseExternalRuntime,
  sendExternalMessage,
  respondExternalPermission,
  stopExternalSession,
  isExternalSessionActive,
  queryRuntimeModels,
  getRuntimePermissionModes,
  getActiveRuntimeType,
  restoreExternalSessionState,
  setExternalImStreamCallback,
  waitForExternalSessionIdle,
  getLastExternalAssistantText,
  setExternalModel,
  setExternalPermissionMode,
  didLastTurnSucceed,
} from './runtimes/external-session';

type ImagePayload = {
  name: string;
  mimeType: string;
  data: string; // base64
};

type PermissionMode = 'auto' | 'plan' | 'fullAgency' | 'custom';

/**
 * Runtime download URLs for common MCP commands
 */
const RUNTIME_DOWNLOAD_URLS: Record<string, { name: string; url: string }> = {
  'node': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npx': { name: 'Node.js', url: 'https://nodejs.org/' },
  'npm': { name: 'Node.js', url: 'https://nodejs.org/' },
  'python': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'python3': { name: 'Python', url: 'https://www.python.org/downloads/' },
  'deno': { name: 'Deno', url: 'https://deno.land/' },
  'uv': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
  'uvx': { name: 'uv (Python 包管理器)', url: 'https://docs.astral.sh/uv/' },
};

/**
 * Get download info for a command
 */
function getCommandDownloadInfo(command: string): { runtimeName?: string; downloadUrl?: string } {
  const info = RUNTIME_DOWNLOAD_URLS[command];
  if (info) {
    return { runtimeName: info.name, downloadUrl: info.url };
  }
  return {};
}

type SendMessagePayload = {
  text?: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  model?: string;
  // 'subscription' = explicit switch to Anthropic subscription (from desktop)
  // undefined/missing = "keep current provider" (safe default for IM/Cron callers)
  // object = use this specific third-party provider
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  } | 'subscription';
};

// Cron task execution payload
type CronExecutePayload = {
  taskId: string;
  prompt: string;
  /** Session ID for single_session mode (reuse existing session) */
  sessionId?: string;
  isFirstExecution?: boolean;
  aiCanExit?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
  providerEnv?: {
    baseUrl?: string;
    apiKey?: string;
    authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
    apiProtocol?: 'anthropic' | 'openai';
    maxOutputTokens?: number;
    maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
    upstreamFormat?: 'chat_completions' | 'responses';
  };
  /** Run mode: "single_session" (keep context) or "new_session" (fresh each time) */
  runMode?: 'single_session' | 'new_session';
  /** Task execution interval in minutes (for System Prompt context) */
  intervalMinutes?: number;
  /** Current execution number, 1-based (for System Prompt context) */
  executionNumber?: number;
};

function parseArgs(argv: string[]): { agentDir: string; initialPrompt?: string; port: number; sessionId?: string; noPreWarm?: boolean } {
  const args = argv.slice(2);
  const getArgValue = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) {
      return null;
    }
    return args[index + 1] ?? null;
  };

  const agentDir = getArgValue('--agent-dir') ?? '';
  const initialPrompt = getArgValue('--prompt') ?? undefined;
  const port = Number(getArgValue('--port') ?? 3000);
  const sessionId = getArgValue('--session-id') ?? undefined;
  const noPreWarm = args.includes('--no-pre-warm');

  if (!agentDir) {
    throw new Error('Missing required argument: --agent-dir <path>');
  }

  return { agentDir, initialPrompt, port: Number.isNaN(port) ? 3000 : port, sessionId, noPreWarm };
}

/**
 * Expand ~ to user's home directory
 */
function expandTilde(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const homeDir = getHomeDirOrNull() || '';
    return path.replace(/^~/, homeDir);
  }
  return path;
}

async function ensureAgentDir(dir: string): Promise<string> {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    await mkdir(resolved, { recursive: true });
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Agent directory is not a directory: ${resolved}`);
  }
  return resolved;
}

// ============= SKILLS CONFIG & SEED =============

interface SkillsConfig {
  seeded: string[];
  disabled: string[];
  generation: number;  // Monotonic counter — incremented on every skill CRUD operation
}

function getSkillsConfigPath(): string {
  const homeDir = getHomeDirOrNull() || '';
  return join(homeDir, '.pm-copilot', 'skills-config.json');
}

function readSkillsConfig(): SkillsConfig {
  const configPath = getSkillsConfigPath();
  const defaults: SkillsConfig = { seeded: [], disabled: [], generation: 0 };
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      return {
        seeded: Array.isArray(raw?.seeded) ? raw.seeded : defaults.seeded,
        disabled: Array.isArray(raw?.disabled) ? raw.disabled : defaults.disabled,
        generation: typeof raw?.generation === 'number' ? raw.generation : 0,
      };
    }
  } catch (err) {
    console.warn('[skills-config] Error reading config:', err);
  }
  return defaults;
}

function writeSkillsConfig(config: SkillsConfig): void {
  const configPath = getSkillsConfigPath();
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Auto-increment generation on every write — signals Tab Sidecars to re-sync symlinks
    config.generation = (config.generation || 0) + 1;
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[skills-config] Error writing config:', err);
  }
}

/**
 * Bump skills generation counter without changing seeded/disabled lists.
 * Called after skill CRUD operations (create/update/delete/upload/import)
 * that don't go through writeSkillsConfig but DO change the available skill set.
 * Tab Sidecars detect this change and re-sync symlinks on next /api/commands fetch.
 */
function bumpSkillsGeneration(): void {
  const config = readSkillsConfig();
  writeSkillsConfig(config);
}

/**
 * Lazy skill sync: Track the last generation we synced to avoid redundant sync work.
 * When a Tab Sidecar's /api/commands or /api/skills is called, we compare the current
 * generation in skills-config.json against this value. Only if they differ do we run
 * syncProjectUserConfig(). This covers the case where the Global Sidecar modified
 * global skills (create/toggle/delete) without the Tab Sidecar knowing.
 */
let lastSyncedSkillsGeneration = -1;  // -1 forces first sync

/**
 * Sync project skill symlinks if the skills generation has changed.
 * Returns true if sync was performed, false if skipped (already up-to-date).
 */
function syncSkillsIfNeeded(projectDir: string): boolean {
  const config = readSkillsConfig();
  if (config.generation === lastSyncedSkillsGeneration) return false;
  syncProjectUserConfig(projectDir);
  lastSyncedSkillsGeneration = config.generation;
  return true;
}

/**
 * Mark the current generation as synced (call after explicit syncProjectUserConfig
 * in CRUD handlers to avoid redundant re-sync on next /api/commands fetch).
 */
function markSkillsSynced(): void {
  lastSyncedSkillsGeneration = readSkillsConfig().generation;
}

/**
 * Resolve bundled-skills directory.
 * - Production (macOS): Contents/Resources/bundled-skills/
 * - Production (Windows): <install-dir>/bundled-skills/
 * - Development: <project-root>/bundled-skills/
 */
function resolveBundledSkillsDir(): string | null {
  const scriptDir = getScriptDir();

  // Production: bundled-skills is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, 'bundled-skills');
  if (existsSync(prodPath)) return prodPath;

  // Development: bundled-skills is at project root
  // In dev, scriptDir is something like <project>/src/server/utils
  // Walk up to find bundled-skills at project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  return null;
}

/**
 * Resolve bundled PM skills directory (bundled-agents/pm-copilot/.claude/skills).
 * Follows the same pattern as resolveBundledSkillsDir().
 */
function resolveBundledPmSkillsDir(): string | null {
  const scriptDir = getScriptDir();

  // Production: bundled-agents is alongside server-dist.js in Resources
  const prodPath = resolve(scriptDir, 'bundled-agents', 'pm-copilot', '.claude', 'skills');
  if (existsSync(prodPath)) return prodPath;

  // Development: walk up to project root
  let dir = scriptDir;
  for (let i = 0; i < 5; i++) {
    const devPath = resolve(dir, 'bundled-agents', 'pm-copilot', '.claude', 'skills');
    if (existsSync(devPath)) return devPath;
    dir = dirname(dir);
  }

  return null;
}

/**
 * Seed bundled skills to ~/.pm-copilot/skills/ on first launch.
 * Only copies skills that haven't been seeded before (tracked in skills-config.json).
 */
function seedBundledSkills(): void {
  try {
    const bundledDir = resolveBundledSkillsDir();
    if (!bundledDir) {
      console.log('[seed] Bundled skills directory not found, skipping seed');
      return;
    }

    const config = readSkillsConfig();
    const homeDir = getHomeDirOrNull() || '';
    const userSkillsDir = join(homeDir, '.pm-copilot', 'skills');

    if (!existsSync(userSkillsDir)) mkdirSync(userSkillsDir, { recursive: true });

    const bundledFolders = readdirSync(bundledDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let changed = false;
    for (const folder of bundledFolders) {
      if (isSkillBlockedOnPlatform(folder)) {
        console.log(`[seed] Skipping ${folder} on ${process.platform} (platform blocked)`);
        continue;
      }
      const dst = join(userSkillsDir, folder);
      // Re-seed if marked as seeded but directory was deleted
      if (config.seeded.includes(folder) && existsSync(dst)) continue;

      const src = join(bundledDir, folder);
      // Skip if destination already exists (don't overwrite user's custom content)
      if (existsSync(dst)) {
        config.seeded.push(folder);
        changed = true;
        console.log(`[seed] Skipped existing folder: ${folder}`);
        continue;
      }
      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] Seeded skill: ${folder}`);
      } catch (err) {
        console.warn(`[seed] Failed to seed skill ${folder}:`, err);
        continue;
      }

      config.seeded.push(folder);
      changed = true;
    }

    if (changed) {
      writeSkillsConfig(config);
    }
  } catch (err) {
    console.error('[seed] Error seeding bundled skills:', err);
  }
}

/**
 * Seed PM-specific skills from bundled-agents/pm-copilot/.claude/skills/ to ~/.pm-copilot/skills/.
 * These are the 27 PM workflow skills (pm-prd, pm-comp, etc.) that ship with the bundled agent
 * but live under the .claude/skills path that the command scanner doesn't check.
 */
function seedBundledPmSkills(): void {
  try {
    const pmSkillsDir = resolveBundledPmSkillsDir();
    if (!pmSkillsDir) {
      console.log('[seed] PM skills directory not found, skipping PM skill seed');
      return;
    }

    const config = readSkillsConfig();
    const homeDir = getHomeDirOrNull() || '';
    const userSkillsDir = join(homeDir, '.pm-copilot', 'skills');

    if (!existsSync(userSkillsDir)) mkdirSync(userSkillsDir, { recursive: true });

    const pmFolders = readdirSync(pmSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    let changed = false;
    for (const folder of pmFolders) {
      const src = join(pmSkillsDir, folder);
      const dst = join(userSkillsDir, folder);

      // Seed shared references/ directory as-is (not a skill, but referenced by skills)
      if (folder === 'references') {
        if (!existsSync(dst)) {
          try {
            cpSync(src, dst, { recursive: true });
            console.log(`[seed] Seeded PM shared references`);
            changed = true;
          } catch (err) {
            console.warn(`[seed] Failed to seed shared references:`, err);
          }
        }
        continue;
      }

      if (isSkillBlockedOnPlatform(folder)) continue;

      // Skip if already seeded and directory exists
      if (config.seeded.includes(folder) && existsSync(dst)) continue;

      // Only seed directories that contain a SKILL.md
      if (!existsSync(join(src, 'SKILL.md'))) continue;

      // Skip if destination already exists (don't overwrite user customizations)
      if (existsSync(dst)) {
        if (!config.seeded.includes(folder)) {
          config.seeded.push(folder);
          changed = true;
        }
        continue;
      }

      try {
        cpSync(src, dst, { recursive: true });
        console.log(`[seed] Seeded PM skill: ${folder}`);
      } catch (err) {
        console.warn(`[seed] Failed to seed PM skill ${folder}:`, err);
        continue;
      }

      config.seeded.push(folder);
      changed = true;
    }

    if (changed) {
      writeSkillsConfig(config);
    }
  } catch (err) {
    console.error('[seed] Error seeding PM skills:', err);
  }
}

/**
 * Generate wrapper script for agent-browser CLI in ~/.pm-copilot/bin/.
 * This makes `agent-browser` available as a bare command in SDK subprocess PATH.
 * The wrapper delegates to `{bun} {agent-browser.js}`.
 */
const AGENT_BROWSER_VERSION = '0.15.1';

/**
 * Clean up stale Playwright MCP profile artifacts left by v0.1.30.
 *
 * v0.1.30 had a bug where ~/.pm-copilot/bin (containing a node→bun shim) was added to
 * global PATH, breaking playwright-core's WebSocket transport. This caused Chrome to
 * launch but hang on the CDP connection, eventually timing out and leaving stale
 * SingletonLock/SingletonSocket files in the profile directory.
 *
 * This cleanup runs once at startup to recover from that state.
 */
function cleanupStalePlaywrightProfile(): void {
  try {
    const homeDir = getHomeDirOrNull();
    if (!homeDir) return;

    const profileDir = join(homeDir, '.playwright-mcp-profile');
    const lockPath = join(profileDir, 'SingletonLock');

    if (!existsSync(lockPath)) return;

    // macOS/Linux: SingletonLock is a symlink containing "hostname-pid"
    // Windows: SingletonLock is a regular file containing "hostname-pid"
    let linkTarget: string;
    try {
      linkTarget = readlinkSync(lockPath);
    } catch {
      try {
        linkTarget = readFileSync(lockPath, 'utf-8').trim();
      } catch {
        return; // Can't read lock content, skip cleanup
      }
    }

    // Format: "hostname-pid" (e.g., "Ethan.local-82424")
    const pidMatch = linkTarget.match(/-(\d+)$/);
    if (!pidMatch) return;

    const pid = parseInt(pidMatch[1], 10);

    // Check if the process is still alive
    try {
      process.kill(pid, 0); // Signal 0 = just check if process exists
      // Process is alive — don't remove the lock
      return;
    } catch {
      // Process is dead — safe to clean up
    }

    // Remove stale lock files
    const staleFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    for (const file of staleFiles) {
      const filePath = join(profileDir, file);
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      } catch { /* ignore cleanup errors */ }
    }

    console.log(`[startup] Cleaned up stale Playwright MCP profile lock (pid ${pid} no longer running)`);
  } catch (err) {
    // Non-critical — don't block startup
    console.warn('[startup] Playwright profile cleanup failed:', err);
  }
}

/**
 * One-time migration: extract cookies from Chromium profile (~/.playwright-mcp-profile/)
 * into Playwright storage-state JSON (~/.pm-copilot/browser-storage-state.json).
 *
 * Runs when the old profile exists but the new storage-state file does not.
 * This preserves login state when upgrading from persistent-profile to isolated mode.
 *
 * Only cookies are migrated (from SQLite). localStorage lives in LevelDB and is
 * too complex to extract statically — ~90% of login state is cookie-based anyway.
 */
function migrateProfileToStorageState(): void {
  try {
    const home = getHomeDirOrNull();
    if (!home) return;

    const profileDir = join(home, '.playwright-mcp-profile');
    const pmCopilotDir = join(home, '.pm-copilot');
    const storageStatePath = join(pmCopilotDir, 'browser-storage-state.json');

    // Only migrate once: old profile exists AND new file does not
    if (!existsSync(profileDir) || existsSync(storageStatePath)) return;

    const cookiesDbPath = join(profileDir, 'Default', 'Cookies');
    if (!existsSync(cookiesDbPath)) {
      console.log('[migration] No Cookies DB found in profile, skipping migration');
      return;
    }

    // Use bun:sqlite to read Chromium's Cookies SQLite database
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('bun:sqlite');
    const db = new Database(cookiesDbPath, { readonly: true });

    const sameSiteMap: Record<number, string> = { 0: 'None', 1: 'Lax', 2: 'Strict' };

    // Chrome epoch: microseconds since 1601-01-01 00:00:00 UTC
    // Unix epoch conversion: subtract 11644473600 seconds, divide by 1000000
    const CHROME_EPOCH_OFFSET = 11644473600;

    // Filter out cookies with empty value — on macOS/Windows, Chromium encrypts cookie
    // values (stored in encrypted_value column, decrypted via OS keychain). The plaintext
    // `value` column is empty for these. We can only migrate unencrypted cookies.
    const rows = db.query(
      `SELECT host_key, name, value, path, expires_utc, is_httponly, is_secure, samesite
       FROM cookies
       WHERE length(name) > 0 AND length(value) > 0`
    ).all() as Array<{
      host_key: string; name: string; value: string; path: string;
      expires_utc: number; is_httponly: number; is_secure: number; samesite: number;
    }>;

    db.close();

    if (rows.length === 0) {
      console.log('[migration] Cookies DB is empty, skipping migration');
      return;
    }

    const cookies = rows.map(row => ({
      name: row.name,
      value: row.value,
      domain: row.host_key,
      path: row.path || '/',
      expires: row.expires_utc > 0
        ? Math.floor(row.expires_utc / 1000000) - CHROME_EPOCH_OFFSET
        : -1,
      httpOnly: !!row.is_httponly,
      secure: !!row.is_secure,
      sameSite: sameSiteMap[row.samesite] ?? 'None',
    }));

    const storageState = { cookies, origins: [] as Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> };

    mkdirSync(pmCopilotDir, { recursive: true });
    writeFileSync(storageStatePath, JSON.stringify(storageState, null, 2));
    console.log(`[migration] Migrated ${cookies.length} cookies from Chrome profile to ${storageStatePath}`);
    console.log('[migration] Old profile at ~/.playwright-mcp-profile/ can be safely deleted');
  } catch (err) {
    // Non-critical — don't block startup
    console.warn('[migration] Profile-to-storage-state migration failed:', err);
  }
}

/**
 * Write the agent-browser wrapper script to ~/.pm-copilot/bin/.
 * Returns true on success.
 *
 * Architecture: "self-contained wrapper + scoped shims"
 * - ~/.pm-copilot/bin/       → user-facing commands (safe for global PATH)
 * - ~/.pm-copilot/shims/     → internal runtime shims (NEVER in global PATH)
 *
 * The wrapper script prepends shims/ to its own PATH before exec, so the
 * `node → bun` shim is only visible to agent-browser's subprocess tree —
 * it never leaks to Playwright MCP or other tools.
 */
function writeAgentBrowserWrapper(cliPath: string): boolean {
  const bunPath = getBundledRuntimePath();
  const homeDir = getHomeDirOrNull();
  if (!homeDir) {
    console.warn('[agent-browser] Home directory not found, skipping wrapper setup');
    return false;
  }
  const binDir = join(homeDir, '.pm-copilot', 'bin');
  const shimsDir = join(homeDir, '.pm-copilot', 'shims');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  if (!existsSync(shimsDir)) mkdirSync(shimsDir, { recursive: true });

  // POSIX sh: escape backslash, double-quote, dollar, backtick inside double-quoted strings
  const shellEscape = (s: string) => s.replace(/([\\"`$])/g, '\\$1');
  const isWin = process.platform === 'win32';

  // --- agent-browser wrapper (self-contained: sets up shims PATH internally) ---
  if (isWin) {
    // Windows needs TWO wrappers (like npm global installs):
    // 1. .cmd for cmd.exe / PowerShell
    // 2. extensionless POSIX sh for Git Bash (SDK uses Git Bash on Windows)
    const safeBun = bunPath.replace(/"/g, '""');
    const safeCli = cliPath.replace(/"/g, '""');
    const safeShims = shimsDir.replace(/"/g, '""');
    writeFileSync(join(binDir, 'agent-browser.cmd'),
      `@set "PATH=${safeShims};%PATH%"\r\n@"${safeBun}" "${safeCli}" %*\r\n`);
    writeFileSync(join(binDir, 'agent-browser'),
      `#!/bin/sh\nexport PATH="${shellEscape(shimsDir)}:$PATH"\nexec "${shellEscape(bunPath)}" "${shellEscape(cliPath)}" "$@"\n`);
  } else {
    writeFileSync(join(binDir, 'agent-browser'),
      `#!/bin/sh\nexport PATH="${shellEscape(shimsDir)}:$PATH"\nexec "${shellEscape(bunPath)}" "${shellEscape(cliPath)}" "$@"\n`,
      { mode: 0o755 });
  }
  console.log(`[agent-browser] Wrapper created: ${join(binDir, 'agent-browser')}${isWin ? ' (.cmd + sh)' : ''}`);

  // --- node shim in ~/.pm-copilot/shims/ (NOT in global PATH) ---
  // agent-browser's Rust binary spawns daemon.js via hardcoded `node` command.
  // Since we bundle bun (not Node.js), create a node shim that delegates to bun.
  // Always overwrite — bunPath may change after app update.
  const nodeShimPath = join(shimsDir, 'node');
  if (isWin) {
    // Windows: create node.exe as a hardlink to bun.exe.
    // Windows PATH resolves .exe before .cmd (PATHEXT order). Using .exe avoids
    // cmd.exe being invoked for node.cmd, which would create a visible console window.
    const nodeExePath = join(shimsDir, 'node.exe');
    try {
      if (existsSync(nodeExePath)) unlinkSync(nodeExePath);
      linkSync(bunPath, nodeExePath);
    } catch {
      // Hardlink failed (cross-volume?) — fall back to copy
      try { copyFileSync(bunPath, nodeExePath); } catch { /* .cmd fallback below */ }
    }
    // .cmd fallback for cmd.exe / PowerShell manual invocation
    const escapedBun = bunPath.replace(/"/g, '""');
    writeFileSync(join(shimsDir, 'node.cmd'), `@"${escapedBun}" %*\r\n`);
    // POSIX sh fallback for Git Bash
    writeFileSync(nodeShimPath, `#!/bin/sh\nexec "${shellEscape(bunPath)}" "$@"\n`);
  } else {
    writeFileSync(nodeShimPath, `#!/bin/sh\nexec "${shellEscape(bunPath)}" "$@"\n`, { mode: 0o755 });
  }

  // --- Migration: remove old node shims from ~/.pm-copilot/bin/ (v0.1.30 artifact) ---
  // v0.1.30 put the node shim in bin/ alongside agent-browser, polluting global PATH.
  for (const oldShim of ['node', 'node.exe', 'node.cmd']) {
    const oldPath = join(binDir, oldShim);
    try {
      if (existsSync(oldPath)) {
        unlinkSync(oldPath);
        console.log(`[agent-browser] Cleaned up old shim: ${oldPath}`);
      }
    } catch { /* ignore */ }
  }

  return true;
}

/**
 * Ensure Chromium is installed via agent-browser's own playwright-core.
 * This avoids version mismatch (agent-browser pins a specific Chromium build).
 * See: https://github.com/vercel-labs/agent-browser/issues/107
 *
 * Runs in the background — does not block caller.
 * @param cliPath Path to agent-browser.js (used to locate node_modules/playwright-core)
 */
/**
 * Check whether Chromium needs installing, using a file-system lock so only one
 * Sidecar process across the whole app performs the download.
 */
function ensureChromiumInstalled(cliPath: string): void {
  // cliPath: .../agent-browser-cli/node_modules/agent-browser/bin/agent-browser.js
  // We need:  .../agent-browser-cli/node_modules/playwright-core/cli.js
  const nodeModulesDir = resolve(cliPath, '..', '..', '..');
  const playwrightCli = join(nodeModulesDir, 'playwright-core', 'cli.js');
  if (!existsSync(playwrightCli)) return;

  // File-system lock: only one process installs; others skip.
  const homeDir = getHomeDirOrNull();
  if (!homeDir) return;
  const lockFile = join(homeDir, '.pm-copilot', '.chromium-installing');
  if (existsSync(lockFile)) {
    try {
      const lockTime = statSync(lockFile).mtimeMs;
      if (Date.now() - lockTime < 10 * 60 * 1000) return; // another process is working (<10 min)
      rmSync(lockFile, { force: true }); // stale lock
    } catch { return; }
  }
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); // exclusive create
  } catch { return; } // another process won the race

  console.log('[agent-browser] Ensuring Chromium is installed via bundled playwright-core...');
  const bunPath = getBundledRuntimePath();
  const chromiumProc = Bun.spawn([bunPath, playwrightCli, 'install', 'chromium'], {
    cwd: nodeModulesDir,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  chromiumProc.exited.then(async (code) => {
    rmSync(lockFile, { force: true });
    if (code === 0) {
      console.log('[agent-browser] Chromium ready');
    } else {
      const stderr = await new Response(chromiumProc.stderr).text();
      console.warn(`[agent-browser] Chromium install failed (exit ${code}):`, stderr.slice(0, 500));
    }
  }).catch((err) => {
    rmSync(lockFile, { force: true });
    console.error('[agent-browser] Chromium install error:', err);
  });
}

/**
 * Auto-install agent-browser to ~/.pm-copilot/agent-browser-cli/ using bundled bun or system npm.
 * Runs in the background so it doesn't block Sidecar startup.
 */
function autoInstallAgentBrowser(): void {
  const homeDir = getHomeDirOrNull();
  if (!homeDir) return;

  const installDir = join(homeDir, '.pm-copilot', 'agent-browser-cli');
  const lockFile = join(installDir, '.installing');

  if (!existsSync(installDir)) mkdirSync(installDir, { recursive: true });

  // Atomic lock: stale check + exclusive create (same pattern as ensureChromiumInstalled)
  if (existsSync(lockFile)) {
    try {
      const lockTime = statSync(lockFile).mtimeMs;
      if (Date.now() - lockTime < 5 * 60 * 1000) {
        console.log('[agent-browser] Install already in progress, skipping');
        return;
      }
      rmSync(lockFile, { force: true }); // stale lock
    } catch { /* ignore */ }
  }
  try {
    writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); // exclusive create
  } catch {
    console.log('[agent-browser] Install already in progress, skipping');
    return;
  }

  // Ensure package.json exists (bun add requires it)
  const pkgJsonPath = join(installDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, '{}');
  }

  const pm = getPackageManagerPath();
  const pkg = `agent-browser@${AGENT_BROWSER_VERSION}`;
  // bun add <pkg> / npm install <pkg> — both work with cwd
  const finalArgs = pm.installArgs(pkg);

  console.log(`[agent-browser] Auto-installing ${pkg} to ${installDir} using ${pm.type}...`);

  const proc = Bun.spawn([pm.command, ...finalArgs], {
    cwd: installDir,
    stdout: 'ignore',
    stderr: 'pipe',
  });

  // Handle in background — don't block startup
  proc.exited.then(async (code) => {
    if (code !== 0) {
      rmSync(lockFile, { force: true });
      new Response(proc.stderr).text().then((stderr) => {
        console.error(`[agent-browser] Auto-install failed (exit ${code}):`, stderr.slice(0, 500));
      }).catch(() => {
        console.error(`[agent-browser] Auto-install failed (exit ${code})`);
      });
      return;
    }

    console.log('[agent-browser] npm install completed');
    const cliPath = getAgentBrowserCliPath();
    if (!cliPath) {
      rmSync(lockFile, { force: true });
      console.warn('[agent-browser] CLI still not found after install');
      return;
    }
    writeAgentBrowserWrapper(cliPath);
    ensureChromiumInstalled(cliPath);
    ensureBrowserStealthConfig();
    rmSync(lockFile, { force: true });
  }).catch((err) => {
    rmSync(lockFile, { force: true });
    console.error('[agent-browser] Auto-install error:', err);
  });
}

function setupAgentBrowserWrapper(): void {
  try {
    const cliPath = getAgentBrowserCliPath();
    if (cliPath) {
      writeAgentBrowserWrapper(cliPath);
      ensureChromiumInstalled(cliPath);  // Background — won't block startup
      ensureBrowserStealthConfig();
      return;
    }

    // CLI not bundled — auto-install to ~/.pm-copilot/agent-browser-cli/
    console.log('[agent-browser] CLI not found in bundle, starting auto-install...');
    autoInstallAgentBrowser();
  } catch (err) {
    console.error('[agent-browser] Error setting up wrapper:', err);
  }
}

// ============= END SKILLS CONFIG & SEED =============

/**
 * Validate that the agent directory is safe to access.
 * Prevents directory traversal attacks and access to sensitive directories.
 */
function isValidAgentDir(dir: string): { valid: boolean; reason?: string } {
  const expanded = expandTilde(dir);
  const resolved = resolve(expanded);
  const homeDir = getHomeDirOrNull() || '';

  // Must be an absolute path (use isAbsolute for cross-platform correctness)
  if (!isAbsolute(resolved)) {
    return { valid: false, reason: 'Path must be absolute' };
  }

  // Forbidden system directories (deny-list approach)
  const forbiddenPaths = [
    // Unix system directories
    '/etc', '/var', '/usr', '/bin', '/sbin', '/boot', '/root', '/sys', '/proc', '/dev',
    // User sensitive directories
    join(homeDir, '.ssh'),
    join(homeDir, '.gnupg'),
    join(homeDir, '.config/op'),  // 1Password
    join(homeDir, 'Library/Keychains'),
    // Windows system directories
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ];

  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  for (const forbidden of forbiddenPaths) {
    const normalizedForbidden = forbidden.replace(/\\/g, '/').toLowerCase();
    if (normalizedResolved === normalizedForbidden || normalizedResolved.startsWith(normalizedForbidden + '/')) {
      return { valid: false, reason: `Access to ${forbidden} is not allowed` };
    }
  }

  // Reject filesystem roots as workspace (too broad, not a real project)
  // Windows: "C:\", "D:\" etc.  Unix: "/"
  if (resolved === '/' || resolved.match(/^[A-Z]:\\?$/i)) {
    return { valid: false, reason: 'Cannot use filesystem root as workspace' };
  }

  return { valid: true };
}

function resolveAgentPath(root: string, relativePath: string): string | null {
  // Strip leading slashes (both / and \ for Windows compatibility)
  const normalized = relativePath.replace(/^[/\\]+/, '');
  const resolved = resolve(root, normalized);
  // Use root + sep to prevent prefix collision (e.g. /agent matching /agent-other)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

/** Read-only safety check: block system/sensitive directories, allow user-accessible paths */
function isSafeReadPath(resolved: string): boolean {
  const homeDir = getHomeDirOrNull() || '';
  const isWin = process.platform === 'win32';

  // Windows paths are case-insensitive; normalize for comparison
  const norm = isWin ? (p: string) => p.toLowerCase() : (p: string) => p;
  const resolvedN = norm(resolved);
  const sepN = norm(sep);

  const forbidden: string[] = isWin
    ? [
        'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
        'C:\\ProgramData', 'C:\\Recovery', 'C:\\$Recycle.Bin',
      ]
    : [
        '/etc', '/var', '/usr', '/bin', '/sbin',
        '/boot', '/root', '/sys', '/proc', '/dev',
      ];

  if (homeDir) {
    if (isWin) {
      forbidden.push(join(homeDir, 'AppData', 'Local', 'Microsoft'));
    }
    // Credential / key stores
    forbidden.push(
      join(homeDir, '.ssh'),
      join(homeDir, '.gnupg'),
      join(homeDir, '.aws'),
      join(homeDir, '.kube'),
      join(homeDir, '.docker'),
      join(homeDir, '.config', 'op'),
    );
    if (!isWin) {
      // macOS sensitive Library subdirectories
      forbidden.push(
        join(homeDir, 'Library', 'Keychains'),
        join(homeDir, 'Library', 'Cookies'),
        join(homeDir, 'Library', 'Mail'),
        join(homeDir, 'Library', 'Messages'),
        join(homeDir, 'Library', 'Safari'),
      );
    }
  }

  for (const f of forbidden) {
    const fN = norm(f);
    if (resolvedN === fN || resolvedN.startsWith(fN + sepN)) return false;
  }

  if (!isWin) {
    const allowed = [homeDir, '/tmp', '/Users', '/home'].filter(Boolean);
    return allowed.some(p => resolvedN === p || resolvedN.startsWith(p + sep));
  }

  // Windows: allow any drive letter path (system dirs already excluded above)
  return /^[A-Z]:\\/i.test(resolved);
}

/** Resolve path for read-only operations: supports both absolute and relative paths */
function resolveReadPath(root: string, inputPath: string): string | null {
  const trimmed = inputPath.trim();
  const isAbsolute = trimmed.startsWith('/') || /^[A-Z]:\\/i.test(trimmed);
  if (isAbsolute) {
    const resolved = resolve(trimmed);
    return isSafeReadPath(resolved) ? resolved : null;
  }
  return resolveAgentPath(root, trimmed);
}


/**
 * Check if a file can be previewed as text.
 * Uses the shared binary-blocklist from `fileTypes.ts` (same logic as frontend)
 * plus MIME-type hints from Bun to cover extensionless files.
 */
function isPreviewableText(name: string, mimeType: string | undefined): boolean {
  // MIME-type hint: trust Bun's detection for text/* and known structured types
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true;
    if (['application/json', 'application/xml', 'application/x-yaml', 'image/svg+xml'].includes(mimeType)) return true;
  }
  // Fall back to shared binary-blocklist strategy (consistent with frontend)
  return isPreviewable(name);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Route /api/admin/* requests to the appropriate handler.
 * Keeps the route matching logic clean and separated from business logic (in admin-api.ts).
 */
async function routeAdminApi(pathname: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  // Strip the prefix for matching
  const route = pathname.replace('/api/admin/', '');

  // MCP commands
  if (route === 'mcp/list') return handleMcpList();
  if (route === 'mcp/add') return handleMcpAdd(payload as Parameters<typeof handleMcpAdd>[0]);
  if (route === 'mcp/remove') return handleMcpRemove(payload as Parameters<typeof handleMcpRemove>[0]);
  if (route === 'mcp/enable') return handleMcpEnable(payload as Parameters<typeof handleMcpEnable>[0]);
  if (route === 'mcp/disable') return handleMcpDisable(payload as Parameters<typeof handleMcpDisable>[0]);
  if (route === 'mcp/env') return handleMcpEnv(payload as Parameters<typeof handleMcpEnv>[0]);
  if (route === 'mcp/test') return await handleMcpTest(payload as Parameters<typeof handleMcpTest>[0]);
  if (route === 'mcp/oauth/discover') return await handleMcpOAuthDiscover(payload as Parameters<typeof handleMcpOAuthDiscover>[0]);
  if (route === 'mcp/oauth/start') return await handleMcpOAuthStart(payload as Parameters<typeof handleMcpOAuthStart>[0]);
  if (route === 'mcp/oauth/status') return await handleMcpOAuthStatus(payload as Parameters<typeof handleMcpOAuthStatus>[0]);
  if (route === 'mcp/oauth/revoke') return await handleMcpOAuthRevoke(payload as Parameters<typeof handleMcpOAuthRevoke>[0]);

  // Model commands
  if (route === 'model/list') return handleModelList();
  if (route === 'model/add') return handleModelAdd(payload as Parameters<typeof handleModelAdd>[0]);
  if (route === 'model/remove') return handleModelRemove(payload as Parameters<typeof handleModelRemove>[0]);
  if (route === 'model/set-key') return handleModelSetKey(payload as Parameters<typeof handleModelSetKey>[0]);
  if (route === 'model/set-default') return handleModelSetDefault(payload as Parameters<typeof handleModelSetDefault>[0]);
  if (route === 'model/verify') return await handleModelVerify(payload as Parameters<typeof handleModelVerify>[0]);

  // Agent commands
  if (route === 'agent/list') return handleAgentList();
  if (route === 'agent/enable') return handleAgentEnable(payload as Parameters<typeof handleAgentEnable>[0]);
  if (route === 'agent/disable') return handleAgentDisable(payload as Parameters<typeof handleAgentDisable>[0]);
  if (route === 'agent/set') return handleAgentSet(payload as Parameters<typeof handleAgentSet>[0]);
  if (route === 'agent/channel/list') return handleAgentChannelList(payload as Parameters<typeof handleAgentChannelList>[0]);
  if (route === 'agent/channel/add') return handleAgentChannelAdd(payload as Parameters<typeof handleAgentChannelAdd>[0]);
  if (route === 'agent/channel/remove') return handleAgentChannelRemove(payload as Parameters<typeof handleAgentChannelRemove>[0]);

  // Agent runtime status
  if (route === 'agent/runtime-status') return await handleAgentRuntimeStatus();

  // Cron task commands
  if (route === 'cron/list') return await handleCronList(payload as Parameters<typeof handleCronList>[0]);
  if (route === 'cron/add') return await handleCronCreate(payload);
  if (route === 'cron/start') return await handleCronStart(payload as Parameters<typeof handleCronStart>[0]);
  if (route === 'cron/stop') return await handleCronStop(payload as Parameters<typeof handleCronStop>[0]);
  if (route === 'cron/remove') return await handleCronDelete(payload as Parameters<typeof handleCronDelete>[0]);
  if (route === 'cron/update') return await handleCronUpdate(payload as Parameters<typeof handleCronUpdate>[0]);
  if (route === 'cron/runs') return await handleCronRuns(payload as Parameters<typeof handleCronRuns>[0]);
  if (route === 'cron/status') return await handleCronStatus(payload as Parameters<typeof handleCronStatus>[0]);

  // Plugin commands
  if (route === 'plugin/list') return await handlePluginList();
  if (route === 'plugin/install') return await handlePluginInstall(payload as Parameters<typeof handlePluginInstall>[0]);
  if (route === 'plugin/remove') return await handlePluginUninstall(payload as Parameters<typeof handlePluginUninstall>[0]);

  // Config commands
  if (route === 'config/get') return handleConfigGet(payload as Parameters<typeof handleConfigGet>[0]);
  if (route === 'config/set') return handleConfigSet(payload as Parameters<typeof handleConfigSet>[0]);

  // System commands
  if (route === 'status') return handleStatus();
  if (route === 'reload') return handleReload(payload.workspacePath as string | undefined);
  if (route === 'version') return handleVersion();
  if (route === 'help') return handleHelp(payload as Parameters<typeof handleHelp>[0]);

  return { success: false, error: `Unknown admin route: ${pathname}` };
}

/**
 * Strip HEARTBEAT_OK token from AI response and determine if it's silent or has content.
 * Supports markdown/HTML wrapping around the token.
 */
function stripHeartbeatToken(text: string, ackMaxChars: number): { status: string; text?: string; reason?: string } {
  if (!text || !text.trim()) {
    return { status: 'silent', reason: 'empty' };
  }

  // Check if HEARTBEAT_OK appears in the text (case-insensitive)
  if (!/HEARTBEAT_OK/i.test(text)) {
    // No token at all — this is real content
    return { status: 'content', text };
  }

  // Strip the token (supports markdown bold, code wrapping)
  const stripped = text
    .replace(/\*{0,2}HEARTBEAT_OK\*{0,2}/gi, '')
    .replace(/`HEARTBEAT_OK`/gi, '')
    .trim();

  // If remaining text is short enough, treat as silent acknowledgment
  if (stripped.length <= ackMaxChars) {
    return { status: 'silent', reason: 'heartbeat_ok' };
  }

  // Remaining text has substance — treat as content (but strip the token)
  return { status: 'content', text: stripped };
}


/**
 * Strip YAML frontmatter from file content.
 * Frontmatter is delimited by --- at the start and a second --- line.
 */
function stripYamlFrontmatter(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) return trimmed;
  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) return trimmed;
  return trimmed.slice(endIndex + 3).trim();
}

/**
 * Recursively copy a directory (synchronous version)
 * Security: Skips symbolic links to prevent following links to sensitive locations
 * @param src Source directory path
 * @param dest Destination directory path
 * @param logPrefix Optional prefix for log messages
 */
function copyDirRecursiveSync(src: string, dest: string, logPrefix = '[copyDir]'): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // Security: Skip symbolic links to prevent following links to sensitive locations
    if (entry.isSymbolicLink()) {
      console.warn(`${logPrefix} Skipping symlink: ${srcPath}`);
      continue;
    }

    if (entry.isDirectory()) {
      copyDirRecursiveSync(srcPath, destPath, logPrefix);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Validate folder name for security (no path traversal)
 */
function isValidFolderName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\') && name.length > 0;
}

async function serveStatic(pathname: string): Promise<Response | null> {
  const distRoot = resolve(process.cwd(), 'dist');
  const resolvedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = join(distRoot, resolvedPath);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return new Response(file);
  }

  const indexFile = Bun.file(join(distRoot, 'index.html'));
  if (await indexFile.exists()) {
    return new Response(indexFile);
  }

  return null;
}

interface SwitchPayload {
  agentDir: string;
  initialPrompt?: string;
}

// System event queue for heartbeat relay (cron completion, etc.)
const systemEventQueue: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];

/** Drain all pending system events (used by heartbeat endpoint) */
export function drainSystemEvents(): Array<{ event: string; content: string; timestamp: number; taskId?: string }> {
  return systemEventQueue.splice(0);
}

/** Build a dedicated prompt for cron completion events (replaces standard heartbeat prompt) */
function buildCronEventPrompt(
  cronEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }>
): string {
  const now = new Date().toLocaleString('en-US', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  if (cronEvents.length === 1) {
    const e = cronEvents[0];
    return (
      'A scheduled task has been triggered and completed. ' +
      'Please relay these results to the user in a helpful and friendly way.\n' +
      `Task id: ${e.taskId || 'unknown'}\n` +
      `Current time: ${now}\n` +
      'The task results are:\n' +
      '```markdown\n' +
      e.content + '\n' +
      '```'
    );
  }

  // Multiple tasks
  let prompt =
    'Scheduled tasks have been triggered and completed. ' +
    'Please relay these results to the user in a helpful and friendly way.\n' +
    `Current time: ${now}\n`;

  for (const e of cronEvents) {
    prompt +=
      `\nTask id: ${e.taskId || 'unknown'}\n` +
      'The task results are:\n' +
      '```markdown\n' +
      e.content + '\n' +
      '```\n';
  }
  return prompt;
}

/**
 * Write a startup beacon directly to unified log file (bypasses initLogger).
 * This is critical for diagnosing Windows startup hangs where initLogger
 * may not be reached yet and zero BUN logs appear.
 */
function startupBeacon(step: string): void {
  // Write to stderr — captured by Rust drain thread → unified log
  try { process.stderr.write(`[startup] ${step}\n`); } catch { /* ignore */ }
  // Also write directly to unified log file.
  // NOTE: 内联时间戳格式而非 import localTimestamp()，因为此函数在 initLogger() 之前运行，
  // 需保持零依赖以诊断 Windows 上 initLogger 未到达的 hang 问题。
  try {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const logsDir = join(homedir(), '.pm-copilot', 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const filePath = join(logsDir, `unified-${y}-${m}-${d}.log`);
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const ts = `${y}-${m}-${d} ${h}:${mi}:${s}.${ms}`;
    appendFileSync(filePath, `${ts} [BUN  ] [INFO ] [startup] ${step}\n`);
  } catch { /* ignore */ }
}

async function main() {
  startupBeacon(`main() entered, pid=${process.pid}, platform=${process.platform}, argv=${process.argv.length} args`);

  const { agentDir, initialPrompt, port, sessionId: initialSessionId, noPreWarm } = parseArgs(process.argv);
  const dirDisplay = agentDir.length > 50 ? agentDir.slice(0, 3) + '...' + agentDir.slice(-44) : agentDir;
  startupBeacon(`args parsed, port=${port}, agentDir=${dirDisplay}`);

  let currentAgentDir = await ensureAgentDir(agentDir);
  startupBeacon('ensureAgentDir done');

  // Initialize unified logging system (intercepts console.log and sends to SSE)
  initLogger(getClients);
  startupBeacon('initLogger done — switching to console.log');

  // Clean up old logs (30+ days)
  cleanupOldLogs();        // Agent session logs
  cleanupOldUnifiedLogs(); // Unified console logs

  // Recovery: clean up stale Playwright MCP profile locks left by v0.1.30 bug
  // (node→bun shim in global PATH caused Chrome CDP WebSocket timeout)
  cleanupStalePlaywrightProfile();

  // One-time migration: extract cookies from old Chromium profile to storage-state JSON
  // (v0.1.51: switched from persistent profile to isolated mode for browser concurrency)
  migrateProfileToStorageState();

  // Seed bundled skills to ~/.pm-copilot/skills/ on first launch
  seedBundledSkills();
  seedBundledPmSkills();
  console.log('[startup] skill seeding done');

  // Generate agent-browser CLI wrapper in ~/.pm-copilot/bin/
  if (!isSkillBlockedOnPlatform('agent-browser')) {
    setupAgentBrowserWrapper();
    console.log('[startup] setupAgentBrowserWrapper done');
  } else {
    console.log('[startup] Skipping agent-browser on this platform (blocked)');
  }

  // Initialize SOCKS5→HTTP bridge if Rust injected socks5:// proxy env vars.
  // Must run BEFORE initializeAgent() which triggers pre-warm → SDK subprocess spawn.
  await initSocksBridgeFromEnv();

  await initializeAgent(currentAgentDir, initialPrompt, initialSessionId, { preWarmDisabled: noPreWarm });
  console.log('[startup] initializeAgent done');

  // For external runtime sessions being resumed: restore module state so sendExternalMessage
  // uses --resume instead of --session-id. Must happen after initializeAgent sets up the session.
  if (shouldUseExternalRuntime() && initialSessionId) {
    restoreExternalSessionState(initialSessionId, currentAgentDir, { type: 'desktop' });
  }

  // Store sidecar port for OpenAI bridge loopback
  setSidecarPort(port);

  // Create OpenAI bridge handler (lazy: only processes requests when bridge config is active)
  const bridgeHandler = createBridgeHandler({
    getUpstreamConfig: () => {
      const config = getOpenAiBridgeConfig();
      if (!config) throw new Error('Bridge not active');
      return {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model, // undefined when aliases exist (modelMapping handles it)
        maxOutputTokens: config.maxOutputTokens,
        maxOutputTokensParamName: config.maxOutputTokensParamName,
        upstreamFormat: config.upstreamFormat,
      };
    },
    // Dynamic model mapping: when aliases exist, map any Claude model ID to the provider's model.
    // Called per-request, so it always reflects the latest provider config.
    modelMapping: (requestModel: string) => {
      const config = getOpenAiBridgeConfig();
      if (!config?.modelAliases) return undefined; // No aliases → fall through to modelOverride
      const aliases = config.modelAliases;
      // Map SDK-resolved model names to provider models
      if (requestModel.startsWith('claude') && requestModel.includes('sonnet') && aliases.sonnet) return aliases.sonnet;
      if (requestModel.startsWith('claude') && requestModel.includes('opus') && aliases.opus) return aliases.opus;
      if (requestModel.startsWith('claude') && requestModel.includes('haiku') && aliases.haiku) return aliases.haiku;
      // Safety fallback: if this is a Claude model name that wasn't matched by any alias
      // (e.g., partial alias config — only sonnet configured, not opus/haiku),
      // fall back to currentModel to prevent raw "claude-*" from leaking to upstream.
      if (requestModel.startsWith('claude-')) return getSessionModel() || undefined;
      // Non-Claude models pass through as-is (e.g., the main model "deepseek-chat")
      return undefined;
    },
    logger: (msg) => console.log(msg),
  });
  registerBridgeSeedFn((entries) => bridgeHandler.seedThoughtSignatures(entries));

  console.log(`[startup] Bun.serve() binding to 127.0.0.1:${port}...`);

  Bun.serve({
    port,
    hostname: '127.0.0.1', // Explicitly bind to IPv4 for Rust proxy compatibility
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const pathname = url.pathname;

      // Skip logging high-frequency polling/config-sync paths to reduce unified log noise.
      // These fire every 15s (health) or on every Tab focus (commands/agents/mcp) with zero diagnostic value.
      const SILENT_PATHS = new Set([
        '/health', '/api/unified-log', '/agent/dir', '/sessions',
        '/api/commands', '/api/agents/enabled', '/api/git/branch',
      ]);
      if (!SILENT_PATHS.has(pathname)) {
        console.debug(`[http] ${request.method} ${pathname}`);
      }

      // Handle CORS preflight requests (for browser dev mode via Vite proxy)
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          }
        });
      }

      // 🩺 Health check endpoint - used by Rust sidecar manager
      // Must be as simple as possible to verify HTTP handler is responsive
      if (pathname === '/health' && request.method === 'GET') {
        return jsonResponse({ status: 'ok', timestamp: Date.now() });
      }

      // Session state endpoint - used by Rust background completion polling
      if (pathname === '/api/session-state' && request.method === 'GET') {
        const { sessionState } = getAgentState();
        return jsonResponse({ sessionState });
      }

      // Read historical session messages from SDK's persisted session files (v0.2.59+)
      // Works without an active Sidecar — reads directly from .claude/ session data
      if (pathname === '/api/session/messages' && request.method === 'GET') {
        const sdkSessionId = url.searchParams.get('sdkSessionId');
        if (!sdkSessionId) {
          return jsonResponse({ success: false, error: 'sdkSessionId is required' }, 400);
        }
        const dir = url.searchParams.get('dir') || undefined;
        const rawLimit = url.searchParams.get('limit');
        const rawOffset = url.searchParams.get('offset');
        const limit = rawLimit ? (Number.isFinite(+rawLimit) && +rawLimit >= 0 ? Math.floor(+rawLimit) : undefined) : undefined;
        const offset = rawOffset ? (Number.isFinite(+rawOffset) && +rawOffset >= 0 ? Math.floor(+rawOffset) : undefined) : undefined;
        try {
          const messages = await getHistoricalSessionMessages(sdkSessionId, dir, limit, offset);
          return jsonResponse({ success: true, messages });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read session messages' },
            500
          );
        }
      }

      // Check ~/.claude/settings.json for env overrides (ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY)
      // External tools like cc-switch write these, which override PM Copilot' provider settings via SDK bug
      if (pathname === '/api/claude-settings/check-env' && request.method === 'GET') {
        try {
          const homeDir = getHomeDirOrNull() || '';
          if (!homeDir) return jsonResponse({ hasOverrides: false });
          const settingsPath = join(homeDir, '.claude', 'settings.json');
          const file = Bun.file(settingsPath);
          if (!(await file.exists())) return jsonResponse({ hasOverrides: false });
          const settings = await file.json() as { env?: Record<string, string> };
          const env = settings?.env;
          if (!env) return jsonResponse({ hasOverrides: false });
          const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
          const apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || undefined;
          if (!baseUrl && !apiKey) return jsonResponse({ hasOverrides: false });
          return jsonResponse({ hasOverrides: true, baseUrl, hasApiKey: !!apiKey });
        } catch {
          return jsonResponse({ hasOverrides: false });
        }
      }

      // Clear env overrides from ~/.claude/settings.json
      if (pathname === '/api/claude-settings/clear-env' && request.method === 'POST') {
        try {
          const homeDir = getHomeDirOrNull() || '';
          if (!homeDir) return jsonResponse({ success: false, error: 'Home directory not found' }, 400);
          const settingsPath = join(homeDir, '.claude', 'settings.json');
          const file = Bun.file(settingsPath);
          if (!(await file.exists())) return jsonResponse({ success: true });
          const settings = await file.json() as Record<string, unknown>;
          if (!settings.env) return jsonResponse({ success: true });
          const env = settings.env as Record<string, string>;
          delete env.ANTHROPIC_BASE_URL;
          delete env.ANTHROPIC_API_KEY;
          delete env.ANTHROPIC_AUTH_TOKEN;
          // Remove env key entirely if empty
          if (Object.keys(env).length === 0) {
            delete settings.env;
          }
          // Atomic write: temp file + rename to prevent corruption
          const tmpPath = settingsPath + '.tmp';
          await Bun.write(tmpPath, JSON.stringify(settings, null, 2) + '\n');
          await rename(tmpPath, settingsPath);
          console.log('[claude-settings] Cleared ANTHROPIC_BASE_URL/API_KEY from ~/.claude/settings.json');
          return jsonResponse({ success: true });
        } catch (err) {
          console.error('[claude-settings] Failed to clear env:', err);
          return jsonResponse({ success: false, error: err instanceof Error ? err.message : String(err) }, 500);
        }
      }

      // 🔍 Debug endpoint: Expose logger diagnostics via HTTP
      if (pathname === '/debug/logger' && request.method === 'GET') {
        const diagnostics = getLoggerDiagnostics();
        const clientsCount = getClients().length;
        return jsonResponse({
          ...diagnostics,
          currentClientsCount: clientsCount,
          timestamp: new Date().toISOString(),
        }, 200);
      }

      if (pathname === '/chat/stream' && request.method === 'GET') {
        const { client, response } = createSseClient(() => { });
        const state = getAgentState();
        client.send('chat:init', state);
        const allMessages = getMessages();
        // When a turn is in-flight, skip the streaming assistant message.
        // Live SSE events (thinking-start, thinking-chunk, message-chunk) will build it from
        // scratch. Replaying it here would create a duplicate in historyMessages alongside the
        // streamingMessage being assembled from live events → duplicate thinking blocks.
        // Filter by message ID (not array position) because mid-turn queued user messages
        // can appear after the streaming assistant in messages[].
        const streamingId = getStreamingAssistantId();
        allMessages.forEach((message) => {
          if (streamingId && message.id === streamingId) return; // skip streaming message
          // Strip Playwright tool results from replay to avoid sending large base64 data to frontend
          const stripped = typeof message.content !== 'string'
            ? { ...message, content: stripPlaywrightResults(message.content) }
            : message;
          client.send('chat:message-replay', { message: stripped });
        });
        client.send('chat:logs', { lines: getLogLines() });
        const systemInitInfo = getSystemInitInfo();
        if (systemInitInfo) {
          client.send('chat:system-init', { info: systemInitInfo });
        }
        // Replay pending interactive requests (permission, ask-user-question)
        // so that a Tab joining mid-session can display and respond to them.
        for (const pending of getPendingInteractiveRequests()) {
          client.send(pending.type, pending.data);
        }
        return response;
      }

      if (pathname === '/chat/send' && request.method === 'POST') {
        let payload: SendMessagePayload;
        try {
          payload = (await request.json()) as SendMessagePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }
        const text = payload?.text?.trim() ?? '';
        const images = payload?.images ?? [];
        const permissionMode = payload?.permissionMode ?? 'auto';
        const model = payload?.model;
        const providerEnv = payload?.providerEnv;

        // Allow sending with just images or just text
        if (!text && images.length === 0) {
          return jsonResponse({ success: false, error: 'Message must have text or images.' }, 400);
        }

        // ─── External Runtime branch (v0.1.59) ───
        if (shouldUseExternalRuntime()) {
          try {
            const runtimeType = getActiveRuntimeType();
            console.log(`[chat] send via ${runtimeType}: text="${text.slice(0, 200)}"`);

            // Unified send: sendExternalMessage handles both first message and follow-ups.
            // CC's -p mode exits after each turn; sendExternalMessage detects this
            // and spawns a new process with --resume for multi-turn continuity.
            const result = await sendExternalMessage(
              text, images, permissionMode, model ?? undefined,
              // Pass session context for first-time start
              { sessionId: getSessionId(), workspacePath: agentDir, scenario: { type: 'desktop' as const }, permissionMode, model: model ?? undefined },
            );
            return jsonResponse({ success: result.queued, error: result.error });
          } catch (error) {
            return jsonResponse(
              { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
              500
            );
          }
        }

        // ─── Builtin Runtime (existing path) ───
        try {
          const providerLabel = typeof providerEnv === 'object' ? providerEnv?.baseUrl ?? 'anthropic' : (providerEnv ?? 'anthropic');
          console.log(`[chat] send text="${text.slice(0, 200)}" images=${images.length} mode=${permissionMode} model=${model ?? 'default'} baseUrl=${providerLabel}`);
          const result = await enqueueUserMessage(text, images, permissionMode, model, providerEnv);
          if (result.error) {
            return jsonResponse({ success: false, error: result.error }, 429);
          }
          return jsonResponse({ success: true, queued: result.queued, queueId: result.queueId });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/chat/stop' && request.method === 'POST') {
        try {
          console.log('[chat] stop');

          // External Runtime: stop the subprocess
          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            const stopped = await stopExternalSession();
            return jsonResponse({ success: true, alreadyStopped: !stopped });
          }

          // Builtin Runtime: existing path
          const stopped = await interruptCurrentResponse();
          if (!stopped) {
            return jsonResponse({ success: true, alreadyStopped: true });
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ─── Runtime API endpoints (v0.1.59) ───

      if (pathname === '/api/runtime/type' && request.method === 'GET') {
        return jsonResponse({ runtime: getActiveRuntimeType() });
      }

      if (pathname === '/api/runtime/models' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        try {
          const models = await queryRuntimeModels(type as import('../shared/types/runtime').RuntimeType);
          return jsonResponse({ models });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
        }
      }

      if (pathname === '/api/runtime/permission-modes' && request.method === 'GET') {
        const type = url.searchParams.get('type');
        if (!type) return jsonResponse({ error: 'Missing type parameter' }, 400);
        const modes = getRuntimePermissionModes(type as import('../shared/types/runtime').RuntimeType);
        return jsonResponse({ modes });
      }

      if (pathname === '/api/runtime/permission-response' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const requestId = body.requestId as string;
        const approved = body.approved as boolean;
        const reason = body.reason as string | undefined;
        if (!requestId) return jsonResponse({ error: 'Missing requestId' }, 400);
        try {
          await respondExternalPermission(requestId, approved, reason);
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
        }
      }

      // CC SessionStart hook receiver (v0.1.59)
      // CC fires this hook when a session starts/resumes/compacts.
      // The forwarder script (cc-session-hook-forwarder.cjs) POSTs the hook input here.
      if (pathname === '/hook/session-start' && request.method === 'POST') {
        try {
          const hookData = (await request.json()) as Record<string, unknown>;
          const ccSessionId = (hookData.session_id as string) || (hookData.sessionId as string) || '';
          if (ccSessionId) {
            console.log(`[hook] CC SessionStart: session_id=${ccSessionId}, source=${hookData.source}`);
            // Import and update the external session's CC session ID
            const { setRuntimeSessionId } = await import('./runtimes/external-session');
            setRuntimeSessionId(ccSessionId);
          }
          return jsonResponse({ ok: true });
        } catch {
          return jsonResponse({ ok: false }, 500);
        }
      }

      // Rewind session to a specific user message (time travel)
      if (pathname === '/chat/rewind' && request.method === 'POST') {
        if (shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'Rewind is not supported for external runtimes (CC/Codex)' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const userMessageId = typeof body.userMessageId === 'string' ? body.userMessageId : '';
        if (!userMessageId) {
          return jsonResponse({ success: false, error: 'Missing userMessageId' }, 400);
        }
        const result = await rewindSession(userMessageId);
        return jsonResponse(result);
      }

      // Fork session at a specific assistant message (create branch)
      if (pathname === '/sessions/fork' && request.method === 'POST') {
        if (shouldUseExternalRuntime()) {
          return jsonResponse({ success: false, error: 'Fork is not supported for external runtimes (CC/Codex)' }, 400);
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const messageId = typeof body.messageId === 'string' ? body.messageId : '';
        if (!messageId) {
          return jsonResponse({ success: false, error: 'Missing messageId' }, 400);
        }
        const result = forkSession(messageId);
        return jsonResponse(result);
      }

      // Cancel a queued message
      if (pathname === '/chat/queue/cancel' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        const cancelledText = cancelQueueItem(queueId);
        if (cancelledText === null) {
          return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
        }
        return jsonResponse({ success: true, cancelledText });
      }

      // Force-execute a queued message (interrupt current + run queued)
      if (pathname === '/chat/queue/force' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const queueId = body?.queueId as string;
        if (!queueId) {
          return jsonResponse({ success: false, error: 'queueId is required' }, 400);
        }
        try {
          const result = await forceExecuteQueueItem(queueId);
          if (!result) {
            return jsonResponse({ success: false, error: 'Queue item not found' }, 404);
          }
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Get queue status
      if (pathname === '/chat/queue/status' && request.method === 'GET') {
        return jsonResponse({ success: true, queue: getQueueStatus() });
      }

      // Poll background task output file for live stats
      if (pathname === '/api/task/poll-background' && request.method === 'POST') {
        try {
          const body = await request.json() as { outputFile?: string; offset?: number };
          const { outputFile, offset = 0 } = body;

          // Validate outputFile path: resolve to canonical path then verify it falls
          // under the user's home directory and matches expected suffix.
          // This prevents path traversal attacks (e.g., "/../../../etc/passwd.output").
          if (!outputFile || typeof outputFile !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }
          const resolvedOutputFile = resolve(outputFile);
          const homeDir = getHomeDirOrNull() || '';
          const isUnderHome = homeDir && resolvedOutputFile.startsWith(homeDir + sep);
          if (!isUnderHome || !resolvedOutputFile.endsWith('.output')) {
            return jsonResponse({ success: false, error: 'Invalid outputFile path' }, 400);
          }

          // Check file existence
          if (!existsSync(resolvedOutputFile)) {
            return jsonResponse({ success: true, stats: null, newOffset: 0, isComplete: false });
          }

          const fileStat = statSync(resolvedOutputFile);
          const fileSize = fileStat.size;

          // No new data
          if (offset >= fileSize) {
            return jsonResponse({ success: true, stats: null, newOffset: offset, isComplete: false });
          }

          // Read incremental data (cap at 1MB)
          const MAX_READ = 1024 * 1024;
          const readEnd = Math.min(offset + MAX_READ, fileSize);
          const file = Bun.file(resolvedOutputFile);
          const slice = file.slice(offset, readEnd);
          const text = await slice.text();

          // Parse JSONL lines
          let toolCount = 0;
          let assistantCount = 0;
          let userCount = 0;
          let progressCount = 0;
          let firstTimestamp = 0;
          let lastTimestamp = 0;
          let lastLineType = '';
          let lastLineHasToolUse = false;

          const lines = text.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0;
              if (ts && !firstTimestamp) firstTimestamp = ts;
              if (ts) lastTimestamp = ts;

              if (parsed.type === 'assistant') {
                assistantCount++;
                lastLineType = 'assistant';
                lastLineHasToolUse = false;
                // Count tool_use blocks in content
                if (Array.isArray(parsed.message?.content)) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'tool_use') {
                      toolCount++;
                      lastLineHasToolUse = true;
                    }
                  }
                }
              } else if (parsed.type === 'user') {
                userCount++;
                lastLineType = 'user';
                lastLineHasToolUse = false;
              } else if (parsed.type === 'progress') {
                progressCount++;
              }
            } catch {
              // Skip truncated/invalid lines
            }
          }

          const elapsed = firstTimestamp && lastTimestamp ? lastTimestamp - firstTimestamp : 0;

          // Detect completion: last line is assistant with only text (no tool_use)
          const isComplete = lastLineType === 'assistant' && !lastLineHasToolUse;

          return jsonResponse({
            success: true,
            stats: { toolCount, assistantCount, userCount, progressCount, elapsed },
            newOffset: readEnd,
            isComplete
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Reset session for "new conversation" - clears all messages and state
      if (pathname === '/chat/reset' && request.method === 'POST') {
        try {
          console.log('[chat] reset (new conversation)');
          // Stop external runtime subprocess if active (prevents orphaned processes)
          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            await stopExternalSession();
          }
          await resetSession();
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // ============= CRON TASK API =============

      // GET /cron/check-completion - Check if the last response indicates task completion
      if (pathname === '/cron/check-completion' && request.method === 'GET') {
        try {
          const messages = getMessages();
          const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');

          if (!lastAssistantMessage) {
            return jsonResponse({ success: true, completed: false, reason: null });
          }

          // Extract text content from the message
          let textContent = '';
          if (typeof lastAssistantMessage.content === 'string') {
            textContent = lastAssistantMessage.content;
          } else if (Array.isArray(lastAssistantMessage.content)) {
            textContent = lastAssistantMessage.content
              .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
              .map(block => block.text)
              .join('\n');
          }

          // Check for completion marker
          const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
          if (completionMatch) {
            return jsonResponse({
              success: true,
              completed: true,
              reason: completionMatch[1].trim()
            });
          }

          return jsonResponse({ success: true, completed: false, reason: null });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute - Execute a scheduled task
      // This endpoint wraps the user's prompt with cron-specific instructions
      // and enables the exit_cron_task custom tool
      if (pathname === '/cron/execute' && request.method === 'POST') {
        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, aiCanExit, model, providerEnv, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Get current session ID for context isolation
        const currentSessionId = getSessionId();

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, currentSessionId);

        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)
        setInteractionScenario({
          type: 'cron',
          taskId,
          intervalMinutes: intervalMinutes ?? 15,
          aiCanExit: aiCanExit ?? false,
        });

        try {
          console.log(`[cron] execute taskId=${taskId} sessionId=${currentSessionId} interval=${intervalMinutes}min exec#=${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);
          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)
          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;
          // Cron tasks are unattended — bypass all permissions so tool requests
          // don't block indefinitely waiting for a user who isn't present.
          await enqueueUserMessage(wrappedPrompt, [], 'fullAgency', model, providerEnv);
          // Reset scenario after enqueue — already consumed by startStreamingSession()
          resetInteractionScenario();
          return jsonResponse({ success: true });
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(currentSessionId);
          resetInteractionScenario();
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // POST /cron/execute-sync - Execute a scheduled task synchronously
      // This endpoint is used by Rust for direct Sidecar invocation without frontend
      // It waits for the execution to complete and returns the result
      if (pathname === '/cron/execute-sync' && request.method === 'POST') {
        console.log('[cron] execute-sync: endpoint matched');

        let payload: CronExecutePayload;
        try {
          payload = (await request.json()) as CronExecutePayload;
          console.log('[cron] execute-sync: payload parsed', { taskId: payload.taskId, hasPrompt: !!payload.prompt, runMode: payload.runMode });
        } catch (e) {
          console.error('[cron] execute-sync: JSON parse error', e);
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const { taskId, prompt, sessionId, aiCanExit, model, providerEnv, runMode, intervalMinutes, executionNumber } = payload;

        if (!taskId || !prompt) {
          return jsonResponse({ success: false, error: 'taskId and prompt are required.' }, 400);
        }

        // Handle session setup based on runMode
        const effectiveRunMode = runMode ?? 'single_session';
        const { agentDir } = getAgentState();

        // Clear any existing cron context before switching sessions
        // This prevents context pollution when sessions change
        clearCronTaskContext();

        let effectiveSessionId = sessionId;

        if (effectiveRunMode === 'new_session') {
          // Create a fresh session for each execution (no memory of previous runs)
          const newSession = createSession(agentDir);
          const switched = await switchToSession(newSession.id);
          if (!switched) {
            console.error(`[cron] execute-sync taskId=${taskId} failed to switch to new session ${newSession.id}`);
            return jsonResponse({ success: false, error: 'Failed to create new session for execution.' }, 500);
          }
          effectiveSessionId = newSession.id;
          console.log(`[cron] execute-sync taskId=${taskId} new_session mode: created fresh session ${newSession.id}`);
        } else if (sessionId) {
          // single_session mode: switch to the task's stored session (keeps context)
          // If already in the target session, skip switchToSession to avoid aborting
          // an active AI response and clearing the message queue.
          const currentSessionId = getSessionId();
          if (currentSessionId === sessionId) {
            console.log(`[cron] execute-sync taskId=${taskId} single_session mode: already in session ${sessionId}, skipping switch`);
          } else {
            console.log(`[cron] execute-sync taskId=${taskId} attempting to switch to session ${sessionId}`);
            const switched = await switchToSession(sessionId);
            if (!switched) {
              console.warn(`[cron] execute-sync taskId=${taskId} failed to switch to session ${sessionId}, will use current session instead`);
              // Log current session state for debugging
              const currentState = getAgentState();
              console.log(`[cron] execute-sync taskId=${taskId} current session state: agentDir=${currentState.agentDir}, sessionState=${currentState.sessionState}, hasInitialPrompt=${currentState.hasInitialPrompt}`);
            } else {
              console.log(`[cron] execute-sync taskId=${taskId} single_session mode: switched to session ${sessionId}`);
            }
          }
        } else {
          console.log(`[cron] execute-sync taskId=${taskId} no sessionId provided, using current session`);
        }

        // Set cron task context so the exit_cron_task tool knows which task is running
        // Pass sessionId for proper isolation between concurrent tasks
        setCronTaskContext(taskId, aiCanExit ?? false, effectiveSessionId);
        console.log(`[cron] execute-sync: cron context set for taskId=${taskId}`);

        // Set System Prompt append for cron task context
        // Set interaction scenario for cron task (L1 + L2-desktop + L3-cron)
        try {
          setInteractionScenario({
            type: 'cron',
            taskId,
            intervalMinutes: intervalMinutes ?? 15,
            aiCanExit: aiCanExit ?? false,
          });
          console.log('[cron] execute-sync: interaction scenario set');
        } catch (e) {
          console.error('[cron] execute-sync: error setting interaction scenario', e);
          clearCronTaskContext(effectiveSessionId);
          return jsonResponse({ success: false, error: `System prompt error: ${e}` }, 500);
        }

        try {
          console.log(`[cron] execute-sync taskId=${taskId} runMode=${effectiveRunMode} interval=${intervalMinutes}min exec#${executionNumber} aiCanExit=${aiCanExit ?? false} prompt="${prompt.slice(0, 100)}..."`);

          // Enqueue the message (this starts the async execution)
          // Wrap cron prompt so AI recognizes it as system-triggered (not a real-time human message)
          const wrappedPrompt = `<system-reminder>\n<CRON_TASK>\n${prompt}\n</CRON_TASK>\n</system-reminder>`;
          console.log('[cron] execute-sync: about to enqueue user message');

          let textContent = '';

          if (shouldUseExternalRuntime()) {
            // ─── External Runtime (CC/Codex): cron task ───
            const ccResult = await sendExternalMessage(
              wrappedPrompt, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'cron', taskId: taskId ?? 'unknown', intervalMinutes: intervalMinutes ?? 0, aiCanExit: aiCanExit ?? false },
                permissionMode: 'fullAgency',
                model: undefined,
              },
            );
            if (!ccResult.queued) {
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: ccResult.error ?? 'Failed to start cron via external runtime' }, 503);
            }

            const completed = await waitForExternalSessionIdle(3600000, 1000);
            if (!completed) {
              console.warn(`[cron] execute-sync taskId=${taskId} timed out (external runtime)`);
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'Execution timed out' }, 408);
            }

            if (!didLastTurnSucceed()) {
              console.warn(`[cron] execute-sync taskId=${taskId} external runtime turn failed`);
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'External runtime turn failed' }, 503);
            }

            textContent = getLastExternalAssistantText();
          } else {
            // ─── Builtin Runtime: existing path ───
            // Cron tasks are unattended — bypass all permissions so tool requests
            // (e.g. Bash) don't block forever waiting for human approval.
            const enqueueResult = await enqueueUserMessage(wrappedPrompt, [], 'fullAgency', model, providerEnv);
            console.log('[cron] execute-sync: user message enqueued, queued:', enqueueResult.queued, 'queueId:', enqueueResult.queueId);

            // Wait for session to become idle (execution complete)
            // Timeout: 60 minutes max execution time (matches Rust cron_task timeout)
            const completed = await waitForSessionIdle(3600000, 1000);

            if (!completed) {
              console.warn(`[cron] execute-sync taskId=${taskId} timed out`);
              if (enqueueResult.queued && enqueueResult.queueId) {
                cancelQueueItem(enqueueResult.queueId);
              }
              clearCronTaskContext(effectiveSessionId);
              resetInteractionScenario();
              return jsonResponse({ success: false, error: 'Execution timed out' }, 408);
            }

            // Extract response text from builtin session messages
            const messages = getMessages();
            const lastAssistantMessage = [...messages].reverse().find(m => m.role === 'assistant');
            if (lastAssistantMessage) {
              if (typeof lastAssistantMessage.content === 'string') {
                textContent = lastAssistantMessage.content;
              } else if (Array.isArray(lastAssistantMessage.content)) {
                textContent = lastAssistantMessage.content
                  .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
                  .map(block => block.text)
                  .join('\n');
              }
            }
          }

          // Check if AI requested exit (works for both runtimes — checks text patterns)
          let aiRequestedExit = false;
          let exitReason: string | undefined;

          if (textContent) {
            const completionMatch = textContent.match(CRON_TASK_COMPLETE_PATTERN);
            if (completionMatch) {
              aiRequestedExit = true;
              exitReason = completionMatch[1].trim();
            }
            if (textContent.includes(CRON_TASK_EXIT_TEXT)) {
              aiRequestedExit = true;
              const reasonMatch = textContent.match(CRON_TASK_EXIT_REASON_PATTERN);
              if (reasonMatch) {
                exitReason = reasonMatch[1].trim();
              }
            }
          }

          // Clear cron task context after execution
          clearCronTaskContext(effectiveSessionId);
          // Reset scenario — already consumed by startStreamingSession() at session creation
          resetInteractionScenario();

          console.log(`[cron] execute-sync taskId=${taskId} completed, aiRequestedExit=${aiRequestedExit}, exitReason=${exitReason}`);

          // Return the Sidecar session ID (our internal storage key) so Rust can
          // pass it to frontend for loading conversation data from our message store.
          const actualSessionId = getSessionId();

          const response = {
            success: true,
            aiRequestedExit,
            exitReason,
            outputText: textContent || undefined,
            sessionId: actualSessionId,
          };
          console.log(`[cron] execute-sync taskId=${taskId} returning response:`, JSON.stringify(response));
          return jsonResponse(response);
        } catch (error) {
          // Clear context on error
          clearCronTaskContext(effectiveSessionId);
          resetInteractionScenario();
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[cron] execute-sync taskId=${taskId} error:`, error);
          const errorResponse = { success: false, error: errorMessage };
          console.log(`[cron] execute-sync taskId=${taskId} returning error response:`, JSON.stringify(errorResponse));
          return jsonResponse(errorResponse, 500);
        }
      }

      // ============= GLOBAL STATS API =============

      // GET /api/global-stats?range=7d|30d|60d - Aggregated token usage across all sessions
      if (pathname === '/api/global-stats' && request.method === 'GET') {
        try {
          const range = url.searchParams.get('range') || '30d';
          if (!['7d', '30d', '60d'].includes(range)) {
            return jsonResponse({ success: false, error: 'Invalid range. Use 7d, 30d, or 60d.' }, 400);
          }

          const allSessions = getAllSessionMetadata();

          // Filter sessions by time range using lastActiveAt as a coarse pre-filter
          const now = Date.now();
          const rangeDays = range === '7d' ? 7 : range === '30d' ? 30 : 60;
          const cutoff = now - rangeDays * 86400_000;

          const sessions = allSessions.filter(s => new Date(s.lastActiveAt).getTime() >= cutoff);

          // Aggregate summary from metadata.stats (fast, no JSONL reads)
          const totalSessions = sessions.length;
          let messageCount = 0;
          let totalInputTokens = 0;
          let totalOutputTokens = 0;
          let totalCacheReadTokens = 0;
          let totalCacheCreationTokens = 0;

          for (const s of sessions) {
            const stats = s.stats;
            if (stats) {
              messageCount += stats.messageCount ?? 0;
              totalInputTokens += stats.totalInputTokens ?? 0;
              totalOutputTokens += stats.totalOutputTokens ?? 0;
              totalCacheReadTokens += stats.totalCacheReadTokens ?? 0;
              totalCacheCreationTokens += stats.totalCacheCreationTokens ?? 0;
            }
          }

          // Helper: convert ISO timestamp to local date string "YYYY-MM-DD"
          const toLocalDate = (isoStr: string): string => {
            const d = new Date(isoStr);
            const y = d.getFullYear();
            const mo = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${mo}-${day}`;
          };

          // Single pass through messages: aggregate both daily + byModel
          const dailyMap: Record<string, { inputTokens: number; outputTokens: number; messageCount: number }> = {};
          const byModel: Record<string, {
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheCreationTokens: number;
            count: number;
          }> = {};

          // Track the current user message date for daily bucketing
          for (const s of sessions) {
            const sessionData = getSessionData(s.id);
            if (!sessionData) continue;

            let lastUserDate = toLocalDate(s.createdAt); // fallback date for first assistant msg

            for (const msg of sessionData.messages) {
              if (msg.role === 'user') {
                // Use user message timestamp for the date of this conversation turn
                lastUserDate = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
              } else if (msg.role === 'assistant' && msg.usage) {
                // Daily aggregation: attribute tokens to the date of the preceding user message
                const date = msg.timestamp ? toLocalDate(msg.timestamp) : lastUserDate;
                if (!dailyMap[date]) {
                  dailyMap[date] = { inputTokens: 0, outputTokens: 0, messageCount: 0 };
                }
                dailyMap[date].inputTokens += msg.usage.inputTokens ?? 0;
                dailyMap[date].outputTokens += msg.usage.outputTokens ?? 0;
                dailyMap[date].messageCount++;

                // byModel aggregation
                if (msg.usage.modelUsage) {
                  for (const [model, mu] of Object.entries(msg.usage.modelUsage)) {
                    if (!byModel[model]) {
                      byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                    }
                    byModel[model].inputTokens += mu.inputTokens ?? 0;
                    byModel[model].outputTokens += mu.outputTokens ?? 0;
                    byModel[model].cacheReadTokens += mu.cacheReadTokens ?? 0;
                    byModel[model].cacheCreationTokens += mu.cacheCreationTokens ?? 0;
                    byModel[model].count++;
                  }
                } else {
                  const model = msg.usage.model || 'unknown';
                  if (!byModel[model]) {
                    byModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, count: 0 };
                  }
                  byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
                  byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
                  byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
                  byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
                  byModel[model].count++;
                }
              }
            }
          }

          // Sort daily entries chronologically
          const daily = Object.entries(dailyMap)
            .map(([date, d]) => ({ date, ...d }))
            .sort((a, b) => a.date.localeCompare(b.date));

          return jsonResponse({
            success: true,
            stats: {
              summary: {
                totalSessions,
                messageCount,
                totalInputTokens,
                totalOutputTokens,
                totalCacheReadTokens,
                totalCacheCreationTokens,
              },
              daily,
              byModel,
            },
          });
        } catch (error) {
          console.error('[global-stats] Error:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          }, 500);
        }
      }

      // ============= SESSION API =============

      // GET /sessions - List all sessions or filter by agentDir
      if (pathname === '/sessions' && request.method === 'GET') {
        try {
          const agentDirParam = url.searchParams.get('agentDir');
          const sessions = agentDirParam
            ? getSessionsByAgentDir(agentDirParam)
            : getAllSessionMetadata();
          return jsonResponse({ success: true, sessions });
        } catch (error) {
          console.error('[sessions] Error in GET /sessions:', error);
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error in SessionStore'
          }, 500);
        }
      }

      // POST /sessions - Create a new session
      if (pathname === '/sessions' && request.method === 'POST') {
        let payload: { agentDir: string };
        try {
          payload = (await request.json()) as { agentDir: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const agentDirValue = payload?.agentDir?.trim();
        if (!agentDirValue) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        const session = createSession(agentDirValue);
        return jsonResponse({ success: true, session });
      }

      // GET /sessions/:id/stats - Get detailed session statistics
      // NOTE: This route must be BEFORE /sessions/:id to avoid being caught by the generic route
      if (pathname.match(/^\/sessions\/[^/]+\/stats$/) && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '').replace('/stats', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Group stats by model
        const byModel: Record<string, {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheCreationTokens: number;
          count: number;
        }> = {};

        // Build message details
        const messageDetails: Array<{
          userQuery: string;
          model?: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
          toolCount?: number;
          durationMs?: number;
        }> = [];

        let currentUserQuery = '';
        for (const msg of session.messages) {
          if (msg.role === 'user') {
            currentUserQuery = typeof msg.content === 'string'
              ? msg.content.slice(0, 100)
              : JSON.stringify(msg.content).slice(0, 100);
          } else if (msg.role === 'assistant' && msg.usage) {
            // Use modelUsage for per-model breakdown if available, fallback to single model
            if (msg.usage.modelUsage) {
              for (const [model, stats] of Object.entries(msg.usage.modelUsage)) {
                if (!byModel[model]) {
                  byModel[model] = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                    count: 0,
                  };
                }
                byModel[model].inputTokens += stats.inputTokens ?? 0;
                byModel[model].outputTokens += stats.outputTokens ?? 0;
                byModel[model].cacheReadTokens += stats.cacheReadTokens ?? 0;
                byModel[model].cacheCreationTokens += stats.cacheCreationTokens ?? 0;
                byModel[model].count++;
              }
            } else {
              // Fallback for older messages without modelUsage
              const model = msg.usage.model || 'unknown';
              if (!byModel[model]) {
                byModel[model] = {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  count: 0,
                };
              }
              byModel[model].inputTokens += msg.usage.inputTokens ?? 0;
              byModel[model].outputTokens += msg.usage.outputTokens ?? 0;
              byModel[model].cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
              byModel[model].cacheCreationTokens += msg.usage.cacheCreationTokens ?? 0;
              byModel[model].count++;
            }

            // Message details always use aggregate values
            messageDetails.push({
              userQuery: currentUserQuery,
              model: msg.usage.model,
              inputTokens: msg.usage.inputTokens ?? 0,
              outputTokens: msg.usage.outputTokens ?? 0,
              cacheReadTokens: msg.usage.cacheReadTokens,
              cacheCreationTokens: msg.usage.cacheCreationTokens,
              toolCount: msg.toolCount,
              durationMs: msg.durationMs,
            });
          }
        }

        const metadata = getSessionMetadata(sessionId);
        return jsonResponse({
          success: true,
          stats: {
            summary: metadata?.stats ?? {
              messageCount: 0,
              totalInputTokens: 0,
              totalOutputTokens: 0,
            },
            byModel,
            messageDetails,
          },
        });
      }

      // GET /sessions/:id - Get session details
      if (pathname.startsWith('/sessions/') && request.method === 'GET') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const session = getSessionData(sessionId);
        if (!session) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // If this is the currently active session, merge in-memory messages.
        // In-memory messages include the current turn's in-progress content
        // (thinking, text, tool_use) that hasn't been persisted to disk yet.
        // This is critical for shared Sidecar: when a Tab opens an IM session
        // mid-turn, it needs to see the partial assistant response.
        let mergedMessages = session.messages;
        if (sessionId === getSessionId()) {
          const inMemory = getMessages();
          if (inMemory.length > 0) {
            const diskIds = new Set(session.messages.map(m => m.id));
            const newMessages = inMemory
              .filter(m => !diskIds.has(m.id))
              .map(m => ({
                id: m.id,
                role: m.role,
                content: typeof m.content === 'string' ? m.content : JSON.stringify(stripPlaywrightResults(m.content)),
                timestamp: m.timestamp,
                sdkUuid: m.sdkUuid,
                attachments: m.attachments?.map(a => ({
                  id: a.id,
                  name: a.name,
                  mimeType: a.mimeType,
                  path: a.savedPath ?? a.relativePath ?? '',
                })),
                metadata: m.metadata,
              }));
            if (newMessages.length > 0) {
              mergedMessages = [...session.messages, ...newMessages];
            }
          }
        }

        // Add previewUrl for image attachments
        const sessionWithPreview = {
          ...session,
          messages: mergedMessages.map((msg) => ({
            ...msg,
            attachments: msg.attachments?.map((att) => ({
              ...att,
              previewUrl: att.mimeType.startsWith('image/')
                ? getAttachmentDataUrl(att.path, att.mimeType)
                : undefined,
            })),
          })),
        };

        return jsonResponse({ success: true, session: sessionWithPreview });
      }

      // DELETE /sessions/:id - Delete a session
      if (pathname.startsWith('/sessions/') && request.method === 'DELETE') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        const deleted = deleteSession(sessionId);
        if (!deleted) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true });
      }

      // PATCH /sessions/:id - Update session metadata
      if (pathname.startsWith('/sessions/') && request.method === 'PATCH') {
        const sessionId = pathname.replace('/sessions/', '');
        if (!sessionId) {
          return jsonResponse({ success: false, error: 'Session ID required.' }, 400);
        }

        let payload: { title?: string; titleSource?: 'default' | 'auto' | 'user' };
        try {
          payload = (await request.json()) as { title?: string; titleSource?: 'default' | 'auto' | 'user' };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const updates: Record<string, unknown> = { lastActiveAt: new Date().toISOString() };
        if (payload.title !== undefined) updates.title = String(payload.title).slice(0, 100);
        if (payload.titleSource !== undefined) updates.titleSource = payload.titleSource;

        const updated = updateSessionMetadata(sessionId, updates as Parameters<typeof updateSessionMetadata>[1]);

        if (!updated) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        return jsonResponse({ success: true, session: updated });
      }

      // POST /sessions/switch - Switch to existing session for resume
      if (pathname === '/sessions/switch' && request.method === 'POST') {
        let payload: { sessionId?: string };
        try {
          payload = (await request.json()) as { sessionId?: string };
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        // Stop external runtime subprocess before switching (prevents orphaned processes)
        if (shouldUseExternalRuntime() && isExternalSessionActive()) {
          await stopExternalSession();
        }

        const success = await switchToSession(payload.sessionId);
        if (!success) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }

        // Restore external runtime state for the target session (enables --resume on next message)
        if (shouldUseExternalRuntime()) {
          restoreExternalSessionState(payload.sessionId, agentDir, { type: 'desktop' });
        }

        console.log(`[sessions] Switched to session: ${payload.sessionId}`);
        return jsonResponse({ success: true, sessionId: payload.sessionId });
      }

      // POST /api/generate-session-title - AI-generate a short session title
      // Accepts `rounds` array (3+ QA rounds) for rich context.
      // Also accepts legacy `userMessage`/`assistantReply` for backward compatibility.
      if (pathname === '/api/generate-session-title' && request.method === 'POST') {
        let payload: {
          sessionId: string;
          rounds?: Array<{ user: string; assistant: string }>;
          // Legacy fields (single-round fallback)
          userMessage?: string;
          assistantReply?: string;
          model: string;
          providerEnv?: ProviderEnv;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        if (!payload.sessionId) {
          return jsonResponse({ success: false, error: 'sessionId is required.' }, 400);
        }

        // Build rounds from payload — prefer `rounds` array, fall back to legacy fields
        let rounds: Array<{ user: string; assistant: string }>;
        if (payload.rounds && Array.isArray(payload.rounds) && payload.rounds.length > 0) {
          // Cap to 10 rounds max, validate shape, enforce length limits
          rounds = payload.rounds.slice(0, 10)
            .filter((r: unknown): r is Record<string, unknown> => r !== null && typeof r === 'object')
            .map(r => ({
              user: (typeof r.user === 'string' ? r.user : '').slice(0, 500),
              assistant: (typeof r.assistant === 'string' ? r.assistant : '').slice(0, 500),
            }));
          if (rounds.length === 0) {
            return jsonResponse({ success: false, error: 'rounds must contain valid entries.' }, 400);
          }
        } else if (payload.userMessage) {
          // Legacy single-round format
          rounds = [{
            user: payload.userMessage.slice(0, 1000),
            assistant: (payload.assistantReply || '').slice(0, 1000),
          }];
        } else {
          return jsonResponse({ success: false, error: 'rounds or userMessage is required.' }, 400);
        }

        payload.model = (payload.model || '').slice(0, 200);

        // Skip if session not found or user has manually renamed
        const meta = getSessionMetadata(payload.sessionId);
        if (!meta) {
          return jsonResponse({ success: false, error: 'Session not found.' }, 404);
        }
        if (meta.titleSource === 'user') {
          return jsonResponse({ success: false, skipped: true });
        }

        const title = await generateTitle(
          rounds,
          payload.model || '',
          payload.providerEnv,
        );

        if (title) {
          // Re-check titleSource before writing to prevent TOCTOU race with user rename
          const currentMeta = getSessionMetadata(payload.sessionId);
          if (currentMeta?.titleSource === 'user') {
            return jsonResponse({ success: false, skipped: true });
          }
          updateSessionMetadata(payload.sessionId, { title, titleSource: 'auto' } as Parameters<typeof updateSessionMetadata>[1]);
          return jsonResponse({ success: true, title });
        }

        return jsonResponse({ success: false });
      }

      // ============= END SESSION API =============

      // Switch agent directory at runtime (for browser development mode)
      if (pathname === '/agent/switch' && request.method === 'POST') {
        let payload: SwitchPayload;
        try {
          payload = (await request.json()) as SwitchPayload;
        } catch {
          return jsonResponse({ success: false, error: 'Invalid JSON payload.' }, 400);
        }

        const newDir = payload?.agentDir?.trim();
        if (!newDir) {
          return jsonResponse({ success: false, error: 'agentDir is required.' }, 400);
        }

        // Security: validate the path before allowing access
        const validation = isValidAgentDir(newDir);
        if (!validation.valid) {
          console.warn(`[agent] blocked switch to "${newDir}": ${validation.reason}`);
          return jsonResponse({
            success: false,
            error: validation.reason || 'Invalid directory path'
          }, 403);
        }

        try {
          console.log(`[agent] switch to dir="${newDir}"`);
          currentAgentDir = await ensureAgentDir(newDir);
          await initializeAgent(currentAgentDir, payload.initialPrompt);
          return jsonResponse({
            success: true,
            agentDir: currentAgentDir
          });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      if (pathname === '/agent/dir' && request.method === 'GET') {
        try {
          const info = await buildDirectoryTree(currentAgentDir);
          return jsonResponse(info);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Expand a specific directory (lazy loading for directories marked as loaded: false)
      if (pathname === '/agent/dir/expand' && request.method === 'GET') {
        try {
          const targetPath = url.searchParams.get('path');
          if (!targetPath) {
            return jsonResponse({ error: 'Missing path parameter' }, 400);
          }
          // Security: Validate that targetPath doesn't escape currentAgentDir (prevent path traversal)
          const resolvedTarget = resolve(currentAgentDir, targetPath);
          if (!resolvedTarget.startsWith(currentAgentDir + sep) && resolvedTarget !== currentAgentDir) {
            return jsonResponse({ error: 'Invalid path: access denied' }, 403);
          }
          console.log('[agent] dir/expand:', targetPath);
          const result = await expandDirectory(currentAgentDir, targetPath);
          return jsonResponse(result);
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Search files in workspace for @mention feature
      if (pathname === '/agent/search-files' && request.method === 'GET') {
        try {
          const query = url.searchParams.get('q') ?? '';
          if (!query) {
            return jsonResponse([]);
          }

          // Use glob to search files
          const glob = new Bun.Glob(`**/*${query}*`);
          const results: { path: string; name: string; type: 'file' | 'dir' }[] = [];

          for await (const file of glob.scan({
            cwd: currentAgentDir,
            onlyFiles: false,
            dot: false, // Ignore hidden files
          })) {
            // Skip node_modules, .git, etc.
            if (file.includes('node_modules/') || file.includes('.git/')) {
              continue;
            }

            const fullPath = join(currentAgentDir, file);
            try {
              const stats = await stat(fullPath);
              results.push({
                path: file,
                name: basename(file),
                type: stats.isDirectory() ? 'dir' : 'file',
              });

              // Limit results
              if (results.length >= 20) break;
            } catch {
              // Skip files we can't stat
            }
          }

          return jsonResponse(results);
        } catch (error) {
          console.error('[agent] search-files error:', error);
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Search failed' },
            500
          );
        }
      }

      // Batch check whether paths exist (for inline code path detection in AI output)
      if (pathname === '/agent/check-paths' && request.method === 'POST') {
        try {
          const payload = await request.json() as { paths?: string[] };
          const paths = payload?.paths;
          if (!Array.isArray(paths)) {
            return jsonResponse({ error: 'paths must be an array.' }, 400);
          }
          if (paths.length > 200) {
            return jsonResponse({ error: 'Too many paths (max 200).' }, 400);
          }
          const results: Record<string, { exists: boolean; type: 'file' | 'dir' }> = {};
          for (const p of paths) {
            if (typeof p !== 'string' || !p) {
              results[p] = { exists: false, type: 'file' };
              continue;
            }
            const resolved = resolveReadPath(currentAgentDir, p);
            if (!resolved) {
              results[p] = { exists: false, type: 'file' };
              continue;
            }
            try {
              const s = statSync(resolved);
              results[p] = { exists: true, type: s.isDirectory() ? 'dir' : 'file' };
            } catch {
              results[p] = { exists: false, type: 'file' };
            }
          }
          return jsonResponse({ results });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'check-paths failed' },
            500
          );
        }
      }

      if (pathname === '/agent/download' && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') ?? '';
        if (!relativePath) {
          return jsonResponse({ error: 'Missing path.' }, 400);
        }
        // Get agentDir from query param, fallback to currentAgentDir
        const queryAgentDir = url.searchParams.get('agentDir');
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          return jsonResponse({ error: 'Invalid agentDir.' }, 400);
        }
        const targetDir = queryAgentDir || currentAgentDir;
        const resolvedPath = resolveReadPath(targetDir, relativePath);
        if (!resolvedPath) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
          return jsonResponse({ error: 'File not found.' }, 404);
        }
        const name = basename(resolvedPath);
        // RFC 5987: use filename* with UTF-8 encoding for non-ASCII filenames
        // Bun throws on non-ASCII characters in header values, causing 500 for Chinese filenames
        const encodedName = encodeURIComponent(name);
        return new Response(file, {
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`
          }
        });
      }

      if (pathname === '/agent/file' && request.method === 'GET') {
        const relativePath = url.searchParams.get('path') ?? '';
        if (!relativePath) {
          return jsonResponse({ error: 'Missing path.' }, 400);
        }
        const resolvedPath = resolveReadPath(currentAgentDir, relativePath);
        if (!resolvedPath) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        const file = Bun.file(resolvedPath);
        if (!(await file.exists())) {
          return jsonResponse({ error: 'File not found.' }, 404);
        }
        const name = basename(resolvedPath);
        if (!isPreviewableText(name, file.type)) {
          return jsonResponse({ error: 'File type not supported.' }, 415);
        }
        const size = file.size;
        const maxSize = 512 * 1024;
        if (size > maxSize) {
          return jsonResponse({ error: 'File too large to preview.' }, 413);
        }
        try {
          const content = await file.text();
          return jsonResponse({ content, name, size });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Failed to read file.' },
            500
          );
        }
      }

      // Save file content
      if (pathname === '/agent/save-file' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string; content?: string };
          const relativePath = payload?.path?.trim();
          const content = payload?.content;

          if (!relativePath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          if (content === undefined || content === null) {
            return jsonResponse({ success: false, error: 'content is required.' }, 400);
          }

          const resolvedPath = resolveAgentPath(currentAgentDir, relativePath);
          if (!resolvedPath) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const file = Bun.file(resolvedPath);
          if (!(await file.exists())) {
            return jsonResponse({ success: false, error: 'File not found.' }, 404);
          }

          // Check file size limit (512KB)
          const maxSize = 512 * 1024;
          if (content.length > maxSize) {
            return jsonResponse({ success: false, error: 'Content too large.' }, 413);
          }

          await Bun.write(resolvedPath, content);
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Save failed' },
            500
          );
        }
      }

      if (pathname === '/agent/upload' && request.method === 'POST') {
        const targetParam = url.searchParams.get('path') ?? '';
        const resolvedTarget =
          targetParam ? resolveAgentPath(currentAgentDir, targetParam) : currentAgentDir;
        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid path.' }, 400);
        }
        try {
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];
          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }
          await mkdir(resolvedTarget, { recursive: true });
          const saved: string[] = [];
          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await Bun.write(destination, file);
            saved.push(relative(currentAgentDir, destination));
          }
          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            500
          );
        }
      }

      // Create new file
      if (pathname === '/agent/new-file' && request.method === 'POST') {
        try {
          const payload = await request.json() as { parentDir?: string; name?: string };
          const parentDir = payload?.parentDir?.trim() ?? '';
          const name = payload?.name?.trim();

          if (!name) {
            return jsonResponse({ success: false, error: 'name is required.' }, 400);
          }

          if (name.includes('/') || name.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid file name.' }, 400);
          }

          const resolvedParent = parentDir
            ? resolveAgentPath(currentAgentDir, parentDir)
            : currentAgentDir;
          if (!resolvedParent) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const filePath = join(resolvedParent, name);

          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists.' }, 409);
          }

          await Bun.write(filePath, '');
          return jsonResponse({ success: true, path: relative(currentAgentDir, filePath) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Create failed' },
            500
          );
        }
      }

      // Create new folder
      if (pathname === '/agent/new-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as { parentDir?: string; name?: string };
          const parentDir = payload?.parentDir?.trim() ?? '';
          const name = payload?.name?.trim();

          if (!name) {
            return jsonResponse({ success: false, error: 'name is required.' }, 400);
          }

          if (name.includes('/') || name.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid folder name.' }, 400);
          }

          const resolvedParent = parentDir
            ? resolveAgentPath(currentAgentDir, parentDir)
            : currentAgentDir;
          if (!resolvedParent) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const folderPath = join(resolvedParent, name);

          if (existsSync(folderPath)) {
            return jsonResponse({ success: false, error: 'Folder already exists.' }, 409);
          }

          await mkdir(folderPath, { recursive: true });
          return jsonResponse({ success: true, path: relative(currentAgentDir, folderPath) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Create failed' },
            500
          );
        }
      }

      // Rename file or folder
      if (pathname === '/agent/rename' && request.method === 'POST') {
        try {
          const payload = await request.json() as { oldPath?: string; newName?: string };
          const oldPath = payload?.oldPath?.trim();
          const newName = payload?.newName?.trim();

          if (!oldPath || !newName) {
            return jsonResponse({ success: false, error: 'oldPath and newName are required.' }, 400);
          }

          // Validate newName doesn't contain path separators
          if (newName.includes('/') || newName.includes('\\')) {
            return jsonResponse({ success: false, error: 'Invalid file name.' }, 400);
          }

          const resolvedOld = resolveAgentPath(currentAgentDir, oldPath);
          if (!resolvedOld) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          const parentDir = dirname(resolvedOld);
          const resolvedNew = join(parentDir, newName);

          if (!existsSync(resolvedOld)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          await rename(resolvedOld, resolvedNew);
          return jsonResponse({ success: true, newPath: relative(currentAgentDir, resolvedNew) });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Rename failed' },
            500
          );
        }
      }

      // Move files/folders to a target directory
      if (pathname === '/agent/move' && request.method === 'POST') {
        try {
          const payload = await request.json() as { sourcePaths?: string[]; targetDir?: string };
          const sourcePaths = payload?.sourcePaths;
          const targetDir = payload?.targetDir?.trim() ?? '';

          if (!sourcePaths || !Array.isArray(sourcePaths) || sourcePaths.length === 0) {
            return jsonResponse({ success: false, error: 'sourcePaths is required.' }, 400);
          }

          // Resolve target directory (empty string = workspace root)
          const resolvedTargetDir = targetDir
            ? resolveAgentPath(currentAgentDir, targetDir)
            : currentAgentDir;
          if (!resolvedTargetDir) {
            return jsonResponse({ success: false, error: 'Invalid target directory.' }, 400);
          }
          if (!existsSync(resolvedTargetDir) || !statSync(resolvedTargetDir).isDirectory()) {
            return jsonResponse({ success: false, error: 'Target must be an existing directory.' }, 400);
          }

          const movedFiles: Array<{ oldPath: string; newPath: string }> = [];
          const errors: string[] = [];

          for (const src of sourcePaths) {
            const resolvedSrc = resolveAgentPath(currentAgentDir, src.trim());
            if (!resolvedSrc || !existsSync(resolvedSrc)) {
              errors.push(`Not found: ${src}`);
              continue;
            }

            // Prevent moving a directory into itself or its descendant
            if (resolvedTargetDir === resolvedSrc || resolvedTargetDir.startsWith(resolvedSrc + sep)) {
              errors.push(`Cannot move folder into itself: ${src}`);
              continue;
            }

            // Skip if already in the target directory
            if (dirname(resolvedSrc) === resolvedTargetDir) continue;

            const itemName = basename(resolvedSrc);
            let destination = join(resolvedTargetDir, itemName);

            // Auto-rename on conflict
            if (existsSync(destination)) {
              const ext = extname(itemName);
              const base = ext ? itemName.slice(0, -ext.length) : itemName;
              let counter = 1;
              do {
                destination = join(resolvedTargetDir, `${base} (${counter})${ext}`);
                counter++;
              } while (existsSync(destination));
            }

            await rename(resolvedSrc, destination);
            movedFiles.push({
              oldPath: relative(currentAgentDir, resolvedSrc),
              newPath: relative(currentAgentDir, destination),
            });
          }

          return jsonResponse({ success: true, movedFiles, errors: errors.length > 0 ? errors : undefined });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Move failed' },
            500
          );
        }
      }

      // Delete file or folder
      if (pathname === '/agent/delete' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string };
          const targetPath = payload?.path?.trim();

          if (!targetPath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          const resolved = resolveAgentPath(currentAgentDir, targetPath);
          if (!resolved) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          if (!existsSync(resolved)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          await rm(resolved, { recursive: true, force: true });
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Delete failed' },
            500
          );
        }
      }

      // Open in Finder/Explorer
      if (pathname === '/agent/open-in-finder' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string; agentDir?: string };
          const targetPath = payload?.path?.trim();

          if (!targetPath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          // Use provided agentDir or fall back to currentAgentDir
          const effectiveAgentDir = payload?.agentDir || currentAgentDir;
          const resolved = resolveReadPath(effectiveAgentDir, targetPath);
          if (!resolved) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          if (!existsSync(resolved)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          // Use 'open -R' on macOS to reveal in Finder, 'explorer /select' on Windows
          const isMac = process.platform === 'darwin';
          const isWin = process.platform === 'win32';

          if (isMac) {
            Bun.spawn(['open', '-R', resolved]);
          } else if (isWin) {
            Bun.spawn(['explorer', '/select,', resolved]);
          } else {
            // Linux: open parent directory
            Bun.spawn(['xdg-open', dirname(resolved)]);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to open' },
            500
          );
        }
      }

      // Open file with system default application
      if (pathname === '/agent/open-with-default' && request.method === 'POST') {
        try {
          const payload = await request.json() as { path?: string; agentDir?: string };
          const targetPath = payload?.path?.trim();

          if (!targetPath) {
            return jsonResponse({ success: false, error: 'path is required.' }, 400);
          }

          const effectiveAgentDir = payload?.agentDir || currentAgentDir;
          const resolved = resolveReadPath(effectiveAgentDir, targetPath);
          if (!resolved) {
            return jsonResponse({ success: false, error: 'Invalid path.' }, 400);
          }

          if (!existsSync(resolved)) {
            return jsonResponse({ success: false, error: 'File not found.' }, 404);
          }

          const isMac = process.platform === 'darwin';
          const isWin = process.platform === 'win32';

          if (isMac) {
            Bun.spawn(['open', resolved]);
          } else if (isWin) {
            // Use PowerShell Start-Process to avoid cmd /c shell interpretation
            // which could treat & | > in filenames as command operators
            Bun.spawn(['powershell', '-NoProfile', '-Command', `Start-Process -FilePath '${resolved.replace(/'/g, "''")}'`]);
          } else {
            Bun.spawn(['xdg-open', resolved]);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to open' },
            500
          );
        }
      }

      // Open absolute path in Finder/Explorer (for user-level skills/commands)
      if (pathname === '/agent/open-path' && request.method === 'POST') {
        try {
          const payload = await request.json() as { fullPath?: string };
          const fullPath = payload?.fullPath?.trim();

          if (!fullPath) {
            return jsonResponse({ success: false, error: 'fullPath is required.' }, 400);
          }

          // Security: Only allow paths under home directory or temp directories
          const homeDir = getHomeDirOrNull() || '';
          const resolvedPath = resolve(fullPath);
          // Cross-platform path comparison: case-insensitive on Windows (drive letter casing)
          const ci = process.platform === 'win32';
          const pathEq = (a: string, b: string) => ci ? a.toLowerCase() === b.toLowerCase() : a === b;
          const pathStartsWith = (p: string, prefix: string) => ci ? p.toLowerCase().startsWith(prefix.toLowerCase()) : p.startsWith(prefix);
          const isUnderHome = homeDir && (pathStartsWith(resolvedPath, homeDir + sep) || pathEq(resolvedPath, homeDir));
          const systemTmpDir = tmpdir();
          const isUnderTmp = pathStartsWith(resolvedPath, systemTmpDir + sep) || pathEq(resolvedPath, systemTmpDir);
          if (!isUnderHome && !isUnderTmp) {
            return jsonResponse({ success: false, error: 'Path not allowed.' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'File or folder not found.' }, 404);
          }

          const isMac = process.platform === 'darwin';
          const isWin = process.platform === 'win32';

          if (isMac) {
            Bun.spawn(['open', '-R', resolvedPath]);
          } else if (isWin) {
            Bun.spawn(['explorer', '/select,', resolvedPath]);
          } else {
            Bun.spawn(['xdg-open', dirname(resolvedPath)]);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to open' },
            500
          );
        }
      }

      // Import files to a specific directory
      if (pathname === '/agent/import' && request.method === 'POST') {
        const targetDir = url.searchParams.get('targetDir') ?? '';
        const resolvedTarget = targetDir ? resolveAgentPath(currentAgentDir, targetDir) : currentAgentDir;

        if (!resolvedTarget) {
          return jsonResponse({ error: 'Invalid target directory.' }, 400);
        }

        try {
          const formData = await request.formData();
          const files = Array.from(formData.values()).filter(
            (value) => typeof value !== 'string'
          ) as File[];

          if (files.length === 0) {
            return jsonResponse({ error: 'No files provided.' }, 400);
          }

          await mkdir(resolvedTarget, { recursive: true });
          const saved: string[] = [];

          for (const file of files) {
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
            const destination = join(resolvedTarget, safeName);
            await Bun.write(destination, file);
            saved.push(relative(currentAgentDir, destination));
          }

          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          return jsonResponse(
            { error: error instanceof Error ? error.message : 'Import failed' },
            500
          );
        }
      }

      // ============= FILE MANAGEMENT API =============

      // POST /api/files/import-base64 - Import files via base64 encoding (works in Tauri)
      if (pathname === '/api/files/import-base64' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            files: Array<{ name: string; content: string }>; // content is base64 encoded
            targetDir?: string;
          };

          const { files, targetDir = '' } = payload;

          if (!files || files.length === 0) {
            return jsonResponse({ success: false, error: 'No files provided' }, 400);
          }

          const resolvedTarget = targetDir
            ? resolveAgentPath(currentAgentDir, targetDir)
            : currentAgentDir;

          if (!resolvedTarget) {
            return jsonResponse({ success: false, error: 'Invalid target directory' }, 400);
          }

          // Ensure target directory exists
          await mkdir(resolvedTarget, { recursive: true });

          const saved: string[] = [];

          for (const file of files) {
            // Sanitize filename
            const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');

            // Generate unique name if file exists
            let finalName = safeName;
            let counter = 1;
            const ext = extname(safeName);
            const base = basename(safeName, ext);
            while (existsSync(join(resolvedTarget, finalName))) {
              finalName = `${base}_${counter}${ext}`;
              counter++;
            }

            const destination = join(resolvedTarget, finalName);

            // Decode base64 and write file
            const buffer = Buffer.from(file.content, 'base64');
            await Bun.write(destination, buffer);

            saved.push(relative(currentAgentDir, destination));
          }

          return jsonResponse({ success: true, files: saved });
        } catch (error) {
          console.error('[api/files/import-base64] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Import failed' },
            500
          );
        }
      }

      // POST /api/files/copy - Copy external files to workspace
      if (pathname === '/api/files/copy' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            sourcePaths: string[];
            targetDir: string;
            autoRename?: boolean;
          };

          const { sourcePaths, targetDir, autoRename = true } = payload;

          if (!sourcePaths || sourcePaths.length === 0) {
            return jsonResponse({ success: false, error: 'sourcePaths is required' }, 400);
          }

          const resolvedTarget = targetDir
            ? resolveAgentPath(currentAgentDir, targetDir)
            : currentAgentDir;

          if (!resolvedTarget) {
            return jsonResponse({ success: false, error: 'Invalid target directory' }, 400);
          }

          // Ensure target directory exists
          await mkdir(resolvedTarget, { recursive: true });

          const copiedFiles: Array<{ sourcePath: string; targetPath: string; renamed: boolean }> = [];

          // Helper function to generate unique filename
          const getUniqueName = (dir: string, name: string): { name: string; renamed: boolean } => {
            const ext = extname(name);
            const base = basename(name, ext);
            let finalName = name;
            let counter = 1;
            let renamed = false;

            while (existsSync(join(dir, finalName))) {
              if (!autoRename) {
                throw new Error(`File ${name} already exists`);
              }
              finalName = `${base}_${counter}${ext}`;
              counter++;
              renamed = true;
            }

            return { name: finalName, renamed };
          };

          // Helper function to copy directory recursively
          const copyDirectory = async (src: string, dest: string) => {
            await mkdir(dest, { recursive: true });
            const entries = readdirSync(src, { withFileTypes: true });

            for (const entry of entries) {
              const srcPath = join(src, entry.name);
              const destPath = join(dest, entry.name);

              if (entry.isDirectory()) {
                await copyDirectory(srcPath, destPath);
              } else {
                const file = Bun.file(srcPath);
                await Bun.write(destPath, file);
              }
            }
          };

          for (const sourcePath of sourcePaths) {
            // Validate source path exists
            if (!existsSync(sourcePath)) {
              console.warn(`[api/files/copy] Source not found: ${sourcePath}`);
              continue;
            }

            const sourceInfo = await stat(sourcePath);
            const sourceName = basename(sourcePath);

            if (sourceInfo.isDirectory()) {
              // Copy directory
              const { name: uniqueName, renamed } = getUniqueName(resolvedTarget, sourceName);
              const destPath = join(resolvedTarget, uniqueName);
              await copyDirectory(sourcePath, destPath);
              copiedFiles.push({
                sourcePath,
                targetPath: relative(currentAgentDir, destPath),
                renamed,
              });
            } else {
              // Copy file
              const { name: uniqueName, renamed } = getUniqueName(resolvedTarget, sourceName);
              const destPath = join(resolvedTarget, uniqueName);
              const file = Bun.file(sourcePath);
              await Bun.write(destPath, file);
              copiedFiles.push({
                sourcePath,
                targetPath: relative(currentAgentDir, destPath),
                renamed,
              });
            }
          }

          return jsonResponse({ success: true, copiedFiles });
        } catch (error) {
          console.error('[api/files/copy] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Copy failed' },
            500
          );
        }
      }

      // POST /api/files/add-gitignore - Add pattern to .gitignore
      if (pathname === '/api/files/add-gitignore' && request.method === 'POST') {
        try {
          const payload = await request.json() as { pattern: string };
          const { pattern } = payload;

          if (!pattern || typeof pattern !== 'string') {
            return jsonResponse({ success: false, error: 'pattern is required' }, 400);
          }

          const gitignorePath = join(currentAgentDir, '.gitignore');

          // Check if .gitignore exists
          if (!existsSync(gitignorePath)) {
            // Create new .gitignore with the pattern
            writeFileSync(gitignorePath, `${pattern}\n`);
            return jsonResponse({ success: true, added: true, reason: 'created new .gitignore' });
          }

          // Read existing content
          const content = readFileSync(gitignorePath, 'utf-8');
          const lines = content.split('\n');

          // Check if pattern already exists
          const trimmedPattern = pattern.trim();
          const patternExists = lines.some(line => line.trim() === trimmedPattern);

          if (patternExists) {
            return jsonResponse({ success: true, added: false, reason: 'pattern already exists' });
          }

          // Append pattern to .gitignore
          const newContent = content.endsWith('\n')
            ? `${content}${pattern}\n`
            : `${content}\n${pattern}\n`;

          writeFileSync(gitignorePath, newContent);
          return jsonResponse({ success: true, added: true });
        } catch (error) {
          console.error('[api/files/add-gitignore] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update .gitignore' },
            500
          );
        }
      }

      // POST /api/files/read-as-base64 - Read external files and return as base64 (for Tauri image drops)
      if (pathname === '/api/files/read-as-base64' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            paths: string[];
          };

          const { paths } = payload;

          if (!paths || paths.length === 0) {
            return jsonResponse({ success: false, error: 'paths is required' }, 400);
          }

          const results: Array<{
            path: string;
            name: string;
            mimeType: string;
            data: string; // base64
            error?: string;
          }> = [];

          for (const filePath of paths) {
            try {
              // Validate file exists
              if (!existsSync(filePath)) {
                results.push({
                  path: filePath,
                  name: basename(filePath),
                  mimeType: '',
                  data: '',
                  error: 'File not found',
                });
                continue;
              }

              // Check file size (limit to 10MB for images)
              const fileInfo = await stat(filePath);
              if (fileInfo.size > 10 * 1024 * 1024) {
                results.push({
                  path: filePath,
                  name: basename(filePath),
                  mimeType: '',
                  data: '',
                  error: 'File too large (max 10MB)',
                });
                continue;
              }

              // Read file
              const file = Bun.file(filePath);
              const arrayBuffer = await file.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString('base64');

              // Determine MIME type from extension
              const ext = extname(filePath).toLowerCase().slice(1);
              const mimeTypes: Record<string, string> = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                webp: 'image/webp',
                svg: 'image/svg+xml',
                bmp: 'image/bmp',
                ico: 'image/x-icon',
              };
              const mimeType = mimeTypes[ext] || file.type || 'application/octet-stream';

              results.push({
                path: filePath,
                name: basename(filePath),
                mimeType,
                data: base64,
              });
            } catch (err) {
              results.push({
                path: filePath,
                name: basename(filePath),
                mimeType: '',
                data: '',
                error: err instanceof Error ? err.message : 'Read failed',
              });
            }
          }

          return jsonResponse({ success: true, files: results });
        } catch (error) {
          console.error('[api/files/read-as-base64] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Read failed' },
            500
          );
        }
      }

      // GET /api/image?path=... - Serve generated images (for browser dev mode)
      if (pathname === '/api/image' && request.method === 'GET') {
        try {
          const imagePath = url.searchParams.get('path');
          if (!imagePath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/pm-copilot-generated/images/ or legacy ~/.pm-copilot/generated/
          const resolvedPath = resolve(imagePath);
          const legacyDir = join(homedir(), '.pm-copilot', 'generated');
          const workspaceDir = currentAgentDir ? join(currentAgentDir, 'pm-copilot-generated', 'images') : '';
          const legacyDirSep = legacyDir.endsWith(sep) ? legacyDir : legacyDir + sep;
          const workspaceDirSep = workspaceDir ? (workspaceDir.endsWith(sep) ? workspaceDir : workspaceDir + sep) : '';
          const allowed = resolvedPath.startsWith(legacyDirSep)
            || (workspaceDirSep && resolvedPath.startsWith(workspaceDirSep));
          if (!allowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Image not found' }, 404);
          }

          const file = Bun.file(resolvedPath);
          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';

          return new Response(file, {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'public, max-age=86400',
            },
          });
        } catch (error) {
          console.error('[api/image] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve image' },
            500
          );
        }
      }

      // GET /api/audio?path=... - Serve generated audio (for browser dev mode)
      if (pathname === '/api/audio' && request.method === 'GET') {
        try {
          const audioPath = url.searchParams.get('path');
          if (!audioPath) {
            return jsonResponse({ success: false, error: 'Missing path parameter' }, 400);
          }

          // Security: allow reading from workspace/pm-copilot-generated/audio/ or legacy ~/.pm-copilot/generated_audio/
          const resolvedPath = resolve(audioPath);
          const legacyAudioDir = join(homedir(), '.pm-copilot', 'generated_audio');
          const workspaceAudioDir = currentAgentDir ? join(currentAgentDir, 'pm-copilot-generated', 'audio') : '';
          const legacyAudioDirSep = legacyAudioDir.endsWith(sep) ? legacyAudioDir : legacyAudioDir + sep;
          const workspaceAudioDirSep = workspaceAudioDir ? (workspaceAudioDir.endsWith(sep) ? workspaceAudioDir : workspaceAudioDir + sep) : '';
          const audioAllowed = resolvedPath.startsWith(legacyAudioDirSep)
            || (workspaceAudioDirSep && resolvedPath.startsWith(workspaceAudioDirSep));
          if (!audioAllowed) {
            return jsonResponse({ success: false, error: 'Access denied: path must be within generated_audio directory' }, 403);
          }

          if (!existsSync(resolvedPath)) {
            return jsonResponse({ success: false, error: 'Audio not found' }, 404);
          }

          const file = Bun.file(resolvedPath);
          const ext = resolvedPath.split('.').pop()?.toLowerCase();
          const mimeTypes: Record<string, string> = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            webm: 'audio/webm',
            opus: 'audio/opus',
            aac: 'audio/aac',
            m4a: 'audio/mp4',
          };
          const mimeType = mimeTypes[ext || ''] || 'audio/mpeg';

          return new Response(file, {
            headers: {
              'Content-Type': mimeType,
              'Cache-Control': 'public, max-age=86400',
            },
          });
        } catch (error) {
          console.error('[api/audio] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to serve audio' },
            500
          );
        }
      }

      // POST /api/edge-tts/preview - Preview TTS from Settings (independent of MCP server state)
      if (pathname === '/api/edge-tts/preview' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            text?: string;
            voice?: string;
            rate?: string;
            volume?: string;
            pitch?: string;
            outputFormat?: string;
          };

          if (!body.text?.trim()) {
            return jsonResponse({ success: false, error: 'Missing text parameter' }, 400);
          }

          // Apply same text length limit as the MCP tool
          if (body.text.length > 10000) {
            return jsonResponse({ success: false, error: `Text too long (${body.text.length} chars). Maximum is 10000.` }, 400);
          }

          const { synthesizePreview } = await import('./tools/edge-tts-tool');
          const result = await synthesizePreview({
            text: body.text,
            voice: body.voice || 'zh-CN-XiaoxiaoNeural',
            rate: body.rate || '0%',
            volume: body.volume || '0%',
            pitch: body.pitch || '+0Hz',
            outputFormat: body.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
          });

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/edge-tts/preview] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Preview failed' },
            500
          );
        }
      }

      // ============= END FILE MANAGEMENT API =============

      // ============= UNIFIED LOGGING API =============

      // POST /api/unified-log - Receive frontend logs for persistence
      if (pathname === '/api/unified-log' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            entries?: Array<{
              source: 'react' | 'bun' | 'rust';
              level: 'info' | 'warn' | 'error' | 'debug';
              message: string;
              timestamp: string;
            }>;
          };

          if (payload.entries && Array.isArray(payload.entries)) {
            appendUnifiedLogBatch(payload.entries);
          }

          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to log'
          }, 500);
        }
      }

      // GET /api/logs/export - Export recent unified logs as zip
      if (pathname === '/api/logs/export' && request.method === 'GET') {
        try {
          const { readdirSync, statSync } = await import('fs');
          const { join: joinPath } = await import('path');
          const { homedir } = await import('os');
          const logsDir = joinPath(homedir(), '.pm-copilot', 'logs');

          // Collect last 3 days of unified-*.log files
          const now = Date.now();
          const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
          const files = readdirSync(logsDir)
            .filter(f => f.startsWith('unified-') && f.endsWith('.log'))
            .filter(f => {
              try {
                return now - statSync(joinPath(logsDir, f)).mtimeMs < threeDaysMs;
              } catch { return false; }
            })
            .sort();

          if (files.length === 0) {
            return jsonResponse({ success: false, error: '没有找到近3天的运行日志' }, 404);
          }

          // Output to Desktop
          const desktopDir = joinPath(homedir(), 'Desktop');
          const timestamp = new Date().toISOString().slice(0, 10);
          const zipName = `PM Copilot-logs-${timestamp}.zip`;
          const zipPath = joinPath(desktopDir, zipName);

          // Create zip using platform-appropriate command
          const isWin = process.platform === 'win32';
          const filePaths = files.map(f => joinPath(logsDir, f));

          if (isWin) {
            // PowerShell Compress-Archive
            const proc = Bun.spawn(['powershell', '-Command',
              `Compress-Archive -Path '${filePaths.join("','")}' -DestinationPath '${zipPath}' -Force`
            ]);
            await proc.exited;
          } else {
            // macOS/Linux: zip command
            const proc = Bun.spawn(['zip', '-j', zipPath, ...filePaths]);
            await proc.exited;
          }

          return jsonResponse({ success: true, path: zipPath });
        } catch (error) {
          return jsonResponse({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to export logs'
          }, 500);
        }
      }

      // ============= PROVIDER VERIFICATION API =============

      // POST /api/provider/verify - Verify API key via SDK (same path as normal chat)
      if (pathname === '/api/provider/verify' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            baseUrl?: string;
            apiKey?: string;
            model?: string;
            authType?: string;
            apiProtocol?: string;
            maxOutputTokens?: number;
            maxOutputTokensParamName?: string;
            upstreamFormat?: string;
          };

          const { baseUrl, apiKey, model, authType, apiProtocol, maxOutputTokens, maxOutputTokensParamName, upstreamFormat } = payload;

          if (!baseUrl || !apiKey) {
            return jsonResponse({ success: false, error: 'baseUrl and apiKey are required.' }, 400);
          }

          console.log(`[api/provider/verify] =========================`);
          console.log(`[api/provider/verify] baseUrl: ${baseUrl}`);
          console.log(`[api/provider/verify] apiKey: ${apiKey.slice(0, 10)}...`);
          console.log(`[api/provider/verify] model: ${model ?? 'default'}`);
          console.log(`[api/provider/verify] authType: ${authType ?? 'both'}`);
          console.log(`[api/provider/verify] apiProtocol: ${apiProtocol ?? 'anthropic'}`);
          console.log(`[api/provider/verify] maxOutputTokens: ${maxOutputTokens ?? 'none'}`);

          // Unified SDK verification for all protocols (Anthropic + OpenAI)
          // For OpenAI protocol: SDK → CLI → bridge loopback → upstream (end-to-end)
          // For Anthropic protocol: SDK → CLI → upstream (same as before)
          const result = await verifyProviderViaSdk(
            baseUrl, apiKey, authType ?? 'both', model || undefined,
            apiProtocol === 'openai' ? 'openai' : undefined,
            maxOutputTokens,
            maxOutputTokensParamName as 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | undefined,
            upstreamFormat === 'responses' ? 'responses' : undefined,
          );

          console.log(`[api/provider/verify] result:`, JSON.stringify(result));
          console.log(`[api/provider/verify] =========================`);

          return jsonResponse(result);
        } catch (error) {
          console.error('[api/provider/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // GET /api/subscription/status - Check Anthropic local subscription status
      if (pathname === '/api/subscription/status' && request.method === 'GET') {
        try {
          const status = checkAnthropicSubscription();
          return jsonResponse(status);
        } catch (error) {
          console.error('[api/subscription/status] Error:', error);
          return jsonResponse(
            { available: false, error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/subscription/verify - Verify Anthropic subscription by sending test request via SDK
      if (pathname === '/api/subscription/verify' && request.method === 'POST') {
        try {
          console.log('[api/subscription/verify] Starting verification...');
          const result = await verifySubscription();
          console.log('[api/subscription/verify] Result:', JSON.stringify(result));
          return jsonResponse(result);
        } catch (error) {
          console.error('[api/subscription/verify] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Verification failed' },
            500
          );
        }
      }

      // GET /api/git/branch - Get current git branch for the workspace
      if (pathname === '/api/git/branch' && request.method === 'GET') {
        try {
          const branch = getGitBranch(currentAgentDir);
          return jsonResponse({ branch: branch || null });
        } catch (error) {
          console.error('[api/git/branch] Error:', error);
          return jsonResponse({ branch: null }, 200); // Non-fatal, just return null
        }
      }

      // GET /api/assets/qr-code - Fetch QR code image with local caching
      // Downloads from CDN on first launch and caches locally for subsequent requests
      // Cache refreshes every hour to get updated QR codes from cloud
      if (pathname === '/api/assets/qr-code' && request.method === 'GET') {
        try {
          const QR_CODE_URL = 'https://download.pm-copilot.io/assets/feedback_qr_code.png';

          // Use tmpdir for cache (simple and safe approach)
          const CACHE_DIR = join(tmpdir(), 'pm-copilot-cache');
          const CACHE_FILE = join(CACHE_DIR, 'feedback_qr_code.png');
          const LOCK_FILE = `${CACHE_FILE}.lock`;
          const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour (faster updates)

          const startTime = Date.now();
          let needsDownload = true;

          // Check if cached file exists and is fresh
          if (existsSync(CACHE_FILE)) {
            const stats = statSync(CACHE_FILE);
            const age = Date.now() - stats.mtimeMs;
            if (age < CACHE_MAX_AGE_MS) {
              needsDownload = false;
              console.log(`[api/assets/qr-code] Cache hit (age: ${Math.round(age / 1000 / 60)}min)`);
            } else {
              console.log(`[api/assets/qr-code] Cache expired (age: ${Math.round(age / 1000 / 60)}min), re-downloading`);
            }
          } else {
            console.log('[api/assets/qr-code] Cache miss, downloading');
          }

          // Download if needed (with file lock to prevent concurrent writes)
          if (needsDownload) {
            // Check if another process is already downloading
            if (existsSync(LOCK_FILE)) {
              const lockStats = statSync(LOCK_FILE);
              const lockAge = Date.now() - lockStats.mtimeMs;
              if (lockAge < 30000) { // Lock valid for 30s
                console.log('[api/assets/qr-code] Download in progress, waiting...');
                // Wait and use existing cache if available
                if (existsSync(CACHE_FILE)) {
                  const imageBuffer = readFileSync(CACHE_FILE);
                  const base64 = imageBuffer.toString('base64');
                  return jsonResponse({
                    success: true,
                    dataUrl: `data:image/png;base64,${base64}`
                  });
                }
              } else {
                // Stale lock, remove it
                rmSync(LOCK_FILE, { force: true });
              }
            }

            // Acquire lock
            if (!existsSync(CACHE_DIR)) {
              mkdirSync(CACHE_DIR, { recursive: true });
            }
            writeFileSync(LOCK_FILE, String(Date.now()));

            try {
              const downloadStartTime = Date.now();
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

              const response = await fetch(QR_CODE_URL, { signal: controller.signal });
              clearTimeout(timeoutId);

              if (!response.ok) {
                // If download fails but cache exists, use stale cache
                if (existsSync(CACHE_FILE)) {
                  console.warn(`[api/assets/qr-code] Download failed (HTTP ${response.status}), using stale cache`);
                } else {
                  throw new Error(`下载失败: HTTP ${response.status}`);
                }
              } else {
                // Save to cache using atomic write pattern
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const downloadTime = Date.now() - downloadStartTime;

                // Write to temp file first
                const tmpFile = `${CACHE_FILE}.${Date.now()}.tmp`;
                writeFileSync(tmpFile, buffer);

                // Atomic rename (POSIX guarantee)
                renameSync(tmpFile, CACHE_FILE);
                console.log(`[api/assets/qr-code] Downloaded and cached (${Math.round(buffer.length / 1024)}KB in ${downloadTime}ms)`);
              }
            } finally {
              // Release lock
              rmSync(LOCK_FILE, { force: true });
            }
          }

          // Read from cache and return as base64
          if (!existsSync(CACHE_FILE)) {
            return jsonResponse({ success: false, error: 'QR code not available' }, 503);
          }

          const imageBuffer = readFileSync(CACHE_FILE);
          const base64 = imageBuffer.toString('base64');
          const mimeType = 'image/png';
          const totalTime = Date.now() - startTime;

          console.log(`[api/assets/qr-code] Request completed in ${totalTime}ms`);

          return jsonResponse({
            success: true,
            dataUrl: `data:${mimeType};base64,${base64}`
          });
        } catch (error) {
          console.error('[api/assets/qr-code] Error:', error);
          const isTimeout = error instanceof Error && error.name === 'AbortError';
          return jsonResponse(
            { success: false, error: isTimeout ? '网络请求超时' : (error instanceof Error ? error.message : '加载失败') },
            isTimeout ? 504 : 503
          );
        }
      }

      // ============= END PROVIDER VERIFICATION API =============

      // ============= PROXY API =============

      // POST /api/proxy/set - Hot-reload proxy config into this Sidecar process
      if (pathname === '/api/proxy/set' && request.method === 'POST') {
        try {
          const payload = await request.json();
          setProxyConfig(payload);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/proxy/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set proxy config' },
            500
          );
        }
      }

      // ============= MCP API =============

      // POST /api/mcp/set - Set MCP servers for current workspace
      if (pathname === '/api/mcp/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { servers?: McpServerDefinition[] };
          const servers = payload?.servers ?? [];
          setMcpServers(servers);
          return jsonResponse({ success: true, servers: servers.map(s => s.id) });
        } catch (error) {
          console.error('[api/mcp/set] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },
            500
          );
        }
      }

      // GET /api/mcp - Get current MCP servers
      if (pathname === '/api/mcp' && request.method === 'GET') {
        try {
          const servers = getMcpServers();
          return jsonResponse({ success: true, servers });
        } catch (error) {
          console.error('[api/mcp] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get MCP servers' },
            500
          );
        }
      }

      // POST /api/mcp/enable - Validate and enable MCP server
      // For preset MCP (npx): warmup npm/npx cache (system npx → bundled npx → bun x)
      // For custom MCP: check if command exists
      if (pathname === '/api/mcp/enable' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            server: McpServerDefinition;
          };

          const server = payload.server;
          if (!server) {
            return jsonResponse({ success: false, error: 'Missing server' }, 400);
          }

          console.log(`[api/mcp/enable] Enabling MCP: ${server.id}, type: ${server.type}, command: ${server.command}`);

          // Built-in MCP (in-process) — delegate validation to registry
          if (server.command === '__builtin__') {
            const entry = getBuiltinMcp(server.id);
            if (entry?.validate) {
              const error = await entry.validate(server.env || {});
              if (error) {
                return jsonResponse({ success: false, error });
              }
            }
            console.log(`[api/mcp/enable] Built-in MCP: ${server.id} — enabled`);
            return jsonResponse({ success: true });
          }

          // SSE/HTTP types: validate remote URL is reachable and protocol matches
          if (server.type === 'sse' || server.type === 'http') {
            if (!server.url) {
              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message: '缺少服务器 URL' }
              });
            }

            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 15000);

              const headers: Record<string, string> = {
                // Streamable HTTP 规范要求同时声明两种格式；SSE 只需 event-stream
                'Accept': server.type === 'sse' ? 'text/event-stream' : 'application/json, text/event-stream',
                // Request uncompressed response to avoid ZlibError.
                // Some servers (e.g., behind WAF/CDN like Huawei Cloud) return
                // content-encoding: gzip with a non-compressed body, causing Bun's
                // fetch() auto-decompression to crash. Validation doesn't need compression.
                'Accept-Encoding': 'identity',
                ...(server.headers || {}),
              };

              let response: Response;

              if (server.type === 'http') {
                // Streamable HTTP: send MCP initialize JSON-RPC request
                response = await fetch(server.url, {
                  method: 'POST',
                  headers: { ...headers, 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                      protocolVersion: '2025-03-26',
                      capabilities: {},
                      clientInfo: { name: 'PM Copilot', version: '0.1.29' },
                    },
                  }),
                  signal: controller.signal,
                });
              } else {
                // SSE: send GET request to check if endpoint is reachable
                response = await fetch(server.url, {
                  method: 'GET',
                  headers,
                  signal: controller.signal,
                });
              }

              clearTimeout(timeout);

              // Helper: abort the underlying connection to prevent resource leaks
              // (especially important for SSE — the response is an infinite stream).
              const cleanup = () => { try { controller.abort(); } catch { /* ignore abort errors */ } };

              // Check HTTP status
              if (response.status === 401 || response.status === 403) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `认证失败 (HTTP ${response.status})，请检查 Headers 配置`,
                  }
                });
              }

              if (response.status === 404) {
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `端点不存在 (HTTP 404)，请检查 URL 是否正确`,
                  }
                });
              }

              if (response.status === 405) {
                // 405 Method Not Allowed: protocol mismatch
                cleanup();
                const hint = server.type === 'sse'
                  ? '。该端点不支持 GET，可能是 Streamable HTTP 端点，请尝试切换传输协议'
                  : '。该端点不支持 POST，可能是 SSE 端点，请尝试切换传输协议';
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `请求方法不被允许 (HTTP 405)${hint}`,
                  }
                });
              }

              if (!response.ok) {
                // 尝试读取 response body 以获取更具体的错误信息
                let detail = '';
                try {
                  const body = await response.json() as Record<string, unknown>;
                  const raw = String(body.message || body.msg || body.error || '');
                  detail = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
                } catch { /* body 不是 JSON，忽略 */ }
                cleanup();
                return jsonResponse({
                  success: false,
                  error: {
                    type: 'connection_failed',
                    message: `服务器返回错误 (HTTP ${response.status})${detail ? '：' + detail : ''}`,
                  }
                });
              }

              // Protocol-specific validation
              const contentType = response.headers.get('content-type') || '';

              if (server.type === 'sse') {
                // SSE validation only needs headers — abort the infinite stream immediately
                cleanup();

                // SSE endpoint should return text/event-stream
                if (!contentType.includes('text/event-stream')) {
                  // If the URL returns JSON, it's likely a Streamable HTTP endpoint
                  const hint = contentType.includes('application/json') || contentType.includes('text/html')
                    ? '。该 URL 可能是 Streamable HTTP 端点，请尝试切换传输协议为 "Streamable HTTP"'
                    : '';
                  return jsonResponse({
                    success: false,
                    error: {
                      type: 'connection_failed',
                      message: `服务器返回的内容类型不是 SSE (${contentType || 'unknown'})${hint}`,
                    }
                  });
                }
              } else {
                // Streamable HTTP: server may respond with JSON or SSE (both valid per spec)
                // (response.ok is guaranteed here — non-ok statuses returned above)
                if (contentType.includes('text/event-stream')) {
                  // SSE response to POST — valid per MCP Streamable HTTP spec.
                  // Read enough to extract the first JSON-RPC message from SSE data lines.
                  try {
                    const text = await response.text();
                    cleanup();
                    const dataLine = text.split('\n').find(l => l.startsWith('data:'));
                    if (dataLine) {
                      const body = JSON.parse(dataLine.slice(5));
                      if (!body.jsonrpc && !body.result && !body.error) {
                        return jsonResponse({
                          success: false,
                          error: {
                            type: 'connection_failed',
                            message: '服务器 SSE 响应中的数据不是有效的 JSON-RPC 格式',
                          }
                        });
                      }
                    }
                    // SSE stream with valid data or empty (server might send events later) — accept
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: '无法解析服务器的 SSE 响应，请检查 URL 和传输协议',
                      }
                    });
                  }
                } else {
                  // JSON response — original path
                  try {
                    const body = await response.json();
                    cleanup();
                    if (!body.jsonrpc && !body.result && !body.error) {
                      return jsonResponse({
                        success: false,
                        error: {
                          type: 'connection_failed',
                          message: '服务器响应不是有效的 JSON-RPC 格式，请检查 URL 和传输协议',
                        }
                      });
                    }
                  } catch {
                    cleanup();
                    return jsonResponse({
                      success: false,
                      error: {
                        type: 'connection_failed',
                        message: `服务器响应不是有效的 JSON 格式 (${contentType || 'unknown'})`,
                      }
                    });
                  }
                }
              }

              console.log(`[api/mcp/enable] Remote MCP validated: ${server.id} (${server.type}) → ${server.url}`);
              return jsonResponse({ success: true });

            } catch (err: unknown) {
              const error = err instanceof Error ? err : new Error(String(err));
              console.error(`[api/mcp/enable] Remote MCP validation failed: ${server.id}`, error.message);

              let message: string;
              if (error.name === 'AbortError') {
                message = '连接超时（15秒），请检查 URL 是否正确或服务器是否可达';
              } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
                message = 'DNS 解析失败，请检查 URL 域名是否正确';
              } else if (error.message.includes('ECONNREFUSED')) {
                message = '连接被拒绝，请检查服务器是否在运行';
              } else if (error.message.includes('ECONNRESET')) {
                message = '连接被重置，请检查网络或服务器状态';
              } else if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {
                message = 'SSL/TLS 证书错误，请检查服务器证书配置';
              } else if (error.message.includes('Zlib') || error.message.includes('Decompression')) {
                // WAF/CDN may return content-encoding: gzip with non-compressed body.
                // Bun's fetch auto-decompression crashes. Skip validation and let SDK handle it.
                console.warn(`[api/mcp/enable] ZlibError during validation (WAF/CDN issue), allowing MCP: ${server.id}`);
                return jsonResponse({ success: true });
              } else {
                message = `连接失败: ${error.message}`;
              }

              return jsonResponse({
                success: false,
                error: { type: 'connection_failed', message }
              });
            }
          }

          // stdio type: validate command
          if (server.type === 'stdio' && server.command) {
            const command = server.command;

            // Preset MCP (isBuiltin: true) with npx → warmup to download and cache package
            if (server.isBuiltin && command === 'npx') {
              const { getBundledNodeDir, getBundledRuntimePath, isBunRuntime, getSystemNpxPaths, findExistingPath } = await import('./utils/runtime');
              const { pinMcpPackageVersions } = await import('./agent-session');
              const args = pinMcpPackageVersions(server.args || []);

              const { spawn } = await import('child_process');
              const { getShellEnv } = await import('./utils/shell');
              const baseEnv = getShellEnv();

              // Priority: system npx → bundled Node.js npx → bun x
              const systemNpx = findExistingPath(getSystemNpxPaths());
              const nodeDir = getBundledNodeDir();
              let warmupCmd: string;
              let warmupArgs: string[];

              if (systemNpx) {
                // 1. System npx available — most reliable, user-maintained
                warmupCmd = systemNpx;
                warmupArgs = ['-y', ...args, '--help'];

                // Ensure system npx's directory is in PATH (GUI-launched apps may have minimal PATH)
                const { dirname } = await import('path');
                const npxDir = dirname(systemNpx);
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const sep = process.platform === 'win32' ? ';' : ':';
                if (!(baseEnv[pathKey] || '').includes(npxDir)) {
                  baseEnv[pathKey] = npxDir + sep + (baseEnv[pathKey] || '');
                }

                console.log(`[api/mcp/enable] Warming up with system npx: ${warmupArgs.join(' ')}`);
              } else if (nodeDir) {
                // 2. Fallback to bundled Node.js npx
                const npxPath = process.platform === 'win32'
                  ? join(nodeDir, 'npx.cmd')
                  : join(nodeDir, 'npx');
                warmupCmd = npxPath;
                warmupArgs = ['-y', ...args, '--help'];

                // Ensure bundled Node.js bin dir is in PATH for npx to find node
                const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
                const sep = process.platform === 'win32' ? ';' : ':';
                baseEnv[pathKey] = nodeDir + sep + (baseEnv[pathKey] || '');

                console.log(`[api/mcp/enable] Warming up with bundled npx: ${warmupArgs.join(' ')}`);
              } else {
                // 3. Last resort: bun x
                const runtime = getBundledRuntimePath();
                if (!isBunRuntime(runtime)) {
                  return jsonResponse({
                    success: false,
                    error: {
                      type: 'runtime_error',
                      message: '运行时不可用（系统/内置 Node.js 和 Bun 均未找到）',
                    }
                  });
                }
                warmupCmd = runtime;
                warmupArgs = ['x', ...args, '--help'];
                console.log(`[api/mcp/enable] Warming up with bun x: ${warmupArgs.join(' ')}`);
              }

              return new Promise<Response>((resolve) => {
                const proc = spawn(warmupCmd, warmupArgs, {
                  env: baseEnv,
                  timeout: 120000, // 2 min timeout
                  stdio: ['ignore', 'pipe', 'pipe'],
                });

                let stderr = '';
                proc.stderr?.on('data', (data) => { stderr += data; });

                proc.on('error', (err) => {
                  console.error('[api/mcp/enable] Warmup error:', err);
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'warmup_failed',
                      message: `预热失败: ${err.message}`,
                    }
                  }));
                });

                proc.on('close', (code) => {
                  console.log(`[api/mcp/enable] Warmup exited with code ${code}`);
                  // Code 0 or 1 is acceptable (--help may return 1 for some packages)
                  // Check stderr for real errors (package not found, network issues, etc.)
                  const stderrLower = stderr.toLowerCase();
                  const networkKeywords = [
                    'enotfound',     // DNS resolution failed
                    'etimedout',     // Connection timeout
                    'econnrefused',  // Connection refused
                    'econnreset',    // Connection reset
                    'proxy error',   // Proxy failures
                    'proxy authentication', // Proxy auth required
                    'bad gateway',   // Proxy 502
                    'socket hang up',// Connection dropped
                  ];
                  const packageKeywords = [
                    '404',                // HTTP 404 not found
                    'package not found',  // npm/npx package resolution
                    'module not found',   // Module resolution failure
                    'err!',               // npm error indicator
                  ];
                  const isNetworkError = networkKeywords.some(kw => stderrLower.includes(kw));
                  const isPackageError = packageKeywords.some(kw => stderrLower.includes(kw));

                  if (isNetworkError) {
                    resolve(jsonResponse({
                      success: false,
                      error: {
                        type: 'warmup_failed',
                        message: '网络连接失败，请检查网络或代理设置',
                      }
                    }));
                  } else if (isPackageError) {
                    resolve(jsonResponse({
                      success: false,
                      error: {
                        type: 'package_not_found',
                        message: '包不存在或无法下载，请检查包名',
                      }
                    }));
                  } else if (code !== 0 && code !== 1) {
                    // Non-zero exit (other than 1 which --help may return) is a failure
                    resolve(jsonResponse({
                      success: false,
                      error: {
                        type: 'warmup_failed',
                        message: `预热异常退出 (code ${code})`,
                      }
                    }));
                  } else {
                    resolve(jsonResponse({ success: true }));
                  }
                });
              });
            }

            // Custom MCP or non-npx command → check if command exists in user's shell PATH
            const { spawn } = await import('child_process');
            const { getShellEnv } = await import('./utils/shell');
            const checkCmd = process.platform === 'win32' ? 'where' : 'which';

            return new Promise<Response>((resolve) => {
              const proc = spawn(checkCmd, [command], { stdio: 'ignore', env: getShellEnv() });

              proc.on('error', () => {
                resolve(jsonResponse({
                  success: false,
                  error: {
                    type: 'command_not_found',
                    command,
                    message: `命令 "${command}" 未找到`,
                    ...getCommandDownloadInfo(command),
                  }
                }));
              });

              proc.on('close', (code) => {
                if (code === 0) {
                  resolve(jsonResponse({ success: true }));
                } else {
                  resolve(jsonResponse({
                    success: false,
                    error: {
                      type: 'command_not_found',
                      command,
                      message: `命令 "${command}" 未找到`,
                      ...getCommandDownloadInfo(command),
                    }
                  }));
                }
              });
            });
          }

          // Default: allow
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/enable] Error:', error);
          return jsonResponse({
            success: false,
            error: {
              type: 'unknown',
              message: error instanceof Error ? error.message : '启用失败',
            }
          }, 500);
        }
      }

      // POST /api/permission/respond - Handle user permission decision
      // Auto-routes to external runtime (CC/Codex) when active, otherwise uses builtin SDK handler.
      if (pathname === '/api/permission/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            // External runtime: translate decision enum → boolean approved
            const approved = payload.decision !== 'deny';
            await respondExternalPermission(payload.requestId, approved);
            return jsonResponse({ success: true });
          }

          const { handlePermissionResponse } = await import('./agent-session');
          const success = handlePermissionResponse(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/permission] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/ask-user-question/respond - Handle user's answers to AskUserQuestion
      if (pathname === '/api/ask-user-question/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            answers: Record<string, string> | null;  // null means user cancelled
          };

          const { handleAskUserQuestionResponse } = await import('./agent-session');
          const success = handleAskUserQuestionResponse(payload.requestId, payload.answers);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/ask-user-question] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }
      // POST /api/exit-plan-mode/respond - Handle user's approval/rejection of ExitPlanMode
      if (pathname === '/api/exit-plan-mode/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as { requestId: string; approved: boolean };
          const { handleExitPlanModeResponse } = await import('./agent-session');
          const success = handleExitPlanModeResponse(payload.requestId, payload.approved);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/exit-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/enter-plan-mode/respond - Handle user's approval/rejection of EnterPlanMode
      if (pathname === '/api/enter-plan-mode/respond' && request.method === 'POST') {
        try {
          const payload = await request.json() as { requestId: string; approved: boolean };
          const { handleEnterPlanModeResponse } = await import('./agent-session');
          const success = handleEnterPlanModeResponse(payload.requestId, payload.approved);
          return jsonResponse({ success });
        } catch (error) {
          console.error('[api/enter-plan-mode] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= MCP OAuth API =============

      // POST /api/mcp/oauth/discover - Probe MCP server for OAuth requirements
      if (pathname === '/api/mcp/oauth/discover' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string; mcpUrl: string; forceRefresh?: boolean };
          if (!payload.serverId || !payload.mcpUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or mcpUrl' }, 400);
          }
          const { probeOAuthRequirement } = await import('./mcp-oauth');
          const result = await probeOAuthRequirement(payload.serverId, payload.mcpUrl, payload.forceRefresh);
          return jsonResponse({ success: true, ...result });
        } catch (error) {
          console.error('[api/mcp/oauth/discover] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Discovery failed' }, 500);
        }
      }

      // POST /api/mcp/oauth/start - Start OAuth flow (auto or manual mode)
      if (pathname === '/api/mcp/oauth/start' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            serverId: string;
            serverUrl: string;
            // Manual mode fields (all optional — omit for auto mode)
            clientId?: string;
            clientSecret?: string;
            scopes?: string[];
            callbackPort?: number;
            authorizationUrl?: string;
            tokenUrl?: string;
          };

          if (!payload.serverId || !payload.serverUrl) {
            return jsonResponse({ success: false, error: 'Missing serverId or serverUrl' }, 400);
          }

          const { authorizeServer } = await import('./mcp-oauth');
          const manualConfig = payload.clientId ? {
            clientId: payload.clientId,
            clientSecret: payload.clientSecret,
            scopes: payload.scopes,
            callbackPort: payload.callbackPort,
            authorizationUrl: payload.authorizationUrl,
            tokenUrl: payload.tokenUrl,
          } : undefined;

          const { authUrl, waitForCompletion } = await authorizeServer(
            payload.serverId,
            payload.serverUrl,
            manualConfig,
          );

          // Don't await completion — return the auth URL immediately
          waitForCompletion.then((success) => {
            if (success) {
              console.log(`[api/mcp/oauth] Authorization completed for ${payload.serverId}`);
            } else {
              console.warn(`[api/mcp/oauth] Authorization failed or cancelled for ${payload.serverId}`);
            }
          });

          return jsonResponse({ success: true, authUrl });
        } catch (error) {
          console.error('[api/mcp/oauth/start] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to start OAuth flow' },
            500
          );
        }
      }

      // GET /api/mcp/oauth/status/:serverId - Get OAuth status
      if (pathname.startsWith('/api/mcp/oauth/status/') && request.method === 'GET') {
        try {
          const serverId = decodeURIComponent(pathname.slice('/api/mcp/oauth/status/'.length));
          const { getOAuthStatus } = await import('./mcp-oauth');
          const result = getOAuthStatus(serverId);
          return jsonResponse({
            success: true,
            status: result.status,
            hasToken: result.status === 'connected' || result.status === 'expired',
            expiresAt: result.expiresAt,
            scope: result.scope,
          });
        } catch (error) {
          console.error('[api/mcp/oauth/status] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/mcp/oauth/refresh - Manually refresh OAuth token
      if (pathname === '/api/mcp/oauth/refresh' && request.method === 'POST') {
        try {
          const payload = await request.json() as { serverId: string };
          const { manualRefreshToken } = await import('./mcp-oauth');
          const refreshed = await manualRefreshToken(payload.serverId);
          return jsonResponse({ success: refreshed, refreshed });
        } catch (error) {
          console.error('[api/mcp/oauth/refresh] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // DELETE /api/mcp/oauth/token - Revoke OAuth authorization
      if (pathname === '/api/mcp/oauth/token' && request.method === 'DELETE') {
        try {
          const payload = await request.json() as { serverId: string };
          const { revokeAuthorization } = await import('./mcp-oauth');
          await revokeAuthorization(payload.serverId);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/mcp/oauth/token] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // ============= END MCP OAuth API =============

      // ============= END MCP API =============

      // ============= ADMIN API (Self-Config CLI) =============
      if (pathname.startsWith('/api/admin/') && request.method === 'POST') {
        try {
          const payload = pathname === '/api/admin/status'
            ? {}
            : await request.json().catch(() => ({})) as Record<string, unknown>;

          const result = await routeAdminApi(pathname, payload);
          return jsonResponse(result, result.success ? 200 : 400);
        } catch (error) {
          console.error(`[admin] ${pathname} error:`, error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Admin API error' },
            500
          );
        }
      }
      // ============= END ADMIN API =============

      // ============= SLASH COMMANDS API =============
      // GET /api/commands - Get all available slash commands and skills
      if (pathname === '/api/commands' && request.method === 'GET') {
        try {
          // Lazy sync: only re-sync symlinks if global skills have changed (generation counter).
          // Covers the case where Global Sidecar (Settings) modified skills without Tab Sidecar knowing.
          if (currentAgentDir) syncSkillsIfNeeded(currentAgentDir);

          // Start with empty array, builtin commands added at the end
          // Order: project commands -> user commands -> skills -> builtin (so custom can override builtin)
          const commands: SlashCommand[] = [];
          const homeDir = getHomeDirOrNull() || '';

          // ===== COMMANDS SCANNING =====
          // Helper function to scan commands from a directory
          const scanCommandsDir = (commandsDir: string, scope: 'user' | 'project') => {
            if (!existsSync(commandsDir)) return;
            try {
              const files = readdirSync(commandsDir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(commandsDir, file);
                try {
                  const content = readFileSync(filePath, 'utf-8');
                  const { frontmatter } = parseFullCommandContent(content);
                  const fileName = extractCommandName(file);
                  commands.push({
                    name: frontmatter.name || fileName,  // Prefer frontmatter name
                    description: frontmatter.description || '',
                    source: 'custom',
                    scope,
                    path: filePath,
                  });
                } catch (err) {
                  console.warn(`[api/commands] Error reading command ${file}:`, err);
                }
              }
            } catch (err) {
              console.warn(`[api/commands] Error scanning commands dir ${commandsDir}:`, err);
            }
          };

          // 1. Scan project-level commands (.claude/commands/) - highest priority
          const claudeCommandsDir = join(currentAgentDir, '.claude', 'commands');
          scanCommandsDir(claudeCommandsDir, 'project');

          // 2. Scan user-level commands (~/.pm-copilot/commands/)
          const userCommandsDir = join(homeDir, '.pm-copilot', 'commands');
          scanCommandsDir(userCommandsDir, 'user');
          // ===== END COMMANDS SCANNING =====

          // ===== SKILLS SCANNING =====
          // Helper function to scan skills from a directory
          const skillsConfig = readSkillsConfig();
          const scanSkillsDir = (skillsDir: string, scope: 'user' | 'project') => {
            if (!existsSync(skillsDir)) return;
            try {
              const skillFolders = readdirSync(skillsDir, { withFileTypes: true });
              for (const folder of skillFolders) {
                if (!folder.isDirectory()) continue;
                if (isSkillBlockedOnPlatform(folder.name)) continue;
                // Skip disabled user-level skills in slash commands
                if (scope === 'user' && skillsConfig.disabled.includes(folder.name)) continue;
                const skillMdPath = join(skillsDir, folder.name, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                try {
                  const content = readFileSync(skillMdPath, 'utf-8');
                  const { name, description, displayName, displayDescription } = parseSkillFrontmatter(content);
                  // Use parsed name or fall back to folder name
                  const skillName = name || folder.name;
                  commands.push({
                    name: skillName,
                    description: description || '',
                    source: 'skill',
                    scope,
                    path: skillMdPath,
                    folderName: folder.name, // Actual folder name for copy operations
                    displayName,
                    displayDescription,
                  });
                } catch (err) {
                  console.warn(`[api/commands] Error reading skill ${folder.name}:`, err);
                }
              }
            } catch (err) {
              console.warn(`[api/commands] Error scanning skills dir ${skillsDir}:`, err);
            }
          };

          // 1. Scan project-level skills (.claude/skills/) - higher priority
          const projectSkillsDir = join(currentAgentDir, '.claude', 'skills');
          scanSkillsDir(projectSkillsDir, 'project');

          // 2. Scan user-level skills (~/.pm-copilot/skills/) - lower priority
          const userSkillsDir = join(homeDir, '.pm-copilot', 'skills');
          scanSkillsDir(userSkillsDir, 'user');
          // ===== END SKILLS SCANNING =====

          // 3. Add builtin commands at the end (so custom/skills can override them)
          commands.push(...BUILTIN_SLASH_COMMANDS);

          // Collect global skill folderNames before dedup (dedup removes global version when project version exists)
          const globalSkillFolderNames = commands
            .filter(c => c.source === 'skill' && c.scope === 'user' && c.folderName)
            .map(c => c.folderName!);

          // Deduplicate commands by name (keep first occurrence - custom/skills take precedence over builtin)
          const seenNames = new Set<string>();
          const uniqueCommands = commands.filter(cmd => {
            if (seenNames.has(cmd.name)) {
              return false;
            }
            seenNames.add(cmd.name);
            return true;
          });

          return jsonResponse({ success: true, commands: uniqueCommands, globalSkillFolderNames });
        } catch (error) {
          console.error('[api/commands] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get commands' },
            500
          );
        }
      }

      // ============= Model Info Helpers =============

      function inferProviderFromBaseUrl(url: string): string {
        const base = url.toLowerCase();
        if (base.includes('anthropic')) return 'Anthropic';
        if (base.includes('openai')) return 'OpenAI';
        if (base.includes('bigmodel') || base.includes('zhipuai')) return '智谱 (Zhipu)';
        if (base.includes('moonshot') || base.includes('kimi')) return 'Moonshot (月之暗面)';
        if (base.includes('deepseek')) return 'DeepSeek';
        if (base.includes('dashscope') || base.includes('aliyun')) return '阿里云 (Qwen)';
        if (base.includes('qwen')) return '阿里云 (Qwen)';
        try { return new URL(url).hostname; } catch { return ''; }
      }

      function inferProviderFromModelName(model: string): string {
        const m = model.toLowerCase();
        if (m.startsWith('glm') || m.startsWith('chatglm')) return '智谱 (Zhipu)';
        if (m.startsWith('moonshot') || m.startsWith('kimi')) return 'Moonshot (月之暗面)';
        if (m.startsWith('deepseek')) return 'DeepSeek';
        if (m.startsWith('qwen') || m.startsWith('qwq')) return '阿里云 (Qwen)';
        if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'OpenAI';
        if (m.startsWith('claude')) return 'Anthropic';
        return '';
      }

      function resolveProviderName(): string {
        const model = getSessionModel() || '';
        // Priority 1: model name inference (most reliable — proxy URLs can be misleading)
        const modelInferred = inferProviderFromModelName(model);
        if (modelInferred) return modelInferred;
        // Priority 2: bridge config baseUrl
        const bridgeConfig = getOpenAiBridgeConfig();
        if (bridgeConfig?.baseUrl) return inferProviderFromBaseUrl(bridgeConfig.baseUrl);
        // Priority 3: provider env baseUrl
        const providerEnv = getSessionProviderEnv();
        if (providerEnv?.baseUrl) return inferProviderFromBaseUrl(providerEnv.baseUrl);
        return '';
      }

      function updateModelInfoInClaudeMd(): void {
        try {
          const hd = getHomeDirOrNull();
          if (!hd) return;
          const claudeMdPath = join(hd, '.pm-copilot', 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) return;
          const modelName = getSessionModel() || '未配置';
          const providerName = resolveProviderName();
          const modelTable = `| 字段 | 值 |\n|------|----|\n| 模型供应商 | ${providerName} |\n| 模型 | ${modelName} |`;
          let content = readFileSync(claudeMdPath, 'utf-8');
          if (content.includes('<!-- RUNTIME_MODEL_INFO -->')) {
            content = content.replace(/<!-- RUNTIME_MODEL_INFO -->/, modelTable);
            writeFileSync(claudeMdPath, content, 'utf-8');
          } else {
            // Replace existing model table (already injected)
            const tableRegex = /\| 字段 \| 值 \|\n\|[-|]+\|\n\| 模型供应商 \| [^|]+ \|\n\| 模型 \| [^|]+ \|/;
            content = content.replace(tableRegex, modelTable);
            writeFileSync(claudeMdPath, content, 'utf-8');
          }
          console.log(`[model-info] Updated CLAUDE.md: provider=${providerName}, model=${modelName}`);
        } catch (err) {
          console.error('[model-info] Failed to update CLAUDE.md:', err);
        }
      }

      // ============= CLAUDE.md API =============
      // GET /api/claude-md - Read CLAUDE.md from workspace
      if (pathname === '/api/claude-md' && request.method === 'GET') {
        try {
          // Get agentDir from query param, fallback to currentAgentDir
          // Get agentDir from query param, fallback to currentAgentDir
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const claudeMdPath = join(targetDir, 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) {
            return jsonResponse({
              success: true,
              exists: false,
              path: claudeMdPath,
              content: ''
            });
          }
          let content = readFileSync(claudeMdPath, 'utf-8');

          // Inject dynamic KB root path from config
          const homeDir = getHomeDirOrNull() || '';
          const kbConfigPath = join(homeDir, '.pm-copilot', 'kb-config.json');
          if (existsSync(kbConfigPath)) {
            try {
              const kbConfig = JSON.parse(readFileSync(kbConfigPath, 'utf-8'));
              if (kbConfig.kbRootPath) {
                content = content.replace(
                  /\*\*KB 根路径\*\*: `[^`]+`/,
                  `**KB 根路径**: \`${kbConfig.kbRootPath}\``
                );
              }
            } catch { /* ignore parse errors */ }
          }

          // Inject runtime model info (provider + model name)
          try {
            const providerName = resolveProviderName();
            const modelName = getSessionModel() || '未配置';
            const modelTable = `| 字段 | 值 |\n|------|----|\n| 模型供应商 | ${providerName} |\n| 模型 | ${modelName} |`;
            content = content.replace(/<!-- RUNTIME_MODEL_INFO -->/, modelTable);
          } catch { /* ignore model info injection errors */ }

          return jsonResponse({
            success: true,
            exists: true,
            path: claudeMdPath,
            content
          });
        } catch (error) {
          console.error('[api/claude-md] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read CLAUDE.md' },
            500
          );
        }
      }

      // GET /api/model-info - Return current provider and model info
      if (pathname === '/api/model-info' && request.method === 'GET') {
        try {
          return jsonResponse({
            provider: resolveProviderName(),
            model: getSessionModel() || '',
          });
        } catch {
          return jsonResponse({ provider: '', model: '' });
        }
      }
      if (pathname === '/api/claude-md' && request.method === 'POST') {
        try {
          const payload = await request.json() as { content: string };
          // Get agentDir from query param, fallback to currentAgentDir
          // Get agentDir from query param, fallback to currentAgentDir
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const claudeMdPath = join(targetDir, 'CLAUDE.md');
          writeFileSync(claudeMdPath, payload.content, 'utf-8');
          return jsonResponse({ success: true, path: claudeMdPath });
        } catch (error) {
          console.error('[api/claude-md] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to write CLAUDE.md' },
            500
          );
        }
      }

      // GET /api/kb-path - Get configured KB root path
      if (pathname === '/api/kb-path' && request.method === 'GET') {
        const kbHomeDir = getHomeDirOrNull() || '';
        const kbCfgPath = join(kbHomeDir, '.pm-copilot', 'kb-config.json');
        if (existsSync(kbCfgPath)) {
          try {
            const raw = JSON.parse(readFileSync(kbCfgPath, 'utf-8'));
            return jsonResponse({ success: true, kbRootPath: raw.kbRootPath || '' });
          } catch { /* ignore */ }
        }
        return jsonResponse({ success: true, kbRootPath: '' });
      }

      // POST /api/kb-path - Set KB root path
      if (pathname === '/api/kb-path' && request.method === 'POST') {
        try {
          const payload = await request.json() as { kbRootPath?: string };
          if (!payload || typeof payload.kbRootPath !== 'string') {
            return jsonResponse({ success: false, error: 'kbRootPath is required' }, 400);
          }
          const kbCfgDir = join(getHomeDirOrNull() || '', '.pm-copilot');
          if (!existsSync(kbCfgDir)) mkdirSync(kbCfgDir, { recursive: true });
          writeFileSync(
            join(kbCfgDir, 'kb-config.json'),
            JSON.stringify({ kbRootPath: payload.kbRootPath }, null, 2),
            'utf-8'
          );
          return jsonResponse({ success: true });
        } catch (error) {
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to save KB path' },
            500
          );
        }
      }

      // Security: Validate item names to prevent path traversal attacks
      // Supports Unicode (Chinese, Japanese, etc.) while maintaining security
      // Defined here (before Rules and Skills APIs) so all endpoints can use it
      const isValidItemName = (name: string): boolean => {
        // Reject empty names
        if (!name || name.trim().length === 0) {
          return false;
        }
        // Reject path separators and parent directory references (security)
        if (name.includes('/') || name.includes('\\') || name.includes('..')) {
          return false;
        }
        // Reject Windows reserved characters: < > : " | ? *
        // These cause issues on Windows file systems
        if (/[<>:"|?*]/.test(name)) {
          return false;
        }
        // Reject control characters (0x00-0x1F, 0x7F)
        // eslint-disable-next-line no-control-regex -- Intentional control character detection for filename validation
        if (/[\x00-\x1f\x7f]/.test(name)) {
          return false;
        }
        // Reject names that are only dots (., ..) or start/end with spaces
        if (/^\.+$/.test(name) || name !== name.trim()) {
          return false;
        }
        // Reject Windows reserved file names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
        if (isWindowsReservedName(name)) {
          return false;
        }
        // Allow Unicode letters, numbers, hyphens, underscores, spaces, and common punctuation
        return true;
      };

      // ============= RULES FILES API =============
      // Manage .claude/rules/*.md files (system prompt rules)

      // GET /api/rules - List all rule files
      if (pathname === '/api/rules' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          if (!existsSync(rulesDir)) {
            return jsonResponse({ success: true, files: [] });
          }
          const files = readdirSync(rulesDir)
            .filter(f => f.endsWith('.md'))
            .sort();
          return jsonResponse({ success: true, files });
        } catch (error) {
          console.error('[api/rules] Error listing:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list rules' },
            500
          );
        }
      }

      // POST /api/rules - Create a new rule file
      if (pathname === '/api/rules' && request.method === 'POST') {
        try {
          const payload = await request.json() as { name: string; content?: string };
          if (!payload.name || !payload.name.trim()) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }
          // Ensure .md suffix
          let filename = payload.name.trim();
          if (!filename.endsWith('.md')) {
            filename = filename + '.md';
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          mkdirSync(rulesDir, { recursive: true });
          const filePath = join(rulesDir, filename);
          if (existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File already exists' }, 409);
          }
          writeFileSync(filePath, payload.content || '', 'utf-8');
          return jsonResponse({ success: true, filename });
        } catch (error) {
          console.error('[api/rules] Error creating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename/rename - Rename a rule file
      if (pathname.startsWith('/api/rules/') && pathname.endsWith('/rename') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length, -'/rename'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const oldNameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(oldNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { newName: string };
          if (!payload.newName || !payload.newName.trim()) {
            return jsonResponse({ success: false, error: 'New name is required' }, 400);
          }
          let newFilename = payload.newName.trim();
          if (!newFilename.endsWith('.md')) {
            newFilename = newFilename + '.md';
          }
          const newNameWithoutExt = newFilename.replace(/\.md$/, '');
          if (!isValidItemName(newNameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const oldPath = join(rulesDir, filename);
          const newPath = join(rulesDir, newFilename);
          if (!existsSync(oldPath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          if (existsSync(newPath)) {
            return jsonResponse({ success: false, error: 'Target filename already exists' }, 409);
          }
          renameSync(oldPath, newPath);
          return jsonResponse({ success: true, filename: newFilename });
        } catch (error) {
          console.error('[api/rules] Error renaming:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to rename rule file' },
            500
          );
        }
      }

      // GET /api/rules/:filename - Read a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'GET') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: true, exists: false, content: '' });
          }
          const content = readFileSync(filePath, 'utf-8');
          return jsonResponse({ success: true, exists: true, content });
        } catch (error) {
          console.error('[api/rules] Error reading:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to read rule file' },
            500
          );
        }
      }

      // PUT /api/rules/:filename - Update a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'PUT') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const payload = await request.json() as { content: string };
          if (typeof payload.content !== 'string') {
            return jsonResponse({ success: false, error: 'Content must be a string' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          mkdirSync(rulesDir, { recursive: true });
          const filePath = join(rulesDir, filename);
          writeFileSync(filePath, payload.content, 'utf-8');
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error updating:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update rule file' },
            500
          );
        }
      }

      // DELETE /api/rules/:filename - Delete a rule file
      if (pathname.startsWith('/api/rules/') && request.method === 'DELETE') {
        try {
          const filename = decodeURIComponent(pathname.slice('/api/rules/'.length));
          if (!filename || !filename.endsWith('.md')) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const nameWithoutExt = filename.replace(/\.md$/, '');
          if (!isValidItemName(nameWithoutExt)) {
            return jsonResponse({ success: false, error: 'Invalid filename' }, 400);
          }
          const queryAgentDir = url.searchParams.get('agentDir');
          if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
            return jsonResponse({ success: false, error: 'Invalid agentDir' }, 400);
          }
          const targetDir = queryAgentDir || currentAgentDir;
          const rulesDir = join(targetDir, '.claude', 'rules');
          const filePath = join(rulesDir, filename);
          if (!existsSync(filePath)) {
            return jsonResponse({ success: false, error: 'File not found' }, 404);
          }
          unlinkSync(filePath);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/rules] Error deleting:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete rule file' },
            500
          );
        }
      }

      // ============= SKILLS MANAGEMENT API =============

      // Cross-platform home directory for user skills/commands
      const homeDir = getHomeDirOrNull() || '';
      const userSkillsBaseDir = join(homeDir, '.pm-copilot', 'skills');
      const userCommandsBaseDir = join(homeDir, '.pm-copilot', 'commands');

      // Helper: Get project base directories (supports explicit agentDir parameter)
      // Security: validates agentDir to prevent path traversal attacks
      const getProjectBaseDirs = (queryAgentDir: string | null) => {
        // If explicit agentDir provided, validate it first
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          // Invalid agentDir, fall back to currentAgentDir
          console.warn(`[getProjectBaseDirs] Invalid agentDir rejected: ${queryAgentDir}`);
          queryAgentDir = null;
        }
        // Use validated agentDir if provided, otherwise fall back to currentAgentDir
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return {
          skillsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'skills') : '',
          commandsDir: hasValidDir ? join(effectiveAgentDir, '.claude', 'commands') : '',
        };
      };

      // Default project paths (using currentAgentDir)
      const hasValidAgentDir = currentAgentDir && existsSync(currentAgentDir);
      const projectSkillsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'skills') : '';
      const projectCommandsBaseDir = hasValidAgentDir ? join(currentAgentDir, '.claude', 'commands') : '';

      // GET /api/skills - List all skills (with scope filter)
      // Supports ?agentDir= for listing skills from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/skills' && request.method === 'GET') {
        try {
          // Lazy sync: ensure symlinks are current before listing
          if (currentAgentDir) syncSkillsIfNeeded(currentAgentDir);

          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { skillsDir: effectiveSkillsDir } = getProjectBaseDirs(queryAgentDir);
          const skillsConfigForList = readSkillsConfig();
          const skills: Array<{
            name: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            folderName: string;
            author?: string;
            enabled?: boolean;
            displayName?: string;
            displayDescription?: string;
          }> = [];

          const scanSkills = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const folders = readdirSync(dir, { withFileTypes: true });
              for (const folder of folders) {
                if (!folder.isDirectory()) continue;
                if (isSkillBlockedOnPlatform(folder.name)) continue;
                const skillMdPath = join(dir, folder.name, 'SKILL.md');
                if (!existsSync(skillMdPath)) continue;

                const content = readFileSync(skillMdPath, 'utf-8');
                const { name, description, author, displayName, displayDescription } = parseSkillFrontmatter(content);
                skills.push({
                  name: name || folder.name,
                  description: description || '',
                  scope: scopeType,
                  path: skillMdPath,
                  folderName: folder.name,
                  author,
                  enabled: scopeType === 'project' ? true : !skillsConfigForList.disabled.includes(folder.name),
                  displayName,
                  displayDescription,
                });
              }
            } catch (scanError) {
              console.warn(`[api/skills] Error scanning ${scopeType} skills:`, scanError);
            }
          };

          const resolvedProjectSkillsDir = effectiveSkillsDir || projectSkillsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectSkillsDir) {
            scanSkills(resolvedProjectSkillsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanSkills(userSkillsBaseDir, 'user');
          }

          return jsonResponse({ success: true, skills });
        } catch (error) {
          console.error('[api/skills] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list skills' },
            500
          );
        }
      }

      // POST /api/skill/toggle-enable - Enable/disable a user-level skill
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/toggle-enable' && request.method === 'POST') {
        try {
          const { folderName, enabled } = await request.json() as { folderName: string; enabled: boolean };
          if (!folderName || typeof folderName !== 'string') {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }
          const config = readSkillsConfig();
          if (enabled) {
            config.disabled = config.disabled.filter(n => n !== folderName);
          } else {
            if (!config.disabled.includes(folderName)) config.disabled.push(folderName);
          }
          writeSkillsConfig(config);
          // Re-sync project skill symlinks if this sidecar has an agentDir
          // (Global Sidecar has no agentDir; Tab Sidecars will sync on next /api/commands or /api/skills)
          if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill/toggle-enable] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to toggle skill' },
            500
          );
        }
      }

      // GET /api/skill/sync-check - Check if there are skills to sync from Claude Code
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-check' && request.method === 'GET') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get folders in Claude Code skills directory
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          // Get existing folders in PM Copilot skills directory
          const pmCopilotFolders = new Set<string>();
          if (existsSync(userSkillsBaseDir)) {
            const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                pmCopilotFolders.add(entry.name);
              }
            }
          }

          // Find folders that can be synced (exist in Claude but not in PM Copilot)
          const syncableFolders = claudeFolders.filter(folder => !pmCopilotFolders.has(folder));

          return jsonResponse({
            canSync: syncableFolders.length > 0,
            count: syncableFolders.length,
            folders: syncableFolders
          });
        } catch (error) {
          console.error('[api/skill/sync-check] Error:', error);
          return jsonResponse(
            { canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' },
            500
          );
        }
      }

      // POST /api/skill/sync-from-claude - Sync skills from Claude Code to PM Copilot
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/sync-from-claude' && request.method === 'POST') {
        try {
          const claudeSkillsDir = join(homeDir, '.claude', 'skills');

          // Check if Claude Code skills directory exists
          if (!existsSync(claudeSkillsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, error: 'Claude Code skills directory not found' }, 404);
          }

          // Get folders in Claude Code skills directory
          const claudeFolders = readdirSync(claudeSkillsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'No skills to sync' });
          }

          // Ensure PM Copilot skills directory exists
          if (!existsSync(userSkillsBaseDir)) {
            mkdirSync(userSkillsBaseDir, { recursive: true });
          }

          // Get existing folders in PM Copilot skills directory
          const pmCopilotFolders = new Set<string>();
          const entries = readdirSync(userSkillsBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              pmCopilotFolders.add(entry.name);
            }
          }

          // Find folders that can be synced (filter out invalid folder names for security)
          const syncableFolders = claudeFolders.filter(folder =>
            !pmCopilotFolders.has(folder) && isValidFolderName(folder)
          );

          if (syncableFolders.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, message: 'All skills already exist' });
          }

          // Copy each syncable folder
          let synced = 0;
          let failed = 0;
          const errors: string[] = [];

          for (const folder of syncableFolders) {
            const srcDir = join(claudeSkillsDir, folder);
            const destDir = join(userSkillsBaseDir, folder);

            try {
              copyDirRecursiveSync(srcDir, destDir, '[api/skill/sync-from-claude]');

              // Ensure SKILL.md exists — Claude Code may use different file names
              const skillMdPath = join(destDir, 'SKILL.md');
              if (!existsSync(skillMdPath)) {
                // Sanitize folder name for YAML frontmatter (escape quotes and backslashes)
                const safeName = folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                // Look for any .md file to use as the skill definition
                const mdFiles = readdirSync(destDir).filter(f => f.endsWith('.md') && f !== 'SKILL.md');
                if (mdFiles.length > 0) {
                  // Use the first .md file as SKILL.md source
                  const srcMd = join(destDir, mdFiles[0]);
                  const mdContent = readFileSync(srcMd, 'utf-8');
                  // Check if it already has frontmatter; if not, add minimal frontmatter
                  if (mdContent.startsWith('---')) {
                    writeFileSync(skillMdPath, mdContent, 'utf-8');
                  } else {
                    const skillContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\n${mdContent}`;
                    writeFileSync(skillMdPath, skillContent, 'utf-8');
                  }
                  console.log(`[api/skill/sync-from-claude] Created SKILL.md from ${mdFiles[0]} for "${folder}"`);
                } else {
                  // No .md files — create minimal SKILL.md
                  const minimalContent = `---\nname: "${safeName}"\ndescription: "Imported from Claude Code"\n---\n\nSkill imported from Claude Code.\n`;
                  writeFileSync(skillMdPath, minimalContent, 'utf-8');
                  console.log(`[api/skill/sync-from-claude] Created minimal SKILL.md for "${folder}"`);
                }
              }

              synced++;
              if (process.env.DEBUG === '1') {
                console.log(`[api/skill/sync-from-claude] Synced skill "${folder}"`);
              }
            } catch (copyError) {
              failed++;
              const errorMsg = copyError instanceof Error ? copyError.message : 'Unknown error';
              errors.push(`${folder}: ${errorMsg}`);
              console.error(`[api/skill/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          // Imported user skills — bump generation + sync symlinks into project
          if (synced > 0) {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
          }
          return jsonResponse({
            success: true,
            synced,
            failed,
            errors: errors.length > 0 ? errors : undefined
          });
        } catch (error) {
          console.error('[api/skill/sync-from-claude] Error:', error);
          return jsonResponse(
            { success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' },
            500
          );
        }
      }

      // GET /api/skill/:name - Get skill detail
      if (pathname.startsWith('/api/skill/') && request.method === 'GET') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillPath = join(baseDir, skillName, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          const content = readFileSync(skillPath, 'utf-8');
          const { frontmatter, body } = parseFullSkillContent(content);

          return jsonResponse({
            success: true,
            skill: {
              name: frontmatter.name || skillName,
              folderName: skillName,
              path: skillPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get skill' },
            500
          );
        }
      }

      // PUT /api/skill/:name - Update skill (with optional folder rename)
      if (pathname.startsWith('/api/skill/') && request.method === 'PUT') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<SkillFrontmatter>;
            body: string;
            newFolderName?: string; // Optional: rename folder if provided
            agentDir?: string; // Optional: explicit project directory
          };

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          let currentFolderName = skillName;
          let skillDir = join(baseDir, currentFolderName);
          let skillPath = join(skillDir, 'SKILL.md');

          if (!existsSync(skillPath)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;

            // Validate new folder name
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }

            const newSkillDir = join(baseDir, newFolderName);

            // Check for conflict
            if (existsSync(newSkillDir)) {
              return jsonResponse({ success: false, error: `技能文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, folder is renamed but content unchanged.
            const content = serializeSkillContent(payload.frontmatter, payload.body);

            // Rename the folder
            renameSync(skillDir, newSkillDir);
            skillDir = newSkillDir;
            skillPath = join(skillDir, 'SKILL.md');
            currentFolderName = newFolderName;

            // Write content to new location
            writeFileSync(skillPath, content, 'utf-8');

            // User skill renamed — bump generation + re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
            }
            return jsonResponse({
              success: true,
              path: skillPath,
              folderName: currentFolderName,
              fullPath: skillDir
            });
          }

          // No rename, just update content
          const content = serializeSkillContent(payload.frontmatter, payload.body);
          writeFileSync(skillPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: skillPath,
            folderName: currentFolderName,
            fullPath: skillDir
          });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' },
            500
          );
        }
      }

      // DELETE /api/skill/:name - Delete skill
      if (pathname.startsWith('/api/skill/') && request.method === 'DELETE') {
        try {
          const skillName = decodeURIComponent(pathname.replace('/api/skill/', ''));
          if (!isValidItemName(skillName)) {
            return jsonResponse({ success: false, error: 'Invalid skill name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, skillName);

          if (!existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill not found' }, 404);
          }

          rmSync(skillDir, { recursive: true, force: true });
          // User skill deleted — bump generation + re-sync to remove dangling symlinks
          if (scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
          }
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/skill] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' },
            500
          );
        }
      }

      // POST /api/skill/copy-to-global - Copy a project skill to global (~/.pm-copilot/skills/)
      // NOTE: This route MUST be before /api/skill/:name to avoid being captured by the wildcard
      if (pathname === '/api/skill/copy-to-global' && request.method === 'POST') {
        try {
          const { folderName } = await request.json() as { folderName: string };
          if (!folderName || typeof folderName !== 'string' || !isValidItemName(folderName)) {
            return jsonResponse({ success: false, error: 'Invalid folderName' }, 400);
          }

          // Validate project skills directory
          if (!projectSkillsBaseDir) {
            return jsonResponse({ success: false, error: '当前没有项目工作目录' }, 400);
          }

          const srcDir = join(projectSkillsBaseDir, folderName);
          if (!existsSync(srcDir)) {
            return jsonResponse({ success: false, error: '项目技能不存在' }, 404);
          }

          // Check SKILL.md exists in source
          if (!existsSync(join(srcDir, 'SKILL.md'))) {
            return jsonResponse({ success: false, error: '项目技能缺少 SKILL.md' }, 400);
          }

          // Check if already exists in global
          const destDir = join(userSkillsBaseDir, folderName);
          if (existsSync(destDir)) {
            return jsonResponse({ success: false, error: '全局技能中已存在同名技能' }, 409);
          }

          // Ensure global skills directory exists
          mkdirSync(userSkillsBaseDir, { recursive: true });

          // Copy the skill folder
          copyDirRecursiveSync(srcDir, destDir, '[api/skill/copy-to-global]');

          // Bump generation + sync symlinks into project
          bumpSkillsGeneration();
          if (currentAgentDir) { syncProjectUserConfig(currentAgentDir); markSkillsSynced(); }

          return jsonResponse({ success: true, folderName });
        } catch (error) {
          console.error('[api/skill/copy-to-global] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to copy skill to global' },
            500
          );
        }
      }

      // POST /api/skill/create - Create new skill
      if (pathname === '/api/skill/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string; // Optional: explicit project directory
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for folder (supports Unicode)
          const folderName = sanitizeFolderName(payload.name);
          // Use explicit agentDir if provided for project scope
          const { skillsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : skillsDir;
          const skillDir = join(baseDir, folderName);

          if (existsSync(skillDir)) {
            return jsonResponse({ success: false, error: 'Skill already exists' }, 409);
          }

          // Create directory structure
          mkdirSync(skillDir, { recursive: true });

          // Create SKILL.md with default content
          const frontmatter: Partial<SkillFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your skill instructions here.`;
          const content = serializeSkillContent(frontmatter, body);

          const skillPath = join(skillDir, 'SKILL.md');
          writeFileSync(skillPath, content, 'utf-8');

          // New user skill — bump generation so Tab Sidecars re-sync symlinks
          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
          }
          return jsonResponse({ success: true, path: skillPath, folderName });
        } catch (error) {
          console.error('[api/skill/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create skill' },
            500
          );
        }
      }

      // POST /api/skill/upload - Upload skill from file (.zip, .skill, .md)
      if (pathname === '/api/skill/upload' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            filename: string;
            content: string; // Base64 encoded file content
            scope: 'user' | 'project';
          };

          if (!payload.filename || !payload.content) {
            return jsonResponse({ success: false, error: 'Filename and content are required' }, 400);
          }

          const ext = extname(payload.filename).toLowerCase();
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Decode base64 content to buffer
          const fileBuffer = Buffer.from(payload.content, 'base64');

          // Helper: Try to extract name from SKILL.md content
          const extractNameFromContent = (content: string): string | null => {
            try {
              const parsed = parseFullSkillContent(content);
              if (parsed.frontmatter.name) {
                return parsed.frontmatter.name;
              }
            } catch {
              // Ignore parse errors
            }
            return null;
          };

          if (ext === '.zip' || ext === '.skill') {
            // Handle zip/skill files - extract to skills directory
            try {
              const zip = new AdmZip(fileBuffer);
              const entries = zip.getEntries();

              // Find the root folder name from zip (or use filename without extension)
              let rootFolderName = basename(payload.filename, ext);

              // Check if zip has a single root directory
              const topLevelDirs = new Set<string>();
              for (const entry of entries) {
                const parts = entry.entryName.split('/');
                if (parts[0] && parts[0] !== '__MACOSX') {
                  topLevelDirs.add(parts[0]);
                }
              }

              // If zip has a single root folder, use that as default folder name
              if (topLevelDirs.size === 1) {
                rootFolderName = Array.from(topLevelDirs)[0];
              }

              // Try to find and parse SKILL.md to get the name from frontmatter
              for (const entry of entries) {
                const entryName = entry.entryName.toLowerCase();
                if (entryName.endsWith('skill.md') && !entry.isDirectory) {
                  const mdContent = entry.getData().toString('utf-8');
                  const nameFromContent = extractNameFromContent(mdContent);
                  if (nameFromContent) {
                    rootFolderName = nameFromContent;
                    break;
                  }
                }
              }

              // Sanitize folder name (supports Unicode)
              const folderName = sanitizeFolderName(rootFolderName);
              const skillDir = join(baseDir, folderName);

              if (existsSync(skillDir)) {
                return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
              }

              // Create skill directory
              mkdirSync(skillDir, { recursive: true });

              // Extract files, handling nested structure
              for (const entry of entries) {
                // Skip __MACOSX folder and directory entries
                if (entry.entryName.startsWith('__MACOSX') || entry.isDirectory) continue;

                // Calculate target path - if zip has root folder, strip it
                let targetPath = entry.entryName;
                if (topLevelDirs.size === 1) {
                  const parts = targetPath.split('/');
                  parts.shift(); // Remove root folder
                  targetPath = parts.join('/');
                }

                if (!targetPath) continue;

                const fullPath = join(skillDir, targetPath);
                const dir = dirname(fullPath);

                // Create subdirectories if needed
                if (!existsSync(dir)) {
                  mkdirSync(dir, { recursive: true });
                }

                // Write file
                writeFileSync(fullPath, entry.getData());
              }

              if (payload.scope === 'user') {
                bumpSkillsGeneration();
                if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
              }
              return jsonResponse({
                success: true,
                folderName,
                path: skillDir,
                message: `已成功导入技能 "${folderName}"`
              });

            } catch (zipError) {
              console.error('[api/skill/upload] Zip extraction error:', zipError);
              return jsonResponse(
                { success: false, error: '无法解压文件，请确保是有效的 zip 文件' },
                400
              );
            }

          } else if (ext === '.md') {
            // Handle .md files - parse content and create folder
            const mdContent = fileBuffer.toString('utf-8');
            const mdFilename = basename(payload.filename, '.md');

            // Try to get name from frontmatter, fallback to filename
            const nameFromContent = extractNameFromContent(mdContent);
            const folderName = sanitizeFolderName(nameFromContent || mdFilename);
            const skillDir = join(baseDir, folderName);

            if (existsSync(skillDir)) {
              return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
            }

            // Create skill directory
            mkdirSync(skillDir, { recursive: true });

            // Write the md file as SKILL.md
            const skillPath = join(skillDir, 'SKILL.md');
            writeFileSync(skillPath, fileBuffer);

            if (payload.scope === 'user') {
              bumpSkillsGeneration();
              if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
            }
            return jsonResponse({
              success: true,
              folderName,
              path: skillPath,
              message: `已成功导入技能 "${folderName}"`
            });

          } else {
            return jsonResponse(
              { success: false, error: '不支持的文件类型，请上传 .zip、.skill 或 .md 文件' },
              400
            );
          }

        } catch (error) {
          console.error('[api/skill/upload] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to upload skill' },
            500
          );
        }
      }

      // POST /api/skill/import-folder - Import skill from a local folder path (Tauri only)
      if (pathname === '/api/skill/import-folder' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            folderPath: string;
            scope: 'user' | 'project';
          };

          if (!payload.folderPath) {
            return jsonResponse({ success: false, error: 'Folder path is required' }, 400);
          }

          const sourcePath = payload.folderPath;
          const baseDir = payload.scope === 'user' ? userSkillsBaseDir : projectSkillsBaseDir;

          // Validate target directory is available
          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          // Validate source folder exists
          if (!existsSync(sourcePath)) {
            return jsonResponse({ success: false, error: '指定的文件夹不存在' }, 400);
          }

          // Check if it's a directory
          try {
            const stats = statSync(sourcePath);
            if (!stats.isDirectory()) {
              return jsonResponse({ success: false, error: '指定的路径不是文件夹' }, 400);
            }
          } catch {
            return jsonResponse({ success: false, error: '无法读取文件夹信息' }, 400);
          }

          // Check for SKILL.md at root
          const skillMdPath = join(sourcePath, 'SKILL.md');
          if (!existsSync(skillMdPath)) {
            return jsonResponse({ success: false, error: '文件夹中未找到 SKILL.md 文件' }, 400);
          }

          // Read SKILL.md to get the skill name
          const skillMdContent = readFileSync(skillMdPath, 'utf-8');
          let folderName = basename(sourcePath);

          // Try to extract name from SKILL.md frontmatter
          try {
            const parsed = parseFullSkillContent(skillMdContent);
            if (parsed.frontmatter.name) {
              folderName = parsed.frontmatter.name;
            }
          } catch {
            // Use folder name as fallback
          }

          // Sanitize folder name
          folderName = sanitizeFolderName(folderName);
          const targetDir = join(baseDir, folderName);

          // Check if skill already exists
          if (existsSync(targetDir)) {
            return jsonResponse({ success: false, error: `技能 "${folderName}" 已存在` }, 409);
          }

          // Copy folder recursively
          const copyDir = (src: string, dest: string) => {
            mkdirSync(dest, { recursive: true });
            const entries = readdirSync(src);

            for (const entry of entries) {
              // Skip hidden files and __MACOSX
              if (entry.startsWith('.') || entry === '__MACOSX') continue;

              const srcPath = join(src, entry);
              const destPath = join(dest, entry);
              const stats = statSync(srcPath);

              if (stats.isDirectory()) {
                copyDir(srcPath, destPath);
              } else {
                // Copy file
                copyFileSync(srcPath, destPath);
              }
            }
          };

          copyDir(sourcePath, targetDir);

          if (payload.scope === 'user') {
            bumpSkillsGeneration();
            if (agentDir) { syncProjectUserConfig(agentDir); markSkillsSynced(); }
          }
          return jsonResponse({
            success: true,
            folderName,
            path: targetDir,
            message: `已成功导入技能 "${folderName}"`
          });

        } catch (error) {
          console.error('[api/skill/import-folder] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to import skill folder' },
            500
          );
        }
      }

      // ============= COMMANDS MANAGEMENT API =============
      // GET /api/command-items - List all commands
      // Supports ?agentDir= for listing commands from a specific workspace (e.g. from Launcher)
      if (pathname === '/api/command-items' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const { commandsDir: effectiveCommandsDir } = getProjectBaseDirs(queryAgentDir);
          const commandItems: Array<{
            name: string;
            fileName: string;
            description: string;
            scope: 'user' | 'project';
            path: string;
            author?: string;
          }> = [];

          const scanCommands = (dir: string, scopeType: 'user' | 'project') => {
            if (!dir || !existsSync(dir)) return;
            try {
              const files = readdirSync(dir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const filePath = join(dir, file);
                const content = readFileSync(filePath, 'utf-8');
                const { frontmatter } = parseFullCommandContent(content);
                const fileName = extractCommandName(file);
                commandItems.push({
                  name: frontmatter.name || fileName,  // Prefer frontmatter name
                  fileName,  // Always include actual file name for reference
                  description: frontmatter.description || '',
                  scope: scopeType,
                  path: filePath,
                  author: frontmatter.author,
                });
              }
            } catch (scanError) {
              console.warn(`[api/command-items] Error scanning ${scopeType} commands:`, scanError);
            }
          };

          const resolvedProjectCommandsDir = effectiveCommandsDir || projectCommandsBaseDir;
          if ((scope === 'all' || scope === 'project') && resolvedProjectCommandsDir) {
            scanCommands(resolvedProjectCommandsDir, 'project');
          }
          if (scope === 'all' || scope === 'user') {
            scanCommands(userCommandsBaseDir, 'user');
          }

          return jsonResponse({ success: true, commands: commandItems });
        } catch (error) {
          console.error('[api/command-items] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list commands' },
            500
          );
        }
      }

      // GET /api/command-item/:name - Get command detail
      if (pathname.startsWith('/api/command-item/') && request.method === 'GET') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          const content = readFileSync(cmdPath, 'utf-8');
          const { frontmatter, body } = parseFullCommandContent(content);

          return jsonResponse({
            success: true,
            command: {
              name: frontmatter.name || cmdName,  // Prefer frontmatter name over file name
              fileName: cmdName,  // Always return the actual file name for reference
              path: cmdPath,
              scope,
              frontmatter,
              body,
            }
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to get command' },
            500
          );
        }
      }

      // PUT /api/command-item/:name - Update command
      if (pathname.startsWith('/api/command-item/') && request.method === 'PUT') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<CommandFrontmatter>;
            body: string;
            agentDir?: string; // Optional: explicit project directory
            newFileName?: string; // Optional: rename file if provided
          };

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : commandsDir;
          let currentFileName = cmdName;
          let cmdPath = join(baseDir, `${currentFileName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          // Handle file rename if newFileName is provided and different
          if (payload.newFileName && payload.newFileName !== currentFileName) {
            const newFileName = payload.newFileName;

            // Validate new file name
            if (!isValidItemName(newFileName)) {
              return jsonResponse({ success: false, error: 'Invalid new file name' }, 400);
            }

            const newCmdPath = join(baseDir, `${newFileName}.md`);

            // Check for conflict
            if (existsSync(newCmdPath)) {
              return jsonResponse({ success: false, error: `指令文件 "${newFileName}.md" 已存在，请使用其他名称` }, 409);
            }

            // Atomic-like operation: prepare content first, then rename
            // If rename fails, nothing is lost. If write fails after rename, file is renamed but content unchanged.
            const content = serializeCommandContent(payload.frontmatter, payload.body);

            // Rename the file
            renameSync(cmdPath, newCmdPath);
            cmdPath = newCmdPath;
            currentFileName = newFileName;

            // Write content to new location
            writeFileSync(cmdPath, content, 'utf-8');

            // User command renamed — re-sync to fix old dangling symlink + create new one
            if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
            return jsonResponse({
              success: true,
              path: cmdPath,
              fileName: currentFileName
            });
          }

          // No rename, just update content
          const content = serializeCommandContent(payload.frontmatter, payload.body);
          writeFileSync(cmdPath, content, 'utf-8');

          return jsonResponse({
            success: true,
            path: cmdPath,
            fileName: currentFileName
          });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to update command' },
            500
          );
        }
      }

      // DELETE /api/command-item/:name - Delete command
      if (pathname.startsWith('/api/command-item/') && request.method === 'DELETE') {
        try {
          const cmdName = decodeURIComponent(pathname.replace('/api/command-item/', ''));
          if (!isValidItemName(cmdName)) {
            return jsonResponse({ success: false, error: 'Invalid command name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');

          // Use explicit agentDir if provided for project scope
          const { commandsDir } = getProjectBaseDirs(queryAgentDir);
          const baseDir = scope === 'user' ? userCommandsBaseDir : commandsDir;
          const cmdPath = join(baseDir, `${cmdName}.md`);

          if (!existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command not found' }, 404);
          }

          rmSync(cmdPath);
          // User command deleted — re-sync to remove dangling symlinks in project
          if (scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/command-item] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to delete command' },
            500
          );
        }
      }

      // POST /api/command-item/create - Create new command
      if (pathname === '/api/command-item/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          // Sanitize name for filename (supports Unicode characters like Chinese)
          const fileName = sanitizeFolderName(payload.name);
          const baseDir = payload.scope === 'user' ? userCommandsBaseDir : projectCommandsBaseDir;

          // Ensure directory exists
          if (!existsSync(baseDir)) {
            mkdirSync(baseDir, { recursive: true });
          }

          const cmdPath = join(baseDir, `${fileName}.md`);

          if (existsSync(cmdPath)) {
            return jsonResponse({ success: false, error: 'Command already exists' }, 409);
          }

          // Create command file with default content
          const frontmatter: Partial<CommandFrontmatter> = {
            name: payload.name,
            description: payload.description || '',
          };
          const body = `在这里编写指令的详细内容...`;
          const content = serializeCommandContent(frontmatter, body);

          writeFileSync(cmdPath, content, 'utf-8');

          // New user command — sync symlink into project so SDK can discover it
          if (payload.scope === 'user' && agentDir) syncProjectUserConfig(agentDir);
          return jsonResponse({ success: true, path: cmdPath, name: fileName });
        } catch (error) {
          console.error('[api/command-item/create] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to create command' },
            500
          );
        }
      }

      // ============= SUB-AGENTS API =============

      const userAgentsBaseDir = join(homeDir, '.pm-copilot', 'agents');

      // Helper: Get project agents directory (supports explicit agentDir parameter)
      const getProjectAgentsDir = (queryAgentDir: string | null) => {
        if (queryAgentDir && !isValidAgentDir(queryAgentDir).valid) {
          queryAgentDir = null;
        }
        const effectiveAgentDir = queryAgentDir || currentAgentDir;
        const hasValidDir = effectiveAgentDir && existsSync(effectiveAgentDir);
        return hasValidDir ? join(effectiveAgentDir, '.claude', 'agents') : '';
      };

      // GET /api/agents - List all agents (with scope filter)
      if (pathname === '/api/agents' && request.method === 'GET') {
        try {
          const scope = url.searchParams.get('scope') || 'all';
          const queryAgentDir = url.searchParams.get('agentDir');
          const projAgentsDir = getProjectAgentsDir(queryAgentDir);

          let agents: Array<{ name: string; description: string; scope: 'user' | 'project'; path: string; folderName: string }> = [];

          if ((scope === 'all' || scope === 'project') && projAgentsDir) {
            agents = agents.concat(scanAgents(projAgentsDir, 'project'));
          }
          if (scope === 'all' || scope === 'user') {
            agents = agents.concat(scanAgents(userAgentsBaseDir, 'user'));
          }

          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Failed to list agents' },
            500
          );
        }
      }

      // GET /api/agent/sync-check - Check if there are agents to sync from Claude Code
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/sync-check' && request.method === 'GET') {
        try {
          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const claudeFolders = readdirSync(claudeAgentsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
            .map(entry => entry.name);

          if (claudeFolders.length === 0) {
            return jsonResponse({ canSync: false, count: 0, folders: [] });
          }

          const pmCopilotFolders = new Set<string>();
          if (existsSync(userAgentsBaseDir)) {
            const entries = readdirSync(userAgentsBaseDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) pmCopilotFolders.add(entry.name);
            }
          }

          const newFolders = claudeFolders.filter(f => !pmCopilotFolders.has(f) && isValidFolderName(f));
          const conflictFolders = claudeFolders.filter(f => pmCopilotFolders.has(f) && isValidFolderName(f));
          const allValidFolders = claudeFolders.filter(f => isValidFolderName(f));
          return jsonResponse({
            canSync: allValidFolders.length > 0,
            count: allValidFolders.length,
            folders: allValidFolders,
            newFolders,
            conflictFolders,
          });
        } catch (error) {
          console.error('[api/agent/sync-check] Error:', error);
          return jsonResponse({ canSync: false, count: 0, folders: [], error: error instanceof Error ? error.message : 'Check failed' }, 500);
        }
      }

      // POST /api/agent/sync-from-claude - Sync agents from Claude Code to PM Copilot
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      // Supports conflict handling: mode = 'skip' (default) | 'overwrite'
      if (pathname === '/api/agent/sync-from-claude' && request.method === 'POST') {
        try {
          const payload = await request.json().catch(() => ({})) as { mode?: 'skip' | 'overwrite'; folders?: string[] };
          const conflictMode = payload.mode || 'skip';
          const selectedFolders = payload.folders; // Optional: sync only these specific folders

          const claudeAgentsDir = join(homeDir, '.claude', 'agents');
          if (!existsSync(claudeAgentsDir)) {
            return jsonResponse({ success: false, synced: 0, failed: 0, skipped: 0, overwritten: 0, error: 'Claude Code agents directory not found' }, 404);
          }

          const claudeFolders = readdirSync(claudeAgentsDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.') && isValidFolderName(entry.name))
            .map(entry => entry.name);

          // Filter to selected folders if specified
          const foldersToSync = selectedFolders
            ? claudeFolders.filter(f => selectedFolders.includes(f))
            : claudeFolders;

          if (foldersToSync.length === 0) {
            return jsonResponse({ success: true, synced: 0, failed: 0, skipped: 0, overwritten: 0, message: 'No agents to sync' });
          }

          if (!existsSync(userAgentsBaseDir)) {
            mkdirSync(userAgentsBaseDir, { recursive: true });
          }

          let synced = 0;
          let failed = 0;
          let skipped = 0;
          let overwritten = 0;
          const errors: string[] = [];
          const conflicts: string[] = [];

          for (const folder of foldersToSync) {
            const srcDir = join(claudeAgentsDir, folder);
            const destDir = join(userAgentsBaseDir, folder);
            const alreadyExists = existsSync(destDir);

            if (alreadyExists) {
              if (conflictMode === 'skip') {
                skipped++;
                conflicts.push(folder);
                continue;
              }
              // overwrite: remove existing first
              rmSync(destDir, { recursive: true, force: true });
              overwritten++;
            }

            try {
              copyDirRecursiveSync(srcDir, destDir, '[api/agent/sync-from-claude]');
              synced++;

              // Auto-generate _meta.json from frontmatter
              const mdPath = join(destDir, `${folder}.md`);
              const metaPath = join(destDir, '_meta.json');
              if (existsSync(mdPath) && !existsSync(metaPath)) {
                try {
                  const content = readFileSync(mdPath, 'utf-8');
                  const { name: agentName } = parseAgentFrontmatter(content);
                  const meta = {
                    displayName: agentName || folder,
                    author: 'claude-code-sync',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  };
                  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                } catch { /* _meta.json generation is optional */ }
              }
            } catch (copyError) {
              failed++;
              errors.push(`${folder}: ${copyError instanceof Error ? copyError.message : 'Unknown error'}`);
              console.error(`[api/agent/sync-from-claude] Failed to copy "${folder}":`, copyError);
            }
          }

          return jsonResponse({
            success: true,
            synced,
            failed,
            skipped,
            overwritten,
            conflicts,
            errors: errors.length > 0 ? errors : undefined,
          });
        } catch (error) {
          console.error('[api/agent/sync-from-claude] Error:', error);
          return jsonResponse({ success: false, synced: 0, failed: 0, error: error instanceof Error ? error.message : 'Sync failed' }, 500);
        }
      }

      // POST /api/agent/create - Create new agent
      // NOTE: Must be before /api/agent/:name to avoid wildcard capture
      if (pathname === '/api/agent/create' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            name: string;
            scope: 'user' | 'project';
            description?: string;
            agentDir?: string;
          };

          if (!payload.name) {
            return jsonResponse({ success: false, error: 'Name is required' }, 400);
          }

          const folderName = sanitizeFolderName(payload.name);
          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;

          if (!baseDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }

          const agentFolderDir = join(baseDir, folderName);
          if (existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent already exists' }, 409);
          }

          mkdirSync(agentFolderDir, { recursive: true });

          const frontmatter: Partial<AgentFrontmatter> = {
            name: payload.name,
            description: payload.description || `Description for ${payload.name}`,
          };
          const body = `# ${payload.name}\n\nDescribe your agent instructions here.`;
          const content = serializeAgentContent(frontmatter, body);

          const agentPath = join(agentFolderDir, `${folderName}.md`);
          writeFileSync(agentPath, content, 'utf-8');

          // Create default _meta.json
          writeAgentMeta(agentFolderDir, {
            displayName: payload.name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });

          return jsonResponse({ success: true, path: agentPath, folderName });
        } catch (error) {
          console.error('[api/agent/create] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to create agent' }, 500);
        }
      }

      // GET /api/agents/workspace-config - Read workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: true, config: { local: {}, global_refs: {} } });
          }
          const config = readWorkspaceConfig(effectiveDir);
          return jsonResponse({ success: true, config });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to read config' }, 500);
        }
      }

      // PUT /api/agents/workspace-config - Update workspace agent config
      if (pathname === '/api/agents/workspace-config' && request.method === 'PUT') {
        try {
          const payload = await request.json() as { config: AgentWorkspaceConfig; agentDir?: string };
          const effectiveDir = (payload.agentDir && isValidAgentDir(payload.agentDir).valid ? payload.agentDir : currentAgentDir) || '';
          if (!effectiveDir) {
            return jsonResponse({ success: false, error: '请先设置工作目录' }, 400);
          }
          writeWorkspaceConfig(effectiveDir, payload.config);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/workspace-config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update config' }, 500);
        }
      }

      // GET /api/agents/enabled - Get enabled agents as SDK definitions
      if (pathname === '/api/agents/enabled' && request.method === 'GET') {
        try {
          const queryAgentDir = url.searchParams.get('agentDir');
          const effectiveDir = (queryAgentDir && isValidAgentDir(queryAgentDir).valid ? queryAgentDir : currentAgentDir) || '';
          const projAgentsDir = effectiveDir ? join(effectiveDir, '.claude', 'agents') : '';
          const agents = loadEnabledAgents(projAgentsDir, userAgentsBaseDir);
          return jsonResponse({ success: true, agents });
        } catch (error) {
          console.error('[api/agents/enabled] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to load agents' }, 500);
        }
      }

      // POST /api/agents/set - Set agents and trigger session resume
      if (pathname === '/api/agents/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { agents: Record<string, unknown> };
          // The payload.agents is already in SDK AgentDefinition format
          setAgents(payload.agents as Record<string, import('@anthropic-ai/claude-agent-sdk').AgentDefinition>);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agents/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
        }
      }

      // GET /api/supported-models - Get available models from SDK
      // Spawns a lightweight SDK subprocess (same pattern as provider verify)
      if (pathname === '/api/supported-models' && request.method === 'GET') {
        try {
          const { fetchSdkSupportedModels } = await import('./provider-verify');
          const models = await fetchSdkSupportedModels();
          return jsonResponse({ models });
        } catch (error) {
          console.error('[api/supported-models] Error:', error);
          return jsonResponse({ models: [], error: error instanceof Error ? error.message : 'Failed to get models' });
        }
      }

      // POST /api/model/set - Set default model for this session
      if (pathname === '/api/model/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { model?: string };
          if (!payload?.model) {
            return jsonResponse({ success: false, error: 'model is required' }, 400);
          }
          if (shouldUseExternalRuntime()) {
            await setExternalModel(payload.model);
          } else {
            setSessionModel(payload.model);
          }
          updateModelInfoInClaudeMd();
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/model/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set model' }, 500);
        }
      }

      // POST /api/provider/set - Set provider env for this session (called by Rust IM router on sidecar creation)
      if (pathname === '/api/provider/set' && request.method === 'POST') {
        try {
          const payload = await request.json() as { providerEnv?: Record<string, unknown> };
          const { setSessionProviderEnv } = await import('./agent-session');
          // Normalize null → undefined (Rust sends { "providerEnv": null } when clearing)
          setSessionProviderEnv((payload?.providerEnv ?? undefined) as import('./agent-session').ProviderEnv | undefined);
          updateModelInfoInClaudeMd();
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/provider/set] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);
        }
      }

      // POST /api/session/permission-mode - Set permission mode for this session (called by Rust IM router)
      if (pathname === '/api/session/permission-mode' && request.method === 'POST') {
        try {
          const payload = await request.json() as { permissionMode?: string };
          if (!payload?.permissionMode) {
            return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);
          }
          if (shouldUseExternalRuntime()) {
            await setExternalPermissionMode(payload.permissionMode);
            return jsonResponse({ success: true });
          }
          const { setSessionPermissionMode } = await import('./agent-session');
          setSessionPermissionMode(payload.permissionMode as import('./agent-session').PermissionMode);
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/session/permission-mode] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);
        }
      }

      // GET /api/session/config - Read sidecar's current config state
      // Used by Tabs joining an existing sidecar (e.g. IM Bot session) to adopt
      // the session's config instead of pushing their own.
      if (pathname === '/api/session/config' && request.method === 'GET') {
        try {
          const { getSessionModel, getMcpServers, getAgents, getSessionPermissionMode } = await import('./agent-session');
          const model = getSessionModel();
          const mcpServers = getMcpServers();
          const agents = getAgents();
          const permissionMode = getSessionPermissionMode();
          return jsonResponse({
            success: true,
            model: model ?? null,
            mcpServerIds: mcpServers?.map(s => s.id) ?? null,
            agentNames: agents ? Object.keys(agents) : null,
            permissionMode,
          });
        } catch (error) {
          console.error('[api/session/config] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);
        }
      }

      // GET /api/agent/:name - Get agent detail
      if (pathname.startsWith('/api/agent/') && request.method === 'GET') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
          const agentPath = join(baseDir, agentName, `${agentName}.md`);

          if (!existsSync(agentPath)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          const content = readFileSync(agentPath, 'utf-8');
          const { frontmatter, body } = parseFullAgentContent(content);
          const meta = readAgentMeta(join(baseDir, agentName));

          return jsonResponse({
            success: true,
            agent: {
              name: frontmatter.name || agentName,
              folderName: agentName,
              path: agentPath,
              scope,
              frontmatter,
              body,
              ...(meta ? { meta } : {}),
            }
          });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get agent' }, 500);
        }
      }

      // PUT /api/agent/:name - Update agent (with optional folder rename)
      if (pathname.startsWith('/api/agent/') && request.method === 'PUT') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const payload = await request.json() as {
            scope: 'user' | 'project';
            frontmatter: Partial<AgentFrontmatter>;
            body: string;
            newFolderName?: string;
            agentDir?: string;
            meta?: AgentMeta;
          };

          const agentsDir = getProjectAgentsDir(payload.agentDir || null);
          const baseDir = payload.scope === 'user' ? userAgentsBaseDir : agentsDir;
          let currentFolderName = agentName;
          let agentFolderDir = join(baseDir, currentFolderName);
          let agentPath = join(agentFolderDir, `${currentFolderName}.md`);

          if (!existsSync(agentPath)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          // Handle folder rename if newFolderName is provided and different
          if (payload.newFolderName && payload.newFolderName !== currentFolderName) {
            const newFolderName = payload.newFolderName;
            if (!isValidItemName(newFolderName)) {
              return jsonResponse({ success: false, error: 'Invalid new folder name' }, 400);
            }
            const newAgentDir = join(baseDir, newFolderName);
            if (existsSync(newAgentDir)) {
              return jsonResponse({ success: false, error: `Agent 文件夹 "${newFolderName}" 已存在，请使用其他名称` }, 409);
            }

            const content = serializeAgentContent(payload.frontmatter, payload.body);
            renameSync(agentFolderDir, newAgentDir);
            agentFolderDir = newAgentDir;
            currentFolderName = newFolderName;

            // Rename the .md file inside to match new folder name
            const oldMdPath = join(agentFolderDir, `${agentName}.md`);
            agentPath = join(agentFolderDir, `${newFolderName}.md`);
            if (existsSync(oldMdPath)) {
              renameSync(oldMdPath, agentPath);
            }

            writeFileSync(agentPath, content, 'utf-8');
            // Update _meta.json displayName to match the new name (scanAgents uses displayName as priority)
            const existingMeta = readAgentMeta(agentFolderDir);
            const updatedMeta = { ...existingMeta, ...payload.meta, displayName: payload.frontmatter.name || newFolderName, updatedAt: new Date().toISOString() };
            writeAgentMeta(agentFolderDir, updatedMeta);
            return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
          }

          // No rename, just update content
          const content = serializeAgentContent(payload.frontmatter, payload.body);
          writeFileSync(agentPath, content, 'utf-8');
          // Always sync _meta.json displayName with frontmatter name
          const existingMeta = readAgentMeta(agentFolderDir);
          if (payload.meta || (payload.frontmatter.name && payload.frontmatter.name !== existingMeta?.displayName)) {
            const updatedMeta = { ...existingMeta, ...payload.meta, updatedAt: new Date().toISOString() };
            if (payload.frontmatter.name) updatedMeta.displayName = payload.frontmatter.name;
            writeAgentMeta(agentFolderDir, updatedMeta);
          }
          return jsonResponse({ success: true, path: agentPath, folderName: currentFolderName });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to update agent' }, 500);
        }
      }

      // DELETE /api/agent/:name - Delete agent
      if (pathname.startsWith('/api/agent/') && request.method === 'DELETE') {
        try {
          const agentName = decodeURIComponent(pathname.replace('/api/agent/', ''));
          if (!isValidItemName(agentName)) {
            return jsonResponse({ success: false, error: 'Invalid agent name' }, 400);
          }
          const scope = url.searchParams.get('scope') || 'project';
          const queryAgentDir = url.searchParams.get('agentDir');
          const agentsDir = getProjectAgentsDir(queryAgentDir);
          const baseDir = scope === 'user' ? userAgentsBaseDir : agentsDir;
          const agentFolderDir = join(baseDir, agentName);

          if (!existsSync(agentFolderDir)) {
            return jsonResponse({ success: false, error: 'Agent not found' }, 404);
          }

          rmSync(agentFolderDir, { recursive: true, force: true });
          return jsonResponse({ success: true });
        } catch (error) {
          console.error('[api/agent] Error:', error);
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to delete agent' }, 500);
        }
      }

      // ============= END SLASH COMMANDS API =============

      // ============= IM BOT API =============
      // These endpoints are called by the Rust IM layer (SessionRouter)

      // POST /api/im/chat — Process an IM message through the AI agent
      if (pathname === '/api/im/chat' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as {
            message: string;
            source: 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group';
            sourceId: string;
            senderName?: string;
            permissionMode?: string;
            providerEnv?: ProviderEnv;
            model?: string;
            images?: Array<{ name: string; mimeType: string; data: string }>;
            botId?: string;
            botName?: string;
            // Group context fields (v0.1.28)
            sourceType?: 'group';
            groupName?: string;
            groupPlatform?: string;
            groupActivation?: 'mention' | 'always';
            isFirstGroupTurn?: boolean;
            pendingHistory?: string;
            groupToolsDeny?: string[];
            replyToBody?: string;
            groupSystemPrompt?: string;
            isMention?: boolean;
            messageCount?: number;
            // Bridge plugin tools context (v0.1.42)
            bridgePort?: number;
            bridgePluginId?: string;
            bridgeEnabledToolGroups?: string[];
            senderId?: string;
            senderIsOwner?: boolean;
          };

          const hasContent = payload.message?.trim() || (payload.images && payload.images.length > 0);
          if (!hasContent) {
            return jsonResponse({ success: false, error: 'Message or images required' }, 400);
          }

          // Set IM cron context for the im-cron tool (v0.1.21)
          if (payload.botId && process.env.PM_COPILOT_MANAGEMENT_PORT) {
            const { getSessionModel } = await import('./agent-session');
            setImCronContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0], // "telegram" or "feishu"
              workspacePath: agentDir,
              model: payload.model ?? getSessionModel(),
              permissionMode: payload.permissionMode,
              providerEnv: payload.providerEnv ? {
                baseUrl: payload.providerEnv.baseUrl,
                apiKey: payload.providerEnv.apiKey,
                authType: payload.providerEnv.authType,
                apiProtocol: payload.providerEnv.apiProtocol,
                maxOutputTokens: payload.providerEnv.maxOutputTokens,
                maxOutputTokensParamName: payload.providerEnv.maxOutputTokensParamName,
                upstreamFormat: payload.providerEnv.upstreamFormat,
              } : undefined,
            });

            // Set IM media context for the im-media tool (send_media)
            setImMediaContext({
              botId: payload.botId,
              chatId: payload.sourceId,
              platform: payload.source.split('_')[0],
            });

            // Set Bridge tools context if this is an OpenClaw plugin session with tools
            // Async: fetches tool definitions from Bridge and creates dynamic MCP server
            if (payload.bridgePort && payload.bridgePluginId) {
              // Derive sourceType from source string (e.g. "feishu_private" → "private")
              const bridgeSourceType = payload.source?.split('_')[1] as string | undefined;
              await setImBridgeToolsContext({
                bridgePort: payload.bridgePort,
                pluginId: payload.bridgePluginId,
                enabledToolGroups: payload.bridgeEnabledToolGroups || [],
                senderId: payload.senderId,
                chatId: payload.sourceId,
                isOwner: payload.senderIsOwner ?? false,
                sourceType: bridgeSourceType,
              });
            }
          }

          // Set IM interaction scenario (L1 + L2-im + L3-heartbeat).
          // Must be set BEFORE enqueueUserMessage so startStreamingSession() picks it up.
          {
            const [imPlatform, imSourceType] = payload.source.split('_') as ['telegram' | 'feishu', 'private' | 'group'];
            setInteractionScenario({
              type: 'im',
              platform: imPlatform,
              sourceType: imSourceType,
              botName: payload.botName,
            });
          }

          // Build final message with group context (v0.1.59 — rewritten per PRD group_chat_prompt)
          let finalMessage = payload.message || '';
          if (payload.sourceType === 'group') {
            const parts: string[] = [];
            const isAlways = payload.groupActivation === 'always';
            // Sanitize untrusted fields to prevent prompt injection via display names
            // (e.g., a sender name containing "</system-reminder>" could break out of the tag)
            const sanitize = (s: string) => s.replace(/[<>[\]]/g, '').replace(/\n/g, ' ').trim();
            const botName = sanitize(payload.botName ?? 'AI');
            const platformLabel = sanitize(payload.groupPlatform ?? '');
            const messageCount = payload.messageCount ?? 0;

            // ── <system-reminder> injection strategy ──
            // Full version: first turn + every 10 turns (survives context compaction)
            // Brief version: every turn in Always mode (prevents multi-bot confusion)
            const shouldInjectFullRules = payload.isFirstGroupTurn || (messageCount > 0 && messageCount % 10 === 0);

            if (shouldInjectFullRules) {
              // Full system-reminder with group info + rules
              const safeGroupName = sanitize(payload.groupName ?? '未知群聊');
              let reminder = `<system-reminder>\n[群聊信息]\n你正在「${safeGroupName}」${platformLabel}群聊中。你的名字是「${botName}」。`;
              if (isAlways) {
                reminder += '\n激活模式：全部消息（你会收到群里所有消息，包括不是发给你的）。';
              } else {
                reminder += '\n激活模式：仅 @提及（只有被 @、被回复或使用 /ask 时才会收到消息）。';
              }
              reminder += '\n你的回复会自动发送到群里，直接回复即可。\n群内不同人的消息会以 [from: 名字 时间] 标注发送者。';
              if (isAlways) {
                const mentionExample = payload.botName ? `（即 @${botName}）` : '';
                reminder += `\n\n[回复规则]\n你必须非常克制，大多数消息不需要你回复。仅在以下情况回复：\n1. 消息明确 @你${mentionExample}\n2. 消息回复了你之前的消息\n3. 有人直接向你提问或请求帮助\n4. 你确信能提供明确价值的信息\n\n以下情况必须保持沉默：\n- 消息 @的是其他人或其他机器人\n- 普通闲聊、与你无关的讨论\n- 你不确定是否该回复时\n\n不需要回复时，只回复 <NO_REPLY>，不要添加任何其他内容。`;
              }
              if (payload.groupSystemPrompt) {
                reminder += `\n\n[群聊指令]\n${payload.groupSystemPrompt}`;
              }
              reminder += '\n</system-reminder>';
              parts.push(reminder);
            } else if (isAlways) {
              // Brief per-turn reminder (Always mode only) — prevents multi-bot confusion
              parts.push(`<system-reminder>\n你是「${botName}」，当前处于群聊的全部消息模式 — 你会收到群聊内的全部信息，你需要自主判断是否需要回复消息，与自己无关的消息不要回复，@其他人的消息不要回复。当你判断不需要回复消息时，只输出字符<NO_REPLY>\n</system-reminder>`);
            }

            // Pending history (accumulated non-triggered messages, Mention mode only)
            if (payload.pendingHistory) {
              parts.push(payload.pendingHistory);
            }
            // Quoted reply context (threaded reply from Bridge plugins)
            if (payload.replyToBody) {
              parts.push(`[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}`);
            }
            // Mention context tag (Always mode only) + sender + message
            const now = new Date();
            const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
            let messageBlock = '';
            if (isAlways) {
              messageBlock += payload.isMention ? '[本条消息 @了你]\n' : '[本条消息未 @你]\n';
            }
            messageBlock += payload.senderName ? `[from: ${sanitize(payload.senderName)} ${ts}]\n` : '';
            messageBlock += finalMessage;
            parts.push(messageBlock);
            finalMessage = parts.join('\n\n');
          } else if (payload.replyToBody) {
            // Private/DM quoted reply — prepend context before message
            finalMessage = `[引用回复]\n> ${payload.replyToBody.split('\n').join('\n> ')}\n\n${finalMessage}`;
          }

          // Set group tool deny list (v0.1.28): block dangerous tools in group context
          // Default: ['Bash', 'Edit', 'Write'] when in group mode with no explicit config
          const DEFAULT_GROUP_TOOLS_DENY = ['Bash', 'Edit', 'Write'];
          if (payload.sourceType === 'group') {
            // undefined = not configured → use default; explicit [] = allow all tools
            const denyList = payload.groupToolsDeny !== undefined ? payload.groupToolsDeny : DEFAULT_GROUP_TOOLS_DENY;
            setGroupToolsDeny(denyList);
          } else {
            setGroupToolsDeny([]);
          }

          const metadata = {
            source: payload.source,
            sourceId: payload.sourceId,
            senderName: payload.senderName,
          };

          // ─── External Runtime branch (CC/Codex) ───
          if (shouldUseExternalRuntime()) {
            if (payload.images?.length) {
              console.warn(`[im/chat] External runtime does not support image attachments, ${payload.images.length} image(s) dropped`);
            }
            const imSource = payload.source.split('_')[0];
            const imSourceType = payload.source.includes('group') ? 'group' as const : 'private' as const;
            const ccResult = await sendExternalMessage(
              finalMessage, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'agent-channel' as const, platform: imSource, sourceType: imSourceType, botName: payload.botName },
                permissionMode: 'fullAgency',
                model: undefined, // CC uses its own configured model
              },
            );
            if (!ccResult.queued) {
              return jsonResponse({ success: false, error: ccResult.error ?? 'Failed to send via external runtime' }, 503);
            }
          } else {
            // Use enqueueUserMessage — shares the same persistent generator as Desktop
            const result = await enqueueUserMessage(
              finalMessage,
              payload.images, // forward image attachments from Telegram
              (payload.permissionMode as PermissionMode) ?? 'plan',
              payload.model ?? undefined, // model: per-message from Rust /model command
              payload.providerEnv ?? undefined, // providerEnv: forwarded from Rust IM (undefined = keep current)
              metadata,
            );

            if (result.error) {
              return jsonResponse({ success: false, error: result.error }, 503);
            }
          }

          // Mark session source (only on first IM message for this session)
          const currentSessionId = getSessionId();
          if (currentSessionId) {
            const sessionMeta = getSessionMetadata(currentSessionId);
            if (sessionMeta && !sessionMeta.source) {
              updateSessionMetadata(currentSessionId, { source: payload.source });
            }
          }

          // Notify Desktop: a new IM user message was enqueued
          broadcast('im:message_received', {
            sessionId: currentSessionId,
            source: payload.source,
            senderName: payload.senderName ?? payload.sourceId,
            content: payload.message,
          });

          // === SSE Stream: stream text deltas to Rust IM for Telegram draft editing ===
          const encoder = new TextEncoder();
          let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
          let safetyTimer: ReturnType<typeof setTimeout> | null = null;
          let closed = false;
          let imAccText = ''; // Current block's accumulated text
          let lastBlockText = ''; // Preserved across block-end for NO_REPLY detection

          const stream = new ReadableStream({
            start(controller) {
              // Immediately flush headers by sending an SSE comment
              // (Bun buffers the response until the first body chunk is written)
              controller.enqueue(encoder.encode(': connected\n\n'));

              // 15s heartbeat (keep-alive during tool calls; Rust read_timeout=300s)
              heartbeatTimer = setInterval(() => {
                try { if (!closed) controller.enqueue(encoder.encode(': ping\n\n')); }
                catch { /* stream closed */ }
              }, 15000);

              const sendEvent = (data: object) => {
                if (closed) return;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              };
              const clearCallback = shouldUseExternalRuntime() ? setExternalImStreamCallback : setImStreamCallback;
              const closeStream = () => {
                if (closed) return;
                closed = true;
                if (heartbeatTimer) clearInterval(heartbeatTimer);
                if (safetyTimer) clearTimeout(safetyTimer);
                clearCallback(null);
                try { controller.close(); } catch { /* already closed */ }
              };

              // 3600s (60 min) safety timeout — aligned with cron task timeout
              safetyTimer = setTimeout(() => {
                if (!closed) {
                  // Flush any remaining text as final block
                  if (imAccText) {
                    sendEvent({ type: 'block-end', text: imAccText });
                    imAccText = '';
                  }
                  // Send 'error' (not 'complete') to prevent Rust from treating timeout as success
                  sendEvent({ type: 'error', error: 'IM 响应超时（60分钟），请重新发送' });
                  closeStream();
                }
              }, 3_600_000);

              // Route IM stream callback to the appropriate runtime's relay
              const setCallback = shouldUseExternalRuntime() ? setExternalImStreamCallback : setImStreamCallback;
              setCallback((event, data) => {
                if (event === 'permission-request') {
                  // Forward permission request to Rust for interactive approval
                  sendEvent({ type: 'permission-request', ...JSON.parse(data) });
                } else if (event === 'delta') {
                  imAccText += data;
                  sendEvent({ type: 'partial', text: imAccText });
                } else if (event === 'block-end') {
                  lastBlockText = imAccText; // Preserve for NO_REPLY detection in 'complete'
                  sendEvent({ type: 'block-end', text: imAccText });
                  imAccText = ''; // Reset for next block
                } else if (event === 'complete') {
                  // Group "always" mode: detect <NO_REPLY> → send silent complete
                  // Check lastBlockText because imAccText is already cleared by block-end
                  if (payload.sourceType === 'group' && payload.groupActivation === 'always') {
                    const trimmed = (imAccText || lastBlockText).trim();
                    if (trimmed === '<NO_REPLY>' || trimmed === 'NO_REPLY') {
                      imAccText = '';
                      sendEvent({ type: 'complete', sessionId: getSessionId(), silent: true });
                      broadcast('im:response_sent', { sessionId: getSessionId() });
                      closeStream();
                      return;
                    }
                  }
                  // Flush any un-ended text
                  if (imAccText) {
                    sendEvent({ type: 'block-end', text: imAccText });
                    imAccText = '';
                  }
                  sendEvent({ type: 'complete', sessionId: getSessionId() });
                  // Notify Desktop: IM turn completed
                  broadcast('im:response_sent', {
                    sessionId: getSessionId(),
                  });
                  closeStream();
                } else if (event === 'activity') {
                  // Non-text block started (thinking, tool_use) — Rust uses this for placeholder
                  sendEvent({ type: 'activity' });
                } else if (event === 'error') {
                  sendEvent({ type: 'error', error: data });
                  closeStream();
                }
              });
            },
            cancel() {
              closed = true;
              if (heartbeatTimer) clearInterval(heartbeatTimer);
              if (safetyTimer) clearTimeout(safetyTimer);
              (shouldUseExternalRuntime() ? setExternalImStreamCallback : setImStreamCallback)(null);
            }
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
              'Connection': 'keep-alive',
              'X-Accel-Buffering': 'no',
            },
          });
        } catch (error) {
          console.error('[im/chat] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'IM chat error' },
            500,
          );
        }
      }

      // POST /api/im/heartbeat — Execute a heartbeat check (synchronous JSON response, not SSE)
      if (pathname === '/api/im/heartbeat' && request.method === 'POST') {
        // Track drained events so they can be re-queued on pre-enqueue failures
        let drainedEvents: Array<{ event: string; content: string; timestamp: number; taskId?: string }> = [];
        let messageEnqueued = false;
        try {
          const payload = await request.json() as {
            prompt: string;
            source: string;
            sourceId: string;
            ackMaxChars?: number;
            isHighPriority?: boolean;
          };

          if (!payload.prompt) {
            return jsonResponse({ status: 'silent', reason: 'empty' });
          }

          // --- Gate: Read HEARTBEAT.md from workspace root ---
          // The actual checklist lives in HEARTBEAT.md, not in config.
          // If the file body is empty/missing AND no system events → skip AI call.
          const heartbeatMdPath = join(currentAgentDir, 'HEARTBEAT.md');
          let heartbeatMdContent = '';
          try {
            const rawContent = readFileSync(heartbeatMdPath, 'utf-8');
            // Strip YAML frontmatter — only the body is used as prompt
            heartbeatMdContent = stripYamlFrontmatter(rawContent);
          } catch {
            // File doesn't exist — create with descriptive frontmatter
            try {
              const defaultHeartbeat = `---
description: >
  心跳清单 — Agent 按心跳间隔定时苏醒时会读取本文件的正文部分作为指令执行。
  正文为空时心跳会直接跳过，不请求 AI（节省 token）。
  你可以在正文中写入需要 Agent 定期检查的任务、监控项或提醒事项。
---
`;
              writeFileSync(heartbeatMdPath, defaultHeartbeat, 'utf-8');
              console.log(`[im/heartbeat] Created HEARTBEAT.md with frontmatter at ${heartbeatMdPath}`);
            } catch (writeErr) {
              console.warn(`[im/heartbeat] Failed to create HEARTBEAT.md: ${writeErr}`);
            }
          }

          // Drain pending system events
          drainedEvents = drainSystemEvents();

          // Separate cron events from other events
          const cronEvents = drainedEvents.filter(e => e.event === 'cron_complete');
          const otherEvents = drainedEvents.filter(e => e.event !== 'cron_complete');

          // Skip AI call if HEARTBEAT.md is empty AND no system events.
          // Always skip regardless of priority — CronComplete events are in drainedEvents
          // so they won't be affected. The isHighPriority flag is for bypassing per-channel
          // enabled=false gate (agent-level heartbeat delegation), NOT for skipping this check.
          if (!heartbeatMdContent && drainedEvents.length === 0) {
            console.log('[im/heartbeat] Skipped: HEARTBEAT.md is empty and no pending events');
            return jsonResponse({ status: 'silent', reason: 'empty_heartbeat_md' });
          }

          let enrichedPrompt: string;

          if (cronEvents.length > 0) {
            // Cron event prompt: completely replaces standard heartbeat prompt
            enrichedPrompt = buildCronEventPrompt(cronEvents);
            // Push back non-cron events so they aren't lost — next heartbeat cycle will pick them up
            for (const e of otherEvents) {
              systemEventQueue.push(e);
            }
          } else {
            // Standard heartbeat prompt (from Rust)
            enrichedPrompt = payload.prompt;
            if (otherEvents.length > 0) {
              const eventLines = otherEvents.map(
                e => `[System Event: ${e.event}] ${e.content}`
              ).join('\n');
              enrichedPrompt += `\n\n${eventLines}`;
            }
          }

          // Wrap the entire heartbeat message in <system-reminder><HEARTBEAT> tags
          enrichedPrompt = `<system-reminder>\n<HEARTBEAT>\n${enrichedPrompt}\n</HEARTBEAT>\n</system-reminder>`;

          const {
            enqueueUserMessage, waitForSessionIdle, getMessages,
            getSessionModel, getSessionProviderEnv,
            getAndClearLastAgentError,
          } = await import('./agent-session');

          // Inject heartbeat prompt as user message (wrapped in <system-reminder><HEARTBEAT> tags)
          // System prompt is already permanently injected at IM session creation (/api/im/chat)
          // Heartbeat is unattended — bypass all permissions so tool use doesn't block.
          // Pass current model + providerEnv for consistency (undefined is also safe —
          // enqueueUserMessage treats it as "keep current provider" via pit-of-success semantics).
          let text = '';

          if (shouldUseExternalRuntime()) {
            // ─── External Runtime (CC/Codex): heartbeat ───
            const ccResult = await sendExternalMessage(
              enrichedPrompt, undefined, undefined, undefined,
              {
                sessionId: getSessionId(),
                workspacePath: agentDir,
                scenario: { type: 'agent-channel', platform: payload.source?.split('_')[0] ?? 'unknown', sourceType: 'private' },
                permissionMode: 'fullAgency',
                model: undefined,
              },
            );
            if (!ccResult.queued) {
              return jsonResponse({ status: 'error', text: ccResult.error ?? 'External runtime failed' });
            }
            messageEnqueued = true;

            const completed = await waitForExternalSessionIdle(300000, 500);
            if (!completed) {
              return jsonResponse({ status: 'error', text: 'Heartbeat timeout' });
            }

            if (!didLastTurnSucceed()) {
              return jsonResponse({ status: 'error', text: 'External runtime turn failed' });
            }

            text = getLastExternalAssistantText();
          } else {
            // ─── Builtin Runtime: existing path ───
            getAndClearLastAgentError();
            await enqueueUserMessage(
              enrichedPrompt,
              [],
              'fullAgency',
              getSessionModel(),
              getSessionProviderEnv(),
              {
                source: payload.source as 'desktop' | 'telegram_private' | 'telegram_group' | 'feishu_private' | 'feishu_group',
                sourceId: payload.sourceId,
              },
            );
            messageEnqueued = true;

            const completed = await waitForSessionIdle(300000, 500);
            if (!completed) {
              return jsonResponse({ status: 'error', text: 'Heartbeat timeout' });
            }

            const messages = getMessages();
            const lastMsg = [...messages].reverse().find(m => m.role === 'assistant');
            if (!lastMsg) {
              return jsonResponse({ status: 'silent', reason: 'no_response' });
            }

            if (typeof lastMsg.content === 'string') {
              text = lastMsg.content;
            } else if (Array.isArray(lastMsg.content)) {
              text = lastMsg.content
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { type: string; text?: string }) => b.text || '')
                .join('\n');
            }
          }

          // Guard: message was enqueued but assistant response is empty → AI failed to respond
          // (SDK wraps API errors as synthetic assistant messages with empty content in messages[])
          if (!text.trim()) {
            const agentErr = getAndClearLastAgentError();
            return jsonResponse({ status: 'error', text: agentErr || 'AI did not respond' });
          }

          // Check HEARTBEAT_OK
          const ackMaxChars = payload.ackMaxChars ?? 300;
          const result = stripHeartbeatToken(text, ackMaxChars);

          return jsonResponse(result);
        } catch (error) {
          // Re-queue drained events only if they weren't yet sent to the AI
          // (after enqueueUserMessage, events are in the AI prompt — re-queuing would duplicate)
          if (!messageEnqueued && drainedEvents.length > 0) {
            for (const e of drainedEvents) {
              systemEventQueue.push(e);
            }
            console.warn(`[im/heartbeat] Re-queued ${drainedEvents.length} drained events after pre-enqueue failure`);
          }
          console.error('[im/heartbeat] Error:', error);
          return jsonResponse(
            { status: 'error', text: error instanceof Error ? error.message : 'Heartbeat error' },
            500,
          );
        }
      }

      // POST /api/memory/update — Trigger memory update in current session (v0.1.43)
      if (pathname === '/api/memory/update' && request.method === 'POST') {
        try {
          const payload = await request.json() as { source: 'auto' | 'manual' };

          // Read UPDATE_MEMORY.md from workspace root
          const updateMdPath = join(currentAgentDir, 'UPDATE_MEMORY.md');
          let rawContent = '';
          try {
            rawContent = readFileSync(updateMdPath, 'utf-8');
          } catch {
            return jsonResponse({ status: 'skipped', reason: 'file_not_found' });
          }

          // Strip YAML frontmatter
          const promptContent = stripYamlFrontmatter(rawContent);
          if (!promptContent.trim()) {
            return jsonResponse({ status: 'skipped', reason: 'empty_content' });
          }

          // Build prompt with <system-reminder> and <MEMORY_UPDATE> tags
          const now = new Date().toLocaleString('en-US', {
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
          });

          const prompt = `<system-reminder>\n<MEMORY_UPDATE>\n${promptContent}\n\nCurrent time: ${now}\n\n完成所有记忆维护操作后（包括文件读写和 git 操作），仅回复 MEMORY_UPDATE_OK，不要输出其他内容。\n</MEMORY_UPDATE>\n</system-reminder>`;

          const { enqueueUserMessage, waitForSessionIdle, getSessionModel, getSessionProviderEnv } = await import('./agent-session');

          // Inject as user message — memory update is unattended, bypass all permissions
          // so Bash/file tools (git commit, file writes) don't block waiting for approval.
          // Pass current model + providerEnv to avoid triggering provider-switch logic.
          await enqueueUserMessage(prompt, [], 'fullAgency', getSessionModel(), getSessionProviderEnv());

          // Wait synchronously for AI completion (60 min timeout — same as background tasks).
          // Memory update can be slow for large sessions: loading 100K+ token context,
          // reading multiple log/topic files, writing updates, git commit+push.
          const completed = await waitForSessionIdle(3600000, 1000);

          if (completed) {
            console.log(`[memory-update] AI completed memory update (source=${payload.source})`);
            return jsonResponse({ status: 'completed' });
          } else {
            console.warn('[memory-update] AI memory update timed out (10 min)');
            return jsonResponse({ status: 'timeout' });
          }
        } catch (error) {
          console.error('[memory-update] Error:', error);
          return jsonResponse(
            { status: 'error', reason: error instanceof Error ? error.message : 'Unknown error' },
            500,
          );
        }
      }

      // POST /api/im/system-event — Receive system events (e.g. cron task completion) for heartbeat relay
      if (pathname === '/api/im/system-event' && request.method === 'POST') {
        try {
          const { event, content, taskId } = (await request.json()) as {
            event: string;
            content: string;
            taskId?: string;
          };
          // Store in queue for next heartbeat to pick up
          systemEventQueue.push({ event, content, timestamp: Date.now(), taskId });
          console.log(`[system-event] Queued: ${event} (queue size: ${systemEventQueue.length})`);
          return jsonResponse({ ok: true });
        } catch (_err) {
          return jsonResponse({ error: 'Invalid request' }, 400);
        }
      }

      // POST /api/im/permission-response — Handle IM user's permission decision (from approval card/button)
      // Auto-routes to external runtime when active (same pattern as /api/permission/respond).
      if (pathname === '/api/im/permission-response' && request.method === 'POST') {
        try {
          const payload = await request.json() as {
            requestId: string;
            decision: 'deny' | 'allow_once' | 'always_allow';
          };

          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            const approved = payload.decision !== 'deny';
            await respondExternalPermission(payload.requestId, approved);
            return jsonResponse({ success: true });
          }

          const { handlePermissionResponse } = await import('./agent-session');
          const success = handlePermissionResponse(payload.requestId, payload.decision);

          return jsonResponse({ success });
        } catch (error) {
          console.error('[im/permission-response] Error:', error);
          return jsonResponse({ success: false, error: String(error) }, 500);
        }
      }

      // POST /api/im/session/new — Start a new session (preserving workspace)
      if (pathname === '/api/im/session/new' && request.method === 'POST') {
        try {
          // Stop external runtime subprocess if active
          if (shouldUseExternalRuntime() && isExternalSessionActive()) {
            await stopExternalSession();
          }
          await resetSession();
          return jsonResponse({
            sessionId: getSessionId(),
          });
        } catch (error) {
          console.error('[im/session/new] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Reset error' },
            500,
          );
        }
      }

      // POST /api/im/session/switch-workspace — Switch workspace and start new session
      if (pathname === '/api/im/session/switch-workspace' && request.method === 'POST') {
        try {
          const payload = (await request.json()) as { workspacePath: string };
          if (!payload.workspacePath) {
            return jsonResponse({ success: false, error: 'workspacePath is required' }, 400);
          }
          // Reset session (workspace change will be handled by Rust layer restarting the Sidecar)
          await resetSession();
          return jsonResponse({
            sessionId: getSessionId(),
            workspacePath: payload.workspacePath,
          });
        } catch (error) {
          console.error('[im/session/switch-workspace] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Switch error' },
            500,
          );
        }
      }

      // GET /api/im/session/:key/messages — Get messages for an IM session
      if (pathname.startsWith('/api/im/session/') && pathname.endsWith('/messages') && request.method === 'GET') {
        try {
          // Currently returns messages from the active session
          // In the future, could look up by session key
          const allMessages = getMessages();
          return jsonResponse({
            messages: allMessages.map(m => ({
              id: m.id,
              role: m.role,
              content: typeof m.content === 'string' ? m.content : m.content
                .filter((b: { type: string; text?: string }) => b.type === 'text')
                .map((b: { text?: string }) => b.text ?? '')
                .join('\n'),
              timestamp: m.timestamp,
              metadata: m.metadata,
            })),
          });
        } catch (error) {
          console.error('[im/session/messages] Error:', error);
          return jsonResponse(
            { success: false, error: error instanceof Error ? error.message : 'Messages error' },
            500,
          );
        }
      }

      // ============= END IM BOT API =============

      // ============= OPENAI BRIDGE (Loopback) =============
      // SDK subprocess sends Anthropic requests here when provider uses OpenAI protocol
      if (pathname === '/v1/messages' && request.method === 'POST') {
        const bridgeConfig = getOpenAiBridgeConfig();
        if (bridgeConfig) {
          // Diagnostic: log incoming model name to verify sub-agent requests reach the bridge
          try {
            const clonedReq = request.clone();
            const body = await clonedReq.json() as { model?: string };
            console.log(`[bridge] Incoming request: model=${body.model ?? '(none)'}, bridge_model_override=${bridgeConfig.model ?? '(none)'}`);
          } catch { /* ignore parse errors for diagnostic */ }
          try {
            return await bridgeHandler(request);
          } catch (error) {
            console.error('[bridge] Handler error:', error);
            return jsonResponse(
              { type: 'error', error: { type: 'api_error', message: error instanceof Error ? error.message : 'Bridge error' } },
              500,
            );
          }
        }
        // Bridge not active — fall through to 404
      }

      // POST /v1/messages/count_tokens — CLI sends this for context window management.
      // OpenAI-compatible APIs have no equivalent, so return an estimated token count.
      if (pathname === '/v1/messages/count_tokens' && request.method === 'POST') {
        const bridgeConfig = getOpenAiBridgeConfig();
        if (bridgeConfig) {
          try {
            const body = await request.json() as { messages?: unknown[]; system?: unknown; tools?: unknown[] };
            // Rough estimate: serialize content → chars / 4 ≈ tokens
            const contentLength = JSON.stringify(body.messages ?? []).length
              + JSON.stringify(body.system ?? '').length
              + JSON.stringify(body.tools ?? []).length;
            const estimatedTokens = Math.max(1, Math.ceil(contentLength / 4));
            return jsonResponse({ input_tokens: estimatedTokens });
          } catch {
            return jsonResponse({ input_tokens: 1024 }); // Safe fallback
          }
        }
      }

      const staticResponse = await serveStatic(pathname);
      if (staticResponse) {
        return staticResponse;
      }

      return new Response('Not Found', { status: 404 });
    }
  });

  console.log(`Web UI server listening on http://localhost:${port}`);

  // ── Sidecar Boot Banner: single-line for AI grep ──
  {
    const model = getSessionModel() || '?';
    const mcpList = getMcpServers();
    const mcpNames = mcpList ? Object.keys(mcpList).join(',') || 'none' : 'none';
    const bridge = getOpenAiBridgeConfig() ? 'yes' : 'no';
    console.log(`[boot] pid=${process.pid} port=${port} bun=${Bun.version} workspace=${currentAgentDir} session=${initialSessionId ?? 'new'} resume=${!!initialSessionId} model=${model} bridge=${bridge} mcp=${mcpNames}`);
  }

  // Verify PATH detection
  import('./utils/shell').then(({ getShellEnv, getShellPath }) => {
    getShellEnv(); // Ensure PATH is initialized
    console.log('[server] Startup PATH:', getShellPath());
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
