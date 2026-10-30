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

/**
 * Subscribe to an event native code sends with `emit`. Returns a function
 * that unsubscribes. The generated native-client has a typed `on`.
 */
export declare function on(event: string, cb: (payload: unknown) => void): () => void;

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
 * directory and paths outside it reject with `permission_denied`; "fs:pick"
 * adds whatever the user picks in `dialog`. Without an fs grant every call
 * rejects with `permission_denied`.
 */
export declare const fs: {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  appDataDir(): Promise<string>;
};

export interface FileDialogOptions {
  title?: string;
  /** A folder to start in, or a file path to suggest (save). */
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface MessageOptions {
  message: string;
  title?: string;
  kind?: "info" | "warning" | "error";
  buttons?: "ok" | "okCancel" | "yesNo";
}

/**
 * Native dialogs. Showing one needs no permission. With "fs:pick", the picked
 * file or folder (and everything in it) becomes readable and writable
 * through `fs` for the rest of the run. File dialogs resolve to null when the
 * user cancels.
 */
export declare const dialog: {
  pickFile(opts?: FileDialogOptions): Promise<string | null>;
  pickFolder(opts?: FileDialogOptions): Promise<string | null>;
  save(opts?: FileDialogOptions): Promise<string | null>;
  /** True for OK/Yes; false for Cancel/No or a dismissed dialog. */
  message(opts: MessageOptions | string): Promise<boolean>;
};

/** Show a system notification. Needs "notifications". */
export declare function notify(title: string, body?: string): Promise<void>;

/** Clipboard text. Needs "clipboard". */
export declare const clipboard: {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
};

/** Open an http, https or mailto link in the default app. Needs "shell:open". */
export declare const shell: {
  open(url: string): Promise<void>;
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
