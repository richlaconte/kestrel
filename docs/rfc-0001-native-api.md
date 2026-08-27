# RFC-0001: The `kestrel/native` v0 API

- **Status:** Draft for comment
- **Author:** Richard LaConte
- **Date:** 2026-08-27
- **Evidence base:** Phase 0 spikes (`FINDINGS.md`) and the three-way friction log
  (`FRICTION.md`). Every design choice below traces to a measured friction item.

## 1. Goals and non-goals

**Goals.** A web developer who knows React and TypeScript can build, run, and (Phase 2)
ship a native desktop app without learning a second language, a second build system, or
an IPC discipline. The API surface is small enough to learn in an afternoon and typed
end to end. Simplicity is the performance strategy: nothing here requires bundling a
runtime with the app.

**Non-goals for v0.** Mobile (design must not preclude it; Tauri v2 supports it).
Multi-window orchestration beyond open/close. A plugin API (v1, RFC-0002). Pixel-parity
across webviews — we document differences, we don't pretend Chromium ships with the app.

## 2. Anatomy of an app

```
my-app/
├── kestrel.json        # the manifest — the only config file
├── index.html          # or a Vite/React app; anything that builds to static files
├── native.ts           # optional: privileged functions (server-actions analogue)
└── native-client.ts    # AUTO-GENERATED typed stubs — never hand-edited
```

`kestrel.json` (v0 schema):

```jsonc
{
  "appId": "quick-note",        // reverse-DNS-free; CLI derives bundle ids from it
  "title": "Quick Note",
  "width": 640, "height": 480,
  "frontend": ".",              // dir of static files, or { "dev": "vite", "dist": "dist" }
  "native": "native.ts",        // omit if the app needs no privileged code
  "permissions": ["fs:app-data", "notifications"]   // §6; empty = sandboxed webview only
}
```

Principle: **the manifest is the whole configuration.** No `tauri.conf.json`, no
`forge.config.ts`, no build-tool contract maintained by hand (friction items T1, T2, E1).

## 3. The std-lib: `import { … } from "kestrel/native"`

Small on purpose; each module earned its place in the friction log or the plan's
"typical app" survey. Everything returns a `Promise`; everything is typed.

| Module | v0 surface (abridged) | Notes |
|---|---|---|
| `app` | `manifest()`, `version()`, `quit()` | |
| `window` | `setTitle()`, `minimize()`, `maximize()`, `close()`, `open(url, opts)` | one main window default |
| `fs` | `readText(p)`, `writeText(p, s)`, `readBytes(p)`, `exists(p)`, `appDataDir()` | scope-gated, §6 |
| `dialog` | `pickFile(opts)`, `pickFolder()`, `save(opts)`, `message(opts)` | native dialogs |
| `notify` | `notify(title, body?)` | |
| `store` | `get(k)`, `set(k, v)`, `delete(k)` | durable KV in app-data |
| `clipboard` | `readText()`, `writeText(s)` | |
| `shell` | `open(url)` | opener only; no arbitrary exec in v0 |
| `tray` | `create({ icon, menu })`, `destroy()` | menu = typed item list |
| `updater` | `check()`, `apply()` | Phase 2; present in types from day one |

These calls go straight from the webview to the host's compiled-in command surface
(spike-proven path). They work with **no `native.ts` at all** — most apps should need
zero privileged code of their own.

## 4. Native functions

For app-specific privileged logic, the developer exports plain functions:

```ts
// native.ts — runs INSIDE the host (QuickJS), never in the webview
import { fs } from "kestrel/native/host";

export async function importCsv(args: { path: string }): Promise<{ rows: number }> {
  const raw = await fs.readText(args.path);
  return { rows: raw.split("\n").length - 1 };
}
```

```tsx
// App.tsx — the generated stub is an ordinary typed async function
import { importCsv } from "./native-client";
const { rows } = await importCsv({ path: file });
```

Semantics, all spike-verified except (d):

- (a) **Execution:** QuickJS embedded in the host process (+0.8 MB, ~0.8 ms round-trip).
  No Node APIs, no ambient authority — the only capabilities are the host bindings
  granted per the manifest's `permissions` (§6). The sandbox is the security model.
- (b) **Dispatch:** name + structured-clone-able args in, structured result out. One
  engine thread per app in v0; calls are serialized (documented, revisit if real apps hit it).
- (c) **State:** module scope persists for the app's lifetime — caches and handles are fine.
- (d) **Async (open edge from spike 2):** natives may be `async`; the host pumps the
  engine's job queue. Host bindings are the only await points, so starvation is bounded.
- (e) **Compute:** no JIT; glue-code fast, number-crunching slow. The documented answer
  for heavy compute is a Rust plugin (v1) or WASM in the webview — not a bigger JS engine.

## 5. Typegen contract

`kestrel typegen` (auto-run by `dev` and `build`) parses `native.ts` with the TypeScript
compiler API and emits `native-client.ts` where **each export's parameter and return
types are preserved exactly**, with `Promise<>` added if absent. Renaming a native
function breaks the frontend **at compile time** (kills friction items T4, E1: no
stringly-typed IPC, no hand-synced `declare global`). The spike CLI ships a regex-level
placeholder of this; the contract is what's specified here.

Errors: a native function that throws rejects the stub's promise with `KestrelError`
(§7) carrying the message and a `native_function` code — never a bare string.

## 6. Permissions

The manifest's `permissions` array is the single source of truth, mapped by the CLI onto
Tauri v2 capabilities underneath. It gates **both** the std-lib (a `fs` call without an
`fs:*` grant rejects with `permission_denied`) and the host bindings visible inside
QuickJS (an ungranted binding is simply absent). Scopes are coarse and legible in v0 —
`fs:app-data`, `fs:pick` (anything the user picked in a dialog), `fs:all` (loud warning),
`notifications`, `tray`, `clipboard`, `shell:open` — not a policy language. Default is
none: a manifest with no permissions is a pure sandboxed webview.

## 7. Errors

Every rejection anywhere in the API is a `KestrelError { code, message, detail? }` with
a closed set of codes: `permission_denied`, `not_found`, `io`, `native_function`,
`cancelled` (user closed a dialog), `unsupported_platform`. Honest, greppable, and the
docs list every code per call. (Friction item K3: raw Rust panics are not an error UX.)

## 8. Open questions for comment

1. Should `native.ts` allow exporting event streams (host → webview push), or is v0
   request/response only? (Tauri events exist under the hood.)
2. `frontend: { "dev": "vite" }` — blessed Vite integration in v0, or static-only until
   the React template lands?
3. Is `store` a thin file under app-data (simple, debuggable) or SQLite from day one?
4. Per-app icon pipeline: one source PNG in the app dir, CLI derives all platform sizes
   at build time — any reason not to?
