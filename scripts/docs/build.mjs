#!/usr/bin/env node
// Builds the GitHub Pages site: site/ as is (the landing page), plus a docs
// section rendered from the Markdown in docs/ and reference pages generated
// from the .d.ts files and the manifest's JSON Schema.
//
//   node scripts/docs/build.mjs [--out=_site]
//
// Fails on a link to a docs page or heading that doesn't exist.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeHtml, render } from "./md.mjs";
import { dtsReference, schemaReference } from "./reference.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = "https://github.com/richlaconte/kestrel";
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const MANIFEST_EXAMPLE = `{
  "$schema": "./node_modules/kestreljs/schema/kestrel.schema.json",
  "appId": "my-app",
  "title": "My App",
  "width": 760,
  "height": 560,
  "frontend": { "dev": "vite", "dist": "dist" },
  "native": "native.ts",
  "permissions": ["fs:app-data"]
}`;

/** The docs, in sidebar order. `src` is Markdown in the repo; `gen` makes it. */
export const SECTIONS = [
  {
    title: "Guide",
    pages: [
      { slug: "getting-started", src: "docs/guide/getting-started.md", blurb: "Create, run and build your first app." },
      {
        slug: "native-functions",
        src: "docs/guide/native-functions.md",
        blurb: "Privileged TypeScript in the host, called like a typed function.",
      },
      {
        slug: "permissions",
        src: "docs/guide/permissions.md",
        blurb: "What an app may touch, granted in kestrel.json.",
      },
      {
        slug: "migrating-from-electron",
        src: "docs/guide/migrating-from-electron.md",
        blurb: "Where main, preload and renderer code goes.",
      },
    ],
  },
  {
    title: "Ship",
    pages: [
      { slug: "building", src: "docs/guide/building.md", blurb: "What kestrel build makes on each OS." },
      { slug: "shipping-macos", src: "docs/SHIPPING-MACOS.md", nav: "macOS", blurb: "The .app, signing, notarizing." },
      {
        slug: "shipping-windows",
        src: "docs/SHIPPING-WINDOWS.md",
        nav: "Windows",
        blurb: "The installer, WebView2, signing.",
      },
      { slug: "shipping-linux", src: "docs/SHIPPING-LINUX.md", nav: "Linux", blurb: ".deb packages and AppImages." },
      { slug: "updates", src: "docs/UPDATES.md", blurb: "Signed updates from a feed you host." },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        slug: "std-lib",
        nav: "kestrel-native",
        source: "packages/kestrel-native/index.d.ts",
        blurb: "The std-lib the webview calls: windows, files, dialogs, tray, store…",
        gen: () =>
          dtsReference("index.d.ts", read("packages/kestrel-native/index.d.ts"), {
            title: "kestrel-native",
            module: "kestrel-native",
            late: ["on", "callNative"],
            intro:
              "The std-lib your frontend calls directly, with no `native.ts` of your own. Every call returns a " +
              "Promise that rejects with a [`KestrelError`](#kestrelerror). Calls that touch the system need a " +
              "[permission](permissions.md) in `kestrel.json`.",
          }),
      },
      {
        slug: "native-host",
        nav: "kestreljs/native/host",
        source: "packages/kestrel/native/host.d.ts",
        blurb: "What native.ts can import inside the host.",
        gen: () =>
          dtsReference("host.d.ts", read("packages/kestrel/native/host.d.ts"), {
            title: "kestreljs/native/host",
            module: "kestreljs/native/host",
            intro:
              "The bindings your [native functions](native-functions.md) can import. They exist only inside " +
              "the host's engine, never in the webview, and only for the permissions `kestrel.json` grants.",
          }),
      },
      {
        slug: "manifest",
        nav: "kestrel.json",
        source: "packages/kestrel/schema/kestrel.schema.json",
        blurb: "Every manifest field.",
        gen: () =>
          schemaReference(JSON.parse(read("packages/kestrel/schema/kestrel.schema.json")), {
            title: "kestrel.json",
            intro:
              "The manifest is an app's whole configuration. The CLI validates it on every run, and editors " +
              "that read `$schema` complete and check it as you type.",
            example: MANIFEST_EXAMPLE,
          }),
      },
      { slug: "cli", src: "docs/guide/cli.md", nav: "CLI", blurb: "Commands, flags and environment variables." },
    ],
  },
  {
    title: "Background",
    pages: [
      { slug: "rfc-0001", src: "docs/rfc-0001-native-api.md", nav: "RFC-0001", blurb: "The design of the v0 API." },
      { slug: "findings", src: "docs/FINDINGS.md", nav: "Spike findings", blurb: "What the Phase 0 spikes measured." },
      {
        slug: "friction",
        src: "docs/FRICTION.md",
        nav: "Friction log",
        blurb: "Kestrel, Tauri and Electron, side by side.",
      },
    ],
  },
];

