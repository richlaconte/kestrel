// kestrel.json validation. Mirrors schema/kestrel.schema.json (published for
// editor autocomplete), with messages that name the field and the fix.
const FIELDS = ["$schema", "appId", "title", "width", "height", "frontend", "native", "csp"];

/** Return a list of human-readable problems; empty means valid. */
export function validateManifest(m) {
  if (typeof m !== "object" || m === null || Array.isArray(m))
    return ["kestrel.json must be a JSON object"];
  const errs = [];
  const need = (k, hint) => {
    if (m[k] === undefined) errs.push(`\`${k}\` is required — ${hint}`);
  };
  need("appId", 'e.g. "appId": "my-app"');
  need("title", 'e.g. "title": "My App"');
  need("frontend", 'a directory with index.html (e.g. "."), or { "dev": "vite", "dist": "dist" }');

  if (m.appId !== undefined && (typeof m.appId !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(m.appId)))
    errs.push(`\`appId\` must be lowercase letters, digits, dots and dashes (got ${JSON.stringify(m.appId)})`);
  if (m.title !== undefined && (typeof m.title !== "string" || !m.title))
    errs.push("`title` must be a non-empty string");
  for (const k of ["width", "height"])
    if (m[k] !== undefined && !(typeof m[k] === "number" && m[k] > 0))
      errs.push(`\`${k}\` must be a positive number (got ${JSON.stringify(m[k])})`);

  const f = m.frontend;
  if (f !== undefined) {
    if (typeof f === "object" && f !== null && !Array.isArray(f)) {
      if (f.dev !== "vite") errs.push('`frontend.dev` must be "vite"');
      if (f.dist !== undefined && typeof f.dist !== "string") errs.push("`frontend.dist` must be a string");
      for (const k of Object.keys(f))
        if (k !== "dev" && k !== "dist") errs.push(`\`frontend.${k}\` is not a known field`);
    } else if (typeof f !== "string" || !f) {
      errs.push('`frontend` must be a directory path or { "dev": "vite", "dist": "dist" }');
    }
  }
  if (m.native !== undefined && (typeof m.native !== "string" || !/\.(ts|js)$/.test(m.native)))
    errs.push("`native` must be a path to a .ts or .js file");

  if (m.csp !== undefined && typeof m.csp !== "string")
    errs.push('`csp` must be a Content-Security-Policy string ("" turns it off)');

  for (const k of Object.keys(m))
    if (!FIELDS.includes(k)) errs.push(`\`${k}\` is not a known field`);
  return errs;
}
