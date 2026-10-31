// A small Markdown renderer for the docs site: the GitHub-flavored subset the
// docs use (headings, paragraphs, nested lists, fenced code, tables, quotes,
// links, images, emphasis), with no dependencies. Links and images go through
// callbacks so the site can point repo-relative paths at its own pages.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

// ---------- inline ----------

function codeSpan(src, i) {
  let n = 0;
  while (src[i + n] === "`") n++;
  const fence = "`".repeat(n);
  let j = i + n;
  for (;;) {
    j = src.indexOf(fence, j);
    if (j < 0) return null;
    if (src[j + n] !== "`" && src[j - 1] !== "`") break;
    j += n;
  }
  let code = src.slice(i + n, j).replace(/\n/g, " ");
  if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
  return { html: `<code>${escapeHtml(code)}</code>`, end: j + n };
}

/** `[text](url)` starting at i (the "["): skips code spans and nested brackets. */
function bracketLink(src, i) {
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") j++;
    else if (c === "`") {
      const span = codeSpan(src, j);
      if (span) j = span.end - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (src[j] !== "]" || src[j + 1] !== "(") return null;
  const close = src.indexOf(")", j + 2);
  if (close < 0) return null;
  const target = src.slice(j + 2, close).trim();
  const m = /^<?([^\s>]*)>?(?:\s+"([^"]*)")?$/.exec(target);
  if (!m) return null;
  return { text: src.slice(i + 1, j), href: m[1], title: m[2], end: close + 1 };
}

