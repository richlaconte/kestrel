// kestreljs/native/host — the host bindings, as a module native.ts imports.
// `kestrel` bundles native.ts into one script for the host's QuickJS engine;
// this file is bundled with it and maps onto the globals the host installs.
// A binding exists only when kestrel.json grants its permission, so a call
// without the grant rejects with `permission_denied` instead of a
// ReferenceError.

function binding(name, permission) {
  const fn = globalThis[name];
  if (typeof fn === "function") return fn;
  const e = new Error(`${permission} needs the "fs:app-data", "fs:pick" or "fs:all" permission in kestrel.json`);
  e.code = "permission_denied";
  throw e;
}

// Async on purpose: today's bindings are synchronous, but callers that await
// them keep working when real async I/O lands (RFC-0001 §4(d)).
export const fs = {
  async readText(path) {
    return binding("hostReadFile", "fs.readText")(path);
  },
  async writeText(path, contents) {
    binding("hostWriteFile", "fs.writeText")(path, contents);
  },
  async exists(path) {
    return binding("hostExists", "fs.exists")(path);
  },
  appDataDir() {
    return binding("hostAppDataDir", "fs.appDataDir")();
  },
};

/**
 * Send an event to the app's windows, where `on(event, cb)` from
 * native-client receives it. The payload must survive JSON.stringify.
 */
export function emit(event, payload) {
  if (typeof event !== "string" || !event) throw new TypeError("emit: the event name must be a non-empty string");
  globalThis.hostEmit(event, JSON.stringify(payload === undefined ? null : payload));
}

/** Print to the terminal running the app (stderr, prefixed `[native]`). */
export function log(...args) {
  globalThis.hostLog(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
}
