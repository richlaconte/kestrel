// Per-app Windows executable resources (#25): every app ships a copy of
// kestrel-host.exe, which carries Kestrel's icon and version info. Explorer,
// file properties and the taskbar read those from the .exe's resource
// section, so `kestrel build` rewrites it: the app's icon, and a version
// block with its name, version and publisher. Everything else in the section
// (the application manifest, which turns on DPI awareness and common
// controls v6) is kept.
//
// Plain Node, like icons.js and linux.js: parse the PE headers, rebuild the
// .rsrc section at its new size, move .reloc (the only section linkers put
// after it, and one nothing refers to except its data directory) to follow
// it, then fix SizeOfImage, the data directories and the checksum. Any other
// layout is refused rather than guessed at.

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;
/** The icon group's id: IDI_APPLICATION, which the host's own resources use. */
const ICON_GROUP_ID = 32512;
const LANG_EN_US = 1033;

export class PeError extends Error {}

const align = (n, a) => Math.ceil(n / a) * a;

/** Headers and section table of a PE32+ image. */
export function parsePe(buf) {
  if (buf.length < 0x40 || buf.toString("latin1", 0, 2) !== "MZ")
    throw new PeError("not a Windows executable (no MZ header)");
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", pe, pe + 4) !== "PE\0\0") throw new PeError("not a PE executable");
  const coff = pe + 4;
  const nsec = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const opt = coff + 20;
  if (buf.readUInt16LE(opt) !== 0x20b) throw new PeError("only 64-bit (PE32+) executables are supported");
  const dirs = opt + 112;
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const o = opt + optSize + i * 40;
    sections.push({
      header: o,
      name: buf.toString("latin1", o, o + 8).replace(/\0+$/, ""),
      vsize: buf.readUInt32LE(o + 8),
      va: buf.readUInt32LE(o + 12),
      rawSize: buf.readUInt32LE(o + 16),
      raw: buf.readUInt32LE(o + 20),
    });
  }
  const dir = (i) => ({
    rva: buf.readUInt32LE(dirs + i * 8),
    size: buf.readUInt32LE(dirs + i * 8 + 4),
    at: dirs + i * 8,
  });
  return {
    opt,
    fileAlign: buf.readUInt32LE(opt + 36),
    sectionAlign: buf.readUInt32LE(opt + 32),
    sections,
    resource: dir(2),
    security: dir(4),
    reloc: dir(5),
  };
}

// ---- reading and writing the resource tree ----
// The tree is three levels: type → name → language → data. Here it's a Map
// of Maps: key (a number id or a string name) → … → { data, codepage }.

/** The resource tree of the section at `sec`. */
export function readResources(buf, sec) {
  const at = (off) => sec.raw + off;
  const key = (v) => {
    if (!(v & 0x80000000)) return v;
    const o = at(v & 0x7fffffff);
    return buf.toString("utf16le", o + 2, o + 2 + buf.readUInt16LE(o) * 2);
  };
  const level = (off, depth) => {
    const out = new Map();
    const n = buf.readUInt16LE(at(off) + 12) + buf.readUInt16LE(at(off) + 14);
    for (let i = 0; i < n; i++) {
      const e = at(off) + 16 + i * 8;
      const k = key(buf.readUInt32LE(e));
      const v = buf.readUInt32LE(e + 4);
      if (v & 0x80000000) {
        if (depth >= 2) throw new PeError("the resource tree is deeper than three levels");
        out.set(k, level(v & 0x7fffffff, depth + 1));
      } else {
        const d = at(v);
        const rva = buf.readUInt32LE(d);
        const size = buf.readUInt32LE(d + 4);
        const from = rva - sec.va + sec.raw;
        out.set(k, { data: Buffer.from(buf.subarray(from, from + size)), codepage: buf.readUInt32LE(d + 8) });
      }
    }
    return out;
  };
  return level(0, 0);
}

/** Named entries first, by name; then ids, ascending (as Windows requires). */
const sortedEntries = (map) =>
  [...map.entries()].sort(([a], [b]) => {
    if (typeof a !== typeof b) return typeof a === "string" ? -1 : 1;
    return typeof a === "string" ? (a < b ? -1 : a > b ? 1 : 0) : a - b;
  });

