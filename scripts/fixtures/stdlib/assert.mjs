// Usage: node assert.mjs <granted|ungranted> <result.json> <run number>
import assert from "node:assert/strict";
import fs from "node:fs";

const [mode, file, run] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(file, "utf8"));
const denied = { error: "permission_denied", kestrelError: true };

assert.equal(r.version, "1.2.3");
assert.equal(r.runsBefore ?? null, Number(run) > 1 ? Number(run) - 1 : null, "store survives a restart");
assert.deepEqual(r.prefs, { theme: "dark", sizes: [1, 2] });
assert.equal(r.deleteMissing, false);
assert.deepEqual(r.keys.filter((k) => k !== "result"), ["prefs", "runs"]);
assert.equal(r.setTitle, null);

if (mode === "granted") {
  assert.equal(r.readText, "héllo");
  assert.deepEqual(r.readBytes, [...Buffer.from("héllo")]);
  assert.equal(r.exists, true);
  assert.deepEqual(r.missing, { error: "not_found", kestrelError: true });
  assert.deepEqual(r.escape, denied);
  assert.deepEqual(r.storeFile, denied, "the store file is Kestrel's, not app data");
} else {
  for (const k of ["write", "readText", "readBytes", "exists", "missing", "escape", "storeFile"])
    assert.deepEqual(r[k], denied, `${k} without an fs grant`);
}
console.log(`OK (${mode}, run ${run}): ${JSON.stringify(r)}`);
