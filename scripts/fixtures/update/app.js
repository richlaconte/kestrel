// e2e fixture (#28): version 1.0.0 checks the feed and applies the update;
// the relaunched 2.0.0 records that it ran. Everything goes to the store
// (no permission needed), which scripts/e2e-update.sh reads.
// kestrel-native.js is copied in by the script.
import { app, store, updater } from "./kestrel-native.js";

const log = (await store.get("log")) ?? [];
const v = await app.version();
log.push({ v });
if (v === "1.0.0") {
  try {
    log.push({ check: await updater.check() });
    // apply exits the app on success, so save first.
    await store.set("log", log);
    log.push({ applied: await updater.apply() });
  } catch (e) {
    log.push({ error: e.code, message: e.message });
  }
}
await store.set("log", log);
await app.quit();
