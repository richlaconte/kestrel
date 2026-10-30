// Prebuilt host targets. One npm package per entry, named
// kestreljs-host-<os>-<cpu>; npm installs only the one whose os/cpu match.
export const TARGETS = [
  { os: "darwin", cpu: "arm64", rust: "aarch64-apple-darwin", runner: "macos-latest", exe: "kestrel-host" },
  { os: "darwin", cpu: "x64", rust: "x86_64-apple-darwin", runner: "macos-latest", exe: "kestrel-host" },
  { os: "linux", cpu: "x64", rust: "x86_64-unknown-linux-gnu", runner: "ubuntu-22.04", exe: "kestrel-host" },
  { os: "linux", cpu: "arm64", rust: "aarch64-unknown-linux-gnu", runner: "ubuntu-22.04-arm", exe: "kestrel-host" },
  { os: "win32", cpu: "x64", rust: "x86_64-pc-windows-msvc", runner: "windows-latest", exe: "kestrel-host.exe" },
];

export const pkgName = (t) => `kestreljs-host-${t.os}-${t.cpu}`;
