import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeIcons } from "../src/icons.js";
import {
  describeResources,
  iconResources,
  PeError,
  parsePe,
  peChecksum,
  readResources,
  setResources,
  versionInfo,
  writeResources,
} from "../src/pe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICO = makeIcons(fs.readFileSync(path.join(ROOT, "assets", "icon.png"))).ico;
const MANIFEST = Buffer.from('<?xml version="1.0"?><assembly manifestVersion="1.0"/>');
const lang = (data) => new Map([[1033, { data, codepage: 0 }]]);

/**
 * A minimal PE32+: .text, .rsrc (a manifest, one old icon, an old version)
 * and .reloc, laid out the way MSVC links Rust binaries. `extra` adds a
 * section after .reloc; `overlay` appends bytes after the last section.
 */
function fakeExe({ extra = false, overlay = null } = {}) {
  const tree = new Map([
    [3, new Map([[1, lang(Buffer.from("old icon"))]])],
    [14, new Map([[32512, lang(Buffer.alloc(20))]])],
    [16, new Map([[1, lang(versionInfo({ version: "0.1.0", strings: { ProductName: "kestrel-host" } }))]])],
    [24, new Map([[1, lang(MANIFEST)]])],
    ["CUSTOM", new Map([["NAMED", lang(Buffer.from("kept"))]])],
  ]);
  const rsrc = writeResources(tree, 0x2000);
  const sections = [
    { name: ".text", va: 0x1000, data: Buffer.alloc(0x180, 0xcc) },
    { name: ".rsrc", va: 0x2000, data: rsrc },
    { name: ".reloc", va: 0x2000 + Math.ceil(rsrc.length / 0x1000) * 0x1000, data: Buffer.from("RELOCATIONS!") },
  ];
  if (extra) sections.push({ name: ".extra", va: sections[2].va + 0x1000, data: Buffer.from("x") });
  const pe = 0x40;
  const opt = pe + 24;
  const headers = 0x400;
  let raw = headers;
  for (const s of sections) {
    s.raw = raw;
    s.rawSize = Math.ceil(s.data.length / 0x200) * 0x200;
    raw += s.rawSize;
  }
  const out = Buffer.alloc(raw);
  out.write("MZ", 0, "latin1");
  out.writeUInt32LE(pe, 0x3c);
  out.write("PE\0\0", pe, "latin1");
  out.writeUInt16LE(0x8664, pe + 4);
  out.writeUInt16LE(sections.length, pe + 6);
  out.writeUInt16LE(240, pe + 20);
  out.writeUInt16LE(0x20b, opt);
  out.writeUInt32LE(
    sections.slice(1).reduce((n, s) => n + s.rawSize, 0),
    opt + 8,
  );
  out.writeUInt32LE(0x1000, opt + 32);
  out.writeUInt32LE(0x200, opt + 36);
  const last = sections.at(-1);
  out.writeUInt32LE(last.va + 0x1000, opt + 56);
  out.writeUInt32LE(headers, opt + 60);
  out.writeUInt32LE(16, opt + 108);
  out.writeUInt32LE(0x2000, opt + 112 + 2 * 8);
  out.writeUInt32LE(rsrc.length, opt + 112 + 2 * 8 + 4);
  out.writeUInt32LE(sections[2].va, opt + 112 + 5 * 8);
  out.writeUInt32LE(sections[2].data.length, opt + 112 + 5 * 8 + 4);
  sections.forEach((s, i) => {
    const h = opt + 240 + i * 40;
    out.write(s.name, h, "latin1");
    out.writeUInt32LE(s.data.length, h + 8);
    out.writeUInt32LE(s.va, h + 12);
    out.writeUInt32LE(s.rawSize, h + 16);
    out.writeUInt32LE(s.raw, h + 20);
    s.data.copy(out, s.raw);
  });
  return overlay ? Buffer.concat([out, overlay]) : out;
}

const STRINGS = {
  CompanyName: "Ada",
  FileDescription: "My Notes",
  ProductName: "My Notes",
  ProductVersion: "1.2.3-beta.4",
};

test("resource trees round trip, named entries included", () => {
  const tree = new Map([
    [24, new Map([[1, lang(MANIFEST)]])],
    ["CUSTOM", new Map([["NAMED", lang(Buffer.from("x"))]])],
    [
      3,
      new Map([
        [2, lang(Buffer.from("b"))],
        [1, lang(Buffer.from("a"))],
      ]),
    ],
  ]);
  const buf = writeResources(tree, 0x5000);
  const back = readResources(Buffer.concat([buf]), { va: 0x5000, raw: 0 });
  assert.deepEqual([...back.keys()], ["CUSTOM", 3, 24], "named first, then ids ascending");
  assert.deepEqual([...back.get(3).keys()], [1, 2]);
  assert.equal(back.get("CUSTOM").get("NAMED").get(1033).data.toString(), "x");
  assert.deepEqual(back.get(24).get(1).get(1033).data, MANIFEST);
});

