# Releasing

Every release ships the npm packages and one prebuilt host per platform. App developers never need Rust.

## How the host reaches users

`kestreljs` lists each platform's host as an `optionalDependency`:

| Package | Contents |
|---|---|
| `kestreljs-host-darwin-arm64` | `bin/kestrel-host` |
| `kestreljs-host-darwin-x64` | `bin/kestrel-host` |
| `kestreljs-host-linux-x64` | `bin/kestrel-host` |
| `kestreljs-host-linux-arm64` | `bin/kestrel-host` |
| `kestreljs-host-win32-x64` | `bin/kestrel-host.exe` |

Each one declares `os` and `cpu`, so npm installs only the matching one. No install scripts run, and it works offline and through registry mirrors. The CLI's `resolveHost()` looks in this order:

1. `KESTREL_HOST`
2. the installed platform package
3. `host/target/release/` (framework development)

The target list lives in one place, `scripts/release/targets.mjs`. The release workflow's build matrix and `set-version.mjs` both read from it.

## Cutting a release

```sh
node scripts/release/set-version.mjs 0.2.0   # every package, Cargo.toml, tauri.conf, optionalDependencies
git commit -am "release: v0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
```

`.github/workflows/release.yml` then:

1. checks that the tag matches `packages/kestrel/package.json`
2. builds the host for every target
3. stages one npm package per binary
4. checks that `kestreljs` pins every host package at the release version
5. publishes the hosts first, then `kestrel-native`, `kestreljs` and `create-kestrel-app`, skipping anything already on the registry, so a failed run can simply be re-run
6. creates a GitHub prerelease with the raw binaries attached

To rehearse a release without publishing anything, run the workflow manually (`workflow_dispatch`) with **dry_run** checked.

## One-time setup

- Add an npm automation token as the repository secret `NPM_TOKEN`.
- The first publish of each `kestreljs-host-*` name creates it. They're unscoped, so no npm org is needed.

## Not yet

The binaries are unsigned. Code signing and notarization are tracked in #24 and #25.
