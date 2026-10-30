#!/usr/bin/env node
// kestrel — the CLI. Pre-alpha: create | typegen | dev | build (stub)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runTypegen, TypegenError } from "../src/typegen.js";
import { WINDOW_FIELDS, validateManifest } from "../src/manifest.js";
import { errorFile, watchNative } from "../src/watch.js";
import { IconError, makeIcons } from "../src/icons.js";
import * as linux from "../src/linux.js";
import * as macos from "../src/macos.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_DEV_PORT = 5183;

const [, , cmd, ...args] = process.argv;
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const positional = args.filter((a) => !a.startsWith("--"));

const die = (msg) => {
  console.error(`\x1b[31mkestrel:\x1b[0m ${msg}`);
  process.exit(1);
};
const info = (msg) => console.log(`\x1b[36mkestrel\x1b[0m ${msg}`);
const warn = (msg) => console.warn(`\x1b[33mkestrel: warning:\x1b[0m ${msg}`);
const DEFAULT_ICON = path.join(PKG_ROOT, "assets", "icon.png");

/** The app's icon source: its own, else Kestrel's. */
function iconOf(dir, m) {
  if (m.icon === undefined) return DEFAULT_ICON;
  const p = path.resolve(dir, m.icon);
  if (!fs.existsSync(p)) die(`icon ${m.icon} not found (from kestrel.json \`icon\`)`);
  return p;
}

function readManifest(dir) {
  const p = path.join(dir, "kestrel.json");
  if (!fs.existsSync(p))
    die(`no kestrel.json in ${dir} — is this a kestrel app? (try: kestrel create my-app)`);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    die(`kestrel.json is not valid JSON: ${e.message}`);
  }
  const errs = validateManifest(m);
  if (errs.length) die(`problems in ${p}:\n${errs.map((e) => `  - ${e}`).join("\n")}`);
  if (m.native && !fs.existsSync(path.resolve(dir, m.native)))
    die(`\`native\` points at ${m.native}, which doesn't exist (in ${dir})`);
  if (m.permissions?.includes("fs:all"))
    console.warn(
      "\x1b[33mkestrel: warning:\x1b[0m `fs:all` lets native code read and write every file the user can. " +
        'Use "fs:app-data" unless the app really needs that.',
    );
  return m;
}

/** The manifest's window options, for the host's runtime manifest. */
function windowFields(m) {
  return Object.fromEntries(WINDOW_FIELDS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]]));
}

// Prebuilt host from the platform package npm installed alongside kestreljs
// (an optionalDependency; see scripts/release). Falls back to a local cargo
// build for framework development.
function resolveHost() {
  const exe = process.platform === "win32" ? "kestrel-host.exe" : "kestrel-host";
  const platformPkg = `kestreljs-host-${process.platform}-${process.arch}`;
  let prebuilt = null;
  try {
    prebuilt = createRequire(import.meta.url).resolve(`${platformPkg}/bin/${exe}`);
  } catch {}
  const candidates = [
    process.env.KESTREL_HOST,
    prebuilt,
    path.join(REPO_ROOT, "host", "target", "release", exe),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  die(
    `no host binary for ${process.platform}-${process.arch}. ` +
      `It ships as the optional dependency ${platformPkg}: reinstall without ` +
      "--no-optional/--omit=optional, or set KESTREL_HOST to a host binary. " +
      "Developing Kestrel itself? Build one with `npm run build:host` (needs Rust).",
  );
}

// Vite's JS entry from the app's own node_modules. Running it with
// process.execPath avoids npx and shells entirely: on Windows `npx` is a
// .cmd, which spawn() refuses without `shell: true` (CVE-2024-27980).
function resolveVite(dir) {
  let pkgPath;
  try {
    pkgPath = createRequire(path.join(dir, "package.json")).resolve("vite/package.json");
  } catch {
    die("vite is not installed in this app — run `npm install` in the app dir first");
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.vite;
  return path.join(path.dirname(pkgPath), bin);
}

function spawnVite(dir, viteArgs, opts) {
  return spawn(process.execPath, [resolveVite(dir), ...viteArgs], { cwd: dir, ...opts });
}

/** End a child and everything it spawned. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {}
}

/** kestrel.json's `version`, else package.json's, for app.version(). */
function appVersion(dir, m) {
  if (m.version) return m.version;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---- create ----------------------------------------------------------------
function create(name) {
  if (!name) die("usage: kestrel create <app-name> [--template=react|vanilla]");
  const template = flag("template") ?? "react";
  const dirName = template === "react" ? "react" : "default";
  // Bundled with the npm package; the repo root works for monorepo development.
  const tplDir = [
    path.join(PKG_ROOT, "templates", dirName),
    path.join(REPO_ROOT, "templates", dirName),
  ].find((p) => fs.existsSync(p));
  if (!tplDir) die(`unknown template: ${template}`);
  const dest = path.resolve(name);
  if (fs.existsSync(dest)) die(`${name} already exists`);
  fs.cpSync(tplDir, dest, { recursive: true });

  const mPath = path.join(dest, "kestrel.json");
  const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  m.appId =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "app";
  m.title = name;
  fs.writeFileSync(mPath, JSON.stringify(m, null, 2) + "\n");

  info(`created ${name}/ (template: ${template})`);
  const install = template === "react" ? `  npm install\n` : "";
  console.log(`\n  cd ${name}\n${install}  kestrel dev\n`);
}

// ---- typegen ---------------------------------------------------------------
function typegen(dir = ".", { quiet } = {}) {
  dir = path.resolve(dir);
  const m = readManifest(dir);
  let res;
  try {
    res = runTypegen(dir, m);
  } catch (e) {
    if (e instanceof TypegenError) die(e.message);
    throw e;
  }
  for (const n of res.skipped)
    console.warn(`\x1b[33mkestrel:\x1b[0m native.ts exports \`${n}\`, which isn't a function — it won't be callable from the webview`);
  if (!quiet) {
    if (!m.native) info("app declares no native module — nothing to generate");
    else info(`generated typed stubs — ${res.names.length} fn(s): ${res.names.join(", ")}`);
  }
  return res;
}

// ---- dev -------------------------------------------------------------------
async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

/** First port at or above `start` that nothing is listening on. */
async function freePort(start) {
  const free = (port) =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, () => srv.close(() => resolve(true)));
    });
  for (let p = start; p < start + 100; p++) if (await free(p)) return p;
  die(`no free port in ${start}–${start + 99} for the dev server`);
}

