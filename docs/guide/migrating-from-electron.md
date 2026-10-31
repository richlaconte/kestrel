# Migrating from Electron

Electron apps have three parts: the main process, a preload script and the renderer.
Kestrel has two, and you write less wiring between them:

| Electron | Kestrel |
|---|---|
| Renderer (your React app) | The frontend, unchanged: it runs in the system webview |
| Main process (Node) | Mostly the [std-lib](std-lib.md), called from the frontend. App-specific logic goes in [`native.ts`](native-functions.md) |
| Preload + `contextBridge` + `ipcMain.handle` | Nothing to write: `native-client.ts` is generated, with types |
| `BrowserWindow` options | The window fields in [`kestrel.json`](manifest.md), and `appWindow.open()` for more windows |
| `electron-builder` / Forge config | `kestrel build`, with a few flags and environment variables |
| `package.json` `main` | `kestrel.json` |

## IPC

In Electron, one call crosses three files and a string channel name:

```ts
// main.ts
ipcMain.handle("notes:save", async (_e, title: string, body: string) => {
  await fs.promises.writeFile(path.join(app.getPath("userData"), `${title}.md`), body);
});

// preload.ts
contextBridge.exposeInMainWorld("api", {
  saveNote: (title: string, body: string) => ipcRenderer.invoke("notes:save", title, body),
});

// renderer.d.ts, kept in sync by hand
declare global { interface Window { api: { saveNote(t: string, b: string): Promise<void> } } }
```

In Kestrel it's one exported function, and the stub is generated from it:

```ts
// native.ts
import { fs } from "kestreljs/native/host";

export async function saveNote(args: { title: string; body: string }): Promise<void> {
  await fs.writeText(`${args.title}.md`, args.body);
}
```

```tsx
// App.tsx
import { saveNote } from "../native-client";
await saveNote({ title, body });
```

Native functions take one object argument rather than a list. Many main-process handlers
don't need porting at all, because the std-lib does the job straight from the page:

| Electron | Kestrel (`kestrel-native`) | Permission |
|---|---|---|
| `fs` under `app.getPath("userData")` | `fs.readText`, `fs.writeText` with relative paths | `fs:app-data` |
| `dialog.showOpenDialog` + `fs` | `dialog.pickFile`, then `fs.readText(path)` | `fs:pick` |
| `dialog.showMessageBox` | `dialog.message` | none |
| `electron-store` | `store.get`, `store.set` | none |
| `new Notification()` | `notify(title, body)` | `notifications` |
| `clipboard.writeText` | `clipboard.writeText` | `clipboard` |
| `shell.openExternal` | `shell.open` | `shell:open` |
| `new Tray()` + `Menu.buildFromTemplate` | `tray.create({ menu })`, `tray.onMenu` | `tray` |
| `win.setTitle`, `win.minimize` | `appWindow.setTitle`, `appWindow.minimize` | none |
| `new BrowserWindow({ … }).loadURL(…)` | `appWindow.open("/settings", { … })` | none |
| `app.getVersion`, `app.quit` | `app.version`, `app.quit` | none |
| `autoUpdater` / `electron-updater` | `updater.check`, `updater.apply` | none |
| `webContents.send` | `emit` in native code, `on` in the page | none |

## Things that work differently

- **No Node in native code.** `native.ts` runs in QuickJS inside the host, so `require`,
  `node:fs`, `child_process` and native Node modules aren't there. Use the host bindings;
  pure-JS npm packages bundle fine. If the app depends on Node-only libraries, it isn't a
  good fit for Kestrel yet.
- **Permissions are opt-in.** Electron's main process can do anything. A Kestrel app
  declares what it needs in [`permissions`](permissions.md), and everything else is
  refused.
- **The system webview, not Chromium.** That's WebKit on macOS and Linux, and Chromium
  (WebView2) on Windows. Modern CSS and JavaScript work everywhere, but test on each OS,
  and check that any Chrome-only API you rely on exists in Safari.
- **One origin.** The page is served from `kestrel://localhost` (in dev too, proxied to
  Vite), and it can't navigate to other sites. Open web links with `shell.open`.
- **Native code isn't a server.** Calls run one at a time on a single engine, so start
  long jobs, report progress with events, and keep heavy computation in the page.

## Steps

1. Create a Kestrel app with `npx create-kestrel-app` and copy your renderer code into
   `src/`. A Vite setup carries over as it is.
2. Move window options from `new BrowserWindow(...)` into `kestrel.json`.
3. Replace each `window.api.*` call with the matching std-lib call, or move the handler's
   body into an exported function in `native.ts`.
4. Add the `permissions` those calls need. Each missing one shows up as a
   `permission_denied` rejection that names the call and the permission it needs.
5. Delete `main.ts`, `preload.ts` and the `Window` type declarations.
6. Run `npx kestrel build` and compare the size with your Electron build.
