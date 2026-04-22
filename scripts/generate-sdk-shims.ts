#!/usr/bin/env bun
/**
 * SDK Shim Stub Generator
 *
 * Reads the OpenClaw source tree and generates safe stub files for every
 * `plugin-sdk/*` subpath export that does not already have a hand-written
 * shim.  This prevents "Cannot find module" crashes when plugins import
 * modules we haven't manually implemented.
 *
 * Usage:
 *   bun scripts/generate-sdk-shims.ts                       # default
 *   bun scripts/generate-sdk-shims.ts --openclaw-dir ../oc   # custom path
 *   bun scripts/generate-sdk-shims.ts --dry-run              # preview only
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");

let openclawDir = path.resolve(process.cwd(), "../openclaw");
const dirIdx = args.indexOf("--openclaw-dir");
if (dirIdx !== -1 && args[dirIdx + 1]) {
  openclawDir = path.resolve(args[dirIdx + 1]);
}

const SHIM_DIR = path.resolve(
  process.cwd(),
  "src/server/plugin-bridge/sdk-shim",
);
const PLUGIN_SDK_DIR = path.join(SHIM_DIR, "plugin-sdk");
const HANDWRITTEN_PATH = path.join(PLUGIN_SDK_DIR, "_handwritten.json");

// ---------------------------------------------------------------------------
// Validate inputs
// ---------------------------------------------------------------------------

const openclawPkgPath = path.join(openclawDir, "package.json");
if (!fs.existsSync(openclawPkgPath)) {
  console.error(`❌ OpenClaw package.json not found at: ${openclawPkgPath}`);
  console.error(
    `   Use --openclaw-dir to specify the openclaw source directory.`,
  );
  process.exit(1);
}

if (!fs.existsSync(HANDWRITTEN_PATH)) {
  console.error(`❌ _handwritten.json not found at: ${HANDWRITTEN_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------

const openclawPkg = JSON.parse(fs.readFileSync(openclawPkgPath, "utf8"));
const handwritten: string[] = JSON.parse(
  fs.readFileSync(HANDWRITTEN_PATH, "utf8"),
);
const handwrittenSet = new Set(handwritten);

// Extract all ./plugin-sdk/* export paths
const allExports: string[] = Object.keys(openclawPkg.exports || {})
  .filter((k: string) => k.startsWith("./plugin-sdk"))
  .map((k: string) => {
    const name = k.replace("./plugin-sdk/", "").replace("./plugin-sdk", "index");
    return name;
  });

console.log(`📦 OpenClaw exports: ${allExports.length}`);
console.log(`✋ Hand-written shims: ${handwrittenSet.size}`);
console.log(`🔧 To generate: ${allExports.length - handwrittenSet.size}`);
console.log(`📂 OpenClaw source: ${openclawDir}`);
if (dryRun) console.log(`🏃 DRY RUN — no files will be written\n`);
else console.log();

// ---------------------------------------------------------------------------
// Export symbol extraction
// ---------------------------------------------------------------------------

interface ExportSymbol {
  name: string;
  kind: "function" | "async-function" | "class" | "const" | "enum";
}

/** Cache to avoid re-parsing the same file */
const extractCache = new Map<string, ExportSymbol[]>();

/**
 * Resolve an import specifier relative to the importing file.
 * Handles the TypeScript convention: `import from "../foo.js"` → `../foo.ts`
 */
function resolveImportPath(
  fromFile: string,
  specifier: string,
): string | null {
  const dir = path.dirname(fromFile);
  const base = path.join(dir, specifier);

  // Try .ts first (TS convention: imports use .js but files are .ts)
  const tsPath = base.replace(/\.js$/, ".ts");
  if (fs.existsSync(tsPath)) return tsPath;

  // Try .ts if no extension
  if (!path.extname(base) && fs.existsSync(base + ".ts")) return base + ".ts";

  // Try the literal path
  if (fs.existsSync(base)) return base;

  // Try index.ts
  if (fs.existsSync(path.join(base, "index.ts")))
    return path.join(base, "index.ts");

  return null;
}

/**
 * Extract all value (non-type) exported symbols from a TypeScript file.
 * Recursively follows `export * from` up to maxDepth.
 */
