# Contributing to Kestrel

Thanks for helping. Kestrel is pre-alpha, so the API still moves and feedback on it is as
useful as code. The [roadmap](https://github.com/richlaconte/kestrel/issues/36) lists
what's planned, and issues labelled
[`good first issue`](https://github.com/richlaconte/kestrel/labels/good%20first%20issue)
are a gentle way in. For anything bigger than a fix, open an issue first so we can agree
on the shape before you write it.

## Set up

You need **Node.js 22** (18 is the floor for users) and **stable Rust**, plus the system
webview's development files:

| OS | Install |
|---|---|
| macOS | Xcode Command Line Tools: `xcode-select --install` |
| Windows | Visual Studio Build Tools with "Desktop development with C++". WebView2 is already there on Windows 10 and 11 |
| Debian, Ubuntu | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev` |

Then:

```sh
npm install
npm run build:host                     # once, and after changing host/
node packages/kestrel/bin/kestrel.js create demo
node packages/kestrel/bin/kestrel.js dev demo
```

The CLI finds the host you built in `host/target/release/`. App developers never build
it: they get a prebuilt one from npm.

## Where things are

| Path | What |
|---|---|
| `host/` | The generic Rust host: Tauri v2, the QuickJS engine for `native.ts`, the std-lib commands |
| `packages/kestrel/` | The CLI (`kestreljs` on npm): `create`, `dev`, `typegen`, `build`, packaging, templates |
| `packages/kestrel-native/` | The std-lib apps import in the webview |
| `packages/create-kestrel-app/` | The `npx create-kestrel-app` wrapper |
| `scripts/e2e-*.sh` | End-to-end tests that build and run real apps |
| `scripts/docs/` | The docs site generator |
| `docs/` | Guides, shipping docs, RFCs |

## Test

```sh
npm test                                # CLI, kestrel-native and docs unit tests
npm run lint                            # Biome lint and format check
npm run format                          # apply Biome's formatting
(cd host && cargo test --release)
(cd host && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
bash scripts/e2e-ipc.sh                 # one end-to-end test
```

The e2e scripts open real windows, so they need a display. On Linux, run them under
`xvfb-run -a`. Each script says at the top what it covers. Set `KESTREL_HOST` to test a
host binary other than `host/target/release/`.

CI runs all of this on Linux, macOS and Windows for every pull request. If you only have
one OS, that's fine: say which one you tested on, and CI covers the rest.

## Docs

The site at <https://richlaconte.github.io/kestrel/docs/> is built from this repo:

- Guides are Markdown in `docs/guide/` and `docs/`. Edit them like any file.
- The API reference is generated from `packages/kestrel-native/index.d.ts` and
  `packages/kestrel/native/host.d.ts`, so a doc comment there is the documentation. The
  `kestrel.json` reference comes from `packages/kestrel/schema/kestrel.schema.json`.
- `npm run docs` builds everything into `_site/`. It fails on a broken link between
  pages.

When a change is visible to app developers, update the docs in the same pull request.

## Changing the API

A few things have to change together:

- **A new std-lib call:** the host command (`host/src/stdlib.rs` or its own module), the
  client in `packages/kestrel-native/index.js`, its types and doc comment in `index.d.ts`,
  and an e2e step in `scripts/e2e-stdlib.sh`.
- **A new permission:** `KNOWN` in `host/src/scope.rs`, `PERMISSIONS` in
  `packages/kestrel/src/manifest.js`, the JSON Schema, and the
  [permissions guide](docs/guide/permissions.md).
- **Error codes** are a closed set (`CODES` in `host/src/error.rs` and its mirror in
  `packages/kestrel/src/typegen.js`). Adding one is an API change: open an issue first.
- **The host binary's size** is a feature. When a change adds a dependency to `host/`,
  say how much bigger `kestrel-host` got in the pull request.

Bigger API changes start as an RFC in `docs/`, like
[RFC-0001](docs/rfc-0001-native-api.md).

## Pull requests

- Keep each one to one change, and link the issue it closes.
- Match the code around you. Biome formats the JS; `cargo fmt` formats the Rust.
- Write commit messages that say what changed and why, in the imperative: "Tray: drop the
  old icon on the main thread", not "fixed bug".
- Add tests for the behavior you changed. A bug fix gets a test that would have caught it.

By contributing, you agree that your work is licensed under the [MIT license](LICENSE),
and to follow the [code of conduct](CODE_OF_CONDUCT.md).
