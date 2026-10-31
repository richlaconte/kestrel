// typegen v1 — TypeScript-compiler-API-based stub generation + native module
// bundling (esbuild) for the host's QuickJS engine. Implements RFC-0001 §5.
import fs from "node:fs";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
let ts;
try {
  ts = require("typescript");
} catch {
  ts = null; // vanilla .js apps don't need it
}

/** Thrown for problems in the user's native.ts that they must fix. */
export class TypegenError extends Error {}

/** KestrelError codes (RFC-0001 §7). Keep in sync with host/src/error.rs. */
export const ERROR_CODES = [
  "permission_denied",
  "not_found",
  "io",
  "native_function",
  "cancelled",
  "unsupported_platform",
  "timeout",
];

// The KestrelError every generated client exports and rejects with. Each app
// gets its own copy (the vanilla client can't import a package), so
// `instanceof` is duck-typed: errors from any copy, including kestrel-native's,
// pass it. Same body for the TS and JS clients; `T(…)` strips the types.
const errorClass = (T) => `
/** Every rejection from a native call (RFC-0001 §7). Check \`err.code\`. */
export class KestrelError extends Error {
${T("  readonly code: KestrelErrorCode;\n  readonly detail?: unknown;\n")}  constructor(code${T(": KestrelErrorCode")}, message${T(": string")}, detail${T("?: unknown")}) {
    super(message);
    this.name = "KestrelError";
    this.code = code;
    this.detail = detail;
  }
  static [Symbol.hasInstance](v${T(": unknown")})${T(": boolean")} {
    return v instanceof Error && v.name === "KestrelError" && typeof (v${T(" as any")}).code === "string";
  }
  /** The host rejects with { code, message, detail? }; anything else is wrapped. */
  static from(e${T(": any")})${T(": KestrelError")} {
    return e && typeof e === "object" && typeof e.code === "string" && typeof e.message === "string"
      ? new KestrelError(e.code, e.message, e.detail)
      : new KestrelError("native_function", String(e));
  }
}
`;
const errorTs = [
  `export type KestrelErrorCode =\n${ERROR_CODES.map((c) => `  | "${c}"`).join("\n")};`,
  errorClass((t) => t),
].join("\n");
const errorJs = errorClass(() => "");
const RESERVED = ["KestrelError", "KestrelErrorCode", "on"];

// \`on\` subscribes to events native code sends with \`emit\` (#22). The host
// carries them all on one Tauri event as { event, payload }. \`T(…)\` strips
// the types for the JS client.
const onFn = (T, typed) => `
/** Subscribe to an event native.ts sends with \`emit\`. Returns a function that unsubscribes. */
export function on${typed ? "<K extends keyof Events & string>" : ""}(event${T(typed ? ": K" : ": string")}, cb${T(typed ? ": (payload: Events[K]) => void" : ": (payload: unknown) => void")})${T(": () => void")} {
  const off = (window${T(" as any")}).__TAURI__.event.listen("kestrel:native", (e${T(": any")}) => {
    if (e.payload.event === event) cb(e.payload.payload);
  });
  return () => {
    off.then((f${T(": () => void")}) => f());
  };
}
`;

/** The first function-like node behind an exported symbol, if it is one. */
function functionDeclOf(checker, sym) {
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  for (const d of sym.declarations ?? []) {
    if (ts.isFunctionDeclaration(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer) {
      let init = d.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))
        init = init.expression;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
  }
  return null;
}

/**
 * Collect named types a type node references that must be imported into the
 * client. Built-in/global types (Array, Promise, Record, Date…) don't need it.
 * Non-exported local types are an error: the client couldn't name them.
 */
function collectTypeRefs(node, checker, entrySource, exportedNames, out, fnName) {
  const visit = (n) => {
    if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
      const nameNode = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
      const root = ts.isQualifiedName(nameNode) ? leftmost(nameNode) : nameNode;
      const sym = checker.getSymbolAtLocation(root);
      const decl = sym?.declarations?.[0];
      if (decl && decl.getSourceFile() === entrySource && !ts.isTypeParameterDeclaration(decl)) {
        const name = root.text;
        const imported = ts.isImportSpecifier(decl) || ts.isImportClause(decl) || ts.isNamespaceImport(decl);
        if (!exportedNames.has(name))
          throw new TypegenError(
            imported
              ? `native.ts: \`${fnName}\` uses type \`${name}\`, which native.ts imports. ` +
                  `Re-export it (\`export type { ${name} } from "…"\`) so native-client.ts can import it.`
              : `native.ts: \`${fnName}\` uses type \`${name}\`, which is not exported. ` +
                  `Add \`export\` to its declaration so native-client.ts can import it.`,
          );
        out.add(name);
      }
    }
    if (ts.isTypeQueryNode(n))
      throw new TypegenError(
        `native.ts: \`${fnName}\` uses a \`typeof\` type, which the client can't import. Use a named type instead.`,
      );
    ts.forEachChild(n, visit);
  };
  visit(node);
}

