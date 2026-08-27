#!/usr/bin/env node
// kestrel — the CLI. Pre-alpha: create | typegen | dev | build (stub)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTypegen } from "../src/typegen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const VITE_PORT = 5183;

const [, , cmd, ...args] = process.argv;
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const positional = args.filter((a) => !a.startsWith("--"));

const die = (msg) => {
  console.error(`\x1b[31mkestrel:\x1b[0m ${msg}`);
  process.exit(1);
};
const info = (msg) => console.log(`\x1b[36mkestrel\x1b[0m ${msg}`);

function readManifest(dir) {
  const p = path.join(dir, "kestrel.json");
  if (!fs.existsSync(p))
    die(`no kestrel.json in ${dir} — is this a kestrel app? (try: kestrel create my-app)`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    die(`kestrel.json is not valid JSON: ${e.message}`);
  }
}

function resolveHost() {
  const candidates = [
    process.env.KESTREL_HOST,
    path.join(REPO_ROOT, "host", "target", "release", "kestrel-host"),
    path.join(REPO_ROOT, "host", "target", "release", "kestrel-host.exe"),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  die(
    "host binary not found. Build it once with `npm run build:host` " +
      "(needs Rust), or set KESTREL_HOST to a prebuilt binary.\n" +
      "  (In the released framework this is downloaded automatically — you never compile it.)",
  );
}

// ---- create ----------------------------------------------------------------
function create(name) {
  if (!name) die("usage: kestrel create <app-name> [--template=react|vanilla]");
  const template = flag("template") ?? "react";
  const tplDir = path.join(REPO_ROOT, "templates", template === "react" ? "react" : "default");
  if (!fs.existsSync(tplDir)) die(`unknown template: ${template}`);
  const dest = path.resolve(name);
  if (fs.existsSync(dest)) die(`${name} already exists`);
  fs.cpSync(tplDir, dest, { recursive: true });

  const mPath = path.join(dest, "kestrel.json");
  const m = JSON.parse(fs.readFileSync(mPath, "utf8"));
  m.appId = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
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
  const res = runTypegen(dir, m);
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

async function dev(dir = ".") {
  dir = path.resolve(dir);
  const m = readManifest(dir);
  const { compiled } = typegen(dir, { quiet: true });
  const host = resolveHost();

  const runtime = {
    appId: m.appId,
    title: m.title,
    width: m.width,
    height: m.height,
    frontend: dir, // used only in static mode; host requires it either way
  };
  if (compiled) runtime.native = path.resolve(compiled);
  const exitAfter = flag("exit-after");
  if (exitAfter) runtime.exitAfterMs = Number(exitAfter);

  let vite = null;
  if (typeof m.frontend === "object" && m.frontend.dev === "vite") {
    info(`starting vite on :${VITE_PORT} …`);
    // stdout ignored on purpose: readiness is detected by HTTP poll, and an
    // inherited/piped stdout makes vite EPIPE-crash noisily at shutdown.
    // detached: vite gets its own process group so shutdown can kill the
    // whole tree — killing just the npx wrapper orphans the real vite.
    vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "inherit"],
      detached: process.platform !== "win32",
    });
    const up = await waitForServer(`http://localhost:${VITE_PORT}/`);
    if (!up) {
      vite.kill();
      die("vite dev server did not come up (is `npm install` done in the app dir?)");
    }
    runtime.devUrl = `http://localhost:${VITE_PORT}/`;
  } else {
    runtime.frontend = path.resolve(dir, typeof m.frontend === "string" ? m.frontend : ".");
  }

  const tmp = path.join(os.tmpdir(), `kestrel-dev-${m.appId}-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2));

  info(`dev: ${m.title} (${m.appId})${runtime.devUrl ? " — HMR on" : ""}`);
  const child = spawn(host, [tmp], { stdio: "inherit", cwd: dir });
  const shutdown = (code) => {
    fs.rmSync(tmp, { force: true });
    if (vite) {
      try {
        if (process.platform === "win32") vite.kill();
        else process.kill(-vite.pid, "SIGTERM"); // whole process group
      } catch {}
    }
    process.exit(code ?? 0);
  };
  child.on("exit", shutdown);
  process.on("SIGINT", () => {
    child.kill();
    shutdown(0);
  });
}

// ---- build -----------------------------------------------------------------
// v0: an UNSIGNED portable bundle — the host binary renamed to the app, the
// built frontend, the compiled native module, and a runtime manifest, all in
// one folder that runs from anywhere. Signing, installers, and auto-update
// land on top of this in Phase 2.
function sh(cmd, argv, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, argv, { cwd, stdio: ["ignore", "inherit", "inherit"] });
    c.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
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
    await sh("npx", ["vite", "build"], dir);
    assets = path.resolve(dir, m.frontend.dist ?? "dist");
  } else {
    assets = path.resolve(dir, m.frontend ?? ".");
  }
  if (!fs.existsSync(path.join(assets, "index.html")))
    die(`no index.html in ${assets} — frontend build failed?`);

  // 2. Assemble the bundle
  const out = path.join(dir, "build", m.appId);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const exe = path.join(out, m.appId + (process.platform === "win32" ? ".exe" : ""));
  fs.copyFileSync(host, exe);
  fs.chmodSync(exe, 0o755);

  fs.cpSync(assets, path.join(out, "app"), { recursive: true });
  const runtime = {
    appId: m.appId,
    title: m.title,
    width: m.width,
    height: m.height,
    frontend: "app",
  };
  if (compiled) {
    fs.copyFileSync(compiled, path.join(out, "native.js"));
    runtime.native = "native.js";
  }
  fs.writeFileSync(path.join(out, "kestrel.json"), JSON.stringify(runtime, null, 2) + "\n");

  const mb = (dirSize(out) / 1024 / 1024).toFixed(1);
  info(`built ${path.relative(process.cwd(), out)}/ — ${mb} MB total, runs from anywhere`);
  console.log(
    "  note: unsigned portable build. Signed installers + auto-update are Phase 2.",
  );
}

switch (cmd) {
  case "create":  create(positional[0]); break;
  case "typegen": typegen(positional[0] ?? "."); break;
  case "dev":     await dev(positional[0] ?? "."); break;
  case "build":   await build(positional[0] ?? "."); break;
  default:
    console.log(`kestrel — just React, actually native  (pre-alpha)

  kestrel create <name> [--template=react|vanilla]
  kestrel dev [dir]       run the app (vite HMR when the template uses it)
  kestrel typegen [dir]   regenerate typed native-function stubs
  kestrel build [dir]     portable app bundle (unsigned; installers land in Phase 2)
`);
    process.exit(cmd ? 1 : 0);
}
