// Types for kestreljs/native/host. Only usable from native.ts (bundled for the
// host's QuickJS engine), never from webview code.

/**
 * Files, gated by kestrel.json `permissions`. With "fs:app-data", relative
 * paths resolve in this app's data directory and paths outside it reject
 * with `permission_denied`; "fs:pick" adds what the user picked in a webview
 * dialog. Without an fs grant every call rejects with
 * `permission_denied`. A missing file rejects with `not_found`.
 */
export declare const fs: {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Absolute path of this app's data directory. */
  appDataDir(): string;
};

/** `[event, payload]` pairs allowed by an event map. */
export type EmitArgs<E> = {
  [K in keyof E & string]: undefined extends E[K] ? [event: K, payload?: E[K]] : [event: K, payload: E[K]];
}[keyof E & string];

/**
 * Send an event to the app's windows, where `on(event, cb)` from
 * native-client receives it. Pass the `Events` map native.ts exports to
 * check names and payloads: `emit<Events>("progress", { done: 1 })`.
 * Events sent before a window subscribes are not kept.
 */
export declare function emit<E extends object = Record<string, unknown>>(...args: EmitArgs<E>): void;

/** Print to the terminal running the app (stderr, prefixed `[native]`). */
export declare function log(...args: unknown[]): void;
