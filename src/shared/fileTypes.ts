/**
 * Shared file type utilities
 *
 * Used by both frontend and backend for consistent file type detection.
 */

/** Image file extensions that should be treated as image attachments (not copied to pm-copilot_files) */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

/**
 * Check if a filename represents an image file based on extension
 */
export function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Get file extension from filename (lowercase, without dot)
 */
export function getFileExtension(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * Supported image MIME types for clipboard/attachment handling
 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
];

/**
 * Check if a MIME type is a supported image type
 */
export function isImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType) || mimeType.startsWith('image/');
}

/**
 * Known binary file extensions that cannot be previewed as text.
 * Strategy: blocklist binary → everything else is assumed text-previewable.
 * This covers far more file types than a text allowlist ever could
 * (.dev.vars, .env.dev, Makefile, LICENSE, .tool-versions, etc.).
 */
export const BINARY_EXTENSIONS = new Set([
  // Images (superset of IMAGE_EXTENSIONS — includes raw/vector formats)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif',
  'psd', 'ai', 'eps', 'raw', 'cr2', 'nef', 'heic', 'heif', 'avif', 'jxl',
  // Video
  'mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp',
  // Audio
  'mp3', 'wav', 'aac', 'ogg', 'flac', 'wma', 'm4a', 'opus', 'aiff',
  // Archives / Compressed
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'zst', 'lz4', 'lzma', 'cab', 'dmg', 'iso',
  // Executables / Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'deb', 'rpm', 'apk', 'ipa',
  // Compiled / Object
  'o', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'elc',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Documents (binary formats)
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  // Databases
  'db', 'sqlite', 'sqlite3', 'mdb',
  // Other binary
  'dat', 'ds_store', 'swp', 'swo',
]);

/**
 * Check if a filename can be previewed as text (code / markdown / plain text).
 *
 * Uses a binary-blocklist strategy: any file that is NOT a known binary format
 * and NOT an image is considered previewable. This naturally covers dotfiles
 * (.env, .gitignore), multi-dot names (.dev.vars, .env.dev), and extensionless
 * files (Makefile, LICENSE, Dockerfile).
 */
export function isPreviewable(filename: string): boolean {
  // Extensionless files (Makefile, Dockerfile, LICENSE, etc.) are text
  const ext = getFileExtension(filename);
  if (!ext || ext === filename.toLowerCase()) return true;
  return !BINARY_EXTENSIONS.has(ext);
}
