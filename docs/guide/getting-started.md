# Getting started

Kestrel apps are a web frontend (React, or plain HTML) plus, when you need it, a little
privileged TypeScript. Your app runs in the system webview and a small prebuilt host
binary does the native work. You don't need Rust or a native toolchain.

## Before you start

- **Node.js 18 or newer.**
- **The system webview.** macOS and Windows 11 already have it. Windows 10 needs the
  WebView2 runtime, which Edge updates install on most machines. On Linux, install
  WebKitGTK 4.1 (`sudo apt install libwebkit2gtk-4.1-0` on Debian and Ubuntu).

> **Pre-alpha.** Until the first release with prebuilt hosts is on npm
> ([#1](https://github.com/richlaconte/kestrel/issues/1)), build the host once from a clone
> of the repo with `npm run build:host` (needs Rust), or point `KESTREL_HOST` at a host
> binary.

## Create an app

```sh
npx create-kestrel-app my-app
cd my-app
npm install
npm run dev
```

A native window opens with the React template. Edit `src/App.tsx` and save: Vite's hot
reload updates the window in place.

For an app with no build step, just `index.html` and a script, pass
`--template=vanilla`. It needs no `npm install`: run it with `npx kestrel dev`.

## What's in the folder

```
my-app/
├── kestrel.json        the manifest: the app's whole configuration
├── index.html, src/    the frontend (a Vite + React app in this template)
├── native.ts           optional: privileged functions that run in the host
└── native-client.ts    generated: typed stubs for native.ts. Don't edit it
```

`kestrel.json` names the app, sizes its window and says what it's allowed to do:

```json
{
  "appId": "my-app",
  "title": "My App",
  "width": 760,
  "height": 560,
  "frontend": { "dev": "vite", "dist": "dist" },
  "native": "native.ts",
  "permissions": ["fs:app-data"]
}
```

Every field is in the [kestrel.json reference](manifest.md).

## Call the std-lib

Most apps need no native code of their own. The std-lib in `kestrel-native` covers
windows, files, dialogs, notifications, the clipboard, a tray icon, durable storage and
updates, and you call it straight from React. Add it to the app first:

```sh
npm install kestrel-native
```

```tsx
import { dialog, fs, store } from "kestrel-native";

await store.set("theme", "dark");          // on disk before this resolves
const file = await dialog.pickFile();      // null if the user cancels
if (file) setText(await fs.readText(file)); // needs "fs:pick" in permissions
```

Calls that reach outside the app need a [permission](permissions.md). Without one they
reject with a `KestrelError` whose `code` is `"permission_denied"`. The
[kestrel-native reference](std-lib.md) lists every call.

## Write a native function

When the std-lib isn't enough, export a function from `native.ts`. It runs inside the
host, not the webview:

```ts
// native.ts
import { fs } from "kestreljs/native/host";

export async function wordCount(args: { path: string }): Promise<number> {
  const text = await fs.readText(args.path);
  return text.split(/\s+/).filter(Boolean).length;
}
```

`kestrel dev` generates a typed stub for it, which you import like any other function:

```tsx
import { wordCount } from "../native-client";

const words = await wordCount({ path: "notes.txt" });
```

Rename `wordCount` and the frontend stops compiling. [Native functions](native-functions.md)
covers arguments, errors, events and hot reload.

## Build it

```sh
npx kestrel build
```

On macOS this makes `build/My App.app`. On Windows and Linux it makes a portable folder.
Flags add a disk image, an installer, a `.deb` or an AppImage. See
[Building and shipping](building.md).
