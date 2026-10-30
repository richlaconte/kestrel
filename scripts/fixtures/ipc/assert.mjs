// Assertions for e2e-ipc.sh. Usage: node assert.mjs ipc-results.json
import fs from "node:fs";
import assert from "node:assert/strict";

const r = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.deepEqual(r.sync, { ok: true, value: 42 });
assert.deepEqual(r.asyncValue, { ok: true, value: { doubled: 42 } }); // #2
assert.deepEqual(r.asyncChain, { ok: true, value: 3 });
assert.deepEqual(r.asyncUndefined, { ok: true, value: null });
// #19: every failure is a structured KestrelError payload.
const fn = (name) => ({ function: name });
assert.deepEqual(r.rejects, { ok: false, code: "native_function", error: "nope", detail: fn("rejects") });
assert.deepEqual(r.throws, { ok: false, code: "native_function", error: "sync nope", detail: fn("throws") });
assert.equal(r.neverSettles.code, "native_function");
assert.match(r.neverSettles.error, /never settled/);
assert.deepEqual(r.missing, { ok: false, code: "not_found", error: "no native function: missing", detail: fn("missing") });
assert.equal(r.readMissing.code, "not_found");
assert.match(r.readMissing.error, /^does-not-exist\.txt: /);
assert.equal(r.escape.code, "permission_denied");
assert.deepEqual(r.cancels, { ok: false, code: "cancelled", error: "user cancelled", detail: fn("cancels") });
assert.deepEqual(r.spin, { ok: true, value: "spun" });
// #22: emitted events reach the page, in order, with their payloads.
assert.deepEqual(r.progress, { ok: true, value: 3 });
assert.deepEqual(r.events, [
  { event: "progress", payload: { i: 1 } },
  { event: "progress", payload: { i: 2 } },
  { event: "progress", payload: { i: 3 } },
  { event: "other", payload: null },
]);
// #5: a 2 s native call must not freeze the page. A blocked main thread
// paints ~0 frames; leave generous headroom for slow CI runners.
assert.ok(r.spinFrames >= 20, `page painted only ${r.spinFrames} frames during a 2 s native call`);
// #11: CSP header applied, popups denied, navigation away refused.
assert.equal(r.evalBlocked, true, "default CSP must block eval");
assert.equal(r.popup, "denied");
assert.match(r.stillHere, /^(kestrel|http):$/, "window must stay on the app origin");
console.log("OK: errors arrive as KestrelError payloads with the right codes");
console.log("OK: CSP blocks eval; popups and navigation away are refused");
console.log("OK: native emit reaches the page in order");
console.log(`OK: IPC contract holds (${r.spinFrames} frames painted during a 2 s native call)`);
