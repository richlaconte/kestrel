import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeIcons } from "../src/icons.js";
import {
  ct, fileVersionOf, findMakensis, installerNameOf, installNameOf, makeInstaller, nsis, nsisScript,
  publisherOf, signArgs, signCommand, signingPlan,
} from "../src/windows.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("names, versions and publisher", () => {
  assert.equal(installNameOf({ title: 'My: "App".', appId: "a" }), "My- -App-");
  assert.equal(installNameOf({ title: "???", appId: "a" }), "-");
  assert.equal(installerNameOf({ title: "My $App", appId: "a" }, "1.0.0", "x64"), "My-App-1.0.0-x64-setup.exe");
  assert.equal(installerNameOf({ title: "日本", appId: "jp" }, "1", "arm64"), "jp-1-arm64-setup.exe");
  assert.equal(fileVersionOf("1.2.3"), "1.2.3.0");
  assert.equal(fileVersionOf("1.2.3-beta.4"), "1.2.3.0");
  assert.equal(fileVersionOf("2"), "2.0.0.0");
  assert.equal(fileVersionOf("1.2.3.4.5"), "1.2.3.4");
  assert.equal(fileVersionOf("v1"), "0.0.0.0");
  assert.equal(fileVersionOf("70000.1"), "65535.1.0.0");
  assert.equal(publisherOf({ author: "Ada Lovelace <ada@x.dev>" }, {}), "Ada Lovelace");
  assert.equal(publisherOf({ author: { name: "Ada" } }, {}), "Ada");
  assert.equal(publisherOf({}, { title: "T" }), "T");
});

test("runtime and compile-time NSIS strings", () => {
  assert.equal(nsis('a $b "c"\nd'), '"a $$b $\\"c$\\" d"');
  assert.equal(ct("a $b"), '"a $b"');
  assert.equal(ct('say "hi"'), `'say "hi"'`);
  assert.equal(ct(`"it's"`), '`"it\'s"`');
  assert.equal(ct("${X}"), '"$ {X}"', "no define expansion");
});

test("signing plan, arguments and the uninstaller's command", () => {
  assert.deepEqual(signingPlan({}), { pfx: null, password: "", timestamp: "http://timestamp.digicert.com", orphanPassword: false });
  assert.equal(signingPlan({ KESTREL_WIN_SIGN_PASSWORD: "x" }).orphanPassword, true);
  const plan = signingPlan({ KESTREL_WIN_SIGN_PFX: "C:\\certs\\my cert.pfx", KESTREL_WIN_SIGN_PASSWORD: "p$w", KESTREL_WIN_TIMESTAMP_URL: "http://ts" });
  assert.deepEqual(signArgs(plan, "a.exe"), ["sign", "/fd", "SHA256", "/f", "C:\\certs\\my cert.pfx", "/p", "p$w", "/tr", "http://ts", "/td", "SHA256", "a.exe"]);
  assert.deepEqual(signArgs({ ...plan, password: "" }, "a.exe").includes("/p"), false);
  assert.equal(
    signCommand("C:\\Program Files\\signtool.exe", plan),
    '"C:\\Program Files\\signtool.exe" sign /fd SHA256 /f "C:\\certs\\my cert.pfx" /p p$w /tr http://ts /td SHA256 "%1"',
  );
  assert.throws(() => signCommand("signtool", { ...plan, password: 'a"b' }), /PASSWORD can't contain/);
  assert.throws(() => signCommand("signtool", { ...plan, pfx: "${x}.pfx" }), /PFX can't contain/);
});

const tmpPortable = (appId) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-nsis-"));
  const src = path.join(tmp, "portable");
  fs.mkdirSync(path.join(src, "app"), { recursive: true });
  fs.writeFileSync(path.join(src, `${appId}.exe`), "MZ");
  fs.writeFileSync(path.join(src, "app", "index.html"), "x");
  fs.writeFileSync(path.join(src, "icon.ico"), makeIcons(fs.readFileSync(path.join(ROOT, "assets", "icon.png"))).ico);
  return { tmp, src };
};

test("the script installs per user, registers an uninstaller and checks WebView2", () => {
  const { tmp, src } = tmpPortable("notes");
  const m = { appId: "notes", title: "My $Notes" };
  const s = nsisScript({ m, version: "1.0.0", src, icon: path.join(src, "icon.ico"), out: path.join(tmp, "setup.exe") });
  const signed = nsisScript({ m, version: "1", src, icon: "i.ico", out: "o.exe", signCmd: '"st" sign "%1"' });
  fs.rmSync(tmp, { recursive: true });
  assert.match(s, /^RequestExecutionLevel user$/m);
  assert.match(s, /^InstallDir "\$LOCALAPPDATA\\Programs\\My \$\$Notes"$/m, "runtime string: $ escaped");
  assert.match(s, /^VIAddVersionKey "ProductName" "My \$Notes"$/m, "compile-time string: $ as is");
  assert.match(s, /CreateShortCut "\$SMPROGRAMS\\My \$\$Notes\.lnk" "\$INSTDIR\\notes\.exe" "" "\$INSTDIR\\icon\.ico"/);
  assert.match(s, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\notes" "QuietUninstallString"/);
  assert.match(s, /EdgeUpdate\\Clients\\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5\}/);
  assert.match(s, /MicrosoftEdgeWebview2Setup\.exe" \/silent \/install/);
  assert.match(s, /^\s+DeleteRegKey HKCU/m);
  assert.doesNotMatch(s, /uninstfinalize/, "no signing without a command");
  assert.match(signed, /^!uninstfinalize `"st" sign "%1"` = 0$/m);
});

const makensis = findMakensis();

test("makensis builds the installer", { skip: !makensis && "no makensis here" }, () => {
  const { tmp, src } = tmpPortable("notes");
  const m = { appId: "notes", title: 'My $Notes "Pro"' };
  const out = path.join(tmp, installerNameOf(m, "1.2.0-rc.1", "x64"));
  makeInstaller({ makensis, script: nsisScript({ m, version: "1.2.0-rc.1", pkg: { author: "Ada <a@b>" }, src, icon: path.join(src, "icon.ico"), out }), out });
  const exe = fs.readFileSync(out);
  assert.equal(exe.subarray(0, 2).toString(), "MZ");
  const has = (t) => exe.includes(Buffer.from(t, "utf16le"));
  assert.ok(has('My $Notes "Pro"'), "the title lands in the version resource literally");
  assert.ok(has("1.2.0-rc.1") && has("Ada"));
  assert.deepEqual(fs.readdirSync(tmp).sort(), [path.basename(out), "portable"].sort(), "the .nsi is cleaned up");
  fs.rmSync(tmp, { recursive: true });
});
