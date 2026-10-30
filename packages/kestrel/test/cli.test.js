import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "kestrel.js");
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-cli-"));

test("no command prints usage and exits 0; unknown command exits 1", () => {
  const ok = run([]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /kestrel create <name>/);
  assert.equal(run(["nope"]).status, 1);
});

for (const template of ["react", "vanilla"]) {
  test(`create --template=${template} sets appId and title from the name`, () => {
    const cwd = tmp();
    const res = run(["create", "My Cool_App", `--template=${template}`], cwd);
    assert.equal(res.status, 0, res.stderr);
    const m = JSON.parse(fs.readFileSync(path.join(cwd, "My Cool_App", "kestrel.json"), "utf8"));
    assert.equal(m.appId, "my-cool-app");
    assert.equal(m.title, "My Cool_App");
  });
}

test("create derives a valid appId from awkward names", () => {
  const cwd = tmp();
  assert.equal(run(["create", "_Weird Name!", "--template=vanilla"], cwd).status, 0);
  const m = JSON.parse(fs.readFileSync(path.join(cwd, "_Weird Name!", "kestrel.json"), "utf8"));
  assert.equal(m.appId, "weird-name-");
});

test("an invalid manifest lists every problem before anything launches", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "kestrel.json"), JSON.stringify({ appId: "Bad Id", frontend: 3 }));
  const res = run(["dev", dir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /`appId` must be lowercase/);
  assert.match(res.stderr, /`title` is required/);
  assert.match(res.stderr, /`frontend` must be a directory path/);
});

test("a missing native module is caught before launch", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "kestrel.json"), JSON.stringify({ appId: "a", title: "A", frontend: ".", native: "native.ts" }));
  const res = run(["typegen", dir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /`native` points at native\.ts, which doesn't exist/);
});

test("create refuses to overwrite an existing directory", () => {
  const cwd = tmp();
  fs.mkdirSync(path.join(cwd, "taken"));
  const res = run(["create", "taken"], cwd);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /already exists/);
});

test("typegen outside an app explains what's missing", () => {
  const res = run(["typegen", tmp()]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no kestrel\.json/);
});

test("typegen reports a user error in native.ts without a stack trace", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "kestrel.json"), JSON.stringify({ appId: "a", title: "A", frontend: ".", native: "native.ts" }));
  fs.writeFileSync(path.join(dir, "native.ts"), "interface X { a: number }\nexport function f(args: X): number { return 1; }\n");
  const res = run(["typegen", dir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /`f` uses type `X`, which is not exported/);
  assert.doesNotMatch(res.stderr, /\n\s+at /);
});

test("typegen warns about non-function exports", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "kestrel.json"), JSON.stringify({ appId: "a", title: "A", frontend: ".", native: "native.ts" }));
  fs.writeFileSync(path.join(dir, "native.ts"), "export const V = 1;\nexport function f(): number { return 1; }\n");
  const res = run(["typegen", dir]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /exports `V`, which isn't a function/);
  assert.match(res.stdout, /1 fn\(s\): f/);
});
