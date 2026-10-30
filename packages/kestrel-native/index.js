// kestrel-native — v0 client runtime (spike-level).
// The std-lib surface here mirrors docs/rfc-0001-native-api.md §3; only the
// modules the host implements are exported. `store` lands with issue #18.

/**
 * Every rejection from the host (RFC-0001 §7). Generated native-client files
 * carry their own copy, so `instanceof` is duck-typed: an error from either
 * passes `err instanceof KestrelError`.
 */
export class KestrelError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "KestrelError";
    this.code = code;
    this.detail = detail;
  }
  static [Symbol.hasInstance](v) {
    return v instanceof Error && v.name === "KestrelError" && typeof v.code === "string";
  }
  /** The host rejects with { code, message, detail? }; anything else is wrapped. */
  static from(e) {
    return e && typeof e === "object" && typeof e.code === "string" && typeof e.message === "string"
      ? new KestrelError(e.code, e.message, e.detail)
      : new KestrelError("native_function", String(e));
  }
}

const invoke = (cmd, args) => {
  if (!globalThis.window?.__TAURI__?.core)
    return Promise.reject(
      new KestrelError("unsupported_platform", "kestrel-native: not running inside a Kestrel window"),
    );
  return window.__TAURI__.core.invoke(cmd, args).catch((e) => {
    throw KestrelError.from(e);
  });
};

/** Low-level escape hatch; prefer generated stubs from `kestrel typegen`. */
export const callNative = (name, args = {}) => invoke("call_native", { name, args });

/** app — identity & manifest */
export const app = {
  manifest: () => invoke("get_manifest"),
};
