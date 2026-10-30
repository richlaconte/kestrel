// Linux packaging for `kestrel build --deb` (#26): a .deb written in plain
// Node (ar, tar and gzip over node:zlib), so any Linux machine or CI runner
// can make one without dpkg-deb.
//
// The app installs to /opt/<name>/ (the portable folder as is), with
// /usr/bin/<name> linking to it, a .desktop entry, and the icon in every
// hicolor size. The host finds its manifest beside the real executable, which
// /proc/self/exe gives it through the link.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Debian package names: lowercase letters, digits, `+ - .`, starting alphanumeric. */
export function debNameOf(m) {
  const name = m.appId.toLowerCase().replace(/[^a-z0-9+.-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  return name.length >= 2 ? name : `${name}-app`;
}

/**
 * A Debian version from the app's: a semver pre-release sorts before its
 * release with `~` ("1.0.0-beta.1" → "1.0.0~beta.1"), and it must start
 * with a digit.
 */
export function debVersionOf(version) {
  const v = String(version).replace(/-/g, "~").replace(/[^A-Za-z0-9.+~]/g, ".");
  return /^[0-9]/.test(v) ? v : `0~${v}`;
}

/** Debian's name for the CPU, or null for one it doesn't build. */
export const debArchOf = (arch = process.arch) => ({ x64: "amd64", arm64: "arm64", arm: "armhf", ia32: "i386" })[arch] ?? null;

/** Who the package says maintains it: package.json `author`, else a placeholder. */
export function maintainerOf(pkg, m) {
  const a = pkg?.author;
  if (typeof a === "string" && a.trim()) return a.trim();
  if (a && typeof a === "object" && a.name) return a.email ? `${a.name} <${a.email}>` : a.name;
  return `${m.title} developers <noreply@${debNameOf(m)}.invalid>`;
}

const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ").trim();

/** The `.desktop` entry the app menu reads. */
export function desktopEntry(m, { name, comment }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${oneLine(m.title)}`,
    ...(comment ? [`Comment=${oneLine(comment)}`] : []),
    `Exec=/usr/bin/${name}`,
    `Icon=${name}`,
    "Terminal=false",
    "Categories=Utility;",
    "",
  ].join("\n");
}

/** DEBIAN/control. `installedKiB` is the unpacked size. */
export function controlFile(m, { name, version, arch, maintainer, description, installedKiB }) {
  const depends = ["libwebkit2gtk-4.1-0", "libgtk-3-0"];
  const lines = [
    `Package: ${name}`,
    `Version: ${version}`,
    `Architecture: ${arch}`,
    `Maintainer: ${oneLine(maintainer)}`,
    `Installed-Size: ${installedKiB}`,
    `Depends: ${depends.join(", ")}`,
  ];
  // tray.create needs the indicator library (see host/src/tray.rs).
  if ((m.permissions ?? []).includes("tray")) lines.push("Recommends: libayatana-appindicator3-1");
  lines.push("Section: misc", "Priority: optional", `Description: ${oneLine(description || m.title)}`);
  return lines.join("\n") + "\n";
}

// ---- tar (ustar, with pax headers for long names) ----

const octal = (n, width) => n.toString(8).padStart(width - 1, "0") + "\0";

function tarHeader({ name, type, mode, size = 0, linkname = "", mtime }) {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid root
  put(octal(0, 8), 116, 8); // gid root
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  h.fill(" ", 148, 156); // checksum counts as spaces while summing
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put("root", 265, 32);
  put("root", 297, 32);
  let sum = 0;
  for (const b of h) sum += b;
  put(octal(sum, 7) + " ", 148, 8);
  return h;
}

const pad512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);

/** One pax record: "<len> key=value\n", where len counts its own digits too. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length > String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

/**
 * A tar archive. Each entry is { path, type: "file" | "dir" | "symlink",
 * mode?, data?, target? }. Owned by root; `mtime` in seconds.
 */
export function tar(entries, mtime) {
  const out = [];
  for (const e of entries) {
    const name = e.type === "dir" && !e.path.endsWith("/") ? `${e.path}/` : e.path;
    const linkname = e.target ?? "";
    const pax = [];
    if (Buffer.byteLength(name) > 100) pax.push(paxRecord("path", name));
    if (Buffer.byteLength(linkname) > 100) pax.push(paxRecord("linkpath", linkname));
    if (pax.length) {
      const body = Buffer.from(pax.join(""));
      out.push(tarHeader({ name: "././@PaxHeader", type: "x", mode: 0o644, size: body.length, mtime }), body, pad512(body.length));
    }
    const data = e.type === "file" ? e.data : Buffer.alloc(0);
    const type = { file: "0", dir: "5", symlink: "2" }[e.type];
    const mode = e.mode ?? (e.type === "file" ? 0o644 : e.type === "dir" ? 0o755 : 0o777);
    out.push(
      tarHeader({ name, type, mode, size: data.length, linkname, mtime }), // pax holds the full names
      data,
      pad512(data.length),
    );
  }
  out.push(Buffer.alloc(1024)); // two zero blocks end the archive
  return Buffer.concat(out);
}

// ---- ar ----

/** An ar archive of [name, Buffer] members, as dpkg reads a .deb. */
export function ar(members, mtime) {
  const out = [Buffer.from("!<arch>\n")];
  for (const [name, data] of members) {
    const field = (s, w) => String(s).padEnd(w, " ");
    out.push(
      Buffer.from(field(name, 16) + field(mtime, 12) + field(0, 6) + field(0, 6) + field("100644", 8) + field(data.length, 10) + "`\n"),
      data,
    );
    if (data.length % 2) out.push(Buffer.from("\n"));
  }
  return Buffer.concat(out);
}

