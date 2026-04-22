/**
 * Path detection utility for inline code in AI output.
 *
 * Determines if a text string looks like a file or directory path,
 * so that only plausible candidates are sent to the backend for existence checks.
 */
import { AUDIO_EXTENSIONS } from '@/utils/audioPlayer';

/**
 * Common file extensions that strongly indicate a file path.
 *
 * NOTE: This set is for path detection only, not for preview eligibility.
 * - PATH_EXTENSIONS: used for "does this look like a path?" heuristic (includes images, locks, etc.)
 * - isPreviewable() in shared/fileTypes.ts: uses a binary-blocklist strategy for preview eligibility
 */
const PATH_EXTENSIONS = new Set([
  // Web / JS / TS
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
  // Config
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml',
  // Docs
  'md', 'mdx', 'txt', 'rst', 'csv', 'log',
  // Systems
  'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'kt', 'sh', 'bash', 'zsh',
  // Build / package
  'lock', 'sum', 'mod',
  // Images (still paths even though they're binary)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  // Audio (imported from audioPlayer to avoid duplication)
  ...AUDIO_EXTENSIONS,
]);

/** Well-known dotfiles that are valid paths but lack a "normal" extension */
const KNOWN_DOTFILES = new Set([
  '.gitignore', '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc',
  '.npmrc', '.nvmrc', '.env', '.env.local', '.env.development', '.env.production',
  '.babelrc', '.prettierignore', '.eslintignore',
]);

/**
 * Quick, synchronous check: does `text` look like it could be a file or directory path?
 *
 * Returns `true` for plausible path candidates, `false` for obvious non-paths.
 * False positives are OK — the backend will verify existence.
 * False negatives should be minimised — we don't want to miss real paths.
 */
export function looksLikeFilePath(text: string): boolean {
  // Too short to be a path (e.g., "a", "go")
  if (text.length < 2) return false;

  // Too long to be a realistic path
  if (text.length > 300) return false;

  // Contains spaces — almost never a path in AI output
  if (text.includes(' ')) return false;

  // Contains URL scheme
  if (/^https?:\/\//i.test(text) || text.includes('://')) return false;

  // Contains code-like characters that disqualify it as a path
  // () {} [] ; => are used in code expressions, not paths
  if (/[(){}[\];=>]/.test(text)) return false;

  // Contains template literal / interpolation syntax
  if (text.includes('${') || text.includes('`')) return false;

  // Known dotfiles (exact match)
  if (KNOWN_DOTFILES.has(text)) return true;

  // Starts with ./ or ../ — very strong path signal
  if (text.startsWith('./') || text.startsWith('../')) return true;

  // Contains path separator — strong signal, but filter out common non-path patterns
  // like "true/false", "yes/no", "input/output"
  if (text.includes('/') || text.includes('\\')) {
    const segments = text.split(/[/\\]/).filter(Boolean);
    // Single segment with separator (e.g., trailing slash) — still plausible
    if (segments.length < 2) return true;
    // At least one segment should contain a dot (extension / dotfile) OR
    // the total path should be long enough to be a real path (> 5 chars)
    const hasDot = segments.some(s => s.includes('.'));
    if (hasDot || text.length > 5) return true;
    return false;
  }

  // Has a file extension (e.g., "package.json", "index.ts")
  const dotIndex = text.lastIndexOf('.');
  if (dotIndex > 0 && dotIndex < text.length - 1) {
    const ext = text.slice(dotIndex + 1).toLowerCase();
    if (PATH_EXTENSIONS.has(ext)) return true;
  }

  // Single word without extension or separator — not a path
  return false;
}

/**
 * Shorten a path for display purposes only.
 * On macOS, replaces `/Users/<username>/` prefix with `~/`.
 * On Windows, returns the path unchanged.
 *
 * This is purely cosmetic — never use the returned value for file operations.
 */
export function shortenPathForDisplay(path: string): string {
  if (!path) return path;
  // macOS: /Users/<username>/... → ~/...
  const match = path.match(/^\/Users\/[^/]+\/(.*)/);
  if (match) return `~/${match[1]}`;
  return path;
}
