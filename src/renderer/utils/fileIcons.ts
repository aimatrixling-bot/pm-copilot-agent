/**
 * File icon mapping for DirectoryPanel tree view.
 *
 * Maps filenames and extensions to lucide-react icon components.
 * Priority: exact filename > extension > fallback (FileText).
 */
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  BookOpenText,
  Box,
  Database,
  FileArchive,
  FileAudio,
  FileCode,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileKey,
  FileLock,
  FileScan,
  FileSliders,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  GitBranch,
  Globe,
  Package,
  Palette,
  Presentation,
  Scale,
  Sheet,
} from 'lucide-react';

// ---------- Exact filename matches ----------

const EXACT_FILENAME_MAP: Record<string, LucideIcon> = {
  // Package manifests
  'package.json': Package,
  'Cargo.toml': Package,
  'go.mod': Package,
  'go.sum': Package,
  'Pipfile': Package,
  'Gemfile': Package,
  'composer.json': Package,
  'pyproject.toml': Package,
  'requirements.txt': Package,

  // Lock files
  'package-lock.json': FileLock,
  'yarn.lock': FileLock,
  'bun.lockb': FileLock,
  'bun.lock': FileLock,
  'pnpm-lock.yaml': FileLock,
  'Cargo.lock': FileLock,
  'Gemfile.lock': FileLock,
  'composer.lock': FileLock,
  'poetry.lock': FileLock,

  // Docker
  'Dockerfile': Box,
  'docker-compose.yml': Box,
  'docker-compose.yaml': Box,
  '.dockerignore': Box,

  // Git
  '.gitignore': GitBranch,
  '.gitattributes': GitBranch,
  '.gitmodules': GitBranch,

  // License
  'LICENSE': Scale,
  'LICENSE.md': Scale,
  'LICENSE.txt': Scale,
  'COPYING': Scale,

  // Project docs
  'README.md': BookOpen,
  'README': BookOpen,
  'CHANGELOG.md': BookOpen,
  'CONTRIBUTING.md': BookOpen,
};

// ---------- Extension matches ----------

const EXTENSION_MAP: Record<string, LucideIcon> = {
  // JavaScript / TypeScript
  js: FileCode2, jsx: FileCode2, mjs: FileCode2, cjs: FileCode2,
  ts: FileCode2, tsx: FileCode2, mts: FileCode2, cts: FileCode2,

  // Other languages
  py: FileCode, pyw: FileCode, pyi: FileCode,
  go: FileCode,
  rs: FileCog,
  java: FileCode, kt: FileCode, scala: FileCode, groovy: FileCode,
  c: FileCode, cpp: FileCode, cc: FileCode, h: FileCode, hpp: FileCode,
  swift: FileCode,
  rb: FileCode, erb: FileCode,
  php: FileCode,
  lua: FileCode,
  r: FileCode,
  dart: FileCode,
  zig: FileCode,
  ex: FileCode, exs: FileCode,
  elm: FileCode,
  clj: FileCode, cljs: FileCode,
  hs: FileCode,

  // Frontend frameworks
  vue: FileCode, svelte: FileCode, astro: FileCode,

  // Shell scripts
  sh: FileTerminal, bash: FileTerminal, zsh: FileTerminal, fish: FileTerminal,
  ps1: FileTerminal, bat: FileTerminal, cmd: FileTerminal,

  // Web
  html: Globe, htm: Globe, ejs: Globe, hbs: Globe, pug: Globe,
  css: Palette, scss: Palette, sass: Palette, less: Palette, styl: Palette,

  // Data formats
  json: FileJson2, jsonc: FileJson2, json5: FileJson2,
  yaml: FileSliders, yml: FileSliders,
  toml: FileCog, ini: FileCog, cfg: FileCog, conf: FileCog,
  xml: FileCode, xsl: FileCode, xslt: FileCode,
  sql: FileCode, graphql: FileCode, gql: FileCode, prisma: FileCode,

  // Spreadsheet data
  csv: FileSpreadsheet, tsv: FileSpreadsheet,

  // Office documents
  xls: Sheet, xlsx: Sheet, ods: Sheet, numbers: Sheet,
  ppt: Presentation, pptx: Presentation, key: Presentation, odp: Presentation,
  doc: FileType, docx: FileType, rtf: FileType, odt: FileType,

  // Documents
  md: BookOpenText, mdx: BookOpenText, markdown: BookOpenText,
  txt: FileText, log: FileText, out: FileText,
  pdf: FileScan,

  // Media — Images
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage,
  webp: FileImage, svg: FileImage, bmp: FileImage, ico: FileImage,
  tiff: FileImage, tif: FileImage, avif: FileImage,

  // Media — Video
  mp4: FileVideo, mov: FileVideo, avi: FileVideo, webm: FileVideo,
  mkv: FileVideo, flv: FileVideo, wmv: FileVideo,

  // Media — Audio
  mp3: FileAudio, wav: FileAudio, ogg: FileAudio, flac: FileAudio,
  aac: FileAudio, m4a: FileAudio, wma: FileAudio,

  // Archives
  zip: FileArchive, tar: FileArchive, gz: FileArchive, tgz: FileArchive,
  rar: FileArchive, '7z': FileArchive, bz2: FileArchive, xz: FileArchive,
  zst: FileArchive,

  // Database
  db: Database, sqlite: Database, sqlite3: Database,

  // Security / env
  pem: FileKey, cert: FileKey, crt: FileKey,
  env: FileKey,

  // Config dotfiles (extension after the dot)
  editorconfig: FileCog,
  prettierrc: FileCog,
  eslintrc: FileCog,
  npmrc: FileCog,
  nvmrc: FileCog,
};

/**
 * Get the appropriate lucide-react icon component for a given filename.
 *
 * Priority: exact filename → extension → FileText fallback.
 */
export function getFileIcon(filename: string): LucideIcon {
  // 1. Exact filename match
  const exact = EXACT_FILENAME_MAP[filename];
  if (exact) return exact;

  // 2. Extension match
  const lastDot = filename.lastIndexOf('.');
  if (lastDot > 0) {
    const ext = filename.slice(lastDot + 1).toLowerCase();
    const byExt = EXTENSION_MAP[ext];
    if (byExt) return byExt;
  }

  // 3. Fallback
  return FileText;
}
