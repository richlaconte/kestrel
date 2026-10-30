import { test } from "node:test";
import assert from "node:assert/strict";
import kestrel from "../src/vite.js";

test("vite plugin points the server and HMR at the port kestrel dev picked", () => {
  process.env.KESTREL_DEV_PORT = "5191";
  try {
    const { base, server } = kestrel().config();
    assert.equal(base, "/");
    assert.equal(server.port, 5191);
    assert.equal(server.strictPort, true);
    assert.deepEqual(server.hmr, { protocol: "ws", host: "localhost", port: 5191 });
  } finally {
    delete process.env.KESTREL_DEV_PORT;
  }
});

test("vite plugin defaults to 5183 outside kestrel dev", () => {
  assert.equal(kestrel().config().server.port, 5183);
});

test("native build errors from kestrel dev reach Vite's overlay, and clear with a reload", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-vite-"));
  const file = path.join(root, ".kestrel", "native-error.json");
  const watcher = Object.assign(new EventEmitter(), { add() {} });
  const sent = [];
  const ws = Object.assign(new EventEmitter(), { send: (m) => sent.push(m) });
  kestrel().configureServer({ config: { root }, watcher, ws });

  watcher.emit("unlink", file);
  assert.deepEqual(sent, [], "no reload when nothing was showing");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ message: "native.ts:1:1: boom" }));
  watcher.emit("add", file);
  assert.equal(sent[0].type, "error");
  assert.equal(sent[0].err.message, "native.ts:1:1: boom");
  ws.emit("connection");
  assert.equal(sent.length, 2, "a window connecting mid-error sees it");
  fs.rmSync(file);
  watcher.emit("unlink", file);
  assert.deepEqual(sent[2], { type: "full-reload" });
});
