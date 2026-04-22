/**
 * MCP OAuth State Store
 *
 * Persists all OAuth state (discovery, registration, tokens) to disk.
 * Handles atomic writes and migration from legacy mcp_oauth_tokens.json.
 *
 * File: ~/.pm-copilot/mcp_oauth_state.json (mode 0o600)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { McpOAuthState, McpOAuthStateStore, LegacyOAuthToken } from './types';

const CONFIG_DIR = join(homedir(), '.pm-copilot');
const STATE_FILE = join(CONFIG_DIR, 'mcp_oauth_state.json');
const LEGACY_TOKEN_FILE = join(CONFIG_DIR, 'mcp_oauth_tokens.json');

/** 24h discovery cache validity */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

/** Migrate legacy mcp_oauth_tokens.json to new state format */
function migrateFromLegacy(): McpOAuthStateStore {
  try {
    if (!existsSync(LEGACY_TOKEN_FILE)) return {};
    const raw = readFileSync(LEGACY_TOKEN_FILE, 'utf-8');
    const legacy = JSON.parse(raw) as Record<string, LegacyOAuthToken>;
    const migrated: McpOAuthStateStore = {};

    for (const [serverId, old] of Object.entries(legacy)) {
      if (!old?.accessToken) continue;
      migrated[serverId] = {
        token: {
          accessToken: old.accessToken,
          refreshToken: old.refreshToken,
          tokenType: old.tokenType || 'Bearer',
          expiresAt: old.expiresAt,
          scope: old.scope,
        },
        // Legacy data was always manual config
        manualConfig: old.clientId ? { clientId: old.clientId } : undefined,
        // Store tokenEndpoint from legacy for refresh
        discovery: old.serverUrl ? {
          authServerUrl: '',
          authorizationEndpoint: '',
          tokenEndpoint: old.serverUrl,
          discoveredAt: 0, // Expired — will re-discover on next probe
        } : undefined,
      };
    }

    console.log(`[mcp-oauth] Migrated ${Object.keys(migrated).length} entries from legacy token file`);
    return migrated;
  } catch (err) {
    console.error('[mcp-oauth] Legacy migration failed:', err);
    return {};
  }
}

// In-memory cache — avoids disk I/O on every getServerState() / resolveAuthHeaders() call
let memoryCache: McpOAuthStateStore | null = null;

/** Load the full OAuth state store (from memory cache or disk) */
export function loadStateStore(): McpOAuthStateStore {
  if (memoryCache) return memoryCache;
  try {
    if (existsSync(STATE_FILE)) {
      const raw = readFileSync(STATE_FILE, 'utf-8');
      memoryCache = JSON.parse(raw) as McpOAuthStateStore;
      return memoryCache;
    }
    // First load — try migration from legacy
    const migrated = migrateFromLegacy();
    if (Object.keys(migrated).length > 0) {
      saveStateStore(migrated);
    }
    memoryCache = migrated;
    return migrated;
  } catch (err) {
    console.error('[mcp-oauth] Failed to load state store:', err);
    return {};
  }
}

/** Save the full state store to disk (atomic write via tmp+rename) and update cache */
export function saveStateStore(store: McpOAuthStateStore): void {
  memoryCache = store;
  try {
    ensureDir();
    const tmpFile = STATE_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(store, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmpFile, STATE_FILE);
  } catch (err) {
    console.error('[mcp-oauth] Failed to save state store:', err);
  }
}

/** Get state for a specific server */
export function getServerState(serverId: string): McpOAuthState | undefined {
  return loadStateStore()[serverId];
}

/** Update state for a specific server (merge) */
export function updateServerState(serverId: string, patch: Partial<McpOAuthState>): void {
  const store = loadStateStore();
  store[serverId] = { ...store[serverId], ...patch };
  saveStateStore(store);
}

/** Clear a specific field from server state */
export function clearServerField(serverId: string, field: keyof McpOAuthState): void {
  const store = loadStateStore();
  if (store[serverId]) {
    delete store[serverId][field];
    // Remove empty entries
    if (Object.keys(store[serverId]).length === 0) {
      delete store[serverId];
    }
    saveStateStore(store);
  }
}

/** Check if discovery cache is still valid */
export function isDiscoveryCacheValid(discovery: McpOAuthState['discovery']): boolean {
  if (!discovery?.discoveredAt) return false;
  return Date.now() - discovery.discoveredAt < DISCOVERY_TTL_MS;
}
