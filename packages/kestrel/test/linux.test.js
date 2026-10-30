import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  ar, controlFile, debArchOf, debNameOf, debPackage, debVersionOf, desktopEntry, maintainerOf, tar,
} from "../src/linux.js";

// ---- readers, written from the formats rather than from linux.js ----

function readAr(buf) {
  assert.equal(buf.subarray(0, 8).toString(), "!<arch>\n");
  const members = [];
  for (let off = 8; off < buf.length; ) {
    const h = buf.subarray(off, off + 60).toString();
    assert.equal(h.slice(58, 60), "`\n", "ar header terminator");
    const size = Number(h.slice(48, 58).trim());
    members.push([h.slice(0, 16).trim(), buf.subarray(off + 60, off + 60 + size)]);
    off += 60 + size + (size % 2);
  }
  return members;
}

function readTar(buf) {
  const out = [];
  let pax = {};
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, n) => h.subarray(a, a + n).toString().replace(/\0.*$/s, "");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(str(148, 8), 8), sum, "tar checksum");
    assert.equal(str(257, 6), "ustar");
    const size = parseInt(str(124, 12), 8);
    const data = buf.subarray(off + 512, off + 512 + size);
    const type = str(156, 1);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      for (const rec of data.toString().split("\n").filter(Boolean)) {
        const [len, kv] = [rec.slice(0, rec.indexOf(" ")), rec.slice(rec.indexOf(" ") + 1)];
        assert.equal(Number(len), Buffer.byteLength(rec) + 1, "pax record length");
        pax[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
      }
      continue;
    }
    out.push({
      path: pax.path ?? str(0, 100),
      type,
      mode: parseInt(str(100, 8), 8),
      uid: parseInt(str(108, 8), 8),
      target: pax.linkpath ?? str(157, 100),
      data,
    });
    pax = {};
  }
  return out;
}

const m = { appId: "My_App", title: "My App", permissions: ["tray"] };

test("Debian names, versions and architectures", () => {
  assert.equal(debNameOf(m), "my-app");
  assert.equal(debNameOf({ appId: "x" }), "x-app");
  assert.equal(debNameOf({ appId: "_Notes.2" }), "notes.2");
  assert.equal(debVersionOf("1.2.3"), "1.2.3");
  assert.equal(debVersionOf("1.0.0-beta.1"), "1.0.0~beta.1");
  assert.equal(debVersionOf("v2"), "0~v2");
  assert.equal(debArchOf("x64"), "amd64");
  assert.equal(debArchOf("arm64"), "arm64");
  assert.equal(debArchOf("mips"), null);
  assert.equal(maintainerOf({ author: "Ada <ada@x.dev>" }, m), "Ada <ada@x.dev>");
  assert.equal(maintainerOf({ author: { name: "Ada", email: "ada@x.dev" } }, m), "Ada <ada@x.dev>");
  assert.match(maintainerOf({}, m), /^My App developers <noreply@my-app\.invalid>$/);
});

test("control file and desktop entry", () => {
  const c = controlFile(m, { name: "my-app", version: "1.0", arch: "amd64", maintainer: "A <a@b>", description: "Notes\nfor you", installedKiB: 12 });
  assert.match(c, /^Package: my-app\nVersion: 1\.0\nArchitecture: amd64\n/);
  assert.match(c, /\nDepends: libwebkit2gtk-4\.1-0, libgtk-3-0\n/);
  assert.match(c, /\nRecommends: libayatana-appindicator3-1\n/, "tray apps recommend the indicator library");
  assert.match(c, /\nDescription: Notes for you\n$/, "one line");
  assert.doesNotMatch(controlFile({ ...m, permissions: [] }, { name: "a", version: "1", arch: "amd64", maintainer: "x", installedKiB: 1 }), /Recommends/);
  const d = desktopEntry({ title: "My\nApp" }, { name: "my-app" });
  assert.match(d, /^\[Desktop Entry\]\nType=Application\nName=My App\nExec=\/usr\/bin\/my-app\nIcon=my-app\n/);
});

