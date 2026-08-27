// kestrel-native — v0 client runtime (spike-level).
// The std-lib surface here mirrors docs/rfc-0001-native-api.md §3; only the
// modules the spike host implements are wired so far.

const core = () => {
  if (!globalThis.window?.__TAURI__?.core)
    throw new Error("kestrel-native: not running inside a Kestrel window");
  return window.__TAURI__.core;
};

/** Low-level escape hatch; prefer generated stubs from `kestrel typegen`. */
export const callNative = (name, args = {}) =>
  core().invoke("call_native", { name, args });

/** app — identity & manifest */
export const app = {
  manifest: () => core().invoke("get_manifest"),
};

/** store — simple KV persisted by the host (in-memory in the spike host) */
export const store = {
  get: (key) => core().invoke("kv_get", { key }),
  set: (key, value) => core().invoke("kv_set", { key, value }),
};
