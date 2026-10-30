// kestrel.json validation. Mirrors schema/kestrel.schema.json (published for
// editor autocomplete), with messages that name the field and the fix.
/** Window fields the host reads (#23). `dev` and `build` copy them into the runtime manifest. */
export const WINDOW_FIELDS = [
  "resizable", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "center", "decorations", "titleBarStyle", "rememberWindow",
];
const FIELDS = ["$schema", "appId", "title", "version", "width", "height", ...WINDOW_FIELDS, "frontend", "native", "csp", "permissions"];
const TITLE_BAR_STYLES = ["visible", "transparent", "overlay"];

/** Permissions the host understands (RFC-0001 §6). Keep in sync with host/src/scope.rs. */
export const PERMISSIONS = ["fs:app-data", "fs:pick", "fs:all", "notifications", "clipboard", "shell:open"];

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
  if (m.version !== undefined && (typeof m.version !== "string" || !m.version))
    errs.push('`version` must be a non-empty string, e.g. "1.0.0"');
  for (const k of ["width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight"])
    if (m[k] !== undefined && !(typeof m[k] === "number" && m[k] > 0))
      errs.push(`\`${k}\` must be a positive number (got ${JSON.stringify(m[k])})`);
  for (const [lo, hi] of [["minWidth", "maxWidth"], ["minHeight", "maxHeight"], ["minWidth", "width"], ["width", "maxWidth"], ["minHeight", "height"], ["height", "maxHeight"]])
    if (typeof m[lo] === "number" && typeof m[hi] === "number" && m[lo] > m[hi])
      errs.push(`\`${lo}\` (${m[lo]}) is larger than \`${hi}\` (${m[hi]})`);
  for (const k of ["resizable", "center", "decorations", "rememberWindow"])
    if (m[k] !== undefined && typeof m[k] !== "boolean")
      errs.push(`\`${k}\` must be true or false (got ${JSON.stringify(m[k])})`);
  if (m.titleBarStyle !== undefined && !TITLE_BAR_STYLES.includes(m.titleBarStyle))
    errs.push(`\`titleBarStyle\` must be one of ${TITLE_BAR_STYLES.map((s) => JSON.stringify(s)).join(", ")} (got ${JSON.stringify(m.titleBarStyle)})`);

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

  const p = m.permissions;
  if (p !== undefined) {
    if (!Array.isArray(p)) errs.push('`permissions` must be an array, e.g. ["fs:app-data"]');
    else
      p.forEach((x, i) => {
        if (!PERMISSIONS.includes(x))
          errs.push(`\`permissions\` has unknown ${JSON.stringify(x)} (available: ${PERMISSIONS.join(", ")})`);
        else if (p.indexOf(x) !== i) errs.push(`\`permissions\` lists ${JSON.stringify(x)} twice`);
      });
  }

  for (const k of Object.keys(m))
    if (!FIELDS.includes(k)) errs.push(`\`${k}\` is not a known field`);
  return errs;
}
