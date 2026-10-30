const call = (name, args = {}) => window.__TAURI__.core.invoke("call_native", { name, args });
// The host rejects with a KestrelError payload: { code, message, detail? }.
const outcome = (p) =>
  p.then(
    (value) => ({ ok: true, value }),
    (e) => ({ ok: false, code: e?.code, error: e?.message ?? String(e), detail: e?.detail }),
  );

const results = {};
for (const [name, args] of [
  ["sync", { n: 21 }],
  ["asyncValue", { n: 21 }],
  ["asyncChain"],
  ["asyncUndefined"],
  ["rejects"],
  ["throws"],
  ["neverSettles"],
  ["missing"],
  ["readMissing"],
  ["escape"],
  ["cancels"],
]) results[name] = await outcome(call(name, args));

// #22: native code's emit arrives as one "kestrel:native" event per emit,
// in order. (kestrel-native and the generated client's `on` wrap this.)
const events = [];
const unlisten = await window.__TAURI__.event.listen("kestrel:native", (e) => events.push(e.payload));
results.progress = await outcome(call("progress", { n: 3 }));
await new Promise((r) => setTimeout(r, 300));
unlisten();
results.events = events;

// #5: while a native call spins for 2 s, the page must keep painting.
let frames = 0;
const count = () => { frames++; document.getElementById("tick").textContent = frames; if (spinning) requestAnimationFrame(count); };
let spinning = true;
requestAnimationFrame(count);
const t0 = performance.now();
results.spin = await outcome(call("spin", { ms: 2000 }));
spinning = false;
results.spinFrames = frames;
results.spinMs = Math.round(performance.now() - t0);

// #11: the built app runs under the default CSP and a navigation lock.
try {
  eval("1");
  results.evalBlocked = false;
} catch {
  results.evalBlocked = true;
}
results.popup = window.open("data:text/html,popup") === null ? "denied" : "opened";
location.href = "data:text/html,navigated-away";
await new Promise((r) => setTimeout(r, 1000));
results.stillHere = location.protocol;

await call("report", results);
