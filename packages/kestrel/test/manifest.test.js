import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSIONS, validateManifest } from "../src/manifest.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ok = { appId: "my-app", title: "My App", frontend: "." };

test("templates' manifests are valid", () => {
  for (const t of ["react", "default"]) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, "templates", t, "kestrel.json"), "utf8"));
    assert.deepEqual(validateManifest(m), [], t);
  }
});

test("minimal and vite manifests are valid", () => {
  assert.deepEqual(validateManifest(ok), []);
  assert.deepEqual(validateManifest({ ...ok, frontend: { dev: "vite" }, native: "native.ts", width: 800 }), []);
});

test("each problem names its field", () => {
  const errs = (m) => validateManifest(m).join("\n");
  assert.match(errs({}), /`appId` is required[\s\S]*`title` is required[\s\S]*`frontend` is required/);
  assert.match(errs({ ...ok, appId: "My App" }), /`appId` must be lowercase/);
  assert.match(errs({ ...ok, width: -1 }), /`width` must be a positive number/);
  assert.match(errs({ ...ok, frontend: { dev: "webpack" } }), /`frontend.dev` must be "vite"/);
  assert.match(errs({ ...ok, native: "native.py" }), /`native` must be a path to a .ts or .js file/);
  assert.match(errs({ ...ok, titel: "typo" }), /`titel` is not a known field/);
  assert.match(errs([]), /must be a JSON object/);
});

test("the published schema lists the same fields as the validator", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "kestrel.schema.json"), "utf8"));
  for (const k of Object.keys(schema.properties))
    assert.deepEqual(validateManifest({ ...ok, [k]: ok[k] ?? (k === "native" ? "n.ts" : k === "$schema" ? "x" : 1) }).filter((e) => e.includes("not a known field")), [], k);
  assert.deepEqual(schema.required.sort(), ["appId", "frontend", "title"]);
});

test("permissions: known names only, no duplicates", () => {
  const errs = (p) => validateManifest({ ...ok, permissions: p }).join("\n");
  assert.equal(errs([]), "");
  assert.equal(errs(["fs:app-data"]), "");
  assert.match(errs("fs:all"), /`permissions` must be an array/);
  assert.match(errs(["fs:root"]), /unknown "fs:root" \(available: fs:app-data, fs:all\)/);
  assert.match(errs(["fs:all", "fs:all"]), /lists "fs:all" twice/);
});

test("CLI, schema and host agree on the permission names", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "kestrel.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.permissions.items.oneOf.map((o) => o.const), PERMISSIONS);
  const host = fs.readFileSync(path.join(ROOT, "..", "..", "host", "src", "scope.rs"), "utf8");
  const known = host.match(/pub const KNOWN: &\[&str\] = &\[([^\]]*)\]/)[1];
  assert.deepEqual([...known.matchAll(/"([^"]+)"/g)].map((x) => x[1]), PERMISSIONS);
});
