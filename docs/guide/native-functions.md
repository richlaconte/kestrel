# Native functions

A native function is TypeScript that runs inside the host process instead of the
webview: the desktop version of a server action. Use one when the
[std-lib](std-lib.md) doesn't cover what you need, or to keep logic and file formats out
of the page.

Name the module in `kestrel.json`:

```json
"native": "native.ts"
```

## Write one

Every exported function in `native.ts` becomes callable from the webview. A function
takes at most one argument, an object, and returns anything JSON can carry. It can be
`async`:

```ts
// native.ts
import { fs } from "kestreljs/native/host";

export interface Note {
  title: string;
  body: string;
}

export async function saveNote(args: { note: Note }): Promise<void> {
  await fs.writeText(`${args.note.title}.md`, args.note.body);
}

export function stats(args: { text: string }) {
  return { words: args.text.split(/\s+/).filter(Boolean).length, chars: args.text.length };
}
```

`kestreljs/native/host` is the host's side of the std-lib: [`fs`](native-host.md#fs),
[`emit`](native-host.md#emit) and [`log`](native-host.md#log). Its bindings exist only
for the [permissions](permissions.md) the manifest grants.

## Call it

`kestrel dev`, `kestrel build` and `kestrel typegen` write `native-client.ts` next to
your manifest: one typed async function per export, with your parameter and return types
copied over exactly.

```tsx
import { saveNote, stats } from "../native-client";
import type { Note } from "../native";

await saveNote({ note: { title: "Ideas", body: "…" } });
const { words } = await stats({ text });
```

Rename a native function, change an argument, or return a different shape, and the
frontend fails to compile instead of failing at runtime. Types a function uses must be
exported from `native.ts`, so the client can import them; typegen says so when one
isn't. Import those types from `native.ts` itself, as type-only imports, which add no code
to the page.

## Errors

Every rejection is a `KestrelError` with a `code` from a closed set, a `message` and an
optional `detail`:

| Code | Means |
|---|---|
| `native_function` | Your function threw. `message` is the error's message |
| `permission_denied` | A binding or path the manifest doesn't grant |
| `not_found` | A file that doesn't exist |
| `io` | Any other system failure |
| `cancelled` | The user backed out, such as closing a dialog |
| `unsupported_platform` | Not available on this OS or in this build |
| `timeout` | Something took too long |

An error from a host binding that your code doesn't catch keeps its code, so a missing
file still arrives as `not_found`. To choose a code yourself, throw an error with a
`code` from the set:

```ts
export function importFile(args: { path: string }) {
  if (!args.path.endsWith(".csv")) {
    const e = new Error("Pick a .csv file");
    (e as Error & { code: string }).code = "cancelled";
    throw e;
  }
  // …
}
```

```tsx
import { importFile, KestrelError } from "../native-client";

try {
  await importFile({ path });
} catch (err) {
  if (err instanceof KestrelError && err.code === "cancelled") return;
  throw err;
}
```

## Send events to the page

A native function can push events to the page while it runs, to report progress or
stream partial results. Export an `Events` interface to type both ends:

```ts
// native.ts
import { emit } from "kestreljs/native/host";

export interface Events {
  progress: { done: number; total: number };
}

export async function indexFiles(args: { paths: string[] }): Promise<number> {
  for (const [i, path] of args.paths.entries()) {
    // … work …
    emit<Events>("progress", { done: i + 1, total: args.paths.length });
  }
  return args.paths.length;
}
```

```tsx
import { indexFiles, on } from "../native-client";

const off = on("progress", ({ done, total }) => setProgress(done / total));
await indexFiles({ paths });
off();
```

Events go to every window of the app. An event sent before a window subscribes is
dropped, not queued.

## Imports

The CLI bundles `native.ts` with esbuild, so it can import your other files and pure-JS
npm packages. It runs in QuickJS, not Node, so Node built-ins like `node:fs` don't exist.
Importing one fails the build with an error that says why. Use the host bindings
instead.

## How it runs

- **One engine per app.** Native code runs in a QuickJS engine in the host process. Calls
  run one at a time, in order, and never block the window: the page keeps painting and
  taking input while a call works.
- **State lasts the app's lifetime.** Module-level variables, caches and handles persist
  between calls.
- **Hot reload in dev.** `kestrel dev` watches `native.ts` and everything it imports. Save,
  and the next call runs the new code in a fresh engine, with no window restart. Module
  state resets on each reload. If a save doesn't build, the error shows in Vite's overlay
  and the last good version keeps running.
- **Glue, not number-crunching.** QuickJS has no JIT. It's fast for I/O and logic, and
  slow for heavy computation, which belongs in the page (or WebAssembly) instead.
- **Logging.** `log(...)` from `kestreljs/native/host` prints to the terminal running the
  app, prefixed `[native]`.

## Without TypeScript

The vanilla template uses `native.js`, an older style with no build step: functions are
assigned to a global `native` object and call the raw host bindings, which are
synchronous.

```js
// native.js
native.greet = ({ name }) => `Hello, ${name}!`;
native.visits = () => {
  const n = hostExists("visits.txt") ? Number(hostReadFile("visits.txt")) + 1 : 1;
  hostWriteFile("visits.txt", String(n));
  return n;
};
```

Typegen then writes `native-client.js`, with the same functions but no types. Prefer
`native.ts` for anything bigger than a few functions.
