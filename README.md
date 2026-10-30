# Kestrel

**Just React. Actually native. Nothing else to learn.**

Kestrel is an open-source framework for building native desktop apps where the entire
developer experience is TypeScript and React, and the shipped result is a small native
binary (signed, auto-updating installers are on the [roadmap](https://github.com/richlaconte/kestrel/issues/36)).
It is a developer-experience layer on [Tauri v2](https://v2.tauri.app): Tauri's runtime
with better-than-Electron ergonomics.

**Site:** https://richlaconte.github.io/kestrel/ · **Roadmap:** [#36](https://github.com/richlaconte/kestrel/issues/36)

```sh
npx create-kestrel-app my-app
cd my-app
npm run dev
```

> **Pre-alpha.** Until the first release with prebuilt hosts is published
> ([#1](https://github.com/richlaconte/kestrel/issues/1)), the host binary is built once
> from this repo (`npm run build:host`, needs Rust) or pointed to with `KESTREL_HOST`.

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
round-trips, and it can only touch the bindings the host grants. Those bindings are not
yet scoped by manifest permissions: today native code can read and write any file the
user can. Capability scoping ([#14](https://github.com/richlaconte/kestrel/issues/14)) is
the headline item for v0.3. The `kestrel typegen` command generates fully typed client stubs from your
native module, so IPC is a typed function call, never a magic string.

## Status: pre-alpha, architecture proven, API unstable

What works today (CI runs the end-to-end flow on Linux, macOS and Windows):

- One shared prebuilt host binary (about 6 MB) runs any app from its manifest, with no
  recompiles
- The frontend is served over a `kestrel://` protocol: full MIME types, client-side
  routes survive a reload, and built apps get a default Content-Security-Policy
- Native functions run in embedded QuickJS with host bindings (fs). Sync and `async`
  functions both work, calls never block the UI thread, and errors carry the JS message
- **The React + Vite template has real HMR in the native window.** In dev, the
  `kestrel://` protocol reverse-proxies to Vite (methods, headers and bodies), so the
  window origin and the IPC policy are the same in dev and prod. Only the app's own
  origin can use IPC, and the window can't navigate away from it
- You write `native.ts` in TypeScript. It's compiled for the host engine, and typed
  client stubs are generated with the TypeScript compiler API, including named types,
  so a rename breaks the frontend at compile time
- `kestrel create` (react | vanilla), `kestrel typegen`, and `kestrel dev` (which picks
  a free port). `kestrel.json` is validated, with a published JSON Schema
- **`kestrel build` makes an unsigned portable bundle:** the host binary renamed to the
  app, plus the built frontend, the compiled native module and the manifest. It runs
  from any directory

Not built yet (see the [roadmap](https://github.com/richlaconte/kestrel/issues/36)):
manifest permissions and scoped bindings, per-app data directories, the full
`kestrel/native` std-lib, and signed installers with auto-update on top of `build`. See
[docs/rfc-0001-native-api.md](docs/rfc-0001-native-api.md) for the v0 API design and
[docs/FINDINGS.md](docs/FINDINGS.md) / [docs/FRICTION.md](docs/FRICTION.md) for the
measured evidence behind the bets.

## Why (the 30-second pitch)

Building the same trivial note-taking app three ways (measured during the spike, not vibes):

| | Kestrel | Raw Tauri v2 | Electron Forge |
|---|---|---|---|
| Languages | TS only | TS + Rust | TS only |
| Dev's first-build wait | 0 s | 8 min | ~2 min |
| Shipped size (Linux) | 5.2 MB + 2.6 KB | 13.2 MB | 282 MB |
| IPC typing | generated | hand-strings | hand-written bridge |

Electron proves TS-only DX is achievable. Tauri proves the small fast runtime is
achievable. Nobody ships both. That's the gap.

## Repo layout

- `host/` — the generic Rust host (Tauri v2 + QuickJS). Built once per platform in CI and
  published as `kestreljs-host-<os>-<cpu>` npm packages (see [docs/RELEASING.md](docs/RELEASING.md)).
- `packages/kestrel/` — the CLI (`kestreljs` on npm): `create`, `dev`, `typegen`, `build`
  — plus the app templates it stamps out.
- `packages/create-kestrel-app/` — the `npx create-kestrel-app` wrapper.
- `packages/kestrel-native/` — the typed client runtime apps import.
- `examples/quick-note/` — the canonical tiny app.
- `docs/` — RFCs, spike findings, release process.
- `scripts/` — end-to-end tests (`e2e-*.sh`) and release tooling.

## Developing

```sh
npm install
npm run build:host          # needs Rust locally, once
node packages/kestrel/bin/kestrel.js create demo
node packages/kestrel/bin/kestrel.js dev demo

npm test                                # CLI + typegen unit tests
(cd host && cargo test --release)       # host tests
bash scripts/e2e-ipc.sh                 # end-to-end (needs a display; xvfb-run on Linux)
```

## License

MIT
