# Kestrel Phase 0 Spike — Findings

**Date:** 2026-08-27 · **Platform tested:** Linux (webkit2gtk 2.52), cloud container, 2 cores
**Question:** Can one precompiled, generic Tauri v2 binary run arbitrary apps from a runtime
manifest — no per-app Rust compilation — with working typed IPC?

## Answer: yes.

One `kestrel-host` release binary (**4.4 MB, stripped**) ran two entirely different apps
(`notes-app`, `timer-app`) with different window titles, sizes, and frontends, purely by
pointing it at different `*.kestrel.json` manifests. Zero recompilation between apps.

## What was proven

- **Runtime manifest** — window title/size, app id, and frontend directory all resolved at
  launch from JSON, not compile time. Tauri's static `tauri.conf.json` only carries a
  placeholder; `windows: []` + a runtime `WebviewWindowBuilder` gives full dynamic control.
- **Runtime frontend serving** — a custom `kestrel://` URI scheme protocol serves any
  directory on disk (with path-traversal guard). This replaces Tauri's compile-time asset
  embedding entirely.
- **IPC works from the custom protocol** — `withGlobalTauri` + `window.__TAURI__.core.invoke`
  reached app-defined commands from `kestrel://` pages with a plain `core:default` capability.
  Round-trips verified: manifest fetch, in-memory KV set/get, echo, and an on-disk proof write.
- **Live JS runtime** — the timer app's `setInterval` clock ran normally; the webview is a
  fully live browsing context, so React + Vite output will drop straight in.
- **Headless CI story** — apps run and self-verify under `xvfb-run` with a manifest-driven
  exit timer. The same pattern becomes the webview-consistency CI suite in Phase 2.

## Numbers (Linux; treat as directional)

- Host binary: 4.4 MB stripped release (`opt-level=s`, LTO) — comfortably inside the
  <10 MB installed-size target before compression.
- Clean release build: ~4 min on 2 cores — but users never do this; it happens once in
  Kestrel's release CI.
- Memory: summed RSS across host + WebKit helper processes was ~430 MB under xvfb with
  software rendering, but RSS double-counts shared webkit libraries and xvfb inflates it.
  The honest benchmark (PSS / platform tools, real GPU) belongs on macOS/Windows in Phase 3.
  Do not quote the Linux number.

## Friction log (feeds the spec)

1. `tauri::generate_context!()` demands `icons/icon.png` even with bundling disabled —
   the host ships a default; per-app icons need runtime window-icon setting (API exists).
2. A command named `manifest` collides with a local binding through the
   `generate_handler!` macro expansion — macro hygiene leak; trivial rename, worth
   knowing for codegen (prefix generated command names).
3. Custom-protocol MIME types are on us — fine, the CLI serves built assets with a
   real MIME table.
4. Never-type fallback warnings from macro expansion on newer rustc — pin toolchain in CI.

---

# Spike 2 — Native functions: embedded engine vs sidecar

**Question:** Where does the developer's privileged code (the server-actions analogue) run
without breaking the footprint story?

## Answer: an embedded QuickJS engine wins for the spike, decisively.

The host now optionally loads a `native` JS module from the manifest into QuickJS running
on a dedicated host thread. A third app (`native-demo`) verified the full chain:
**webview → `call_native` IPC → user JS in QuickJS → host bindings (real fs read) → back**.
The webview itself can't touch the filesystem; the native module read `/etc/os-release`
through a host binding. Apps without a `native` field are unaffected (regression-checked).

## Numbers

- **Binary cost: +0.83 MB** (4.38 → 5.21 MB stripped). A Node sidecar is ~50–80 MB and a
  process supervisor; Bun similar. The footprint story survives intact.
- **Latency: 0.81 ms avg** per full webview→native→webview round-trip (200 sequential
  calls, JSON args both ways, headless Linux, no tuning). Interactive-use territory.
- **Compute: fine for glue** — fib(40) instantaneous; QuickJS has no JIT, so real number
  crunching still belongs in Rust plugins or WASM, which the plan already assumed.

## Design implications for real Kestrel

1. Dispatch protocol (name + JSON args → JSON result) is trivially codegen-able: the CLI
   can generate typed client stubs from the native module's TS exports — typed IPC with
   zero user wiring, no Rust anywhere.
2. QuickJS is ES2023 but has **no Node APIs, no fetch, no fs** — the privileged surface
   is exactly the host bindings Kestrel exposes. That's a security feature: native
   functions get a capability-scoped std-lib, not ambient authority.
3. Async is the open edge: this spike is synchronous dispatch on one engine thread.
   Real Kestrel needs the QuickJS job queue pumped (promises/async natives) and possibly
   an engine pool. Solvable, not scary.
4. Alternative if QuickJS ever pinches: swap the engine behind the same dispatch
   protocol (e.g. a JIT engine) — the architecture doesn't care.

## What this does NOT yet prove

- macOS/Windows behavior (same Tauri codepath, but WKWebView/WebView2 custom-protocol +
  IPC quirks must be verified on real hardware/CI — first item of the platform matrix).
- Async native functions / engine job-queue pumping (see Spike 2 implications).
- Signing/updater flow with a shared binary + per-app identity — Phase 2 design question
  (macOS re-signing per app is expected and fine).

## Repo layout

- `host/` — the generic host (one `main.rs`, ~170 lines)
- `apps/notes-app`, `apps/timer-app` — two stand-in frontends
- `notes.kestrel.json`, `timer.kestrel.json` — the manifests that ARE the apps
- Build: `cd host && cargo build --release`
- Run: `./host/target/release/kestrel-host notes.kestrel.json`
