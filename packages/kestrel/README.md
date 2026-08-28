# kestreljs

**Kestrel — just React. Actually native. Nothing else to learn.**

The Kestrel CLI (its binary is `kestrel`): `create`, `dev` (Vite + HMR into a native
window), `typegen` (typed stubs generated from your `native.ts`), and `build` (a
portable native app bundle).

```sh
npx create-kestrel-app my-app
cd my-app
npm install
npm run dev
```

> **Pre-alpha.** The runtime host binary is not yet distributed through npm — today it
> is built once from the [Kestrel repo](https://github.com/richlaconte/kestrel) (`npm
> run build:host`, needs Rust) or pointed to via `KESTREL_HOST`. Automatic host
> download, signed installers, and auto-update are the current roadmap.

Kestrel is a developer-experience layer on [Tauri v2](https://v2.tauri.app): system
webview (no bundled Chromium), a precompiled generic host (no Rust toolchain for app
developers), and TypeScript end to end — hello-world ships at ~6.6 MB.

Docs, RFCs, and the measured Electron/Tauri comparison live in the
[repo](https://github.com/richlaconte/kestrel). MIT.
