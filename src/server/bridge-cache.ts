/**
 * Shared bridge cache seeding — decouples agent-session.ts from index.ts
 * to avoid circular imports.
 *
 * index.ts registers the bridge handler's seedThoughtSignatures function at startup.
 * agent-session.ts calls seedBridgeThoughtSignatures() when loading session history.
 *
 * Handles startup ordering: if seed is called before registration (initializeAgent
 * runs before bridge handler is created), entries are buffered and flushed on registration.
 */

type SeedEntry = { id: string; thought_signature: string };
type SeedFn = (entries: SeedEntry[]) => void;

let _seedFn: SeedFn | null = null;
let _pendingEntries: SeedEntry[] | null = [];

/** Called by index.ts after creating the bridge handler */
export function registerBridgeSeedFn(fn: SeedFn): void {
  _seedFn = fn;
  // Flush any entries that arrived before registration
  if (_pendingEntries && _pendingEntries.length > 0) {
    fn(_pendingEntries);
  }
  _pendingEntries = null; // No longer needed after registration
}

/** Called by agent-session.ts when loading persisted session messages */
export function seedBridgeThoughtSignatures(entries: SeedEntry[]): void {
  if (_seedFn) {
    _seedFn(entries);
  } else if (_pendingEntries) {
    // Buffer until registration (startup ordering: initializeAgent before bridge handler)
    _pendingEntries.push(...entries);
  }
}
