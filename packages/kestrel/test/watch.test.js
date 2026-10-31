import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTypegen } from "../src/typegen.js";
import { watchNative } from "../src/watch.js";

/** Start watching a temp app; events land in a queue `next()` awaits. */
function watchApp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-watch-"));
  for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), src);
  const manifest = { native: "native.ts" };
  const first = runTypegen(dir, manifest);
  const queue = [];
  let wake = null;
  const push = (e) => {
    queue.push(e);
    wake?.();
  };
  const stop = watchNative(dir, manifest, first.inputs, {
    onBuild: (res) => push({ ok: res }),
    onError: (message) => push({ error: message }),
    debounceMs: 20,
  });
  const next = async () => {
    const deadline = Date.now() + 5000;
    while (!queue.length) {
      if (Date.now() > deadline) throw new Error("no rebuild within 5s");
      await new Promise((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
    return queue.shift();
  };
  // fs.watch can report a write as several events; let them settle first.
  const write = async (f, src) => {
    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(path.join(dir, f), src);
  };
  const run = (res) => {
    const g = {};
    new Function("globalThis", fs.readFileSync(res.compiled, "utf8"))(g);
    return g.native;
  };
  return { dir, next, write, run, stop, drain: () => queue.splice(0) };
}

test("editing native.ts or a file it imports rebuilds the bundle (#21)", async (t) => {
  const app = watchApp({
    "native.ts": `import { n } from "./lib";\nexport function value(): number { return n; }`,
    "lib.ts": `export const n = 1;`,
  });
  t.after(app.stop);

  await app.write("lib.ts", `export const n = 2;`);
  let e = await app.next();
  assert.equal(app.run(e.ok).value(), 2);

  // A new import joins the watched set.
  fs.writeFileSync(path.join(app.dir, "extra.ts"), `export const m = 40;`);
  await app.write(
    "native.ts",
    `import { n } from "./lib";\nimport { m } from "./extra";\nexport function value(): number { return n + m; }`,
  );
  e = await app.next();
  assert.equal(app.run(e.ok).value(), 42);
  app.drain();
  await app.write("extra.ts", `export const m = 100;`);
  e = await app.next();
  assert.equal(app.run(e.ok).value(), 102);
});

test("a broken save reports the error and keeps watching (#21)", async (t) => {
  const app = watchApp({ "native.ts": `export function value(): number { return 1; }` });
  t.after(app.stop);
  const client = path.join(app.dir, "native-client.ts");
  const before = fs.readFileSync(client, "utf8");

  await app.write("native.ts", `import { x } from "./nope";\nexport function renamed(): number { return x; }`);
  const e = await app.next();
  assert.match(e.error, /Could not resolve "\.\/nope"/);
  assert.equal(fs.readFileSync(client, "utf8"), before, "a failed build leaves the client alone");

  app.drain();
  await app.write("native.ts", `export function value(): string { return "fixed"; }`);
  const ok = await app.next();
  assert.equal(app.run(ok.ok).value(), "fixed");
  assert.match(fs.readFileSync(client, "utf8"), /value\(\): Promise<string>/);
});

test("an unexpected rebuild failure is reported, not thrown out of a timer", async (t) => {
  const app = watchApp({ "native.ts": `export function value(): number { return 1; }` });
  t.after(app.stop);
  // A directory where the bundle must be written makes esbuild's output fail
  // in a way that isn't a TypegenError.
  fs.rmSync(path.join(app.dir, ".kestrel"), { recursive: true });
  fs.mkdirSync(path.join(app.dir, ".kestrel", "native.compiled.js.tmp"), { recursive: true });
  await app.write("native.ts", `export function value(): number { return 2; }`);
  const e = await app.next();
  assert.match(e.error, /^native rebuild failed: /);
});
