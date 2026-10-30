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
assert.deepEqual(r.badDialog, { error: "io", kestrelError: true }, "dialog options are validated");
assert.equal(r.open, "second");
assert.equal(r.openAgain, "second", "an open label is focused, not opened twice");
assert.deepEqual(r.openRemote, denied, "appWindow.open refuses other sites");
assert.deepEqual(r.openBadLabel, { error: "io", kestrelError: true });
assert.equal(r.fromSecond, "/second.html", "the second window shares the app's store");
assert.equal(r.hide, null);
assert.equal(r.show, null);

if (mode === "granted") {
  assert.equal(r.readText, "héllo");
  assert.deepEqual(r.readBytes, [...Buffer.from("héllo")]);
  assert.equal(r.exists, true);
  assert.deepEqual(r.missing, { error: "not_found", kestrelError: true });
  assert.deepEqual(r.escape, denied);
  assert.deepEqual(r.storeFile, denied, "the store file is Kestrel's, not app data");
  assert.equal(r.clipWrite, null);
  assert.equal(r.clipRead, true, "clipboard round trip");
  assert.deepEqual(r.openFile, { error: "io", kestrelError: true }, "file: links are refused");
  assert.deepEqual(r.openJunk, { error: "io", kestrelError: true });
  assert.deepEqual(r.trayBad, { error: "io", kestrelError: true }, "a duplicate menu id is refused");
  if (process.platform === "linux" && r.trayCreate !== null) {
    // No appindicator library on the runner: refused, not a crash.
    assert.deepEqual(r.trayCreate, { error: "unsupported_platform", kestrelError: true });
    assert.equal(r.trayDestroy, false);
  } else {
    assert.equal(r.trayCreate, null, "tray.create");
    assert.equal(r.closeToTray, "still running", "closeToTray hides the main window instead of closing it");
    assert.equal(r.trayDestroy, true);
  }
  assert.equal(r.trayDestroyAgain, false);
} else {
  for (const k of ["write", "readText", "readBytes", "exists", "missing", "escape", "storeFile",
                   "clipWrite", "clipRead", "openFile", "openJunk", "notify",
                   "trayBad", "trayCreate", "trayDestroy", "trayDestroyAgain"])
    assert.deepEqual(r[k], denied, `${k} without an fs grant`);
}
console.log(`OK (${mode}, run ${run}): ${JSON.stringify(r)}`);
