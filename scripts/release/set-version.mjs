// Set one version across every published package, the host crate, and
// kestreljs's optionalDependencies on the platform host packages.
// Usage: node set-version.mjs 0.2.0
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, pkgName } from "./targets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const version = process.argv[2]?.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("usage: set-version.mjs <semver>");
  process.exit(1);
}

const editJson = (rel, fn) => {
  const p = path.join(ROOT, rel);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  fn(j);
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
};

editJson("packages/kestrel/package.json", (j) => {
  j.version = version;
  j.optionalDependencies = Object.fromEntries(TARGETS.map((t) => [pkgName(t), version]));
});
editJson("packages/create-kestrel-app/package.json", (j) => {
  j.version = version;
  if (j.dependencies?.kestreljs) j.dependencies.kestreljs = version;
});
editJson("packages/kestrel-native/package.json", (j) => (j.version = version));
editJson("packages/kestrel/templates/react/package.json", (j) => {
  j.devDependencies.kestreljs = `^${version}`;
});
editJson("host/tauri.conf.json", (j) => (j.version = version));

const cargo = path.join(ROOT, "host/Cargo.toml");
fs.writeFileSync(
  cargo,
  fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`),
);
console.log(`set version ${version}`);
