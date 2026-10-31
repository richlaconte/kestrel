# Auto-update

A Kestrel app can update itself. It reads a JSON feed you host, downloads the new
version, checks the download's Ed25519 signature against a public key compiled into the
app, replaces itself and relaunches.

## Set up

1. Make a signing key, once per app:

   ```sh
   npx kestrel updater keygen            # writes kestrel-updater.key
   ```

   Keep `kestrel-updater.key` secret and out of git: anyone with it can ship your users
   code. If you lose it, installed copies can't be updated any more, because they only
   trust that key.

2. Add the printed public key and your feed's URL to `kestrel.json`:

   ```json
   "updater": {
     "endpoint": "https://example.com/my-app/latest.json",
     "pubkey": "MoazJXfi3mmeMYPNrJc58l1wIA8C4dB34qMlvJa9AhE="
   }
   ```

   The endpoint must be https. Plain http is allowed only to `localhost`, for testing.

3. Check for updates in your app:

   ```ts
   import { updater, dialog } from "kestrel-native";

   const update = await updater.check();          // null when up to date
   if (update?.canApply && (await dialog.message({ message: `Install ${update.version}?`, buttons: "yesNo" })))
     await updater.apply();                       // quits and starts the new version
   ```

## Release an update

Bump `version` (in `kestrel.json` or `package.json`), then build on each OS with the key:

```sh
KESTREL_UPDATER_KEY=kestrel-updater.key npx kestrel build --notes="What's new"
# macOS:   build/My App.app.tar.gz
# Linux:   add --appimage → build/My-App-1.2.0-x86_64.AppImage
# Windows: add --installer → build/My-App-1.2.0-x64-setup.exe
# and on each: build/latest.json
```

`KESTREL_UPDATER_KEY` is the key file's path, or the key itself, which is handy as a CI
secret. The build refuses to run if the key doesn't match `updater.pubkey`, so you can't
ship an update your users' apps would reject.

Each build's `latest.json` lists only its own platform. Merge them, then upload the merged
feed and every update file to the folder the endpoint points at:

```sh
npx kestrel updater merge mac/latest.json linux/latest.json win/latest.json --out=latest.json
```

The feed looks like this. Each `url` may be relative to the feed or absolute.

```json
{
  "version": "1.2.0",
  "notes": "What's new",
  "pubDate": "2026-10-30T12:00:00.000Z",
  "platforms": {
    "macos-aarch64": { "url": "My App.app.tar.gz", "signature": "…" },
    "linux-x86_64": { "url": "My-App-1.2.0-x86_64.AppImage", "signature": "…" },
    "windows-x86_64": { "url": "My-App-1.2.0-x64-setup.exe", "signature": "…" }
  }
}
```

## What `apply` replaces

| Installed as | Update file | How |
|---|---|---|
| macOS `.app` | `<Title>.app.tar.gz` | Unpacked beside the app, then swapped in with two renames; the old copy is deleted |
| Linux AppImage | the new AppImage | Written next to it, then renamed over it (`$APPIMAGE`) |
| Windows installer | the new `setup.exe` | Run with `/S --relaunch`; it waits for the app to exit, installs over it, and starts it |
| `kestrel dev`, a portable folder, a `.deb` | — | `check` works and reports `canApply: false`; `apply` rejects with `unsupported_platform` (apt updates `.deb` installs) |

A version is newer when it's higher by semver: `1.2.0-beta.1` < `1.2.0` < `1.10.0`. Builds
for macOS need the app to sit somewhere the user can write, such as `/Applications` on a
single-user Mac or `~/Applications`.

## Errors

| Code | When |
|---|---|
| `permission_denied` | The download's signature doesn't match `updater.pubkey` (nothing is replaced), or a URL isn't https |
| `unsupported_platform` | No `updater` in kestrel.json, this copy can't replace itself, or the feed has no build for this OS |
| `not_found` | The feed or the file returned 404 |
| `io` | Network errors, an invalid feed, or a failure while replacing files (the old version is put back) |

## Not yet

- Download progress events, and a background download you install later.
- Delta updates. Each update downloads the whole app.
- Release channels, such as beta.
- On Windows the update's `setup.exe` is verified by Kestrel's signature, but if you sign
  it with Authenticode too, the updater doesn't require that.