function extractExports(filePath: string, depth: number = 0): ExportSymbol[] {
  if (depth > 5) return [];
  if (extractCache.has(filePath)) return extractCache.get(filePath)!;

  // Put empty array in cache first to break circular references
  extractCache.set(filePath, []);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const symbols: ExportSymbol[] = [];
  const seen = new Set<string>();

  const add = (sym: ExportSymbol) => {
    if (!seen.has(sym.name)) {
      seen.add(sym.name);
      symbols.push(sym);
    }
  };

  // --- Direct exports ---

  // export function NAME / export async function NAME
  for (const m of content.matchAll(
    /^export\s+async\s+function\s+(\w+)/gm,
  )) {
    add({ name: m[1], kind: "async-function" });
  }
  for (const m of content.matchAll(
    /^export\s+function\s+(\w+)/gm,
  )) {
    add({ name: m[1], kind: "function" });
  }

  // export class NAME
  for (const m of content.matchAll(/^export\s+class\s+(\w+)/gm)) {
    add({ name: m[1], kind: "class" });
  }

  // export const/let NAME
  for (const m of content.matchAll(/^export\s+(?:const|let)\s+(\w+)/gm)) {
    add({ name: m[1], kind: "const" });
  }

  // export enum NAME
  for (const m of content.matchAll(/^export\s+enum\s+(\w+)/gm)) {
    add({ name: m[1], kind: "enum" });
  }

  // --- Named exports: export { A, B } from "..." AND local export { A, B };
  // Must skip type-only: export type { A } from "..." / export type { A };
  // And skip individual `type X` within mixed export blocks

  // Match both re-exports and local exports:
  //   export { foo, bar } from "...";
  //   export { foo, bar };
  const namedExportRe =
    /^export\s+\{([^}]+)\}/gm;

  for (const m of content.matchAll(namedExportRe)) {
    // Check the full match doesn't start with `export type {`
    const fullLine = content.slice(
      Math.max(0, (m.index ?? 0) - 5),
      (m.index ?? 0) + m[0].length,
    );
    if (/export\s+type\s+\{/.test(fullLine)) continue;

    const namesBlock = m[1];
    for (const part of namesBlock.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      // Skip `type Foo` within a mixed export block
      if (/^type\s+/.test(trimmed)) continue;

      // Handle `foo as bar` → exported name is `bar`
      const asMatch = trimmed.match(/(\w+)\s+as\s+(\w+)/);
      const name = asMatch ? asMatch[2] : trimmed.match(/^(\w+)/)?.[1];
      if (name) {
        // Heuristic: UPPER_CASE or PascalCase ending in Schema/Config/Defaults → const
        const isConst =
          /^[A-Z_][A-Z0-9_]*$/.test(name) ||
          /Schema$|Config$|Defaults$|Pattern$|PATTERN$/.test(name);
        const kind = isConst ? "const" : "function";
        add({ name, kind: kind as ExportSymbol["kind"] });
      }
    }
  }

  // --- Star re-exports: export * from "..." ---
  // NOT: export type * from "..."
  for (const m of content.matchAll(
    /^export\s+\*\s+from\s+["']([^"']+)["']/gm,
  )) {
    // Check it's not `export type * from`
    const lineStart = content.lastIndexOf("\n", (m.index ?? 0)) + 1;
    const linePrefix = content.slice(lineStart, m.index ?? 0);
    if (/type\s*$/.test(linePrefix)) continue;

    const targetPath = resolveImportPath(filePath, m[1]);
    if (targetPath) {
      for (const sym of extractExports(targetPath, depth + 1)) {
        add(sym);
      }
    } else if (verbose) {
      console.warn(
        `  ⚠️  Cannot resolve: export * from "${m[1]}" in ${path.relative(openclawDir, filePath)}`,
      );
    }
  }

  extractCache.set(filePath, symbols);
  return symbols;
}

// ---------------------------------------------------------------------------
// Stub rendering
// ---------------------------------------------------------------------------

/** Heuristic return value based on function name */
function inferReturnValue(name: string): string {
  // Boolean predicates
  if (/^(is|has|should|can|was|did|does|needs|supports)[A-Z]/.test(name))
    return "false";
  // List/collection builders
  if (/^(list|collect|get\w*Entries|get\w*Items|find\w*All)/.test(name))
    return "[]";
  // String formatters
  if (/^(format|normalize|strip|sanitize|encode|decode|serialize)/.test(name))
    return '""';
  // Default
  return "undefined";
}

