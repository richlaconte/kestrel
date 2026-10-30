# Shipping on macOS

`kestrel build` on a Mac makes `build/<Title>.app`:

```
My App.app/Contents/
├── Info.plist          name, bundle id, version, icon
├── MacOS/my-app        the shared Kestrel host
└── Resources/
    ├── kestrel.json    the runtime manifest
    ├── app/            your built frontend
    ├── native.js       your compiled native module, if any
    ├── icon.icns       from kestrel.json "icon"
    └── icon.png
```

Add `--dmg` for `build/<Title>-<version>.dmg`, a disk image with the app and a link to
Applications.

## Before you ship

Set `bundleId` in `kestrel.json` to a reverse-DNS name you own, like
`"com.example.my-app"`. Without it the app gets `dev.kestrel.app.<appId>`, which is fine
for trying things out. macOS keys notification permissions and some settings to the
bundle id, so changing it after release resets them for your users.

## Signing

How `build` signs the app depends on the environment:

| Set | Result | Runs on |
|---|---|---|
| nothing | signed ad hoc | the Mac that built it. Gatekeeper blocks it elsewhere |
| `KESTREL_SIGN_IDENTITY` | signed with your Developer ID and the hardened runtime | other Macs, after the user approves it in System Settings |
| `KESTREL_SIGN_IDENTITY` + `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | signed, notarized and stapled | any Mac, no warnings |

- `KESTREL_SIGN_IDENTITY` is the name of a "Developer ID Application" certificate in your
  keychain, e.g. `"Developer ID Application: Jane Doe (TEAM123456)"`. List yours with
  `security find-identity -v -p codesigning`.
- `APPLE_PASSWORD` is an
  [app-specific password](https://support.apple.com/en-us/102654), not your Apple ID
  password.
- Notarization uploads the app to Apple and waits for the scan, usually a few minutes.
  If Apple rejects it, `build` prints the result; `xcrun notarytool log <id>` says why.

In CI, import the certificate into a temporary keychain first (for example with
`apple-actions/import-codesign-certs`), then run `kestrel build` with the variables set
as secrets.

## Status

Ad hoc signing, the `.app` layout and `--dmg` are tested on every macOS CI run.
Developer ID signing and notarization follow Apple's documented `codesign` and
`notarytool` flow but haven't been run against a real Apple account yet. Please report
what you hit.