async function dev(dir = ".") {
  dir = path.resolve(dir);
  const m = readManifest(dir);
  fs.rmSync(errorFile(dir), { force: true });
  const { compiled, inputs } = typegen(dir, { quiet: true });
  const host = resolveHost();

  const runtime = {
    appId: m.appId,
    title: m.title,
    version: appVersion(dir, m),
    width: m.width,
    height: m.height,
    ...windowFields(m),
    icon: iconOf(dir, m),
    frontend: dir, // used only in static mode; host requires it either way
    permissions: m.permissions ?? [],
  };
  if (compiled) {
    runtime.native = path.resolve(compiled);
    runtime.devReload = true;
  }
  const exitAfter = flag("exit-after");
  if (exitAfter) runtime.exitAfterMs = Number(exitAfter);

  let vite = null;
  if (typeof m.frontend === "object" && m.frontend.dev === "vite") {
    const port = await freePort(Number(flag("port")) || DEFAULT_DEV_PORT);
    info(`starting vite on :${port} …`);
    // stdout ignored on purpose: readiness is detected by HTTP poll, and an
    // inherited/piped stdout makes vite EPIPE-crash noisily at shutdown.
    vite = spawnVite(dir, ["--port", String(port), "--strictPort"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, KESTREL_DEV_PORT: String(port) },
    });
    const up = await waitForServer(`http://localhost:${port}/`);
    if (!up) {
      killTree(vite);
      die("vite dev server did not come up (is `npm install` done in the app dir?)");
    }
    runtime.devUrl = `http://localhost:${port}/`;
  } else {
    runtime.frontend = path.resolve(dir, typeof m.frontend === "string" ? m.frontend : ".");
  }

  const tmp = path.join(os.tmpdir(), `kestrel-dev-${m.appId}-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2));

  info(`dev: ${m.title} (${m.appId})${runtime.devUrl ? " — HMR on" : ""}`);
  // stdin is the reload channel: one `reload-native` line per rebuild.
  const child = spawn(host, [tmp], { stdio: ["pipe", "inherit", "inherit"], cwd: dir });
  child.stdin.on("error", () => {}); // host already gone; exit handles it
  const stopWatching = compiled
    ? watchNative(dir, m, inputs, {
        onBuild(res) {
          fs.rmSync(errorFile(dir), { force: true });
          child.stdin.write("reload-native\n");
          info(`native module rebuilt and reloaded — ${res.names.length} fn(s): ${res.names.join(", ")}`);
        },
        onError(message) {
          // The overlay shows it in the window; the last good module keeps running.
          fs.writeFileSync(errorFile(dir), JSON.stringify({ message }));
          console.error(`\x1b[31mkestrel:\x1b[0m ${message}`);
        },
      })
    : () => {};
  const shutdown = (code) => {
    stopWatching();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(errorFile(dir), { force: true });
    killTree(vite);
    process.exit(code ?? 0);
  };
  child.on("exit", shutdown);
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      child.kill();
      shutdown(0);
    });
}

// ---- build -----------------------------------------------------------------
// v0: an UNSIGNED portable bundle — the host binary renamed to the app, the
// built frontend, the compiled native module, and a runtime manifest, all in
// one folder that runs from anywhere. Signing, installers, and auto-update
// land on top of this in Phase 2.
function viteBuild(dir) {
  return new Promise((resolve, reject) => {
    const c = spawnVite(dir, ["build"], { stdio: ["ignore", "inherit", "inherit"] });
    c.on("error", reject);
    c.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`)),
    );
  });
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  }
  return total;
}

