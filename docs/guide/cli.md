# CLI

The `kestreljs` package installs the `kestrel` command. Apps made from a template have it
as a dev dependency, so run it with `npx kestrel` or from an npm script.

<!-- kestrel --help -->

`[dir]` is the folder with `kestrel.json`, the current one by default.

## kestrel create

```sh
npx create-kestrel-app my-app                    # the same as: kestrel create my-app
npx create-kestrel-app my-app --template=vanilla
```

`react` (the default) is Vite, React and a `native.ts`. `vanilla` is `index.html`, a
script and a `native.js`, with no build step.

## kestrel dev

Runs the app in a native window. For Vite apps it starts Vite on the first free port from
5183 (or `--port`) and serves it through the app's `kestrel://` origin, with hot reload.
It also watches `native.ts` and everything it imports, regenerating `native-client.ts`
and reloading the native module on each save.

## kestrel typegen

Writes `native-client.ts` from `native.ts` without running the app, for CI type checks.
`dev` and `build` run it for you.

## kestrel build

Builds the app for the OS you run it on. See [Building and shipping](building.md).

| Flag | OS | Makes |
|---|---|---|
| `--dmg` | macOS | `build/<Title>-<version>.dmg` |
| `--installer` | Windows | `build/<Title>-<version>-x64-setup.exe` |
| `--deb` | Linux | `build/<name>_<version>_<arch>.deb` |
| `--appimage` | Linux | `build/<Title>-<version>-<arch>.AppImage` |
| `--notes=<text>` | all | Release notes for the update feed |

Flags for another OS are ignored, so one command works in every CI job.

## kestrel updater

```sh
npx kestrel updater keygen [file]          # default: kestrel-updater.key
npx kestrel updater merge mac/latest.json linux/latest.json win/latest.json --out=latest.json
```

`keygen` writes the private key that signs updates and prints the public key for
`kestrel.json`. `merge` joins the `latest.json` each OS's build writes into one feed. See
[Auto-update](updates.md).

## Environment variables

| Variable | Used by | Does |
|---|---|---|
| `KESTREL_HOST` | all | A host binary to use instead of the prebuilt one |
| `KESTREL_SIGN_IDENTITY` | build, macOS | A Developer ID Application certificate to sign with ([details](shipping-macos.md#signing)) |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | build, macOS | Notarize the signed app |
| `KESTREL_WIN_SIGN_PFX`, `KESTREL_WIN_SIGN_PASSWORD` | build, Windows | A code-signing certificate to sign the `.exe` and installer with ([details](shipping-windows.md#signing)) |
| `KESTREL_WIN_TIMESTAMP_URL` | build, Windows | The timestamp server. Default `http://timestamp.digicert.com` |
| `KESTREL_UPDATER_KEY` | build | The update signing key, as a file path or the key itself ([details](updates.md#release-an-update)) |
| `KESTREL_APPIMAGE_RUNTIME` | build, Linux | A local AppImage runtime file, instead of downloading the pinned one |
| `KESTREL_DATA_DIR` | the app | Overrides the app data directory, for tests |