function leftmost(q) {
  while (ts.isQualifiedName(q)) q = q.left;
  return q;
}

function unwrapPromise(text) {
  const m = /^Promise<([\s\S]*)>$/.exec(text.trim());
  return m ? m[1].trim() : text;
}

/** Extract { name, argsType, returnType, hasArgs } for each exported function. */
export function analyze(entry) {
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  });
  const source = program.getSourceFile(entry);
  // Syntax errors stop here, with native.ts positions, instead of surfacing
  // later as a load error against the compiled file.
  const syntax = program.getSyntacticDiagnostics(source);
  if (syntax.length) {
    const lines = syntax.map((d) => {
      const { line, character } = source.getLineAndCharacterOfPosition(d.start ?? 0);
      const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
      return `${path.basename(entry)}:${line + 1}:${character + 1}: ${msg}`;
    });
    throw new TypegenError(`syntax error in native module:\n  ${lines.join("\n  ")}`);
  }
  const checker = program.getTypeChecker();
  const moduleSym = checker.getSymbolAtLocation(source);
  const exports = moduleSym ? checker.getExportsOfModule(moduleSym) : [];
  const exportedNames = new Set(exports.map((s) => s.name));
  const typeImports = new Set();
  const fns = [];
  const skipped = [];
  // An exported \`Events\` type map types \`on\` in the client.
  const events = exports.some((s) => {
    const r = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return s.name === "Events" && Boolean(r.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias));
  });
  if (events) typeImports.add("Events");

  for (const sym of exports) {
    const resolved = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
    if (!(resolved.flags & ts.SymbolFlags.Value)) continue; // type-only export
    const decl = functionDeclOf(checker, sym);
    if (!decl) {
      skipped.push(sym.name);
      continue;
    }
    const name = sym.name;
    const declSource = decl.getSourceFile();
    if (declSource !== source)
      throw new TypegenError(
        `native.ts: \`${name}\` is re-exported from another file. Define the exported function in native.ts ` +
          `(it can call anything it imports), so its types reach native-client.ts.`,
      );

    const param = decl.parameters[0];
    let argsType = null;
    if (param?.type) {
      collectTypeRefs(param.type, checker, source, exportedNames, typeImports, name);
      argsType = param.type.getText(source);
    }

    let returnType;
    if (decl.type) {
      collectTypeRefs(decl.type, checker, source, exportedNames, typeImports, name);
      returnType = unwrapPromise(decl.type.getText(source));
    } else {
      // Inferred: print structurally so no unexported names leak into the client.
      const sig = checker.getSignatureFromDeclaration(decl);
      let t = checker.getReturnTypeOfSignature(sig);
      const awaited = checker.getAwaitedType?.(t);
      if (awaited) t = awaited;
      const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias;
      returnType = checker.typeToString(t, decl, flags);
      // The printer uses local type names where it can; resolve each one so
      // exported types get imported and unexported ones fail clearly.
      const typeNode = checker.typeToTypeNode(t, decl, ts.NodeBuilderFlags.NoTruncation);
      const refs = [];
      const walk = (n) => {
        if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) refs.push(n.typeName.text);
        ts.forEachChild(n, walk);
      };
      if (typeNode) walk(typeNode);
      for (const ref of refs) {
        const s = checker.resolveName(ref, decl, ts.SymbolFlags.Type, false);
        if (s?.declarations?.[0]?.getSourceFile() !== source) continue;
        if (!exportedNames.has(ref))
          throw new TypegenError(
            `native.ts: \`${name}\` returns type \`${ref}\`, which is not exported. ` +
              `Export it or annotate the return type.`,
          );
        typeImports.add(ref);
      }
      if (/\bimport\(/.test(returnType))
        throw new TypegenError(
          `native.ts: \`${name}\` has an inferred return type that references another module. Annotate its return type.`,
        );
    }
    fns.push({ name, argsType, returnType, hasArgs: Boolean(param) });
  }
  return { fns, typeImports: [...typeImports].sort(), skipped, events };
}

/** Emit native-client.ts with exact types (renames break the frontend at compile time). */
export function emitClient(dir, { fns, typeImports, events }, nativeRel = "./native") {
  const lines = [
    "// AUTO-GENERATED by `kestrel typegen` — do not edit.",
    "/* eslint-disable */",
    ...(typeImports.length ? [`import type { ${typeImports.join(", ")} } from "${nativeRel}";`, ""] : []),
    errorTs,
    "const invoke = (name: string, args: unknown): Promise<unknown> =>",
    "  (window as any).__TAURI__.core",
    "    .invoke('call_native', { name, args })",
    "    .catch((e: unknown) => { throw KestrelError.from(e); });",
    onFn((t) => t, events),
    ...fns.map((f) =>
      f.hasArgs
        ? `export function ${f.name}(args: ${f.argsType ?? "Record<string, unknown>"}): Promise<${f.returnType}> {\n  return invoke('${f.name}', args) as Promise<${f.returnType}>;\n}`
        : `export function ${f.name}(): Promise<${f.returnType}> {\n  return invoke('${f.name}', {}) as Promise<${f.returnType}>;\n}`,
    ),
    "",
  ];
  const file = path.join(dir, "native-client.ts");
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

// Node built-ins don't exist in QuickJS; an import of one gets a pointed error.
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const HOST_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "native", "host.js");

