// macOS packaging for `kestrel build` (#24): the `.app` layout and its
// Info.plist, code signing, notarization and the optional .dmg.
//
// Signing is always done: ad hoc by default, which is enough to run the app
// on the machine that built it. With KESTREL_SIGN_IDENTITY (a "Developer ID
// Application: …" identity in the keychain) it is signed for distribution
// with the hardened runtime. With APPLE_ID, APPLE_PASSWORD (an app-specific
// password) and APPLE_TEAM_ID as well, it is notarized and stapled, so
// Gatekeeper opens it on any Mac.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** A bundle identifier for the app: the manifest's, else one derived from appId. */
export const bundleIdOf = (m) => m.bundleId ?? `dev.kestrel.app.${m.appId}`;

/** A file-name-safe bundle name from the title. */
export const appNameOf = (m) => m.title.replace(/[/:\\]/g, "-").trim() || m.appId;

/** Where everything goes inside `<name>.app`. */
export function appLayout(root, m) {
  const contents = path.join(root, "Contents");
  return {
    contents,
    exe: path.join(contents, "MacOS", m.appId),
    resources: path.join(contents, "Resources"),
    plist: path.join(contents, "Info.plist"),
  };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Info.plist for the app. `version` is the app's version string. */
export function infoPlist(m, version) {
  const entries = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: m.title,
    CFBundleExecutable: m.appId,
    CFBundleIconFile: "icon.icns",
    CFBundleIdentifier: bundleIdOf(m),
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: m.title,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: "10.15",
    NSHighResolutionCapable: true,
  };
  const value = (v) => (v === true ? "<true/>" : `<string>${esc(v)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...Object.entries(entries).map(([k, v]) => `  <key>${k}</key>\n  ${value(v)}`),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();

/** What to do with the signing and notarization env vars; the reasons say why not. */
export function signingPlan(env = process.env) {
  const identity = env.KESTREL_SIGN_IDENTITY || null;
  const creds = ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"];
  const missing = creds.filter((k) => !env[k]);
  return {
    identity,
    notarize: Boolean(identity) && missing.length === 0,
    // Some but not all credentials: almost certainly a mistake.
    partial: missing.length > 0 && missing.length < creds.length ? missing : [],
  };
}

/** Sign the bundle. Ad hoc without an identity. */
export function sign(app, identity) {
  const args = identity
    ? ["--force", "--options", "runtime", "--timestamp", "--sign", identity, app]
    : ["--force", "--sign", "-", app];
  run("codesign", args);
  run("codesign", ["--verify", "--strict", app]);
}

/** Notarize and staple. Takes minutes: Apple scans the upload. */
export function notarize(app, env = process.env) {
  const zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-notary-")), "app.zip");
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  const out = run("xcrun", [
    "notarytool", "submit", zip, "--wait",
    "--apple-id", env.APPLE_ID, "--password", env.APPLE_PASSWORD, "--team-id", env.APPLE_TEAM_ID,
  ]);
  fs.rmSync(path.dirname(zip), { recursive: true, force: true });
  if (!/status:\s*Accepted/i.test(out))
    throw new Error(`notarization was not accepted:\n${out.trim()}\n(see \`xcrun notarytool log <id>\` for why)`);
  run("xcrun", ["stapler", "staple", app]);
}

/** A compressed .dmg holding the app and a link to /Applications. */
export function dmg(app, out, volume) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-dmg-"));
  fs.cpSync(app, path.join(stage, path.basename(app)), { recursive: true, verbatimSymlinks: true });
  fs.symlinkSync("/Applications", path.join(stage, "Applications"));
  fs.rmSync(out, { force: true });
  run("hdiutil", ["create", "-volname", volume, "-srcfolder", stage, "-ov", "-format", "UDZO", out]);
  fs.rmSync(stage, { recursive: true, force: true });
}