const PUNCT = /[\\`*_[\]()#+\-.!|<>~{}]/;

export function inline(src, opt = {}) {
  const link = opt.link ?? ((h) => h);
  const image = opt.image ?? ((h) => h);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);
    if (c === "\\" && PUNCT.test(src[i + 1] ?? "")) {
      out += escapeHtml(src[i + 1]);
      i += 2;
      continue;
    }
    if (c === "`") {
      const span = codeSpan(src, i);
      if (span) {
        out += span.html;
        i = span.end;
        continue;
      }
      const run = /^`+/.exec(rest)[0];
      out += run;
      i += run.length;
      continue;
    }
    if (c === "!" && src[i + 1] === "[") {
      const l = bracketLink(src, i + 1);
      if (l) {
        out += `<img src="${escapeHtml(image(l.href))}" alt="${escapeHtml(l.text)}" loading="lazy">`;
        i = l.end;
        continue;
      }
    }
    if (c === "[") {
      const l = bracketLink(src, i);
      if (l) {
        const title = l.title ? ` title="${escapeHtml(l.title)}"` : "";
        out += `<a href="${escapeHtml(link(l.href))}"${title}>${inline(l.text, opt)}</a>`;
        i = l.end;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/.exec(rest);
      if (m) {
        out += `<a href="${escapeHtml(m[1])}">${escapeHtml(m[1].replace(/^mailto:/, ""))}</a>`;
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !/[\w/]/.test(src[i - 1] ?? "")) {
      const m = /^https?:\/\/[^\s<]*[^\s<).,:;!?'"*_]/.exec(rest);
      if (m) {
        out += `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_") {
      const prev = src[i - 1] ?? " ";
      const flanked = c === "*" || !/[\p{L}\p{N}]/u.test(prev);
      const d = c === "*" ? "\\*" : "_";
      const strong = flanked && new RegExp(`^${d}${d}(?=\\S)([\\s\\S]*?\\S)${d}${d}`).exec(rest);
      if (strong) {
        out += `<strong>${inline(strong[1], opt)}</strong>`;
        i += strong[0].length;
        continue;
      }
      const em =
        flanked &&
        new RegExp(
          `^${d}(?=[^\\s${d}])([\\s\\S]*?[^\\s${d}])${d}(?!${d})${c === "_" ? "(?![\\p{L}\\p{N}])" : ""}`,
          "u",
        ).exec(rest);
      if (em) {
        out += `<em>${inline(em[1], opt)}</em>`;
        i += em[0].length;
        continue;
      }
    }
    if (c === "~" && src[i + 1] === "~") {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
      if (m) {
        out += `<del>${inline(m[1], opt)}</del>`;
        i += m[0].length;
        continue;
      }
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------- code highlighting ----------

const JS_KEYWORDS = new Set(
  (
    "as async await break case catch class const continue declare default delete do else enum export extends " +
    "false finally for from function if implements import in instanceof interface let new null of readonly " +
    "return static super switch this throw true try type typeof undefined var void while yield keyof"
  ).split(" "),
);

const span = (cls, s) => `<span class="${cls}">${escapeHtml(s)}</span>`;

function highlightJs(code) {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|([A-Za-z_$][\w$]*)(\s*\()?|(\d[\d_.]*)/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += escapeHtml(code.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += span("c", m[1]);
    else if (m[2]) out += span("s", m[2]);
    else if (m[3]) {
      const word = m[3];
      if (JS_KEYWORDS.has(word)) out += span("k", word);
      else if (m[4]) out += span("f", word);
      else if (/^[A-Z]/.test(word)) out += span("t", word);
      else out += escapeHtml(word);
      if (m[4]) out += escapeHtml(m[4]);
    } else out += span("k", m[5]);
  }
  return out + escapeHtml(code.slice(last));
}

function highlightJson(code) {
  const re = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d[\d.eE+-]*)/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += escapeHtml(code.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += span("c", m[1]);
    else if (m[2]) out += m[3] ? span("t", m[2]) + escapeHtml(m[3]) : span("s", m[2]);
    else out += span("k", m[4] ?? m[5]);
  }
  return out + escapeHtml(code.slice(last));
}

function highlightSh(code) {
  const re = /((?:^|(?<=\s))#[^\n]*)|("(?:[^"\\\n]|\\.)*"|'[^'\n]*')|(^|(?<=\s))([A-Z_][A-Z0-9_]*)(?==)/gm;
  let out = "";
  let last = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    out += escapeHtml(code.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) out += span("c", m[1]);
    else if (m[2]) out += span("s", m[2]);
    else out += escapeHtml(m[3] ?? "") + span("t", m[4]);
  }
  return out + escapeHtml(code.slice(last));
}

export function highlight(code, lang) {
  if (/^(ts|tsx|js|jsx|javascript|typescript|mjs)$/.test(lang)) return highlightJs(code);
  if (/^(json|jsonc)$/.test(lang)) return highlightJson(code);
  if (/^(sh|bash|shell|console|zsh)$/.test(lang)) return highlightSh(code);
  return escapeHtml(code);
}

// ---------- blocks ----------

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([\w+-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const HTML_BLOCK = /^ {0,3}<\/?(div|details|summary|aside|section|table|p|figure|img|br|hr)\b/i;

const indentOf = (line) => /^ */.exec(line)[0].length;
const blank = (line) => /^\s*$/.test(line);

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "`") {
      const run = /^`+/.exec(s.slice(i))[0];
      const end = s.indexOf(run, i + run.length);
      const stop = end < 0 ? i + run.length : end + run.length;
      cur += s.slice(i, stop).replaceAll("\\|", "|");
      i = stop - 1;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

/** Does this line start a block that interrupts a paragraph? */
function interrupts(line) {
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || HTML_BLOCK.test(line)) return true;
  const item = ITEM.exec(line);
  return Boolean(item && item[4] !== "" && (!/\d/.test(item[2]) || /^1[.)]$/.test(item[2])));
}

function renderBlocks(lines, opt, ctx, tight = false) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, ind, marks, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marks[0]}{${marks.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${ind.length}}`), ""));
        i++;
      }
      i++;
      const code = body.join("\n");
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${highlight(code, lang)}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const html = inline(heading[2], opt);
      const base = slugify(html) || "section";
      let id = base;
      for (let n = 1; ctx.ids.has(id); n++) id = `${base}-${n}`;
      ctx.ids.add(id);
      ctx.headings.push({ level, html, text: html.replace(/<[^>]+>/g, ""), id });
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
      );
      const cell = (tag, text, n) =>
        `<${tag}${align[n] ? ` style="text-align:${align[n]}"` : ""}>${inline(text, opt)}</${tag}>`;
      i += 2;
      const rows = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes("|")) {
        const cells = splitRow(lines[i]);
        rows.push(`<tr>${head.map((_, n) => cell("td", cells[n] ?? "", n)).join("")}</tr>`);
        i++;
      }
      out.push(
        `<div class="table"><table><thead><tr>${head.map((h, n) => cell("th", h, n)).join("")}</tr></thead>` +
          `<tbody>${rows.join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i])) {
        body.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(body, opt, ctx)}</blockquote>`);
      continue;
    }

    if (HTML_BLOCK.test(line)) {
      const body = [];
      while (i < lines.length && !blank(lines[i])) body.push(lines[i++]);
      out.push(body.join("\n"));
      continue;
    }

    const first = ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const delim = first[2].slice(-1);
      const start = ordered ? Number.parseInt(first[2], 10) : 1;
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || /\d/.test(m[2]) !== ordered || m[2].slice(-1) !== delim) break;
        const spaces = m[3].length > 4 || m[4] === "" ? 1 : m[3].length;
        const content = m[1].length + m[2].length + spaces;
        const body = [m[4]];
        i++;
        let pendingBlank = 0;
        while (i < lines.length) {
          const l = lines[i];
          if (blank(l)) {
            pendingBlank++;
            i++;
            continue;
          }
          if (indentOf(l) >= content) {
            for (; pendingBlank; pendingBlank--) body.push("");
            body.push(l.slice(content));
            i++;
            continue;
          }
          // A lazy continuation: more of the item's paragraph, not indented.
          if (!pendingBlank && !interrupts(l) && !ITEM.exec(l) && !blank(body.at(-1))) {
            body.push(l.trim());
            i++;
            continue;
          }
          break;
        }
        // A blank line between items, or between blocks inside one, makes the list loose.
        let inFence = false;
        for (const l of body) {
          if (FENCE.test(l)) inFence = !inFence;
          else if (!inFence && blank(l)) loose = true;
        }
        items.push(body);
        if (pendingBlank) {
          const next = ITEM.exec(lines[i] ?? "");
          if (next && /\d/.test(next[2]) === ordered && next[2].slice(-1) === delim && indentOf(lines[i]) < content)
            loose = true;
          else break;
        }
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      const lis = items.map((body) => `<li>${renderBlocks(body, opt, ctx, !loose)}</li>`).join("");
      out.push(`<${tag}${startAttr}>${lis}</${tag}>`);
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines[i])) {
      if (lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) break;
      para.push(lines[i].trim());
      i++;
    }
    const html = inline(para.join("\n"), opt);
    out.push(tight ? html : `<p>${html}</p>`);
  }
  return out.join("\n");
}

/**
 * Render Markdown to HTML. Returns the HTML, the headings (with their ids)
 * and the first h1's text as the title.
 */
export function render(md, opt = {}) {
  const ctx = { ids: new Set(), headings: [] };
  const lines = md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const html = renderBlocks(lines, opt, ctx);
  const h1 = ctx.headings.find((h) => h.level === 1);
  return { html, headings: ctx.headings, title: h1?.text ?? null };
}