function renderStub(moduleName: string, symbols: ExportSymbol[]): string {
  const lines: string[] = [];

  lines.push(`// AUTO-GENERATED STUB — do not edit manually.`);
  lines.push(`// Regenerate: bun scripts/generate-sdk-shims.ts`);
  lines.push(`// Source: openclaw/src/plugin-sdk/${moduleName}.ts`);
  lines.push(``);

  if (symbols.length === 0) {
    lines.push(`// Type-only module or no extractable runtime exports.`);
    lines.push(`module.exports = {};`);
    lines.push(``);
    return lines.join("\n");
  }

  // Warning helper
  lines.push(`const _warned = new Set();`);
  lines.push(`function _w(fn) {`);
  lines.push(
    `  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/${moduleName}.' + fn + '() not implemented in Bridge mode'); }`,
  );
  lines.push(`}`);
  lines.push(``);

  // Render each symbol
  for (const sym of symbols) {
    switch (sym.kind) {
      case "function": {
        const ret = inferReturnValue(sym.name);
        lines.push(
          `function ${sym.name}() { _w('${sym.name}'); return ${ret}; }`,
        );
        break;
      }
      case "async-function": {
        const ret = inferReturnValue(sym.name);
        lines.push(
          `async function ${sym.name}() { _w('${sym.name}'); return ${ret}; }`,
        );
        break;
      }
      case "class":
        lines.push(
          `class ${sym.name} { constructor() { _w('${sym.name}'); } }`,
        );
        break;
      case "const":
        lines.push(`const ${sym.name} = undefined;`);
        break;
      case "enum":
        lines.push(`const ${sym.name} = Object.freeze({});`);
        break;
    }
  }

  // module.exports
  lines.push(``);
  lines.push(`module.exports = {`);
  for (const sym of symbols) {
    lines.push(`  ${sym.name},`);
  }
  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Package.json update
// ---------------------------------------------------------------------------

function buildExportsMap(moduleNames: string[]): Record<string, string> {
  const exports: Record<string, string> = {};
  for (const name of moduleNames) {
    const key = name === "index" ? "./plugin-sdk" : `./plugin-sdk/${name}`;
    exports[key] = `./plugin-sdk/${name}.js`;
  }
  return exports;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let generated = 0;
let skipped = 0;
let warnings = 0;

for (const moduleName of allExports) {
  // Skip hand-written modules
  if (handwrittenSet.has(moduleName)) {
    skipped++;
    if (verbose) console.log(`  ✋ ${moduleName} (hand-written, skip)`);
    continue;
  }

  // Safety: if file exists but is NOT in handwritten manifest and NOT auto-generated, warn
  const targetFile = path.join(PLUGIN_SDK_DIR, `${moduleName}.js`);
  if (fs.existsSync(targetFile)) {
    const header = fs.readFileSync(targetFile, "utf8").slice(0, 100);
    if (!header.includes("AUTO-GENERATED STUB")) {
      console.warn(
        `  ⚠️  ${moduleName}.js exists but is NOT in _handwritten.json and has no auto-gen header. Skipping to be safe — add it to _handwritten.json if intentional.`,
      );
      warnings++;
      continue;
    }
  }

  // Read OpenClaw source
  const srcPath = path.join(openclawDir, "src/plugin-sdk", `${moduleName}.ts`);
  if (!fs.existsSync(srcPath)) {
    console.warn(`  ⚠️  Source not found: ${srcPath}`);
    warnings++;
    // Generate empty stub anyway
    const stub = renderStub(moduleName, []);
    if (!dryRun) {
      fs.writeFileSync(path.join(PLUGIN_SDK_DIR, `${moduleName}.js`), stub);
    }
    generated++;
    continue;
  }

  // Extract symbols
  const symbols = extractExports(srcPath);

  if (verbose) {
    console.log(
      `  🤖 ${moduleName}: ${symbols.length} symbols (${symbols.map((s) => s.name).join(", ")})`,
    );
  }

  // Render and write stub
  const stub = renderStub(moduleName, symbols);

  if (!dryRun) {
    fs.writeFileSync(path.join(PLUGIN_SDK_DIR, `${moduleName}.js`), stub);
  }

  generated++;
}

// Update package.json
const shimPkgPath = path.join(SHIM_DIR, "package.json");
const shimPkg = JSON.parse(fs.readFileSync(shimPkgPath, "utf8"));

// Update version to today's date
const now = new Date();
const dateStr = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
shimPkg.version = `${dateStr}-shim`;

// Build complete exports map: OpenClaw exports + any extra hand-written modules
// (e.g., `compat` is our custom module not in OpenClaw's exports)
const allModuleNames = new Set(allExports);
for (const hw of handwritten) {
  const jsFile = path.join(PLUGIN_SDK_DIR, `${hw}.js`);
  if (!allModuleNames.has(hw) && fs.existsSync(jsFile)) {
    allModuleNames.add(hw);
    if (verbose) console.log(`  ➕ ${hw} (custom hand-written, not in OpenClaw)`);
  }
}
const sortedModules = [...allModuleNames].sort((a, b) => {
  // index always first
  if (a === "index") return -1;
  if (b === "index") return 1;
  return a.localeCompare(b);
});
shimPkg.exports = buildExportsMap(sortedModules);

if (!dryRun) {
  fs.writeFileSync(shimPkgPath, JSON.stringify(shimPkg, null, 2) + "\n");
}

// Summary
const customCount = sortedModules.length - allExports.length;
console.log(`\n✅ Done!`);
console.log(`   Generated: ${generated} stub files`);
console.log(`   Skipped:   ${skipped} hand-written files`);
console.log(`   Custom:    ${customCount} hand-written modules not in OpenClaw`);
console.log(`   Warnings:  ${warnings}`);
console.log(`   Exports:   ${sortedModules.length} total in package.json`);
console.log(`   Version:   ${shimPkg.version}`);

if (dryRun) {
  console.log(`\n🏃 This was a dry run. No files were written.`);
} else {
  console.log(`\n📁 Output: ${PLUGIN_SDK_DIR}`);
}
