// e2e fixture (#17, #18): call the webview std-lib with no native.ts, record
// each result or error code, report, then quit. kestrel-native.js is copied in
// by scripts/e2e-stdlib.sh. With an fs grant the report goes through fs;
// without one it goes through the store (which needs no permission).
import { app, appWindow, clipboard, dialog, fs, KestrelError, notify, shell, store } from "./kestrel-native.js";

const r = {};
const step = async (name, f) => {
  try {
    r[name] = await f();
  } catch (e) {
    r[name] = { error: e.code, kestrelError: e instanceof KestrelError };
  }
};
const { permissions } = await app.manifest();
r.permissions = permissions;
await step("version", () => app.version());
await step("runsBefore", () => store.get("runs"));
await step("setRuns", () => store.set("runs", (r.runsBefore ?? 0) + 1));
await step("setObject", () => store.set("prefs", { theme: "dark", sizes: [1, 2] }));
await step("prefs", () => store.get("prefs"));
await step("deleteMissing", () => store.delete("never-set"));
await step("keys", () => store.keys());
await step("setTitle", () => appWindow.setTitle("std-lib ok"));
await step("write", () => fs.writeText("notes/a.txt", "héllo"));
await step("readText", () => fs.readText("notes/a.txt"));
await step("readBytes", async () => [...(await fs.readBytes("notes/a.txt"))]);
await step("exists", () => fs.exists("notes/a.txt"));
await step("missing", () => fs.readText("nope.txt"));
await step("escape", () => fs.readText("../outside.txt"));
await step("storeFile", () => fs.readText(".kestrel/store.json"));
// No modal opens: an invalid option is refused before the dialog is built.
await step("badDialog", () => dialog.message({ message: "x", kind: "loud" }));
const marker = `kestrel-e2e-${Date.now()}`;
await step("clipWrite", () => clipboard.writeText(marker));
await step("clipRead", async () => (await clipboard.readText()) === marker);
// Refused schemes and non-URLs: nothing is ever opened.
await step("openFile", () => shell.open("file:///etc/hosts"));
await step("openJunk", () => shell.open("not a url"));
// Only when ungranted: a real notification needs a bundled app on macOS.
if (!permissions.includes("fs:app-data")) await step("notify", () => notify("e2e"));

if (permissions.includes("fs:app-data")) await fs.writeText("stdlib-result.json", JSON.stringify(r));
else await store.set("result", r);
await app.quit();
