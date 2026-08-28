// native.ts — your app's privileged code, in TypeScript.
// Runs inside the host (QuickJS), never in the webview. `kestrel dev` compiles
// it for the host and regenerates fully typed client stubs (native-client.ts):
// rename a function here and your React code stops compiling. That's the point.

declare function hostReadFile(path: string): string;
declare function hostWriteFile(path: string, contents: string): string;

const DATA_FILE = "./kestrel-data.json";

export function greet(args: { name: string }): string {
  return `Hello, ${args.name}! Greeted from inside the host.`;
}

export function visitCount(): number {
  const raw = hostReadFile(DATA_FILE);
  const data: { visits: number } = raw.startsWith("ERR:")
    ? { visits: 0 }
    : JSON.parse(raw);
  data.visits += 1;
  hostWriteFile(DATA_FILE, JSON.stringify(data));
  return data.visits;
}