/** Serialize a resource tree for a section at virtual address `va`. */
export function writeResources(tree, va) {
  // Layout: every directory table (breadth first), then the data entries,
  // then name strings, then the data, each blob 8-aligned.
  const dirs = [];
  const leaves = [];
  const queue = [tree];
  while (queue.length) {
    const map = queue.shift();
    dirs.push(map);
    for (const [, v] of sortedEntries(map)) if (v instanceof Map) queue.push(v);
    for (const [, v] of sortedEntries(map)) if (!(v instanceof Map)) leaves.push(v);
  }
  const dirOff = new Map();
  let off = 0;
  for (const d of dirs) {
    dirOff.set(d, off);
    off += 16 + d.size * 8;
  }
  const leafOff = new Map();
  for (const l of leaves) {
    leafOff.set(l, off);
    off += 16;
  }
  const names = new Map();
  for (const d of dirs)
    for (const k of d.keys())
      if (typeof k === "string" && !names.has(k)) {
        names.set(k, off);
        off += 2 + k.length * 2;
      }
  const dataOff = new Map();
  for (const l of leaves) {
    off = align(off, 8);
    dataOff.set(l, off);
    off += l.data.length;
  }
  const out = Buffer.alloc(align(off, 8));
  for (const d of dirs) {
    const o = dirOff.get(d);
    const entries = sortedEntries(d);
    out.writeUInt16LE(entries.filter(([k]) => typeof k === "string").length, o + 12);
    out.writeUInt16LE(entries.filter(([k]) => typeof k !== "string").length, o + 14);
    entries.forEach(([k, v], i) => {
      const e = o + 16 + i * 8;
      out.writeUInt32LE(typeof k === "string" ? (0x80000000 | names.get(k)) >>> 0 : k, e);
      out.writeUInt32LE(v instanceof Map ? (0x80000000 | dirOff.get(v)) >>> 0 : leafOff.get(v), e + 4);
    });
  }
  for (const l of leaves) {
    const o = leafOff.get(l);
    out.writeUInt32LE(va + dataOff.get(l), o);
    out.writeUInt32LE(l.data.length, o + 4);
    out.writeUInt32LE(l.codepage ?? 0, o + 8);
    l.data.copy(out, dataOff.get(l));
  }
  for (const [k, o] of names) {
    out.writeUInt16LE(k.length, o);
    out.write(k, o + 2, "utf16le");
  }
  return out;
}

// ---- the resources this replaces ----

/** RT_ICON images and the RT_GROUP_ICON directory for a .ico file. */
export function iconResources(ico) {
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new PeError("not a .ico file");
  const count = ico.readUInt16LE(4);
  const images = [];
  const group = Buffer.alloc(6 + count * 14);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(count, 4);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = ico.readUInt32LE(e + 8);
    const offset = ico.readUInt32LE(e + 12);
    images.push(ico.subarray(offset, offset + size));
    // GRPICONDIRENTRY: the ICONDIRENTRY's first 12 bytes, then the id.
    ico.copy(group, 6 + i * 14, e, e + 12);
    group.writeUInt16LE(i + 1, 6 + i * 14 + 12);
  }
  return { images, group };
}

/** "1.2.3-beta" → [1, 2, 3, 0], each clamped to 16 bits. */
const versionParts = (v) => {
  const parts = [];
  for (const p of String(v).split(/[.+-]/)) {
    if (!/^\d+$/.test(p) || parts.length === 4) break;
    parts.push(Math.min(Number(p), 65535));
  }
  while (parts.length < 4) parts.push(0);
  return parts;
};

const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

/**
 * One VS_VERSIONINFO-style block: wLength, wValueLength, wType, the key,
 * the value and the children, each 4-aligned. `text` blocks (wType 1) count
 * their value in UTF-16 units; binary ones (wType 0) in bytes.
 */
