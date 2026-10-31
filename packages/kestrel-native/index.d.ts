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

export interface OpenWindowOptions {
  /** Names the window. Opening a label that's already open focuses that window instead. */
  label?: string;
  /** Defaults to the manifest's title. */
  title?: string;
  /** Default to the manifest's width and height. */
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
  resizable?: boolean;
  center?: boolean;
  decorations?: boolean;
  /** macOS only. */
  titleBarStyle?: "visible" | "transparent" | "overlay";
}

/**
 * The window the calling page is in. (Not `window`, which would shadow the
 * DOM global.)
 */
export declare const appWindow: {
  setTitle(title: string): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  /** Under `tray.create({ closeToTray: true })`, the main window hides instead. */
  close(): Promise<void>;
  /** Show, unminimize and focus the window, e.g. after it was closed to the tray. */
  show(): Promise<void>;
  hide(): Promise<void>;
  /**
   * Open another window on one of the app's pages, like "/settings" or
   * "about.html". It shares the app's storage and std-lib, and native
   * events reach it too. Resolves to the window's label. Any other URL
   * rejects with `permission_denied`: use `shell.open` for links.
   */
  open(path: string, opts?: OpenWindowOptions): Promise<string>;
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

/** One entry in a tray menu. Ids are unique across the whole menu. */
export type TrayMenuItem =
  | { id: string; label: string; enabled?: boolean }
  /** A check item toggles itself when clicked; onMenu gets its new state. */
  | { id: string; label: string; checked: boolean; enabled?: boolean }
  | { type: "separator" }
  /** A submenu; they nest at most 4 deep. */
  | { label: string; items: TrayMenuItem[]; enabled?: boolean };

export interface TrayOptions {
  tooltip?: string;
  /** Text beside the icon. macOS only. */
  title?: string;
  /** Opens on a click; see `menuOnLeftClick`. */
  menu?: TrayMenuItem[];
  /**
   * Default true. False keeps left click for `onClick` (say, to show the
   * window) and opens the menu on right click. Windows and macOS; Linux
   * always opens the menu.
   */
  menuOnLeftClick?: boolean;
  /**
   * Closing the main window hides it instead, so the app keeps running in
   * the tray. Bring it back with `appWindow.show()`; on macOS a dock click
   * does too. `app.quit()` still quits.
   */
  closeToTray?: boolean;
}

/**
 * One icon in the menu bar (macOS) or system tray, showing the app's icon.
 * Needs "tray". On Linux it needs libayatana-appindicator3, and rejects with
 * `unsupported_platform` without it.
 */
export declare const tray: {
  /** Show the icon, replacing the one already up. A bad menu rejects with `io`, naming the item. */
  create(opts?: TrayOptions): Promise<void>;
  /** Resolves false if there was no tray. */
  destroy(): Promise<boolean>;
  /** A menu item was clicked. Returns a function that unsubscribes. */
  onMenu(cb: (e: { id: string; checked?: boolean }) => void): () => void;
  /** The icon was left-clicked. Windows and macOS; Linux has no icon clicks. Pair with `menuOnLeftClick: false`. */
  onClick(cb: () => void): () => void;
};

export interface UpdateInfo {
  version: string;
  notes: string | null;
  pubDate: string | null;
  /**
   * False when this copy can't replace itself: in dev, a portable folder,
   * a .deb (apt updates those), or no build for this OS in the feed.
   */
  canApply: boolean;
}

/**
 * Auto-update from the feed named by kestrel.json `updater.endpoint`. Every
 * download is checked against `updater.pubkey` before anything is replaced.
 * Without `updater` in kestrel.json, calls reject with `unsupported_platform`.
 */
export declare const updater: {
  /** The newer version, or null when this is the latest. */
  check(): Promise<UpdateInfo | null>;
  /**
   * Download, verify and install the newer version, then quit and start it:
   * on success the promise never settles, because the app exits. Resolves
   * false when there's nothing newer. A bad signature rejects with
   * `permission_denied`; a copy that can't replace itself, with
   * `unsupported_platform`.
   */
  apply(): Promise<boolean>;
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
