# kestrel-native

The typed client runtime for [Kestrel](https://github.com/richlaconte/kestrel) apps:
the std-lib you call straight from the webview, with no `native.ts` of your own. The
full surface is specified in
[RFC-0001](https://github.com/richlaconte/kestrel/blob/main/docs/rfc-0001-native-api.md);
this pre-alpha ships:

```ts
import { app, appWindow, dialog, fs, store, KestrelError } from "kestrel-native";

await app.version();                 // kestrel.json "version", else package.json's
await appWindow.setTitle("Saved");   // also minimize(), maximize(), close()
await store.set("theme", "dark");    // durable: on disk before it resolves
const theme = await store.get<string>("theme");
await fs.writeText("notes.txt", "hi"); // needs "fs:app-data" (or "fs:all")

const file = await dialog.pickFile({ filters: [{ name: "Text", extensions: ["txt"] }] });
if (file) await fs.readText(file);    // needs "fs:pick": only what the user picked
```

Also `notify(title, body?)` (`"notifications"`), `clipboard.readText/writeText`
(`"clipboard"`), and `shell.open(url)` for http, https and mailto links (`"shell:open"`).

- `store` keeps JSON values in `<app data dir>/.kestrel/store.json` and needs no
  permission.
- `fs` uses the same scope as native code: with `"fs:app-data"`, relative paths resolve
  in the app's data directory, and anything outside it rejects with
  `permission_denied`. `"fs:pick"` adds whatever the user picks in a dialog this run.
  Without an fs grant, every `fs` call rejects that way.
- Dialogs need no permission to show. File dialogs resolve to `null` when cancelled.
- Every call returns a Promise that rejects with a `KestrelError` (`err.code`).

For your own native functions, `kestrel typegen` generates fully typed stubs from your
`native.ts`; `callNative` is the untyped escape hatch. MIT.
