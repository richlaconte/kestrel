// Types for kestreljs/native/host. Only usable from native.ts (bundled for the
// host's QuickJS engine), never from webview code.

/**
 * Files, gated by kestrel.json `permissions`. With "fs:app-data", relative
 * paths resolve in this app's data directory and paths outside it reject
 * with `permission_denied`. Without an fs grant every call rejects with
 * `permission_denied`. A missing file rejects with `not_found`.
 */
export declare const fs: {
  readText(path: string): Promise<string>;
  writeText(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Absolute path of this app's data directory. */
  appDataDir(): string;
};

/** Print to the terminal running the app (stderr, prefixed `[native]`). */
export declare function log(...args: unknown[]): void;
