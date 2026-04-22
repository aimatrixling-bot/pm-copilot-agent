// AUTO-GENERATED STUB — do not edit manually.
// Regenerate: bun scripts/generate-sdk-shims.ts
// Source: openclaw/src/plugin-sdk/runtime-store.ts

const _warned = new Set();
function _w(fn) {
  if (!_warned.has(fn)) { _warned.add(fn); console.warn('[sdk-shim] openclaw/plugin-sdk/runtime-store.' + fn + '() not implemented in Bridge mode'); }
}

function createPluginRuntimeStore() { _w('createPluginRuntimeStore'); return undefined; }

module.exports = {
  createPluginRuntimeStore,
};
