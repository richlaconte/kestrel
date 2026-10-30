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
