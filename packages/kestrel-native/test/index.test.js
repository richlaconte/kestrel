import { test } from "node:test";
import assert from "node:assert/strict";
import { app, appWindow as win, clipboard, dialog, fs, KestrelError, notify, shell, store, tray } from "../index.js";

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
  await win.show();
  await win.hide();
  await win.open("/settings", { label: "settings", width: 400 });
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
    ["window_show", undefined],
    ["window_hide", undefined],
    ["window_open", { path: "/settings", opts: { label: "settings", width: 400 } }],
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

test("dialog, notify, clipboard and shell map onto their host commands", async () => {
  const calls = fakeHost(() => null);
  const filters = [{ name: "Text", extensions: ["txt"] }];
  assert.equal(await dialog.pickFile({ filters }), null, "cancelled");
  await dialog.pickFolder();
  await dialog.save({ defaultPath: "notes.txt" });
  await dialog.message("Saved");
  await dialog.message({ message: "Delete?", buttons: "yesNo", kind: "warning" });
  await notify("Done", "3 files");
  await clipboard.writeText("hi");
  await clipboard.readText();
  await shell.open("https://example.com");
  assert.deepEqual(calls, [
    ["dialog_pick_file", { opts: { filters } }],
    ["dialog_pick_folder", { opts: undefined }],
    ["dialog_save", { opts: { defaultPath: "notes.txt" } }],
    ["dialog_message", { opts: { message: "Saved" } }],
    ["dialog_message", { opts: { message: "Delete?", buttons: "yesNo", kind: "warning" } }],
    ["notify", { title: "Done", body: "3 files" }],
    ["clipboard_write_text", { text: "hi" }],
    ["clipboard_read_text", undefined],
    ["shell_open", { url: "https://example.com" }],
  ]);
});

test("tray maps onto its commands and splits its event by kind", async () => {
  const calls = fakeHost(() => true);
  const listeners = [];
  globalThis.window.__TAURI__.event = {
    listen: async (name, cb) => (listeners.push([name, cb]), () => {}),
  };
  const menu = [{ id: "show", label: "Show" }, { type: "separator" }];
  await tray.create({ tooltip: "T", menu, closeToTray: true });
  assert.equal(await tray.destroy(), true);
  assert.deepEqual(calls, [
    ["tray_create", { opts: { tooltip: "T", menu, closeToTray: true } }],
    ["tray_destroy", undefined],
  ]);

  const got = [];
  const off = tray.onMenu((e) => got.push(["menu", e]));
  tray.onClick(() => got.push(["click"]));
  assert.ok(listeners.every(([name]) => name === "kestrel:tray"));
  for (const payload of [{ kind: "menu", id: "show" }, { kind: "click" }, { kind: "menu", id: "mute", checked: false }])
    for (const [, cb] of listeners) cb({ payload });
  assert.deepEqual(got, [
    ["menu", { id: "show" }],
    ["click"],
    ["menu", { id: "mute", checked: false }],
  ]);
  assert.equal(typeof off, "function");
});