test("icon resources: one RT_ICON per image, and a group that numbers them", () => {
  const { images, group } = iconResources(ICO);
  const count = ICO.readUInt16LE(4);
  assert.equal(images.length, count);
  assert.equal(group.readUInt16LE(2), 1, "type: icon");
  assert.equal(group.readUInt16LE(4), count);
  for (let i = 0; i < count; i++) {
    assert.deepEqual(group.subarray(6 + i * 14, 6 + i * 14 + 12), ICO.subarray(6 + i * 16, 6 + i * 16 + 12));
    assert.equal(group.readUInt16LE(6 + i * 14 + 12), i + 1);
    assert.equal(images[i].subarray(1, 4).toString(), "PNG", "PNG images, as icons.js writes them");
  }
  assert.throws(() => iconResources(Buffer.from("not an icon")), PeError);
});

test("setResources replaces icons and version, and keeps everything else", () => {
  const exe = fakeExe();
  const before = parsePe(exe);
  const out = setResources(exe, { ico: ICO, version: "1.2.3-beta.4", strings: STRINGS });
  const pe = parsePe(out);
  const d = describeResources(out);
  assert.deepEqual(
    d.types.sort((a, b) => String(a).localeCompare(String(b))),
    [14, 16, 24, 3, "CUSTOM"],
  );
  assert.equal(d.icons, ICO.readUInt16LE(4));
  assert.deepEqual(d.version, [1, 2, 3, 0]);
  assert.deepEqual(d.strings, STRINGS);

  const rsrc = pe.sections.find((s) => s.name === ".rsrc");
  const tree = readResources(out, rsrc);
  assert.deepEqual(tree.get(24).get(1).get(1033).data, MANIFEST, "the manifest is untouched");
  assert.equal(tree.get("CUSTOM").get("NAMED").get(1033).data.toString(), "kept");
  assert.deepEqual([...tree.get(14).keys()], [32512]);

  const text = (p) => p.sections[0];
  assert.deepEqual(
    out.subarray(text(pe).raw, text(pe).raw + 0x180),
    exe.subarray(text(before).raw, text(before).raw + 0x180),
  );
  const reloc = pe.sections.find((s) => s.name === ".reloc");
  assert.equal(out.toString("latin1", reloc.raw, reloc.raw + 12), "RELOCATIONS!", "relocations moved intact");
  assert.equal(pe.reloc.rva, reloc.va, "the data directory follows .reloc");
  assert.equal(reloc.va % 0x1000, 0);
  assert.ok(reloc.va >= rsrc.va + rsrc.vsize, ".reloc after the new .rsrc");
  assert.equal(reloc.raw, rsrc.raw + rsrc.rawSize);
  assert.equal(pe.resource.size, rsrc.vsize);
  assert.equal(out.readUInt32LE(pe.opt + 56), reloc.va + 0x1000, "SizeOfImage");
  assert.equal(out.readUInt32LE(pe.opt + 64), peChecksum(out, pe.opt + 64));
  assert.equal(out.length, reloc.raw + reloc.rawSize);
});

test("an Authenticode signature is dropped, other trailing data is refused", () => {
  const exe = fakeExe({ overlay: Buffer.alloc(0x100, 1) });
  const pe = parsePe(exe);
  assert.throws(() => setResources(exe, { ico: ICO, version: "1", strings: {} }), /data after its last section/);
  exe.writeUInt32LE(exe.length - 0x100, pe.security.at);
  exe.writeUInt32LE(0x100, pe.security.at + 4);
  const out = setResources(exe, { ico: ICO, version: "1", strings: {} });
  const after = parsePe(out);
  assert.deepEqual([after.security.rva, after.security.size], [0, 0]);
  assert.equal(out.length, after.sections.at(-1).raw + after.sections.at(-1).rawSize);
});

test("layouts it can't rewrite are refused", () => {
  assert.throws(
    () => setResources(fakeExe({ extra: true }), { ico: ICO, version: "1", strings: {} }),
    /\.reloc, \.extra/,
  );
  assert.throws(() => parsePe(Buffer.from("not an exe at all, really not")), /no MZ header/);
  const pe32 = fakeExe();
  pe32.writeUInt16LE(0x10b, 0x40 + 24);
  assert.throws(() => parsePe(pe32), /64-bit/);
});

test("the version block parses back with Windows' layout rules", () => {
  const v = versionInfo({ version: "70000.2", strings: { ProductName: "X" } });
  assert.equal(v.readUInt16LE(0), v.length, "wLength covers the whole block");
  assert.equal(v.readUInt16LE(2), 52, "VS_FIXEDFILEINFO");
  assert.equal(v.toString("utf16le", 6, 36), "VS_VERSION_INFO");
  assert.equal(v.readUInt32LE(40), 0xfeef04bd);
  assert.equal(v.readUInt32LE(48), ((65535 << 16) | 2) >>> 0, "clamped to 16 bits");
});
