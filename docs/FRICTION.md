# Friction Log — the same app, three ways

**Date:** 2026-08-27 · **App:** "Quick Note" — a window with a textarea; loads a note from
disk on start, saves it back on click. The smallest app that needs real privileged I/O.
**Implementations:** raw Tauri v2 (`create-tauri-app`, vanilla-ts), Electron Forge
(vite-typescript), and Kestrel-style (the spike host). All three built, run, and
screenshot-verified headless on Linux. This log is the spec: every friction item is a
feature Kestrel must delete.

## The numbers

| | Kestrel (spike) | Raw Tauri v2 | Electron Forge |
|---|---|---|---|
| Files the developer writes/edits | **3** (html, native.js, manifest) | 3 — but one is Rust | 4 (main, preload, renderer, html) |
| App-specific LOC | **74** | 66 + 46 lines of config schema to understand | 117 |
| Languages required | TS/JS only | TS **+ Rust** (+ Cargo, capabilities schema) | TS only |
| Scaffold files in repo | 3 | 41 (incl. 17 icon files, 2 build systems) | 33 (incl. 4 build configs) |
| Toolchain on the dev's machine | none (prebuilt host) | Rust + Node | Node |
| First-build wait (this machine, 2 cores) | **0 s** | 8 min cold, ~1.5 min warm | ~2 min install + 13 s package |
| Build artifacts on disk | 0 for the dev | 1.6 GB `target/` | 303 MB `node_modules/` + 282 MB `out/` |
| Shipped size (Linux, unpacked) | **5.2 MB host + 2.6 KB app** | 13.2 MB | **282 MB** |
| IPC typing | codegen-able from one JS module | hand-typed strings | hand-written bridge + hand-synced global types |

## Friction found in raw Tauri v2 (each item = a Kestrel feature)

1. **`cargo build --release` produces a broken app.** It compiles cleanly, launches, and
   renders "Could not connect to localhost: Connection refused" — because release-mode
   asset embedding only happens through the Tauri CLI (`tauri build`), which nothing tells
   you. This cost the most debugging time of the whole exercise, and it would cost a
   newcomer far more. *Kestrel: there is exactly one build entry point.*
2. **Two build systems, three config files.** Vite + Cargo, wired through
   `tauri.conf.json`'s `beforeBuildCommand`/`devUrl`/`frontendDist` — the developer
   maintains the contract between them by hand. *Kestrel: the CLI owns the contract.*
3. **Every native touch is a Rust round-trip.** Even `fs::read_to_string` means editing
   `lib.rs`, re-listing commands in `generate_handler!`, and recompiling (~1–1.5 min warm
   on this box) per iteration. *Kestrel: native functions are JS, hot-reloadable in principle.*
4. **IPC is stringly-typed.** `invoke<string>("save_note", { text })` — the TS type is an
   assertion, not a fact; renames break silently at runtime. *Kestrel: stubs generated
   from the native module.*
5. **Scaffold weight.** 41 files including 17 icons and a capabilities schema before the
   developer has written a line. Not blocking, but it sets the "this is heavy" tone.

## Friction found in Electron Forge

1. **The security boilerplate is the app.** main/preload/renderer split, `contextBridge`,
   channel-name strings, plus a hand-written `declare global` to get types — 4 files and
   ~50 of the 117 lines exist only to move one string across a process boundary safely.
   *Kestrel: that entire pattern is the framework's job.*
2. **282 MB for a textarea.** The packaged Linux app is 54× the Kestrel host+app. Nothing
   to debug — it's just the Chromium tax, working as designed.
3. **Smooth where Tauri is rough.** Credit where due: scaffold → implement → package
   worked first try in pure TS, ~15 min total. Electron's DX is the bar to beat;
   its footprint is the reason it's beatable.

## Friction found in the Kestrel path (honesty section)

1. Manifest + `native.js` + `index.html` worked first try, and the same host binary ran
   it with zero build step — the core promise demonstrably holds.
2. But: no HMR yet, no TS typechecking of `native.js`, no codegen'd stubs — the spike's
   `nativeCall('saveNote', …)` is stringly-typed too. The DX win is real but the CLI
   (create/dev/typegen) is where it becomes decisive. That's the next build target.
3. And: error surfaces are raw (a bad manifest = a Rust panic). Kestrel's CLI must own
   friendly errors end to end.

## Verdict

The gap is real and it is exactly where the plan bet it was: **Tauri's runtime with
Electron's (or better) ergonomics**. Electron proves TS-only DX is achievable; Tauri
proves the small-fast runtime is achievable; nobody ships both. The single worst moment
in the exercise — Tauri's silently-broken plain-cargo release build — is the strongest
argument for a framework that owns the whole pipeline.
