# Permissions

A Kestrel app can reach only what its manifest grants. The `permissions` array in
`kestrel.json` is the whole policy, and the same rules apply to the webview std-lib and to
your [native functions](native-functions.md):

```json
"permissions": ["fs:app-data", "notifications"]
```

Leave it out, or empty, and the app is a sandboxed web page: it can use the
[`store`](std-lib.md#store), show dialogs and manage its windows, but it can't read
files, use the clipboard, notify or open links.

## The permissions

| Permission | Grants |
|---|---|
| `fs:app-data` | Read and write files in the app's own data directory |
| `fs:pick` | Read and write the files and folders the user picks in a dialog, for the rest of the run |
| `fs:all` | Read and write any file the user can. The CLI warns about it. Prefer the two above |
| `notifications` | [`notify()`](std-lib.md#notify) |
| `clipboard` | [`clipboard.readText()` and `writeText()`](std-lib.md#clipboard) |
| `shell:open` | [`shell.open()`](std-lib.md#shell) for http, https and mailto links |
| `tray` | [`tray.create()`](std-lib.md#tray), an icon in the menu bar or system tray |

These need no permission: `app`, `appWindow`, `store`, showing a `dialog`, and `updater`
(which needs an [`updater`](manifest.md#updater) section in the manifest instead).

## Files

With `fs:app-data`, relative paths resolve in the app's data directory, never in the
current directory:

| OS | App data directory |
|---|---|
| macOS | `~/Library/Application Support/<appId>` |
| Windows | `%APPDATA%\<appId>` |
| Linux | `$XDG_DATA_HOME/<appId>`, usually `~/.local/share/<appId>` |

A path outside that folder, a `..` that climbs out of it, or a symlink that points out of
it rejects with `permission_denied`. `fs.appDataDir()` returns the folder's absolute
path.

`fs:pick` is the way to work with the user's own documents without blanket access. A path
the user chose in `dialog.pickFile`, `pickFolder` or `save` becomes readable and writable,
along with everything inside a picked folder, until the app quits:

```ts
import { dialog, fs } from "kestrel-native";

const path = await dialog.pickFile({ filters: [{ name: "Markdown", extensions: ["md"] }] });
if (path) editor.setValue(await fs.readText(path));
```

## What a denial looks like

A call without its permission rejects with a `KestrelError` whose `code` is
`permission_denied`, in the webview and in native code alike. Inside the host, an
ungranted binding doesn't exist at all: without an `fs` permission, native code has no
file bindings to call.

```ts
import { clipboard, KestrelError } from "kestrel-native";

try {
  await clipboard.writeText(link);
} catch (err) {
  if (err instanceof KestrelError && err.code === "permission_denied") {
    // add "clipboard" to kestrel.json
  }
}
```

## The webview itself

The page is locked down too, whatever the manifest grants:

- **Content-Security-Policy.** Built apps get a default policy: scripts only from the app
  itself, and no `eval`. Set [`csp`](manifest.md#csp) to replace it, or to `""` to turn
  it off. It's never applied in `kestrel dev`, so Vite's hot reload works.
- **IPC only from the app.** The app is served from its own `kestrel://` origin, and only
  that origin can call the std-lib or native functions.
- **No navigating away.** The window can't leave the app's pages. Links to websites go
  through `shell.open`, and extra windows through
  [`appWindow.open`](std-lib.md#appwindowopen), which only opens the app's own pages.
- **Storage per app.** Every app shares the one host binary, but each gets its own
  localStorage, IndexedDB and cookies, keyed by its `appId`.
