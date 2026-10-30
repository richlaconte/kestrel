export type KestrelErrorCode =
  | "permission_denied"
  | "not_found"
  | "io"
  | "native_function"
  | "cancelled"
  | "unsupported_platform"
  | "timeout";

/** Every rejection from the host (RFC-0001 §7). Check `err.code`. */
export declare class KestrelError extends Error {
  readonly code: KestrelErrorCode;
  readonly detail?: unknown;
  constructor(code: KestrelErrorCode, message: string, detail?: unknown);
  static from(e: unknown): KestrelError;
}

export declare function callNative(name: string, args?: Record<string, unknown>): Promise<unknown>;

export declare const app: {
  manifest(): Promise<{
    appId: string;
    title: string;
    version: string;
    width: number;
    height: number;
    permissions: string[];
  }>;
  /** kestrel.json's `version`, else package.json's. */
  version(): Promise<string>;
  /** Exit the app. */
  quit(): Promise<void>;
};

/** The app's main window. (Not `window`, which would shadow the DOM global.) */
export declare const appWindow: {
  setTitle(title: string): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Files, gated by kestrel.json `permissions`, with the same scope native code
 * gets. With "fs:app-data", relative paths resolve in the app's data
 * directory and paths outside it reject with `permission_denied`. Without an
 * fs grant every call rejects with `permission_denied`.
 */
export declare const fs: {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  appDataDir(): Promise<string>;
};

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Durable key-value storage for this app, in `<app data dir>/.kestrel/store.json`.
 * Each change is on disk before its promise resolves. Needs no permission.
 */
export declare const store: {
  /** `undefined` when the key isn't set. */
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  /** Resolves true if the key was there. */
  delete(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
};
