// Assertions for e2e-serve.sh. Usage: node assert.mjs <app dir>
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const read = (mode) => JSON.parse(fs.readFileSync(path.join(process.argv[2], `serve-results-${mode}.json`), "utf8"));

const dev = read("dev");
assert.equal(dev.post.status, 200, JSON.stringify(dev.post));
assert.equal(dev.post.echo, "1", "response headers must survive the dev proxy");
assert.deepEqual(JSON.parse(dev.post.body), { method: "POST", type: "application/json", body: '{"hi":1}' });
assert.equal(dev.wasm, "ok");
console.log("OK: dev proxy forwards POST, headers and body; wasm streams");

const build = read("build");
assert.equal(build.path, "/deep/route", "client-side route must load after reload");
assert.equal(build.wasm, "ok", "instantiateStreaming needs application/wasm");
assert.equal(build.fontType, "font/woff2");
console.log("OK: built app serves a client route, wasm and fonts with the right types");
