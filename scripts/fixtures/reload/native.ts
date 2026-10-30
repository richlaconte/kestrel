// e2e fixture (#20, #21): imports a sibling file and the typed host module.
import { fs } from "kestreljs/native/host";
import { VALUE } from "./value";

export function value(): string {
  return VALUE;
}

export async function report(args: { seen: string[] }): Promise<void> {
  await fs.writeText("reload-result.json", JSON.stringify(args));
}
