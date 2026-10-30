import { test } from "node:test";
import assert from "node:assert/strict";
import { app, appWindow as win, fs, KestrelError, store } from "../index.js";

/** Route invoke() to `impl`, recording each command and its args. */
function fakeHost(impl) {
  const calls = [];
  globalThis.window = {
    __TAURI__: { core: { invoke: async (cmd, args) => (calls.push([cmd, args]), impl(cmd, args)) } },
  };
  return calls;
}

test("each std-lib call maps onto its host command", async () => {
  const calls = fakeHost(() => null);
  await app.version();
  await app.quit();
  await win.setTitle("T");
  await win.minimize();
  await win.maximize();
  await win.close();
  await fs.readText("a");
  await fs.writeText("a", "x");
  await fs.exists("a");
  await fs.appDataDir();
  await store.set("k", { v: 1 });
  await store.delete("k");
  await store.keys();
  assert.deepEqual(calls, [
    ["app_version", undefined],
    ["app_quit", undefined],
    ["window_set_title", { title: "T" }],
    ["window_minimize", undefined],
    ["window_maximize", undefined],
    ["window_close", undefined],
    ["fs_read_text", { path: "a" }],
    ["fs_write_text", { path: "a", contents: "x" }],
    ["fs_exists", { path: "a" }],
    ["fs_app_data_dir", undefined],
    ["store_set", { key: "k", value: { v: 1 } }],
    ["store_delete", { key: "k" }],
    ["store_keys", undefined],
  ]);
});

test("readBytes gives a Uint8Array; a missing store key is undefined", async () => {
  fakeHost((cmd) => (cmd === "fs_read_bytes" ? new Uint8Array([1, 2, 3]).buffer : cmd === "store_get" ? null : 0));
  const bytes = await fs.readBytes("b.bin");
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(await store.get("nope"), undefined);
});

test("store.set(key, undefined) rejects instead of sending nothing", async () => {
  const calls = fakeHost(() => null);
  const e = await store.set("k", undefined).catch((x) => x);
  assert.ok(e instanceof KestrelError);
  assert.match(e.message, /use store\.delete/);
  assert.deepEqual(calls, []);
});

test("host rejections arrive as KestrelError with their code", async () => {
  fakeHost(() => {
    throw { code: "permission_denied", message: 'fs.readText needs the "fs:app-data" or "fs:all" permission' };
  });
  const e = await fs.readText("x").catch((x) => x);
  assert.ok(e instanceof KestrelError);
  assert.equal(e.code, "permission_denied");
});

test("outside a Kestrel window every call rejects with unsupported_platform", async () => {
  delete globalThis.window;
  const e = await store.keys().catch((x) => x);
  assert.equal(e.code, "unsupported_platform");
});
