// Reference pages generated from the source of truth, so they can't drift:
// the std-lib from kestrel-native's .d.ts, the native.ts host API from
// kestreljs/native/host's, and kestrel.json from its JSON Schema.
import ts from "typescript";

/** A node's own /** doc comment, as Markdown. */
function docOf(node, text) {
  const ranges = ts.getLeadingCommentRanges(text, node.pos) ?? [];
  const doc = ranges.filter((r) => text.startsWith("/**", r.pos)).at(-1);
  if (!doc) return "";
  return text
    .slice(doc.pos + 3, doc.end - 2)
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd())
    .join("\n")
    .trim();
}

/**
 * Declaration text without `export declare` or its own doc comment, and
 * with the indentation it had in its file removed.
 */
function declText(node, sf) {
  const lines = node
    .getText(sf)
    .replace(/^export\s+(declare\s+)?/, "")
    .replace(/;$/, "")
    .split("\n");
  const rest = lines.slice(1).filter((l) => l.trim());
  // Later lines keep their indent relative to the least-indented one (the closing brace).
  const indent = Math.min(...rest.map((l) => /^ */.exec(l)[0].length), Infinity);
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Number.isFinite(indent) ? indent : 0))].join("\n");
}

const code = (s) => "```ts\n" + s + "\n```";
const cell = (s) => s.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");

function memberName(m, sf) {
  return m.name ? m.name.getText(sf) : "";
}

function interfaceTable(members, sf, text) {
  const rows = members
    .filter((m) => ts.isPropertySignature(m) || ts.isMethodSignature(m))
    .map((m) => {
      const name = memberName(m, sf) + (m.questionToken ? "?" : "");
      const type = ts.isPropertySignature(m) ? (m.type?.getText(sf) ?? "unknown") : declText(m, sf);
      return `| \`${name}\` | \`${cell(type)}\` | ${cell(docOf(m, text))} |`;
    });
  return ["| Property | Type | Description |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Markdown for a .d.ts: each exported const object becomes a section with
 * one entry per member, each function a section, and interfaces and type
 * aliases go under "Types". Classes and the functions named in `late` come
 * after the rest.
 */
export function dtsReference(file, text, { title, intro, module: mod, late = [] }) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const api = [];
  const after = [];
  const types = [];
  for (const st of sf.statements) {
    const doc = docOf(st, text);
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        const name = decl.name.getText(sf);
        const parts = [`## ${name}`, doc];
        if (decl.type && ts.isTypeLiteralNode(decl.type)) {
          for (const m of decl.type.members) {
            const member = memberName(m, sf);
            const call = ts.isMethodSignature(m) ? "()" : "";
            parts.push(`### ${name}.${member}${call}`, code(declText(m, sf)), docOf(m, text));
          }
        } else parts.push(code(`const ${declText(decl, sf)}`));
        api.push(parts);
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      (late.includes(st.name.text) ? after : api).push([`## ${st.name.text}()`, code(declText(st, sf)), doc]);
    } else if (ts.isClassDeclaration(st) && st.name) {
      after.push([`## ${st.name.text}`, doc, code(declText(st, sf))]);
    } else if (ts.isInterfaceDeclaration(st)) {
      types.push([`### ${st.name.text}`, doc, interfaceTable(st.members, sf, text)]);
    } else if (ts.isTypeAliasDeclaration(st)) {
      types.push([`### ${st.name.text}`, doc, code(declText(st, sf))]);
    }
  }
  const sections = [
    `# ${title}`,
    intro,
    "```ts\nimport { … } from " + JSON.stringify(mod) + ";\n```",
    ...api.flat(),
    ...after.flat(),
  ];
  if (types.length) sections.push("## Types", ...types.flat());
  return sections.filter(Boolean).join("\n\n") + "\n";
}

// ---------- JSON Schema ----------

function typeOf(s) {
  if ("const" in s) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (s.oneOf) return s.oneOf.map(typeOf).join(" or ");
  if (s.type === "array") return s.items?.oneOf?.every((o) => "const" in o) ? "string[]" : `${typeOf(s.items)}[]`;
  return s.type ?? "any";
}

function constraints(s) {
  const out = [];
  if (s.pattern) out.push(`matches \`${s.pattern}\``);
  if (s.minLength) out.push(`at least ${s.minLength} character${s.minLength === 1 ? "" : "s"}`);
  if (s.exclusiveMinimum === 0) out.push("greater than 0");
  if (s.format === "uri") out.push("a URL");
  if (s.uniqueItems) out.push("no duplicates");
  return out;
}

function field(name, s, required) {
  const meta = [`**Type:** ${typeOf(s)}`];
  if (required) meta.push("**Required**");
  if ("default" in s) meta.push(`**Default:** \`${JSON.stringify(s.default)}\``);
  const extra = constraints(s);
  if (extra.length) meta.push(extra.join(", "));
  const parts = [`### ${name}`, meta.join(" · "), s.description ?? ""];

  const choices = s.items?.oneOf ?? (s.oneOf?.every((o) => "const" in o) ? s.oneOf : null);
  if (choices) {
    parts.push(
      [
        "| Value | Grants |",
        "|---|---|",
        ...choices.map((o) => `| \`${o.const}\` | ${cell(o.description ?? "")} |`),
      ].join("\n"),
    );
  } else if (s.oneOf) {
    parts.push(
      s.oneOf
        .map((o, n) => {
          const head = `${n + 1}. ${o.type === "object" ? "An object" : `A ${typeOf(o)}`}${o.description ? `: ${o.description}` : ""}`;
          return o.properties ? `${head}\n\n${table(o, "   ")}` : head;
        })
        .join("\n\n"),
    );
  } else if (s.properties) parts.push(table(s));
  return parts.filter(Boolean).join("\n\n");
}

function table(s, indent = "") {
  const req = new Set(s.required ?? []);
  const rows = Object.entries(s.properties).map(([k, p]) => {
    const notes = [req.has(k) ? "**Required.**" : "", p.description ?? ""];
    if ("default" in p) notes.push(`Default \`${JSON.stringify(p.default)}\`.`);
    return `| \`${k}\` | ${typeOf(p)} | ${cell(notes.filter(Boolean).join(" "))} |`;
  });
  return ["| Field | Type | Description |", "|---|---|---|", ...rows].map((l) => indent + l).join("\n");
}

/** Markdown for kestrel.json, from its JSON Schema. */
export function schemaReference(schema, { title, intro, example }) {
  const req = new Set(schema.required ?? []);
  const props = Object.entries(schema.properties).filter(([k]) => k !== "$schema");
  const overview = [
    "| Field | Type | |",
    "|---|---|---|",
    ...props.map(([k, s]) => `| [\`${k}\`](#${k.toLowerCase()}) | ${typeOf(s)} | ${req.has(k) ? "required" : ""} |`),
  ].join("\n");
  return (
    [
      `# ${title}`,
      intro,
      "```json\n" + example + "\n```",
      "## Fields",
      overview,
      ...props.map(([k, s]) => field(k, s, req.has(k))),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
