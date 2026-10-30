// e2e fixture (#16): report what localStorage held at startup, then claim the
// key for this app. Two apps on the same kestrel://localhost origin must never
// see each other's value; the same app must see its own on the next launch.
const invoke = window.__TAURI__.core.invoke;
const { appId } = await invoke("get_manifest");
const seen = localStorage.getItem("owner");
localStorage.setItem("owner", appId);
await invoke("call_native", { name: "report", args: { appId, seen } });