function block(key, value, children, { text }) {
  const head = pad4(Buffer.concat([Buffer.alloc(6), Buffer.from(`${key}\0`, "utf16le")]));
  const body = Buffer.concat([head, children.length ? pad4(value) : value, ...children.map(pad4)]);
  // wLength leaves out the padding after the last child.
  const last = children.at(-1);
  const length = last ? body.length - ((4 - (last.length % 4)) % 4) : body.length;
  body.writeUInt16LE(length, 0);
  body.writeUInt16LE(text ? value.length / 2 : value.length, 2);
  body.writeUInt16LE(text ? 1 : 0, 4);
  return body.subarray(0, length);
}

/** Parse one block back: { key, value, children }. */
function parseBlock(buf, o = 0) {
  const length = buf.readUInt16LE(o);
  const valueLength = buf.readUInt16LE(o + 2);
  const text = buf.readUInt16LE(o + 4) === 1;
  let k = o + 6;
  while (buf.readUInt16LE(k) !== 0) k += 2;
  const key = buf.toString("utf16le", o + 6, k);
  const vo = align(k + 2 - o, 4) + o;
  const vlen = text ? valueLength * 2 : valueLength;
  const value = buf.subarray(vo, vo + vlen);
  const children = [];
  for (let c = align(vo + vlen - o, 4) + o; c < o + length; ) {
    const child = parseBlock(buf, c);
    children.push(child);
    c = align(c + child.length - o, 4) + o;
  }
  return { key, value, text, children, length };
}

/** A VS_VERSIONINFO resource: the fixed file info and US-English strings. */
export function versionInfo({ version, strings }) {
  const [a, b, c, d] = versionParts(version);
  // VS_FIXEDFILEINFO: signature, struct version, file and product versions,
  // flags mask and flags, VOS_NT_WINDOWS32, VFT_APP, subtype, date.
  const fields = [
    0xfeef04bd,
    0x00010000,
    (a << 16) | b,
    (c << 16) | d,
    (a << 16) | b,
    (c << 16) | d,
    0x3f,
    0,
    0x40004,
    1,
    0,
    0,
    0,
  ];
  const fixed = Buffer.alloc(52);
  for (const [i, v] of fields.entries()) fixed.writeUInt32LE(v >>> 0, i * 4);
  const none = Buffer.alloc(0);
  const str = (k, v) => block(k, Buffer.from(`${v}\0`, "utf16le"), [], { text: true });
  // US English, Unicode.
  const table = block(
    "040904b0",
    none,
    Object.entries(strings).map(([k, v]) => str(k, v)),
    { text: true },
  );
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(0x0409, 0);
  translation.writeUInt16LE(1200, 2);
  return block(
    "VS_VERSION_INFO",
    fixed,
    [
      block("StringFileInfo", none, [table], { text: true }),
      block("VarFileInfo", none, [block("Translation", translation, [], { text: false })], { text: true }),
    ],
    { text: false },
  );
}

// ---- patching ----

/** The PE checksum (as imagehlp's CheckSumMappedFile computes it). */
export function peChecksum(buf, checksumAt) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (i === checksumAt || i === checksumAt + 2) continue;
    sum += buf.readUInt16LE(i);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (buf.length % 2) sum += buf[buf.length - 1];
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + buf.length) >>> 0;
}

/**
 * The executable with its icon, icon group and version replaced. `ico` is a
 * .ico file; `version` the app's version; `strings` the version block's
 * StringFileInfo (ProductName, FileDescription, …).
 */
