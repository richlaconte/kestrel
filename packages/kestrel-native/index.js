// kestrel-native — v0 client runtime.
// The std-lib surface here mirrors docs/rfc-0001-native-api.md §3; only the
// modules the host implements are exported. Every call returns a Promise that
// rejects with a KestrelError.

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

/**
 * Subscribe to an event native code sends with `emit`. Returns a function
 * that unsubscribes. Prefer the typed `on` in the generated native-client.
 */
export const on = (event, cb) => {
  const events = globalThis.window?.__TAURI__?.event;
  if (!events) return () => {};
  const off = events.listen("kestrel:native", (e) => {
    if (e.payload.event === event) cb(e.payload.payload);
  });
  return () => off.then((f) => f());
};

/** Low-level escape hatch; prefer generated stubs from `kestrel typegen`. */
export const callNative = (name, args = {}) => invoke("call_native", { name, args });

/** app — identity & lifecycle */
export const app = {
  manifest: () => invoke("get_manifest"),
  version: () => invoke("app_version"),
  quit: () => invoke("app_quit"),
};

/** appWindow — the app's main window. Not `window`: importing that name
 * would shadow the DOM global in the importing file. */
export const appWindow = {
  setTitle: (title) => invoke("window_set_title", { title }),
  minimize: () => invoke("window_minimize"),
  maximize: () => invoke("window_maximize"),
  close: () => invoke("window_close"),
};

/** fs — files, gated by kestrel.json `permissions` (same scope as native code) */
export const fs = {
  readText: (path) => invoke("fs_read_text", { path }),
  readBytes: (path) => invoke("fs_read_bytes", { path }).then((b) => new Uint8Array(b)),
  writeText: (path, contents) => invoke("fs_write_text", { path, contents }),
  exists: (path) => invoke("fs_exists", { path }),
  appDataDir: () => invoke("fs_app_data_dir"),
};

/** store — durable key-value storage, saved before each change resolves */
export const store = {
  get: (key) => invoke("store_get", { key }).then((v) => (v === null ? undefined : v)),
  set: (key, value) =>
    value === undefined
      ? Promise.reject(new KestrelError("io", `store.set("${key}", undefined): use store.delete to remove a key`))
      : invoke("store_set", { key, value }),
  delete: (key) => invoke("store_delete", { key }),
  keys: () => invoke("store_keys"),
};

/**
 * dialog — native file and message dialogs. Showing one needs no permission;
 * with "fs:pick", what the user picks becomes readable/writable through `fs`.
 * File dialogs resolve to the picked path, or null if the user cancelled.
 */
export const dialog = {
  pickFile: (opts) => invoke("dialog_pick_file", { opts }),
  pickFolder: (opts) => invoke("dialog_pick_folder", { opts }),
  save: (opts) => invoke("dialog_save", { opts }),
  message: (opts) => invoke("dialog_message", { opts: typeof opts === "string" ? { message: opts } : opts }),
};

/** notify — a system notification. Needs "notifications". */
export const notify = (title, body) => invoke("notify", { title, body });

/** clipboard — text only. Needs "clipboard". */
export const clipboard = {
  readText: () => invoke("clipboard_read_text"),
  writeText: (text) => invoke("clipboard_write_text", { text }),
};

/** shell — open an http(s) or mailto link in the default app. Needs "shell:open". */
export const shell = {
  open: (url) => invoke("shell_open", { url }),
};
