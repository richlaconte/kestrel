// native.ts — your app's privileged code, in TypeScript.
// Runs inside the host (QuickJS), never in the webview. `kestrel dev` bundles
// it (with anything it imports: your own files, pure-JS npm packages) for the
// host and regenerates fully typed client stubs (native-client.ts): rename a
// function here and your React code stops compiling. That's the point.
//
// Host APIs exist only for permissions granted in kestrel.json. With
// "fs:app-data", relative paths live in this app's data directory, and paths
// outside it reject.
import { fs } from "kestreljs/native/host";

const DATA_FILE = "kestrel-data.json";

export function greet(args: { name: string }): string {
  return `Hello, ${args.name}! Greeted from inside the host.`;
}

export async function visitCount(): Promise<number> {
  const data: { visits: number } = (await fs.exists(DATA_FILE))
    ? JSON.parse(await fs.readText(DATA_FILE))
    : { visits: 0 };
  data.visits += 1;
  await fs.writeText(DATA_FILE, JSON.stringify(data));
  return data.visits;
}
