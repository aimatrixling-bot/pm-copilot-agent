/**
 * Agent-browser anti-detection defaults.
 *
 * Generates ~/.agent-browser/config.json (agent-browser's default config path)
 * with headed mode, realistic UA, and anti-detection Chrome flags.
 * No env var needed — agent-browser reads this path automatically.
 *
 * Profile field is intentionally omitted so each agent-browser invocation uses
 * a temporary profile, allowing concurrent use across multiple sessions without
 * Chromium SingletonLock conflicts.
 *
 * User override: remove the `_managed_by` field from the JSON file — PM Copilot
 * will stop overwriting it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getHomeDirOrNull } from './platform';

// ---- Cached values (computed once per process) ----

let _cachedChromeVersion: string | null = null;
let _cachedUA: string | null = null;
let _cachedLocale: string | null = null;

// ---- Internal helpers ----

/**
 * Detect installed Chrome version. Falls back to a recent stable version.
 */
function detectChromeVersion(): string {
  if (_cachedChromeVersion) return _cachedChromeVersion;

  const FALLBACK = '131.0.0.0';
  const execOpts = { encoding: 'utf-8' as const, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };

  try {
    if (process.platform === 'darwin') {
      const ver = execSync(
        "defaults read '/Applications/Google Chrome.app/Contents/Info' CFBundleShortVersionString",
        execOpts,
      ).trim();
      if (/^\d+\.\d+/.test(ver)) {
        _cachedChromeVersion = ver;
        return ver;
      }
    } else if (process.platform === 'win32') {
      // Try HKLM first, then HKCU
      for (const root of ['HKLM', 'HKCU']) {
        try {
          const out = execSync(
            `reg query "${root}\\SOFTWARE\\Google\\Chrome\\BLBeacon" /v version`,
            execOpts,
          );
          const m = out.match(/REG_SZ\s+([\d.]+)/);
          if (m) {
            _cachedChromeVersion = m[1];
            return m[1];
          }
        } catch { /* try next */ }
      }
    } else {
      // Linux
      const out = execSync('google-chrome --version', execOpts).trim();
      const m = out.match(/([\d.]+)/);
      if (m) {
        _cachedChromeVersion = m[1];
        return m[1];
      }
    }
  } catch { /* ignore */ }

  _cachedChromeVersion = FALLBACK;
  return FALLBACK;
}

/**
 * Build a realistic Chrome user-agent string matching the current platform.
 */
function buildRealisticUserAgent(): string {
  if (_cachedUA) return _cachedUA;

  const ver = detectChromeVersion();

  const osStr =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';

  _cachedUA = `Mozilla/5.0 (${osStr}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
  return _cachedUA;
}

/**
 * Detect system locale (e.g. "zh-CN", "en-US"). Defaults to "zh-CN".
 */
function detectSystemLocale(): string {
  if (_cachedLocale) return _cachedLocale;

  // Try LANG / LC_ALL env var (works on macOS, Linux, Git Bash on Windows)
  const lang = process.env.LANG || process.env.LC_ALL || '';
  if (lang) {
    // "zh_CN.UTF-8" → "zh-CN"
    const code = lang.split('.')[0].replace('_', '-');
    if (code && code !== 'C' && code !== 'POSIX') {
      _cachedLocale = code;
      return code;
    }
  }

  // macOS fallback: read AppleLanguages
  if (process.platform === 'darwin') {
    try {
      const out = execSync(
        'defaults read NSGlobalDomain AppleLanguages',
        { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] },
      );
      // Output: (\n    "zh-Hans-CN",\n    "en-CN"\n)
      const m = out.match(/"([^"]+)"/);
      if (m) {
        // "zh-Hans-CN" → "zh-CN"
        const simplified = m[1].replace(/-Hans|-Hant/, '');
        _cachedLocale = simplified;
        return simplified;
      }
    } catch { /* ignore */ }
  }

  // Default: zh-CN (PM Copilot 初期用户主要为中文用户)
  _cachedLocale = 'zh-CN';
  return 'zh-CN';
}

// ---- Public API ----

/**
 * Ensure ~/.agent-browser/config.json exists with anti-detection defaults.
 *
 * Called on every Sidecar startup. Regenerates the file when `_managed_by`
 * is "pm-copilot" (keeps UA/locale fresh). Skips if the user removed the marker.
 */
export function ensureBrowserStealthConfig(): void {
  const homeDir = getHomeDirOrNull();
  if (!homeDir) return;

  const configDir = join(homeDir, '.agent-browser');
  const configPath = join(configDir, 'config.json');

  // Check if user has taken ownership
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (existing._managed_by !== 'pm-copilot') {
        console.log('[agent-browser] Stealth config is user-managed, skipping');
        return;
      }
    } catch { /* corrupt file, overwrite */ }
  }

  const locale = detectSystemLocale();

  // Build Chrome launch args for anti-detection.
  // IMPORTANT: agent-browser's Rust CLI splits args by BOTH comma AND newline.
  // Args containing commas (e.g. --window-size=1440,900) will be split incorrectly.
  // Use --start-maximized instead of --window-size to avoid this.
  const args = [
    // Remove navigator.webdriver = true (the #1 detection signal)
    '--disable-blink-features=AutomationControlled',
    // Set locale for Accept-Language header consistency
    `--lang=${locale}`,
    // Maximize window — triggers browser.js hasWindowSizeArgs check, which disables
    // Playwright's viewport emulation (1280x720 default). Real OS display values
    // (DPR, colorDepth, screen dimensions) are used instead.
    '--start-maximized',
    // Disable "Chrome is being controlled by automated test software" infobar
    '--disable-infobars',
    // Suppress first-run / default-browser prompts that reveal fresh profile
    '--no-first-run',
    '--no-default-browser-check',
    // Suppress "Chrome didn't shut down correctly" restore dialog — blocks automation
    // when user-data-dir is set and browser was previously killed/crashed
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
  ].join('\n');

  // Profile field intentionally omitted — each invocation uses a temp profile,
  // enabling concurrent browser use across multiple sessions (no SingletonLock).
  const config = {
    _managed_by: 'pm-copilot',
    headed: true,
    userAgent: buildRealisticUserAgent(),
    args,
  };

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    console.log(`[agent-browser] Stealth config written: ${configPath}`);
  } catch (err) {
    console.warn('[agent-browser] Failed to write stealth config:', err);
  }
}
