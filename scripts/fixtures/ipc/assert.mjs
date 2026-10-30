// Assertions for e2e-ipc.sh. Usage: node assert.mjs ipc-results.json
import fs from "node:fs";
import assert from "node:assert/strict";

const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.deepEqual(r.sync, { ok: true, value: 42 });
assert.deepEqual(r.asyncValue, { ok: true, value: { doubled: 42 } }); // #2
assert.deepEqual(r.asyncChain, { ok: true, value: 3 });
assert.deepEqual(r.asyncUndefined, { ok: true, value: null });
assert.deepEqual(r.rejects, { ok: false, error: "nope" });
assert.deepEqual(r.throws, { ok: false, error: "sync nope" });
assert.match(r.neverSettles.error, /never settled/);
assert.match(r.missing.error, /no native function: missing/);
assert.deepEqual(r.spin, { ok: true, value: "spun" });
// #5: a 2 s native call must not freeze the page. A blocked main thread
// paints ~0 frames; leave generous headroom for slow CI runners.
assert.ok(r.spinFrames >= 20, `page painted only ${r.spinFrames} frames during a 2 s native call`);
console.log(`OK: IPC contract holds (${r.spinFrames} frames painted during a 2 s native call)`);