test("tar: files, folders, links, long names through pax", () => {
  const long = `./${"deep/".repeat(30)}file.txt`;
  const entries = readTar(
    tar(
      [
        { path: "./a", type: "dir" },
        { path: "./a/run", type: "file", data: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
        { path: "./a/link", type: "symlink", target: "/opt/x/run" },
        { path: long, type: "file", data: Buffer.alloc(1000, 7) },
        { path: "./b", type: "symlink", target: `/${"t".repeat(150)}` },
      ],
      1700000000,
    ),
  );
  assert.deepEqual(entries.map((e) => [e.path, e.type, e.mode.toString(8)]), [
    ["./a/", "5", "755"],
    ["./a/run", "0", "755"],
    ["./a/link", "2", "777"],
    [long, "0", "644"],
    ["./b", "2", "777"],
  ]);
  assert.equal(entries[1].data.toString(), "#!/bin/sh\n");
  assert.equal(entries[2].target, "/opt/x/run");
  assert.equal(entries[3].data.length, 1000);
  assert.equal(entries[4].target.length, 151);
  assert.ok(entries.every((e) => e.uid === 0), "owned by root");
});

test("ar pads odd members", () => {
  const members = readAr(ar([["a", Buffer.from("abc")], ["b", Buffer.from("de")]], 0));
  assert.deepEqual(members.map(([n, d]) => [n, d.toString()]), [["a", "abc"], ["b", "de"]]);
});

test("debPackage lays out /opt, /usr/bin, the desktop entry and icons", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-deb-"));
  fs.writeFileSync(path.join(dir, "My_App"), "ELF");
  fs.writeFileSync(path.join(dir, "kestrel.json"), "{}");
  fs.mkdirSync(path.join(dir, "app", "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(dir, "app", "assets", "index-abc.js"), "x");
  const icons = { 16: Buffer.from("p16"), 512: Buffer.from("p512"), 1024: Buffer.from("p1024") };
  const { file, version, deb } = debPackage({ m, dir, version: "1.0.0-rc.1", arch: "amd64", icons, pkg: { description: "Notes" }, mtime: 1 });
  fs.rmSync(dir, { recursive: true });
  assert.equal(file, "my-app_1.0.0~rc.1_amd64.deb");
  assert.equal(version, "1.0.0~rc.1");

  const members = readAr(deb);
  assert.deepEqual(members.map(([n]) => n), ["debian-binary", "control.tar.gz", "data.tar.gz"]);
  assert.equal(members[0][1].toString(), "2.0\n");
  const data = readTar(zlib.gunzipSync(members[2][1]));
  const byPath = Object.fromEntries(data.map((e) => [e.path, e]));
  for (const p of ["./", "./opt/", "./usr/", "./usr/bin/", "./usr/share/applications/", "./opt/my-app/app/assets/"])
    assert.equal(byPath[p]?.type, "5", `${p} is listed`);
  assert.equal(byPath["./opt/my-app/My_App"].mode, 0o755, "the host is executable");
  assert.equal(byPath["./opt/my-app/kestrel.json"].mode, 0o644);
  assert.equal(byPath["./usr/bin/my-app"].target, "/opt/my-app/My_App");
  assert.match(byPath["./usr/share/applications/my-app.desktop"].data.toString(), /Comment=Notes\n/);
  assert.equal(byPath["./usr/share/icons/hicolor/512x512/apps/my-app.png"].data.toString(), "p512");
  assert.equal(byPath["./usr/share/icons/hicolor/1024x1024/apps/my-app.png"], undefined, "hicolor stops at 512");
  const paths = data.map((e) => e.path);
  assert.equal(new Set(paths).size, paths.length, "no entry twice");
  for (const p of paths.filter((p) => p !== "./"))
    assert.ok(paths.indexOf(p.replace(/[^/]+\/?$/, "")) < paths.indexOf(p), `${p} comes after its folder`);

  const control = Object.fromEntries(readTar(zlib.gunzipSync(members[1][1])).map((e) => [e.path, e.data.toString()]));
  assert.match(control["./control"], /^Package: my-app\nVersion: 1\.0\.0~rc\.1\n/);
  assert.match(control["./control"], /\nInstalled-Size: 1\n/);
  const md5 = crypto.createHash("md5").update("ELF").digest("hex");
  assert.match(control["./md5sums"], new RegExp(`^${md5}  opt/my-app/My_App$`, "m"));
});

// The real tool, where there is one (CI's Ubuntu runner).
const hasDpkg = (() => {
  try {
    execFileSync("dpkg-deb", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("dpkg-deb accepts the package", { skip: !hasDpkg && "no dpkg-deb here" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-deb-"));
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "My_App"), "ELF");
  fs.writeFileSync(path.join(dir, "app", "index.html"), "x");
  const { deb } = debPackage({ m, dir, version: "1.0.0", arch: "amd64", icons: { 32: Buffer.from("p") } });
  const f = path.join(dir, "x.deb");
  fs.writeFileSync(f, deb);
  const info = execFileSync("dpkg-deb", ["--info", f]).toString();
  assert.match(info, /Package: my-app/);
  const list = execFileSync("dpkg-deb", ["--contents", f]).toString();
  assert.match(list, /\.\/usr\/bin\/my-app -> \/opt\/my-app\/My_App/);
  fs.rmSync(dir, { recursive: true });
});
