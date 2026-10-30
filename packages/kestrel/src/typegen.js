// typegen v1 — TypeScript-compiler-API-based stub generation + native module
// compilation for the host's QuickJS engine. Implements RFC-0001 §5.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

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
const RESERVED = ["KestrelError", "KestrelErrorCode"];

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
        if (!exportedNames.has(name))
          throw new TypegenError(
            `native.ts: \`${fnName}\` uses type \`${name}\`, which is not exported. ` +
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
        `native.ts: \`${name}\` is re-exported from another file. Imports aren't bundled yet (see issue #20); define it in native.ts.`,
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
  return { fns, typeImports: [...typeImports].sort(), skipped };
}

/** Emit native-client.ts with exact types (renames break the frontend at compile time). */
export function emitClient(dir, { fns, typeImports }, nativeRel = "./native") {
  const lines = [
    "// AUTO-GENERATED by `kestrel typegen` — do not edit.",
    "/* eslint-disable */",
    ...(typeImports.length
      ? [`import type { ${typeImports.join(", ")} } from "${nativeRel}";`, ""]
      : []),
    errorTs,
    "const invoke = (name: string, args: unknown): Promise<unknown> =>",
    "  (window as any).__TAURI__.core",
    "    .invoke('call_native', { name, args })",
    "    .catch((e: unknown) => { throw KestrelError.from(e); });",
    "",
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

/** Transpile native.ts to a script QuickJS can eval; exports land on globalThis.native. */
export function compileNative(dir, entry) {
  const out = ts.transpileModule(fs.readFileSync(entry, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const wrapped = [
    "// AUTO-GENERATED by kestrel from native.ts — do not edit.",
    "globalThis.native = globalThis.native || {};",
    "(function () {",
    "  const exports = {};",
    "  const module = { exports };",
    out,
    "  Object.assign(globalThis.native, module.exports);",
    "})();",
    "",
  ].join("\n");
  const outDir = path.join(dir, ".kestrel");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "native.compiled.js");
  fs.writeFileSync(outFile, wrapped);
  return outFile;
}

/** Legacy path for .js native modules (spike style: `native.fn = …`). */
function typegenJs(dir, nativePath) {
  const src = fs.readFileSync(nativePath, "utf8");
  const names = [...src.matchAll(/^\s*native\.([A-Za-z_$][\w$]*)\s*=/gm)].map((x) => x[1]);
  for (const n of names)
    if (RESERVED.includes(n))
      throw new TypegenError(`${path.basename(nativePath)}: \`native.${n}\` is reserved — native-client.js exports its own. Rename it.`);
  const js = [
    "// AUTO-GENERATED by `kestrel typegen` — do not edit.",
    errorJs,
    "const invoke = (name, args) =>",
    "  window.__TAURI__.core",
    "    .invoke('call_native', { name, args })",
    "    .catch((e) => { throw KestrelError.from(e); });",
    ...names.map((n) => `export const ${n} = (args = {}) => invoke('${n}', args);`),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "native-client.js"), js);
  return { names, compiled: nativePath, skipped: [] };
}

/**
 * Main entry. Returns { names, compiled, skipped } where `compiled` is the
 * file the host's QuickJS engine should load and `skipped` lists exported
 * values that aren't functions (and so aren't callable from the webview).
 */
export function runTypegen(dir, manifest) {
  if (!manifest.native) return { names: [], compiled: null, skipped: [] };
  const entry = path.resolve(dir, manifest.native);
  if (!entry.endsWith(".ts")) return typegenJs(dir, entry);

  if (!ts)
    throw new Error(
      "native.ts requires the `typescript` package — run npm install in the kestrel repo",
    );
  const analysis = analyze(entry);
  for (const n of [...analysis.fns.map((f) => f.name), ...analysis.typeImports])
    if (RESERVED.includes(n))
      throw new TypegenError(`native.ts: \`${n}\` is reserved — native-client.ts exports its own. Rename it.`);
  let rel = path.relative(dir, entry).replace(/\\/g, "/").replace(/\.ts$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  emitClient(dir, analysis, rel);
  const compiled = compileNative(dir, entry);
  return { names: analysis.fns.map((f) => f.name), compiled, skipped: analysis.skipped };
}
