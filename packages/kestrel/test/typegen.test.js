import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { runTypegen, TypegenError } from "../src/typegen.js";

const ts = createRequire(import.meta.url)("typescript");

/** Write native.ts into a temp app dir, run typegen, return the client source. */
function gen(src) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-typegen-"));
  fs.writeFileSync(path.join(dir, "native.ts"), src);
  const res = runTypegen(dir, { native: "native.ts" });
  const client = fs.readFileSync(path.join(dir, "native-client.ts"), "utf8");
  return { dir, res, client };
}

/** Type-check native.ts + native-client.ts together, as the template's tsconfig does. */
function typecheck(dir) {
  const files = ["native.ts", "native-client.ts"].map((f) => path.join(dir, f));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2020,
    lib: ["lib.es2020.d.ts", "lib.dom.d.ts"],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

function assertCompiles(dir) {
  assert.deepEqual(typecheck(dir), []);
}

test("primitive params and returns", () => {
  const { dir, client, res } = gen(`
    export function greet(args: { name: string }): string { return args.name; }
    export function count(): number { return 1; }
  `);
  assert.deepEqual(res.names, ["greet", "count"]);
  assert.match(client, /greet\(args: \{ name: string \}\): Promise<string>/);
  assert.match(client, /count\(\): Promise<number>/);
  assert.doesNotMatch(client, /import type/);
  assertCompiles(dir);
});

test("named interface and type alias are imported (#3)", () => {
  const { dir, client } = gen(`
    export interface NoteArgs { text: string }
    export type Saved = { ok: boolean; at: number };
    export async function save(args: NoteArgs): Promise<Saved> { return { ok: true, at: 0 }; }
  `);
  assert.match(client, /import type \{ NoteArgs, Saved \} from "\.\/native";/);
  assert.match(client, /save\(args: NoteArgs\): Promise<Saved>/);
  assertCompiles(dir);
});

test("generics and unions of named types", () => {
  const { dir, client } = gen(`
    export interface Note { id: string }
    export type Filter = "all" | "done";
    export function list(args: { filter: Filter }): Array<Note> { return []; }
    export function find(args: { id: string }): Note | null { return null; }
    export function many(): Promise<Record<string, Note[]>> { return Promise.resolve({}); }
  `);
  assert.match(client, /import type \{ Filter, Note \}/);
  assert.match(client, /list\(args: \{ filter: Filter \}\): Promise<Array<Note>>/);
  assert.match(client, /find\(args: \{ id: string \}\): Promise<Note \| null>/);
  assert.match(client, /many\(\): Promise<Record<string, Note\[\]>>/);
  assertCompiles(dir);
});

test("inferred return types unwrap Promise and print anonymous shapes", () => {
  const { dir, client } = gen(`
    export async function save() { return { ok: true, at: 1 }; }
  `);
  assert.match(client, /save\(\): Promise<\{ ok: boolean; at: number; \}>/);
  assertCompiles(dir);
});

test("inferred return of an exported named type is imported", () => {
  const { dir, client } = gen(`
    export interface Saved { ok: boolean }
    const make = (): Saved => ({ ok: true });
    export async function save() { return [make()]; }
  `);
  assert.match(client, /import type \{ Saved \}/);
  assert.match(client, /save\(\): Promise<Saved\[\]>/);
  assertCompiles(dir);
});

test("inferred return of an unexported named type fails clearly", () => {
  assert.throws(
    () =>
      gen(`
        interface Internal { ok: boolean }
        const make = (): Internal => ({ ok: true });
        export async function save() { return make(); }
      `),
    (e) => e instanceof TypegenError && /returns type `Internal`, which is not exported/.test(e.message),
  );
});

test("non-exported named type in a signature fails with a clear message", () => {
  assert.throws(
    () =>
      gen(`
        interface Hidden { x: number }
        export function f(args: Hidden): number { return args.x; }
      `),
    (e) => e instanceof TypegenError && /`f` uses type `Hidden`, which is not exported/.test(e.message),
  );
});

test("arrow-function and function-expression exports (#4)", () => {
  const { dir, client, res } = gen(`
    export const add = (args: { a: number; b: number }): number => args.a + args.b;
    export const ping = async () => "pong";
    export const legacy = function (args: { n: number }): number { return args.n; };
  `);
  assert.deepEqual(res.names.sort(), ["add", "legacy", "ping"]);
  assert.match(client, /add\(args: \{ a: number; b: number \}\): Promise<number>/);
  assert.match(client, /ping\(\): Promise<string>/);
  assertCompiles(dir);
});

test("local re-exports and default-less export lists (#4)", () => {
  const { dir, res } = gen(`
    function hidden(): number { return 1; }
    const alsoHidden = (): string => "x";
    export { hidden as one, alsoHidden };
  `);
  assert.deepEqual(res.names.sort(), ["alsoHidden", "one"]);
  assertCompiles(dir);
});

test("non-function value exports are reported as skipped, not silently dropped", () => {
  const { res } = gen(`
    export const VERSION = "1";
    export function f(): number { return 1; }
  `);
  assert.deepEqual(res.names, ["f"]);
  assert.deepEqual(res.skipped, ["VERSION"]);
});

test("type-only exports are neither functions nor skipped", () => {
  const { res } = gen(`
    export interface A { x: number }
    export type B = string;
    export function f(args: A): B { return ""; }
  `);
  assert.deepEqual(res.names, ["f"]);
  assert.deepEqual(res.skipped, []);
});

test("compiled module exposes every export on globalThis.native", () => {
  const { res } = gen(`
    export function a(): number { return 1; }
    export const b = (): number => 2;
  `);
  const g = {};
  new Function("globalThis", fs.readFileSync(res.compiled, "utf8"))(g);
  assert.equal(g.native.a(), 1);
  assert.equal(g.native.b(), 2);
});

test("vanilla .js native modules still produce a JS client", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kestrel-typegen-"));
  fs.writeFileSync(path.join(dir, "native.js"), "native.hello = () => 1;\nnative.bye = () => 2;\n");
  const res = runTypegen(dir, { native: "native.js" });
  assert.deepEqual(res.names, ["hello", "bye"]);
  assert.ok(fs.existsSync(path.join(dir, "native-client.js")));
});

test("syntax errors in native.ts are reported with native.ts line and column", () => {
  assert.throws(
    () => gen("export function ok(): number { return 1; }\nexport function bad( { \n"),
    (e) => e instanceof TypegenError && /native\.ts:\d+:\d+: /.test(e.message),
  );
});
