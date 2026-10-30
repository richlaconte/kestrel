#!/usr/bin/env node
// create-kestrel-app — thin wrapper over `kestrel create` so the canonical
// `npx create-kestrel-app my-app` flow works without installing the CLI first.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
let cli;
try {
  cli = require.resolve("kestreljs/bin/kestrel.js");
} catch {
  // monorepo fallback
  cli = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "kestrel",
    "bin",
    "kestrel.js",
  );
}
const r = spawnSync(process.execPath, [cli, "create", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
