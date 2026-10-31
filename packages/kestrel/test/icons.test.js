import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { decodePng, encodePng, ico, icns, IconError, makeIcons, resize } from "../src/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT = fs.readFileSync(path.join(ROOT, "assets", "icon.png"));

/** A solid square, or a half-transparent one. */
const square = (size, rgba) => ({
  width: size,
  height: size,
  data: new Uint8Array(size * size * 4).map((_, i) => rgba[i % 4]),
});

test("PNG encode/decode round trips exactly", () => {
  const img = { width: 3, height: 2, data: Uint8Array.from({ length: 24 }, (_, i) => (i * 37) & 0xff) };
  assert.deepEqual(decodePng(encodePng(img)), img);
});

test("decodes RGB and palette PNGs, refuses 16-bit and interlaced ones", () => {
  // Hand-built 1×1 PNGs: IHDR fields, then one filtered scanline.
  const png = (colorType, depth, interlace, row, extra = []) => {
    const chunk = (type, data) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0);
      b.write(type, 4, "latin1");
      data.copy(b, 8);
      return b; // CRC isn't checked by the decoder
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.set([depth, colorType, 0, 0, interlace], 8);
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      ...extra.map(([t, d]) => chunk(t, Buffer.from(d))),
      chunk("IDAT", zlib.deflateSync(Buffer.from([0, ...row]))),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  };
  assert.deepEqual([...decodePng(png(2, 8, 0, [10, 20, 30])).data], [10, 20, 30, 255]);
  const pal = png(
    3,
    8,
    0,
    [1],
    [
      ["PLTE", [0, 0, 0, 9, 8, 7]],
      ["tRNS", [255, 128]],
    ],
  );
  assert.deepEqual([...decodePng(pal).data], [9, 8, 7, 128]);
  assert.throws(() => decodePng(png(6, 16, 0, [])), /16-bit PNGs aren't supported/);
  assert.throws(() => decodePng(png(6, 8, 1, [1, 2, 3, 4])), /interlaced/);
  assert.throws(() => decodePng(Buffer.from("GIF89a")), IconError);
});

test("resize averages area and doesn't let transparent pixels darken edges", () => {
  const img = square(4, [200, 100, 50, 255]);
  // Make the left half transparent black.
  for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) img.data.set([0, 0, 0, 0], (y * 4 + x) * 4);
  const out = resize(img, 1);
  assert.deepEqual([...out.data], [200, 100, 50, 128]);
});

test("makeIcons: every size, valid containers, and clear errors", () => {
  const r = makeIcons(DEFAULT);
  assert.deepEqual(Object.keys(r.png).map(Number), [16, 24, 32, 48, 64, 128, 256, 512, 1024]);
  for (const [s, png] of Object.entries(r.png)) assert.equal(decodePng(png).width, Number(s));
  assert.equal(r.icns.toString("latin1", 0, 4), "icns");
  assert.equal(r.icns.readUInt32BE(4), r.icns.length);
  assert.deepEqual([r.ico.readUInt16LE(2), r.ico.readUInt16LE(4)], [1, 7]);
  assert.equal(r.ico[6 + 16 * 6], 0, "256 px is stored as 0");
  assert.deepEqual(r.warnings, []);

  assert.throws(
    () => makeIcons(encodePng({ width: 600, height: 500, data: new Uint8Array(600 * 500 * 4) })),
    /must be square \(got 600×500\)/,
  );
  assert.throws(() => makeIcons(encodePng(square(256, [1, 2, 3, 255]))), /at least 512×512/);
  const small = makeIcons(encodePng(square(512, [1, 2, 3, 255])));
  assert.ok(!small.png[1024], "no upscaled 1024");
  assert.match(small.warnings[0], /1024×1024 looks sharp/);
});

test("icns and ico skip sizes that aren't given", () => {
  const p = encodePng(square(16, [0, 0, 0, 255]));
  assert.equal(icns({ 16: p }).length, 8 + 8 + p.length);
  assert.equal(ico({ 16: p }).readUInt16LE(4), 1);
});