const PAGES = SECTIONS.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));

/** Replaces `<!-- kestrel --help -->` with the CLI's real usage text. */
function includes(md) {
  return md.replace(/<!-- kestrel --help -->/g, () => {
    // Usage exits non-zero; its text is what we want.
    const { stdout } = spawnSync(process.execPath, [path.join(ROOT, "packages/kestrel/bin/kestrel.js"), "--help"], {
      encoding: "utf8",
    });
    if (!stdout.includes("kestrel build")) throw new Error(`kestrel --help printed no usage:\n${stdout}`);
    return "```\n" + stdout.trimEnd() + "\n```";
  });
}

function layout({ page, title, body, headings, prev, next, description, titles }) {
  const nav = SECTIONS.map(
    (s) =>
      `<div class="side-group"><h2>${s.title}</h2><ul>` +
      s.pages
        .map((p) => {
          const label = escapeHtml(p.nav ?? titles.get(p.slug));
          const cur = page && p.slug === page.slug ? ' aria-current="page"' : "";
          return `<li><a href="${p.slug}.html"${cur}>${label}</a></li>`;
        })
        .join("") +
      "</ul></div>",
  ).join("");
  const toc = headings.filter((h) => h.level === 2);
  const tocHtml =
    toc.length > 1
      ? `<aside class="toc" aria-label="On this page"><h2>On this page</h2><ul>${toc
          .map((h) => `<li><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
          .join("")}</ul></aside>`
      : "";
  const pager =
    prev || next
      ? `<nav class="pager" aria-label="Previous and next">${
          prev
            ? `<a class="prev" href="${prev.slug}.html"><small>Previous</small>${escapeHtml(prev.title)}</a>`
            : "<span></span>"
        }${next ? `<a class="next" href="${next.slug}.html"><small>Next</small>${escapeHtml(next.title)}</a>` : ""}</nav>`
      : "";
  let source = "";
  if (page?.src) source = `<a href="${REPO}/edit/main/${page.src}">Edit this page on GitHub</a>`;
  else if (page?.source)
    source = `Generated from <a href="${REPO}/blob/main/${page.source}"><code>${page.source}</code></a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Kestrel docs</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#14110f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23D9633A'/%3E%3Cpath d='M6 19c5-1 8-4 10-9 1 3 3 5 6 6l4-1-3 3c-3 1-6 1-8 0l-3 6-1-5c-2 1-4 1-5 0z' fill='%23fff'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="docs.css">
