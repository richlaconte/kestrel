// Publish staged packages in dependency order, skipping any name@version
// already on the registry so a failed release can simply be re-run.
// Usage: node publish.mjs <dir> [<dir> …]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const npm = (args, opts = {}) =>
  execFileSync("npm", args, { stdio: "inherit", shell: process.platform === "win32", ...opts });

for (const dir of process.argv.slice(2)) {
  const { name, version } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  let exists = false;
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], { stdio: "pipe" });
    exists = true;
  } catch {}
  if (exists) {
    console.log(`skip ${name}@${version} (already published)`);
    continue;
  }
  npm(["publish", "--access", "public", "--provenance"], { cwd: dir });
}
