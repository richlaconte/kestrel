// native.ts — your app's privileged code, in TypeScript.
// Runs inside the host (QuickJS), never in the webview. `kestrel dev` compiles
// it for the host and regenerates fully typed client stubs (native-client.ts):
// rename a function here and your React code stops compiling. That's the point.
//
// Host bindings exist only for permissions granted in kestrel.json. With
// "fs:app-data", relative paths live in this app's data directory, and paths
// outside it throw.

declare function hostReadFile(path: string): string;
declare function hostWriteFile(path: string, contents: string): void;
declare function hostExists(path: string): boolean;

const DATA_FILE = "kestrel-data.json";

export function greet(args: { name: string }): string {
  return `Hello, ${args.name}! Greeted from inside the host.`;
}

export function visitCount(): number {
  const data: { visits: number } = hostExists(DATA_FILE)
    ? JSON.parse(hostReadFile(DATA_FILE))
    : { visits: 0 };
  data.visits += 1;
  hostWriteFile(DATA_FILE, JSON.stringify(data));
  return data.visits;
}
