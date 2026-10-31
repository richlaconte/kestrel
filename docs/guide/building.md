# Building and shipping

```sh
npx kestrel build
```

`build` runs typegen, bundles `native.ts`, builds the frontend (`vite build` for Vite
apps) and puts the app together around the shared host binary. Nothing is compiled per
app, so a build takes seconds. Everything lands in `build/`.

## What you get

| OS | Always | With a flag |
|---|---|---|
| macOS | `<Title>.app`, signed | `--dmg`: a disk image |
| Windows | `<appId>\`, a portable folder | `--installer`: a per-user `setup.exe` |
| Linux | `<appId>/`, a portable folder | `--deb`: a Debian package; `--appimage`: an AppImage |

Each OS builds its own packages: build the macOS app on a Mac, and so on. A CI matrix with
one job per OS does it in one go. The guides cover each format, and signing:

- [macOS](shipping-macos.md): the `.app`, Developer ID signing and notarization
- [Windows](shipping-windows.md): the installer, WebView2, Authenticode signing
- [Linux](shipping-linux.md): `.deb` and AppImage

## The app's identity

Set these in `kestrel.json` before your first release. Changing them later makes the
system treat the app as a new one:

- `appId` names the data directory, so changing it loses your users' data and settings.
- `bundleId` (macOS) is what notifications and system settings are keyed to. It defaults
  to `dev.kestrel.app.<appId>`: set it to a reverse-DNS name you own.
- `version`, or package.json's `version`, goes into every package, and the updater
  compares it.

## Icons

Point `icon` at a square PNG, ideally 1024×1024:

```json
"icon": "assets/icon.png"
```

`build` makes every size each OS wants (`.icns`, `.ico` and PNGs, in `build/icons/`)
with no extra tools. The window uses it in dev too. Apps without one get the Kestrel
icon.

## What's inside

The app is the host binary renamed after your app, the runtime manifest, your built
frontend and the bundled `native.js`. A React app comes to about 6 MB on disk, most of it
the host. There's no browser engine to ship, because the system webview renders the
page.

## Updates

Give `build` your update key and it also writes the signed update files and a
`latest.json` feed. See [Auto-update](updates.md).

## In CI

```yaml
jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - if: runner.os == 'Linux'
        run: sudo apt-get install -y squashfs-tools
      - run: npm ci
      - run: npx kestrel build --dmg --installer --deb --appimage
        env:
          KESTREL_UPDATER_KEY: ${{ secrets.KESTREL_UPDATER_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: app-${{ matrix.os }}
          path: build/
```

Flags for other OSes are ignored, so one command works in every job. Making an AppImage
needs `mksquashfs` (from `squashfs-tools`), and the Windows installer needs NSIS. The
[CLI reference](cli.md#environment-variables) lists the variables for signing.