async function build(dir = ".") {
  dir = path.resolve(dir);
  const m = readManifest(dir);
  const host = resolveHost();
  const { compiled } = typegen(dir, { quiet: true });

  // 1. Frontend → static files
  let assets;
  if (typeof m.frontend === "object") {
    info("building frontend (vite build)…");
    await viteBuild(dir).catch((e) => die(e.message));
    assets = path.resolve(dir, m.frontend.dist ?? "dist");
  } else {
    assets = path.resolve(dir, m.frontend ?? ".");
  }
  if (!fs.existsSync(path.join(assets, "index.html")))
    die(`no index.html in ${assets} — frontend build failed?`);

  // 2. Icons: every size, for the bundle and for installers.
  const iconSrc = iconOf(dir, m);
  let icons;
  try {
    icons = makeIcons(fs.readFileSync(iconSrc));
  } catch (e) {
    if (!(e instanceof IconError)) throw e;
    die(`icon ${path.relative(dir, iconSrc)}: ${e.message}`);
  }
  icons.warnings.forEach((w) => warn(w));
  const iconsDir = path.join(dir, "build", "icons");
  fs.rmSync(iconsDir, { recursive: true, force: true });
  fs.mkdirSync(iconsDir, { recursive: true });
  fs.writeFileSync(path.join(iconsDir, "icon.icns"), icons.icns);
  fs.writeFileSync(path.join(iconsDir, "icon.ico"), icons.ico);
  for (const [s, png] of Object.entries(icons.png)) fs.writeFileSync(path.join(iconsDir, `${s}x${s}.png`), png);

  // 3. Assemble: a .app on macOS, a portable folder elsewhere.
  const mac = process.platform === "darwin";
  const version = appVersion(dir, m);
  const out = mac
    ? path.join(dir, "build", `${macos.appNameOf(m)}.app`)
    : path.join(dir, "build", m.appId);
  const layout = mac
    ? macos.appLayout(out, m)
    : { exe: path.join(out, m.appId + (process.platform === "win32" ? ".exe" : "")), resources: out };
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(layout.exe), { recursive: true });
  fs.mkdirSync(layout.resources, { recursive: true });

  fs.copyFileSync(host, layout.exe);
  fs.chmodSync(layout.exe, 0o755);
  // A frontend of "." holds the build output, dependencies and dotfiles
  // too. Entry by entry: cpSync refuses to copy a folder into itself.
  const skip = new Set([path.join(dir, "build"), path.join(dir, "node_modules")]);
  const hidden = (p) => path.basename(p).startsWith(".");
  for (const e of fs.readdirSync(assets)) {
    const src = path.join(assets, e);
    if (skip.has(src) || hidden(src)) continue;
    fs.cpSync(src, path.join(layout.resources, "app", e), { recursive: true, filter: (p) => !hidden(p) });
  }
  fs.writeFileSync(path.join(layout.resources, "icon.png"), icons.png[256]);
  const runtime = {
    appId: m.appId,
    title: m.title,
    version,
    width: m.width,
    height: m.height,
    ...windowFields(m),
    icon: "icon.png",
    frontend: "app",
    permissions: m.permissions ?? [],
  };
  if (m.csp !== undefined) runtime.csp = m.csp;
  if (compiled) {
    fs.copyFileSync(compiled, path.join(layout.resources, "native.js"));
    runtime.native = "native.js";
  }
  fs.writeFileSync(path.join(layout.resources, "kestrel.json"), JSON.stringify(runtime, null, 2) + "\n");

  let signed = "unsigned";
  if (mac) {
    fs.writeFileSync(layout.plist, macos.infoPlist(m, version));
    fs.writeFileSync(path.join(layout.resources, "icon.icns"), icons.icns);
    signed = signMac(out);
  }

  const rel = path.relative(process.cwd(), out);
  const mb = (dirSize(out) / 1024 / 1024).toFixed(1);
  info(`built ${rel}${mac ? "" : "/"} — ${mb} MB, ${signed}; icons in ${path.relative(process.cwd(), iconsDir)}/`);
  if (mac && args.includes("--dmg")) {
    const image = path.join(dir, "build", `${macos.appNameOf(m)}-${version}.dmg`);
    try {
      macos.dmg(out, image, m.title);
    } catch (e) {
      die(`could not make the .dmg: ${e.stderr?.toString().trim() || e.message}`);
    }
    info(`built ${path.relative(process.cwd(), image)}`);
  }
  const linuxOut = process.platform === "linux" && ["--deb", "--appimage"].some((f) => args.includes(f));
  if (process.platform === "linux" && args.includes("--deb")) makeDeb(dir, m, out, version, icons);
  if (process.platform === "linux" && args.includes("--appimage")) await makeAppImage(dir, m, out, version, icons);
  if (process.platform === "win32") console.log("  note: unsigned portable build. A Windows installer is coming (#25).");
  else if (!mac && !linuxOut) console.log("  note: portable build. Add --deb or --appimage for an installable package.");
}

