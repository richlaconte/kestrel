# Shipping on Linux

`kestrel build` on Linux makes a portable folder, `build/<appId>/`, that runs from any
directory. `kestrel build --deb` also makes a Debian package for Ubuntu, Debian, Mint,
Pop!_OS and the rest of that family:

```sh
npx kestrel build --deb
# build/my-app_1.2.0_amd64.deb
sudo apt install ./build/my-app_1.2.0_amd64.deb
```

The package is written by the CLI itself, so you don't need `dpkg-deb` or any other tool
to make it. Build it on the architecture you're shipping (`amd64` or `arm64`), because it
carries that machine's host binary.

## What it installs

| Path | What |
|---|---|
| `/opt/<name>/` | the portable folder: the host renamed to `<appId>`, `kestrel.json`, the frontend, `native.js` |
| `/usr/bin/<name>` | a link to the executable, so the app runs from a terminal |
| `/usr/share/applications/<name>.desktop` | the app-menu entry |
| `/usr/share/icons/hicolor/<size>/apps/<name>.png` | your `icon`, at 16–512 px |

`<name>` is the Debian package name: your `appId` in lowercase, with characters Debian
doesn't allow replaced by `-`. The app's data still goes to `$XDG_DATA_HOME/<appId>`,
not `/opt`, which is read-only.

## Package fields

- **Version:** the manifest's `version`, else package.json's. A pre-release such as
  `1.0.0-beta.1` becomes `1.0.0~beta.1`, so it sorts before `1.0.0`.
- **Maintainer:** package.json `author`. Without one, the package has a placeholder;
  set `author` before you publish.
- **Description:** package.json `description`, else the title.
- **Depends:** `libwebkit2gtk-4.1-0` and `libgtk-3-0`. `apt` installs them if
  they're missing.
- **Recommends:** `libayatana-appindicator3-1` when `permissions` includes `"tray"`.
  Without it, `tray.create` rejects with `unsupported_platform`.

## Minimum versions

Ubuntu 22.04, Debian 12, or anything newer with webkit2gtk 4.1 and glibc 2.35. The
prebuilt hosts are built on Ubuntu 22.04.

## Not yet

- AppImage, for distros outside the Debian family.
- Signing the package or hosting an apt repository. Share the `.deb` directly for now.
- `StartupWMClass` in the desktop entry, so some docks may show the running window as a
  separate icon.
