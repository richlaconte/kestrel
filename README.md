# Kestrel

**Just React. Actually native. Nothing else to learn.**

Kestrel is an open-source framework for building native desktop apps where the entire
developer experience is TypeScript and React — and the shipped result is a signed,
auto-updating, sub-10 MB binary. It is a developer-experience layer on
[Tauri v2](https://v2.tauri.app): Tauri's runtime with better-than-Electron ergonomics.

```sh
npx create-kestrel-app my-app
cd my-app
npm run dev
```

npm packages: `kestreljs` (the CLI — its binary is `kestrel`), `create-kestrel-app`
(scaffolding), `kestrel-native` (the typed runtime).

No Rust. No `tauri.conf.json`. No main/preload/renderer wiring. No 100 MB Chromium.

## How it works

Most Tauri apps compile a fresh Rust binary per app, which puts a Rust toolchain between
a web developer and their first window. Kestrel instead ships a **precompiled generic
host binary** per platform — Tauri v2 with a curated capability surface compiled in —
driven entirely by your app's `kestrel.json` manifest:

```
your React + TS app  ─┐
your native.ts fns   ─┼─▶  kestrel CLI  ─▶  prebuilt kestrel-host  ─▶  system webview
kestrel.json         ─┘        (typegen, dev, build)
```

Privileged code ("native functions" — the desktop analogue of server actions) is
TypeScript running in a QuickJS engine **inside the host process**: +0.8 MB, ~0.8 ms
round-trips, and capability-scoped by construction — it can only touch the bindings the
host grants. The `kestrel typegen` command generates fully typed client stubs from your
native module, so IPC is a typed function call, never a magic string.

## Status: pre-alpha spike — architecture proven, API unstable

What works today (verified on Linux; macOS/Windows verification is next):

- One shared host binary (5.3 MB) running arbitrary apps from manifests, zero recompiles
- Runtime frontend serving over a `kestrel://` protocol with working typed IPC
- Native functions in embedded QuickJS with host bindings (fs), 0.81 ms avg round-trip
- **React + Vite template with real HMR into the native window** — in dev the
  `kestrel://` protocol reverse-proxies to Vite, so the window origin (and the IPC
  policy) is identical in dev and prod
- `native.ts` in TypeScript: compiled for the host engine, with client stubs generated
  by the TypeScript compiler API — exact param/return types, renames fail at compile time
- `kestrel create` (react | vanilla) / `kestrel typegen` / `kestrel dev`
- **`kestrel build`: an unsigned portable bundle** — host binary renamed to the app +
  built frontend + compiled native module + manifest, 6.6 MB total for the React
  template, runs from any directory (manifest and paths resolve beside the executable)

What doesn't exist yet: signed installers and auto-update on top of `build`, async
native functions, the full `kestrel/native` std-lib, macOS/Windows host builds. See
[docs/rfc-0001-native-api.md](docs/rfc-0001-native-api.md) for the v0 API design and
`FINDINGS.md` / `FRICTION.md` (spike artifacts) for the measured evidence behind the bets.

## Why (the 30-second pitch)

Building the same trivial note-taking app three ways (measured, not vibes):

| | Kestrel | Raw Tauri v2 | Electron Forge |
|---|---|---|---|
| Languages | TS only | TS + Rust | TS only |
| Dev's first-build wait | 0 s | 8 min | ~2 min |
| Shipped size (Linux) | 5.2 MB + 2.6 KB | 13.2 MB | 282 MB |
| IPC typing | generated | hand-strings | hand-written bridge |

Electron proves TS-only DX is achievable. Tauri proves the small fast runtime is
achievable. Nobody ships both. That's the gap.

## Repo layout

- `host/` — the generic Rust host (Tauri v2 + QuickJS). Built once per platform in CI.
- `packages/kestrel/` — the CLI: `create`, `dev`, `typegen` (and soon `build`, `release`).
- `packages/kestrel-native/` — the typed client runtime apps import.
- `templates/default/` — what `kestrel create` stamps out.
- `examples/quick-note/` — the canonical tiny app.
- `docs/` — RFCs.

## Developing

```sh
npm install
npm run build:host          # needs Rust locally, once
node packages/kestrel/bin/kestrel.js create demo
node packages/kestrel/bin/kestrel.js dev demo
```

## License

MIT