<script>try{var t=localStorage.getItem("kestrel-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}document.documentElement.classList.add("js")</script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="nav">
  <a class="brand" href="../"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="var(--accent)"/><path d="M6 19c5-1 8-4 10-9 1 3 3 5 6 6l4-1-3 3c-3 1-6 1-8 0l-3 6-1-5c-2 1-4 1-5 0z" fill="#fff"/></svg>Kestrel</a>
  <a class="nav-docs" href="./">Docs</a>
  <span class="nav-badge">pre-alpha</span>
  <div class="nav-right">
    <a href="${REPO}" aria-label="Kestrel on GitHub"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg></a>
    <button class="icon-btn" id="theme" type="button" aria-label="Toggle color theme"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
    <button class="icon-btn menu-btn" id="menu" type="button" aria-label="Show navigation" aria-expanded="false" aria-controls="sidebar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
  </div>
</header>
<div class="layout">
  <nav class="sidebar" id="sidebar" aria-label="Docs">${nav}</nav>
  <main id="content">
    <article class="prose">
${body}
    </article>
    ${pager}
    ${source ? `<p class="source">${source}</p>` : ""}
  </main>
  ${tocHtml}
</div>
<script src="docs.js"></script>
</body>
</html>
`;
}

/** First paragraph's text, for the meta description. */
function describe(html) {
  const p = /<p>([\s\S]*?)<\/p>/.exec(html);
  const text = (p?.[1] ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

export function build(out = path.join(ROOT, "_site")) {
  fs.rmSync(out, { recursive: true, force: true });
  // site/docs/ holds the docs pages' stylesheet and script.
  fs.cpSync(path.join(ROOT, "site"), out, { recursive: true });
  const docsOut = path.join(out, "docs");

  const bySource = new Map(PAGES.filter((p) => p.src).map((p) => [path.join(ROOT, p.src), p]));
  const links = [];
  const assets = new Map();

  const rendered = PAGES.map((page) => {
    const from = page.src ? path.join(ROOT, page.src) : path.join(ROOT, "docs/guide", `${page.slug}.md`);
    const md = page.gen ? page.gen() : includes(read(page.src));
    const resolve = (href) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { url: href };
      const [p, hash] = href.split("#");
      if (!p) {
        links.push({ from: page.slug, slug: page.slug, hash });
        return { url: href };
      }
      const abs = path.resolve(path.dirname(from), decodeURI(p));
      const target = bySource.get(abs) ?? PAGES.find((x) => abs === path.join(ROOT, "docs/guide", `${x.slug}.md`));
      if (target) {
        links.push({ from: page.slug, slug: target.slug, hash });
        return { url: `${target.slug}.html${hash ? `#${hash}` : ""}` };
      }
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      if (rel.startsWith("..") || !fs.existsSync(abs)) throw new Error(`${page.slug}: link to a missing file: ${href}`);
      const kind = fs.statSync(abs).isDirectory() ? "tree" : "blob";
      return { url: `${REPO}/${kind}/main/${rel}${hash ? `#${hash}` : ""}`, abs, rel };
    };
    const r = render(md, {
      link: (href) => resolve(href).url,
      image: (src) => {
        const t = resolve(src);
        if (!t.abs) return t.url;
        const name = path.basename(t.abs);
        assets.set(name, t.abs);
        return `assets/${name}`;
      },
    });
    return { page: { ...page, title: page.title ?? r.title ?? page.slug }, ...r };
  });

  const ids = new Map(rendered.map((r) => [r.page.slug, new Set(r.headings.map((h) => h.id))]));
  const broken = links.filter((l) => !ids.has(l.slug) || (l.hash && !ids.get(l.slug).has(l.hash)));
  if (broken.length)
    throw new Error(
      `broken docs links:\n${broken.map((l) => `  ${l.from} → ${l.slug}.html${l.hash ? `#${l.hash}` : ""}`).join("\n")}`,
    );

  const titles = new Map(rendered.map((r) => [r.page.slug, r.page.title]));
  rendered.forEach((r, n) => {
    const html = layout({
      page: r.page,
      body: r.html,
      headings: r.headings,
      title: r.page.title,
      prev: rendered[n - 1]?.page,
      next: rendered[n + 1]?.page,
      description: describe(r.html) || r.page.blurb,
      titles,
    });
    fs.writeFileSync(path.join(docsOut, `${r.page.slug}.html`), html);
  });

  const index = [
    "<h1>Kestrel docs</h1>",
    '<p class="lede">Build desktop apps in TypeScript and React, run them on the system webview, and ship a ' +
      "small signed app for macOS, Windows and Linux. Kestrel is pre-alpha: the API can still change.</p>",
    ...SECTIONS.map(
      (s) =>
        `<h2 id="${s.title.toLowerCase()}">${s.title}</h2><div class="cards">` +
        s.pages
          .map(
            (p) =>
              `<a class="card" href="${p.slug}.html"><b>${escapeHtml(p.nav ?? titles.get(p.slug))}</b><span>${escapeHtml(p.blurb)}</span></a>`,
          )
          .join("") +
        "</div>",
    ),
  ].join("\n");
  fs.writeFileSync(
    path.join(docsOut, "index.html"),
    layout({
      page: null,
      title: "Overview",
      body: index,
      headings: [],
      next: rendered[0].page,
      description: "Guides and API reference for Kestrel: native desktop apps in TypeScript and React.",
      titles,
    }),
  );

  if (assets.size) {
    fs.mkdirSync(path.join(docsOut, "assets"), { recursive: true });
    for (const [name, abs] of assets) fs.copyFileSync(abs, path.join(docsOut, "assets", name));
  }
  return { out, pages: rendered.length + 1 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv.find((a) => a.startsWith("--out="));
  const { out, pages } = build(arg ? path.resolve(arg.slice(6)) : undefined);
  console.log(`built ${pages} docs pages into ${path.relative(process.cwd(), out) || "."}`);
}