export function setResources(exe, { ico, version, strings }) {
  const pe = parsePe(exe);
  const rsrcIdx = pe.sections.findIndex(
    (s) => pe.resource.rva >= s.va && pe.resource.rva < s.va + Math.max(s.vsize, s.rawSize),
  );
  if (rsrcIdx < 0) throw new PeError("the executable has no resource section");
  const rsrc = pe.sections[rsrcIdx];
  if (rsrc.va !== pe.resource.rva) throw new PeError("the resource directory doesn't start its section");
  const after = pe.sections.slice(rsrcIdx + 1);
  if (after.length > 1 || (after.length === 1 && after[0].va !== pe.reloc.rva))
    throw new PeError(`can't move the sections after .rsrc (${after.map((s) => s.name).join(", ")})`);
  const reloc = after[0];

  // An Authenticode signature sits after the last section and covers the
  // whole file; it would be invalid after this, so drop it.
  const last = pe.sections.at(-1);
  let end = last.raw + last.rawSize;
  if (pe.security.size && pe.security.rva >= end) end = Math.min(end, pe.security.rva);
  if (exe.length > end && !(pe.security.size && pe.security.rva === end))
    throw new PeError("the executable has data after its last section; refusing to rewrite it");

  const tree = readResources(exe, rsrc);
  const { images, group } = iconResources(ico);
  const lang = (data) => new Map([[LANG_EN_US, { data, codepage: 0 }]]);
  tree.set(RT_ICON, new Map(images.map((img, i) => [i + 1, lang(Buffer.from(img))])));
  tree.set(RT_GROUP_ICON, new Map([[ICON_GROUP_ID, lang(group)]]));
  tree.set(RT_VERSION, new Map([[1, lang(versionInfo({ version, strings }))]]));
  const data = writeResources(tree, rsrc.va);

  const rsrcRawSize = align(data.length, pe.fileAlign);
  const relocVa = reloc ? align(rsrc.va + data.length, pe.sectionAlign) : 0;
  const relocRaw = rsrc.raw + rsrcRawSize;
  const size = relocRaw + (reloc ? reloc.rawSize : 0);
  const out = Buffer.alloc(size);
  exe.copy(out, 0, 0, rsrc.raw);
  data.copy(out, rsrc.raw);
  if (reloc) exe.copy(out, relocRaw, reloc.raw, reloc.raw + reloc.rawSize);

  // Section headers.
  out.writeUInt32LE(data.length, rsrc.header + 8);
  out.writeUInt32LE(rsrcRawSize, rsrc.header + 16);
  if (reloc) {
    out.writeUInt32LE(relocVa, reloc.header + 12);
    out.writeUInt32LE(relocRaw, reloc.header + 20);
  }
  // Data directories.
  out.writeUInt32LE(data.length, pe.resource.at + 4);
  if (reloc) out.writeUInt32LE(relocVa, pe.reloc.at);
  out.writeUInt32LE(0, pe.security.at);
  out.writeUInt32LE(0, pe.security.at + 4);
  // SizeOfInitializedData, SizeOfImage, CheckSum.
  const grow = rsrcRawSize - rsrc.rawSize;
  out.writeUInt32LE((out.readUInt32LE(pe.opt + 8) + grow) >>> 0, pe.opt + 8);
  const tail = reloc ? { va: relocVa, vsize: reloc.vsize } : { va: rsrc.va, vsize: data.length };
  out.writeUInt32LE(align(tail.va + tail.vsize, pe.sectionAlign), pe.opt + 56);
  out.writeUInt32LE(peChecksum(out, pe.opt + 64), pe.opt + 64);
  return out;
}

/** Read back what setResources wrote: resource types, icon count, version numbers and strings. */
export function describeResources(exe) {
  const pe = parsePe(exe);
  const tree = readResources(
    exe,
    pe.sections.find((sec) => sec.va === pe.resource.rva),
  );
  const first = (m) => (m ? [...m.values()][0] : undefined);
  const group = first(first(tree.get(RT_GROUP_ICON)))?.data;
  const ver = first(first(tree.get(RT_VERSION)))?.data;
  let version = null;
  const strings = {};
  if (ver) {
    const root = parseBlock(ver);
    const f = root.value;
    version = [
      f.readUInt32LE(8) >>> 16,
      f.readUInt32LE(8) & 0xffff,
      f.readUInt32LE(12) >>> 16,
      f.readUInt32LE(12) & 0xffff,
    ];
    for (const table of root.children.find((c) => c.key === "StringFileInfo")?.children ?? [])
      for (const str of table.children) strings[str.key] = str.value.toString("utf16le").replace(/\0$/, "");
  }
  return { types: [...tree.keys()], icons: group ? group.readUInt16LE(4) : 0, version, strings };
}
