// kestrel-native — v0 client runtime (spike-level).
// The std-lib surface here mirrors docs/rfc-0001-native-api.md §3; only the
// modules the host implements are exported. `store` lands with issue #18.

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
