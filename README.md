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
round-trips, and it can only touch the bindings the manifest grants. With no
`permissions`, native code gets no filesystem bindings at all. `"fs:app-data"` confines
it to the app's own data directory, and `"fs:all"` (which the CLI warns about) opens
every file the user can reach. The `kestrel typegen` command generates fully typed client stubs from your
native module, so IPC is a typed function call, never a magic string.

## Status: pre-alpha, architecture proven, API unstable

What works today (CI runs the end-to-end flow on Linux, macOS and Windows):

- One shared prebuilt host binary (about 6 MB) runs any app from its manifest, with no
  recompiles
- The frontend is served over a `kestrel://` protocol: full MIME types, client-side
  routes survive a reload, and built apps get a default Content-Security-Policy
- Native functions run in embedded QuickJS. Sync and `async` functions both work,
  calls never block the UI thread, and errors carry the JS message
- **Manifest permissions scope everything privileged**, in the webview and native code
  alike: `fs:app-data`, `fs:pick` (whatever the user picks in a dialog), `fs:all`,
  `notifications`, `clipboard`, `shell:open`, `tray`. `"permissions": ["fs:app-data"]` enables
  `fs.readText`, `fs.writeText`, `fs.exists` and `fs.appDataDir` from
  `kestreljs/native/host` (the raw `hostReadFile`, `hostWriteFile`, `hostExists` and
  `hostAppDataDir` globals underneath). Relative paths
  resolve in the per-app data directory (`~/Library/Application Support/<appId>`,
  `%APPDATA%\<appId>`, `$XDG_DATA_HOME/<appId>`), never the process cwd. Paths
  outside it, `..` and symlink escapes throw `permission_denied`. An ungranted binding
  simply doesn't exist, and its `fs.*` wrapper rejects with `permission_denied`
- **Every failure is a `KestrelError`.** Generated stubs reject with an exported
  `KestrelError` carrying a `code` from a closed set (`permission_denied`, `not_found`,
  `io`, `native_function`, `cancelled`, `unsupported_platform`, `timeout`), a `message`
  and an optional `detail`, so `err instanceof KestrelError && err.code === "not_found"`
  works. An uncaught `fs.readText` miss keeps its `not_found` code; native code can
  throw an error with its own `code` from the set
- **A std-lib you call straight from the webview**, no `native.ts` needed:
  `import { app, appWindow, fs, store } from "kestrel-native"`. `app.version()` and
  `app.quit()`; `appWindow.setTitle/minimize/maximize/close`, and `appWindow.open("/settings")`
  for more windows on the app's own pages (a `label` opens one only once); `fs.readText/readBytes/
  writeText/exists/appDataDir` with the same permission scope native code gets; and a
  durable `store` (`get/set/delete/keys`) in `<app data dir>/.kestrel/store.json`,
  saved to disk before each change resolves. Plus native `dialog`s (`pickFile`,
  `pickFolder`, `save`, `message`), `notify`, `clipboard` text, `shell.open` for
  web and mail links, and a `tray` icon with a menu (`closeToTray` keeps the app
  running when its window closes)
- **Each app gets its own webview storage**, even though every app shares the host
  binary and the `kestrel://localhost` origin: localStorage, IndexedDB and cookies are
  keyed by `appId` (a data directory on Windows and Linux, a WKWebView data store on
  macOS 14+; older macOS falls back to one shared store)
- **Window options live in the manifest:** `resizable`, `minWidth`/`minHeight`,
  `maxWidth`/`maxHeight`, `center`, `decorations` (off for a frameless window) and, on
  macOS, `titleBarStyle` (`"transparent"` or `"overlay"`). The window reopens where the
  user left it: size, position and maximized state, unless that display is gone. Set
  `"rememberWindow": false` to opt out. macOS apps get the standard app menu, so
  copy, paste and quit shortcuts work
- **The React + Vite template has real HMR in the native window.** In dev, the
  `kestrel://` protocol reverse-proxies to Vite (methods, headers and bodies), so the
  window origin and the IPC policy are the same in dev and prod. Only the app's own
  origin can use IPC, and the window can't navigate away from it
- You write `native.ts` in TypeScript. It's bundled for the host engine with esbuild,
  so it can import your own files and pure-JS npm packages (importing a Node built-in
  fails with an error that says why). Typed client stubs are generated with the
  TypeScript compiler API, including named types, so a rename breaks the frontend at
  compile time
- **Native code can push events to the page.** `emit("progress", { done })` from
  `kestreljs/native/host` reaches `on("progress", cb)` in the generated client while a
  call is still running. Export an `Events` interface from `native.ts` and both sides
  are typed: a wrong event name or payload fails to compile
- **Native code hot-reloads.** `kestrel dev` watches `native.ts` and everything it
  imports. A save rebuilds the bundle and the stubs, and the host swaps in a fresh
  engine, so the next call runs the new code without restarting the window. Module
  state resets on reload. A broken save shows in Vite's error overlay, and the last
  good module keeps running
- `kestrel create` (react | vanilla), `kestrel typegen`, and `kestrel dev` (which picks
  a free port). `kestrel.json` is validated, with a published JSON Schema
- **`kestrel build` makes a real `.app` on macOS:** the host binary, an `Info.plist`
  with the app's name, bundle id and version, its icon, and the built frontend and
  native module. It's signed ad hoc, or for distribution and notarized when you give it
  Apple credentials; `--dmg` adds a disk image. See
  [docs/SHIPPING-MACOS.md](docs/SHIPPING-MACOS.md). On Linux, `--deb` makes a Debian
  package with an app-menu entry and icons, and `--appimage` a single-file AppImage
  ([docs/SHIPPING-LINUX.md](docs/SHIPPING-LINUX.md)). On Windows, `--installer` makes a
  per-user setup.exe that installs WebView2 when it's missing, signed when you give it a
  certificate ([docs/SHIPPING-WINDOWS.md](docs/SHIPPING-WINDOWS.md)). On Windows and Linux it also makes
  a portable folder that runs from any directory
- **One icon, every size:** point `icon` in `kestrel.json` at a square PNG (1024×1024 is
  best). `build` writes `.icns`, `.ico` and every PNG size to `build/icons/`, and the
  window uses it in dev too. Apps without one get the Kestrel icon

Not built yet (see the [roadmap](https://github.com/richlaconte/kestrel/issues/36)):
auto-update. See
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
