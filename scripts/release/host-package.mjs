// Stage one platform's host npm package around a built binary.
// Usage: node host-package.mjs <os>-<cpu> <path/to/kestrel-host[.exe]> <outDir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, pkgName } from "./targets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [key, binary, outDir] = process.argv.slice(2);
const t = TARGETS.find((x) => `${x.os}-${x.cpu}` === key);
if (!t || !binary || !outDir) {
  console.error("usage: host-package.mjs <os>-<cpu> <binary> <outDir>");
  process.exit(1);
}
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/kestrel/package.json"), "utf8"));
const name = pkgName(t);
const dir = path.join(outDir, name);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
fs.copyFileSync(binary, path.join(dir, "bin", t.exe));
fs.chmodSync(path.join(dir, "bin", t.exe), 0o755);
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(dir, "LICENSE"));
fs.writeFileSync(
  path.join(dir, "package.json"),
  JSON.stringify(
    {
      name,
      version,
      description: `Prebuilt Kestrel host for ${t.os}-${t.cpu}. Installed automatically by kestreljs.`,
      license: "MIT",
      os: [t.os],
      cpu: [t.cpu],
      files: ["bin"],
      repository: { type: "git", url: "git+https://github.com/richlaconte/kestrel.git" },
      homepage: "https://github.com/richlaconte/kestrel",
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  path.join(dir, "README.md"),
  `# ${name}\n\nThe prebuilt Kestrel host binary for ${t.os}-${t.cpu}. You don't install this directly: \`kestreljs\` lists it as an optional dependency and npm picks the one for your platform.\n`,
);
console.log(dir);
