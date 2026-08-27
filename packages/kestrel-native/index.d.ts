export declare function callNative(name: string, args?: Record<string, unknown>): Promise<unknown>;

export declare const app: {
  manifest(): Promise<{
    appId: string;
    title: string;
    width: number;
    height: number;
  }>;
};

export declare const store: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};
