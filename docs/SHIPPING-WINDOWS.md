# Shipping on Windows

`kestrel build` on Windows makes a portable folder, `build\<appId>\`, that runs from any
directory. `kestrel build --installer` also makes a setup program:

```sh
npx kestrel build --installer
# build\My-App-1.2.0-x64-setup.exe
```

Making one needs [NSIS](https://nsis.sourceforge.io) 3.08 or newer (`winget install
NSIS.NSIS`). The CLI finds `makensis` on `PATH` or in `Program Files (x86)\NSIS`.

## What the installer does

- Installs **per user, with no admin prompt**, to `%LOCALAPPDATA%\Programs\<Title>`. The
  user can pick another folder.
- Adds a Start-menu shortcut with your app's icon.
- Registers an uninstaller in **Apps & features**, with the name, version, publisher
  (package.json `author`) and icon.
- Installs the **WebView2 runtime** first if the machine doesn't have it. Windows 11
  always has it, and so do most Windows 10 machines through Edge updates. Otherwise
  the installer downloads Microsoft's evergreen bootstrapper and runs it silently. If
  that fails, it stops and links to the manual download.
- Supports silent installs: `setup.exe /S` (optionally `/D=C:\path`, which must come
  last), and `uninstall.exe /S`.

Reinstalling or upgrading replaces the app's files. The app's data lives in
`%APPDATA%\<appId>`, so it survives both reinstalls and uninstalls.

## Signing

Unsigned installers trigger SmartScreen's "Windows protected your PC" warning. To sign,
give the build a code-signing certificate as a `.pfx`:

```sh
KESTREL_WIN_SIGN_PFX=C:\certs\code-signing.pfx \
KESTREL_WIN_SIGN_PASSWORD=... \
npx kestrel build --installer
```

The build signs the app's `.exe`, the uninstaller (while NSIS writes it) and the
installer with SHA-256, and timestamps each signature through
`http://timestamp.digicert.com`. Set `KESTREL_WIN_TIMESTAMP_URL` to use another server.
It needs `signtool` from the Windows SDK, found on `PATH` or in the newest
`Windows Kits\10\bin\<version>\x64`. You can sign the portable build too: the variables
work without `--installer`.

An OV certificate removes the "unknown publisher" label, but SmartScreen still warns
until the app builds up reputation. An EV certificate is trusted right away.

## Not yet

- **The `.exe`'s own icon and version resources** are still the Kestrel host's. Shortcuts,
  Apps & features and the taskbar show your icon, but Explorer shows Kestrel's on the
  `.exe` file itself.
- Azure Trusted Signing and certificates on hardware tokens. For those, sign the files in
  `build\` with your own `signtool` command after the build.
- MSI packages, for managed deployment through Group Policy or Intune.