// ---- the package ----

/** Every file, folder and link under `dir`, as tar entries rooted at `prefix`. */
function walk(dir, prefix, exe) {
  const entries = [{ path: prefix, type: "dir" }];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(dir, e.name);
    const dst = `${prefix}/${e.name}`;
    if (e.isSymbolicLink()) entries.push({ path: dst, type: "symlink", target: fs.readlinkSync(src) });
    else if (e.isDirectory()) entries.push(...walk(src, dst, exe));
    else entries.push({ path: dst, type: "file", data: fs.readFileSync(src), mode: src === exe ? 0o755 : 0o644 });
  }
  return entries;
}

/** Folders that hold `paths`, each listed once, parents first. */
function parents(paths) {
  const seen = new Set();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 2; i < parts.length; i++) seen.add(parts.slice(0, i).join("/"));
  }
  return [...seen].sort().map((p) => ({ path: p, type: "dir" }));
}

/**
 * The .deb for a built portable folder `dir` (the host at `dir/<appId>`).
 * `icons` maps sizes to PNG buffers. Returns { name, version, file, deb }.
 */
export function debPackage({ m, dir, version, arch, icons, pkg = {}, mtime = Math.floor(Date.now() / 1000) }) {
  const name = debNameOf(m);
  const debVersion = debVersionOf(version);
  const opt = `./opt/${name}`;
  const app = walk(dir, opt, path.join(dir, m.appId));
  const extra = [
    { path: `./usr/bin/${name}`, type: "symlink", target: `/opt/${name}/${m.appId}` },
    { path: `./usr/share/applications/${name}.desktop`, type: "file", data: Buffer.from(desktopEntry(m, { name, comment: pkg.description })) },
    ...Object.entries(icons)
      .filter(([s]) => Number(s) <= 512)
      .map(([s, png]) => ({ path: `./usr/share/icons/hicolor/${s}x${s}/apps/${name}.png`, type: "file", data: png })),
  ];
  const files = [...app, ...extra];
  const listed = new Set(files.filter((f) => f.type === "dir").map((f) => f.path));
  const missing = parents(files.map((f) => f.path)).filter((d) => !listed.has(d.path));
  const data = [{ path: ".", type: "dir" }, ...missing, ...app, ...extra];

  const bytes = files.reduce((n, f) => n + (f.data?.length ?? 0), 0);
  const control = controlFile(m, {
    name,
    version: debVersion,
    arch,
    maintainer: maintainerOf(pkg, m),
    description: pkg.description,
    installedKiB: Math.ceil(bytes / 1024),
  });
  const md5sums = files
    .filter((f) => f.type === "file")
    .map((f) => `${crypto.createHash("md5").update(f.data).digest("hex")}  ${f.path.slice(2)}\n`)
    .join("");
  const controlTar = tar(
    [
      { path: ".", type: "dir" },
      { path: "./control", type: "file", data: Buffer.from(control) },
      { path: "./md5sums", type: "file", data: Buffer.from(md5sums) },
    ],
    mtime,
  );
  const gz = (b) => zlib.gzipSync(b, { level: 9 });
  const deb = ar(
    [
      ["debian-binary", Buffer.from("2.0\n")],
      ["control.tar.gz", gz(controlTar)],
      ["data.tar.gz", gz(tar(data, mtime))],
    ],
    mtime,
  );
  return { name, version: debVersion, file: `${name}_${debVersion}_${arch}.deb`, deb };
}
