import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, SECTIONS } from "./build.mjs";
import { inline, render, slugify } from "./md.mjs";
import { dtsReference, schemaReference } from "./reference.mjs";

test("slugs match GitHub's heading anchors", () => {
  assert.equal(slugify("What `apply` replaces"), "what-apply-replaces");
  assert.equal(slugify("<code>fs.readText()</code>"), "fsreadtext");
  assert.equal(slugify("3. The std-lib: x"), "3-the-std-lib-x");
});

test("inline: code, links, emphasis, escapes", () => {
  assert.equal(inline("a `<b>` c"), "a <code>&lt;b&gt;</code> c");
  assert.equal(inline("``a ` b``"), "<code>a ` b</code>");
  assert.equal(
    inline("[`x`](y.md#z)", { link: (h) => h.replace(".md", ".html") }),
    '<a href="y.html#z"><code>x</code></a>',
  );
  assert.equal(inline("**bold** and *em* and _em_"), "<strong>bold</strong> and <em>em</em> and <em>em</em>");
  assert.equal(inline("snake_case_name stays"), "snake_case_name stays");
  assert.equal(inline("see https://x.dev/a."), 'see <a href="https://x.dev/a">https://x.dev/a</a>.');
  assert.equal(inline("\\*not em\\*"), "*not em*");
  assert.equal(
    inline("![alt](i.png)", { image: (s) => `assets/${s}` }),
    '<img src="assets/i.png" alt="alt" loading="lazy">',
  );
});

test("lists: tight, loose, nested, with code inside", () => {
  assert.equal(render("- a\n  more\n- b\n  - c").html, "<ul><li>a\nmore</li><li>b\n<ul><li>c</li></ul></li></ul>");
  const loose = render("1. one\n\n   ```sh\n   x\n   ```\n2. two").html;
  assert.match(
    loose,
    /^<ol><li><p>one<\/p>\n<pre><code class="language-sh">x<\/code><\/pre><\/li><li><p>two<\/p><\/li><\/ol>$/,
  );
  assert.equal(render("3. c\n4. d").html, '<ol start="3"><li>c</li><li>d</li></ol>');
});

test("tables, fences, quotes and headings", () => {
  const t = render("| a | b |\n|---|--:|\n| `x\\|y` | 2 |").html;
  assert.match(t, /<th>a<\/th><th style="text-align:right">b<\/th>/);
  assert.match(t, /<td><code>x\|y<\/code><\/td>/);
  assert.equal(render("```\n<tag>\n\n  kept\n```").html, "<pre><code>&lt;tag&gt;\n\n  kept</code></pre>");
  assert.equal(
    render("> **Note.** hi\n> there").html,
    "<blockquote><p><strong>Note.</strong> hi\nthere</p></blockquote>",
  );
  const r = render("# Title\n\n## Same\n\n## Same");
  assert.equal(r.title, "Title");
  assert.deepEqual(
    r.headings.map((h) => h.id),
    ["title", "same", "same-1"],
  );
});

test("code is highlighted and escaped", () => {
  const html = render('```ts\nconst x: Foo = f("<a>"); // hi\n```').html;
  assert.match(html, /<span class="k">const<\/span> x: <span class="t">Foo<\/span>/);
  assert.match(html, /<span class="f">f<\/span>\(<span class="s">&quot;&lt;a&gt;&quot;<\/span>\)/);
  assert.match(html, /<span class="c">\/\/ hi<\/span>/);
});

test("a .d.ts becomes a section per module and member, with types last", () => {
  const md = dtsReference(
    "x.d.ts",
    `/** Late. */
export declare function on(e: string): void;
/** Files. */
export declare const fs: {
  /** Reads. */
  readText(path: string): Promise<string>;
};
/** Opts. */
export interface Opts {
  /** A label. */
  label?: string;
}
export declare class Err extends Error {}`,
    { title: "T", intro: "Intro.", module: "m", late: ["on"] },
  );
  const heads = md.match(/^#+ .*$/gm);
  assert.deepEqual(heads, ["# T", "## fs", "### fs.readText()", "## on()", "## Err", "## Types", "### Opts"]);
  assert.match(md, /```ts\nreadText\(path: string\): Promise<string>\n```\n\nReads\./);
  assert.match(md, /\| `label\?` \| `string` \| A label\. \|/);
});

test("the schema reference covers every field", () => {
  const schema = JSON.parse(
    fs.readFileSync(new URL("../../packages/kestrel/schema/kestrel.schema.json", import.meta.url)),
  );
  const md = schemaReference(schema, { title: "kestrel.json", intro: "", example: "{}" });
  for (const k of Object.keys(schema.properties).filter((k) => k !== "$schema"))
    assert.match(md, new RegExp(`^### ${k}$`, "m"));
  assert.match(md, /\| `fs:pick` \| Read and write files and folders the user picks/);
  assert.match(md, /\*\*Type:\*\* string · \*\*Required\*\*/);
});

test("the site builds, with every page and no broken links", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-site-"));
  try {
    const { pages } = build(out);
    const slugs = SECTIONS.flatMap((s) => s.pages.map((p) => p.slug));
    assert.equal(pages, slugs.length + 1);
    assert.ok(fs.existsSync(path.join(out, "index.html")), "the landing page is copied");
    for (const slug of [...slugs, "index"]) {
      const html = fs.readFileSync(path.join(out, "docs", `${slug}.html`), "utf8");
      assert.doesNotMatch(html, /\.html"[^>]*>(<b>)?undefined</, `${slug}: a link without a label`);
    }
    const cli = fs.readFileSync(path.join(out, "docs", "cli.html"), "utf8");
    assert.match(cli, /kestrel updater keygen/, "the CLI page includes the real usage text");
    const updates = fs.readFileSync(path.join(out, "docs", "updates.html"), "utf8");
    assert.doesNotMatch(updates, /href="(?!https:)[^"]*\.md[#"]/, "links between docs point at pages");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