/** esbuild messages as `file:line:col: text`, relative to the app dir. */
function formatBuildErrors(errors) {
  return errors.map((m) => {
    const at = m.location ? `${m.location.file}:${m.location.line}:${m.location.column + 1}: ` : "";
    const spec = /^Could not resolve "([^"]+)"/.exec(m.text)?.[1];
    if (spec && NODE_BUILTINS.has(spec))
      return (
        `${at}"${spec}" is a Node.js module. Native code runs in the host's QuickJS engine, ` +
        `not Node: use kestreljs/native/host for files, and only pure-JS packages.`
      );
    return at + m.text;
  });
}

/**
 * Bundle native.ts and everything it imports into one script QuickJS can
 * eval; exports land on globalThis.native. Returns the compiled file and the
 * app source files that went into it (what `dev` watches).
 */
export function compileNative(dir, entry) {
  const outDir = path.join(dir, ".kestrel");
  const outFile = path.join(outDir, "native.compiled.js");
  let result;
  try {
    result = esbuild.buildSync({
      entryPoints: [entry],
      absWorkingDir: dir,
      outfile: outFile,
      bundle: true,
      write: false,
      metafile: true,
      platform: "neutral",
      // neutral resolves no package.json fields by default; most npm
      // packages still need these.
      mainFields: ["module", "main"],
      format: "iife",
      globalName: "__kestrel_native",
      target: "es2020",
      sourcemap: "external",
      alias: { "kestreljs/native/host": HOST_MODULE },
      banner: { js: "// AUTO-GENERATED by kestrel from native.ts — do not edit." },
      footer: { js: "globalThis.native = Object.assign(globalThis.native || {}, __kestrel_native);" },
      logLevel: "silent",
    });
  } catch (e) {
    if (!e.errors) throw e;
    throw new TypegenError(`cannot bundle the native module:\n  ${formatBuildErrors(e.errors).join("\n  ")}`);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // Write-then-rename: a host reloading in dev never reads half a file.
  for (const f of result.outputFiles) {
    fs.writeFileSync(f.path + ".tmp", f.contents);
    fs.renameSync(f.path + ".tmp", f.path);
  }
  const inputs = Object.keys(result.metafile.inputs)
    .map((f) => path.resolve(dir, f))
    .filter((f) => f !== HOST_MODULE && !f.split(path.sep).includes("node_modules"));
  return { file: outFile, inputs };
}

/** Legacy path for .js native modules (spike style: `native.fn = …`). */
function typegenJs(dir, nativePath) {
  const src = fs.readFileSync(nativePath, "utf8");
  const names = [...src.matchAll(/^\s*native\.([A-Za-z_$][\w$]*)\s*=/gm)].map((x) => x[1]);
  for (const n of names)
    if (RESERVED.includes(n))
      throw new TypegenError(
        `${path.basename(nativePath)}: \`native.${n}\` is reserved — native-client.js exports its own. Rename it.`,
      );
  const js = [
    "// AUTO-GENERATED by `kestrel typegen` — do not edit.",
    errorJs,
    "const invoke = (name, args) =>",
    "  window.__TAURI__.core",
    "    .invoke('call_native', { name, args })",
    "    .catch((e) => { throw KestrelError.from(e); });",
    onFn(() => "", false),
    ...names.map((n) => `export const ${n} = (args = {}) => invoke('${n}', args);`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "native-client.js"), js);
  return { names, compiled: nativePath, inputs: [nativePath], skipped: [] };
}

/**
 * Main entry. Returns { names, compiled, inputs, skipped } where `compiled`
 * is the file the host's QuickJS engine should load, `inputs` the app files
 * it was built from, and `skipped` lists exported values that aren't
 * functions (and so aren't callable from the webview).
 */
export function runTypegen(dir, manifest) {
  if (!manifest.native) return { names: [], compiled: null, inputs: [], skipped: [] };
  const entry = path.resolve(dir, manifest.native);
  if (!entry.endsWith(".ts")) return typegenJs(dir, entry);

  if (!ts) throw new Error("native.ts requires the `typescript` package — run npm install in the kestrel repo");
  const analysis = analyze(entry);
  for (const n of [...analysis.fns.map((f) => f.name), ...analysis.typeImports])
    if (RESERVED.includes(n))
      throw new TypegenError(`native.ts: \`${n}\` is reserved — native-client.ts exports its own. Rename it.`);
  let rel = path.relative(dir, entry).replace(/\\/g, "/").replace(/\.ts$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  // Bundle first: a build that fails leaves the previous client in place.
  const { file, inputs } = compileNative(dir, entry);
  emitClient(dir, analysis, rel);
  return { names: analysis.fns.map((f) => f.name), compiled: file, inputs, skipped: analysis.skipped };
}
