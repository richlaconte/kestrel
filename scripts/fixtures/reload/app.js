// e2e fixture (#21): poll a native function and report every distinct value
// it returns. The history lives in this page, so seeing old and new values in
// one report proves the module reloaded without the window restarting.
const invoke = window.__TAURI__.core.invoke;
const seen = [];
for (;;) {
  const v = await invoke("call_native", { name: "value", args: {} }).catch((e) => `error: ${e.message}`);
  if (v !== seen[seen.length - 1]) {
    seen.push(v);
    document.getElementById("out").textContent = seen.join(" → ");
    await invoke("call_native", { name: "report", args: { seen } });
  }
  await new Promise((r) => setTimeout(r, 200));
}
