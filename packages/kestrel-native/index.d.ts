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
    width: number;
    height: number;
    permissions: string[];
  }>;
};