function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** build/<name>_<version>_<arch>.deb from the portable folder. */
function makeDeb(dir, m, out, version, icons) {
  const arch = linux.debArchOf();
  if (!arch) die(`--deb: no Debian architecture for ${process.arch}`);
  const pkg = readPackageJson(dir);
  const { file, deb } = linux.debPackage({ m, dir: out, version, arch, icons: icons.png, pkg });
  const dest = path.join(dir, "build", file);
  fs.writeFileSync(dest, deb);
  info(`built ${path.relative(process.cwd(), dest)} — ${(deb.length / 1024 / 1024).toFixed(1)} MB; installs to /opt/${linux.debNameOf(m)}`);
}

/** build/<Title>-<version>-<arch>.AppImage from the portable folder. */
async function makeAppImage(dir, m, out, version, icons) {
  const arch = linux.appImageArchOf();
  if (!arch) die(`--appimage: no AppImage runtime for ${process.arch}`);
  const dest = path.join(dir, "build", linux.appImageNameOf(m, version, arch));
  const root = path.join(dir, "build", ".AppDir");
  try {
    const runtime = await linux.appImageRuntime(arch);
    linux.appDir({ m, dir: out, root, version, icons: icons.png, pkg: readPackageJson(dir) });
    linux.appImage(root, runtime, dest);
  } catch (e) {
    die(`could not make the AppImage: ${e.stderr?.toString().trim() || e.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  info(`built ${path.relative(process.cwd(), dest)} — ${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB`);
}

/** Sign (and maybe notarize) a built .app; returns how it ended up signed. */
function signMac(app) {
  const plan = macos.signingPlan();
  if (plan.partial.length)
    warn(`notarization needs APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID; missing ${plan.partial.join(", ")}`);
  const failed = (what, e) => die(`${what} failed: ${e.stderr?.toString().trim() || e.message}`);
  try {
    macos.sign(app, plan.identity);
  } catch (e) {
    failed(plan.identity ? `codesign with "${plan.identity}"` : "ad hoc codesign", e);
  }
  if (!plan.identity) return "signed ad hoc (runs on this Mac; set KESTREL_SIGN_IDENTITY to ship it)";
  if (!plan.notarize) return `signed by ${plan.identity}, not notarized`;
  info("notarizing (Apple usually takes a few minutes)…");
  try {
    macos.notarize(app);
  } catch (e) {
    failed("notarization", e);
  }
  return `signed by ${plan.identity}, notarized and stapled`;
}

switch (cmd) {
  case "create":  create(positional[0]); break;
  case "typegen": typegen(positional[0] ?? "."); break;
  case "dev":     await dev(positional[0] ?? "."); break;
  case "build":   await build(positional[0] ?? "."); break;
  default:
    console.log(`kestrel — just React, actually native  (pre-alpha)

  kestrel create <name> [--template=react|vanilla]
  kestrel dev [dir] [--port=N]
                          run the app (vite HMR when the template uses it;
                          the dev server takes the first free port from N, default 5183)
  kestrel typegen [dir]   regenerate typed native-function stubs
  kestrel build [dir]     a signed .app on macOS (--dmg for a disk image), a portable folder
                          elsewhere (on Linux, --deb for a Debian package and
                          --appimage for an AppImage)
`);
    process.exit(cmd ? 1 : 0);
}
