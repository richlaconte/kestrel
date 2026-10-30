import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSIONS, WINDOW_FIELDS, validateManifest } from "../src/manifest.js";

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
  assert.equal(errs(["fs:pick", "clipboard", "notifications", "shell:open", "tray"]), "");
  assert.match(
    errs(["fs:root"]),
    /unknown "fs:root" \(available: fs:app-data, fs:pick, fs:all, notifications, clipboard, shell:open, tray\)/,
  );
  assert.match(errs(["fs:all", "fs:all"]), /lists "fs:all" twice/);
});

test("CLI, schema and host agree on the permission names", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "kestrel.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.permissions.items.oneOf.map((o) => o.const), PERMISSIONS);
  const host = fs.readFileSync(path.join(ROOT, "..", "..", "host", "src", "scope.rs"), "utf8");
  const known = host.match(/pub const KNOWN: &\[&str\] = &\[([^\]]*)\]/)[1];
  assert.deepEqual([...known.matchAll(/"([^"]+)"/g)].map((x) => x[1]), PERMISSIONS);
});

test("version is an optional non-empty string", () => {
  assert.deepEqual(validateManifest({ ...ok, version: "1.2.3" }), []);
  for (const bad of ["", 1])
    assert.match(validateManifest({ ...ok, version: bad }).join(), /`version` must be a non-empty string/);
});

test("window options: types, enum and min/max order", () => {
  const errs = (o) => validateManifest({ ...ok, ...o }).join("\n");
  assert.equal(
    errs({ resizable: false, center: true, decorations: false, rememberWindow: false, titleBarStyle: "overlay", width: 800, minWidth: 400, maxWidth: 1200, minHeight: 300 }),
    "",
  );
  assert.match(errs({ resizable: "no" }), /`resizable` must be true or false/);
  assert.match(errs({ titleBarStyle: "hidden" }), /`titleBarStyle` must be one of "visible", "transparent", "overlay"/);
  assert.match(errs({ minWidth: 0 }), /`minWidth` must be a positive number/);
  assert.match(errs({ minWidth: 900, maxWidth: 800 }), /`minWidth` \(900\) is larger than `maxWidth` \(800\)/);
  assert.match(errs({ width: 300, minWidth: 400 }), /`minWidth` \(400\) is larger than `width` \(300\)/);
  assert.match(errs({ height: 900, maxHeight: 800 }), /`height` \(900\) is larger than `maxHeight` \(800\)/);
});

test("CLI and host agree on the window fields", () => {
  const host = fs.readFileSync(path.join(ROOT, "..", "..", "host", "src", "window.rs"), "utf8");
  const struct = host.match(/pub struct WindowOptions \{([\s\S]*?)\n\}/)[1];
  const camel = (s) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  assert.deepEqual([...struct.matchAll(/pub (\w+):/g)].map((x) => camel(x[1])), WINDOW_FIELDS);
});

test("icon and bundleId (#24, #27)", () => {
  const errs = (o) => validateManifest({ ...ok, ...o }).join("\n");
  assert.equal(errs({ icon: "assets/icon.png", bundleId: "com.example.my-app" }), "");
  assert.match(errs({ icon: "icon.svg" }), /`icon` must be a path to a square PNG/);
  assert.match(errs({ bundleId: "my-app" }), /`bundleId` must be reverse-DNS/);
  assert.match(errs({ bundleId: "com.example/x" }), /`bundleId` must be reverse-DNS/);
});
