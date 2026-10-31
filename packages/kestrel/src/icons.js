// The icon pipeline (#27, RFC-0001 Q4): one square source PNG in, every
// platform's icon out. No dependencies: PNG decode/encode over node:zlib, a
// box-filter downscale, and .icns/.ico containers that embed PNGs (macOS
// 10.7+, Windows Vista+).
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Thrown for a source icon the user must fix. */
export class IconError extends Error {}

/** Decode an 8-bit, non-interlaced PNG to RGBA. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new IconError("not a PNG file");
  let pos = 8;
  let width, height, depth, colorType, interlace, palette, trns;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      [depth, colorType] = [data[8], data[9]];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (depth !== 8)
    throw new IconError(`${depth}-bit PNGs aren't supported; export it as an 8-bit (24- or 32-bit color) PNG`);
  if (interlace) throw new IconError("interlaced PNGs aren't supported; export it without interlacing");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new IconError(`unknown PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new IconError("palette PNG without a palette");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = px.subarray(i * channels, (i + 1) * channels);
    let r,
      g,
      b,
      a = 255;
    if (colorType === 0) [r, g, b] = [s[0], s[0], s[0]];
    else if (colorType === 4) [r, g, b, a] = [s[0], s[0], s[0], s[1]];
    else if (colorType === 2) [r, g, b] = s;
    else if (colorType === 6) [r, g, b, a] = s;
    else {
      [r, g, b] = palette.subarray(s[0] * 3, s[0] * 3 + 3);
      a = trns && s[0] < trns.length ? trns[s[0]] : 255;
    }
    rgba.set([r, g, b, a], i * 4);
  }
  return { width, height, data: rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Encode RGBA as a PNG (Paeth filter on every row, which suits icons). */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 4;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const a = i >= 4 ? data[at - 4] : 0;
      const b = y ? data[at - stride] : 0;
      const c = y && i >= 4 ? data[at - stride - 4] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (stride + 1) + 1 + i] = (data[at] - pred) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Downscale a square image to `size` by averaging each output pixel's
 * source area. Colors are averaged weighted by alpha, so transparent pixels
 * don't darken the edges.
 */
export function resize(img, size) {
  if (size === img.width) return img;
  const scale = img.width / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = y * scale,
      y1 = y0 + scale;
    for (let x = 0; x < size; x++) {
      const x0 = x * scale,
        x1 = x0 + scale;
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * img.width + sx) * 4;
          const wa = w * img.data[i + 3];
          r += img.data[i] * wa;
          g += img.data[i + 1] * wa;
          b += img.data[i + 2] * wa;
          a += wa;
          area += w;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) out.set([r / a, g / a, b / a].map(Math.round), o);
      out[o + 3] = Math.round(a / area);
    }
  }
  return { width: size, height: size, data: out };
}

// .icns entry types holding PNGs, by pixel size. Retina variants (ic11–ic14)
// are the same pixels as the next size up.
const ICNS_TYPES = [
  ["icp4", 16],
  ["ic11", 32],
  ["icp5", 32],
  ["icp6", 48],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** An .icns file from PNGs keyed by size. Sizes not given are left out. */
export function icns(pngs) {
  const entries = ICNS_TYPES.filter(([, s]) => pngs[s]).map(([type, s]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "latin1");
    head.writeUInt32BE(8 + pngs[s].length, 4);
    return Buffer.concat([head, pngs[s]]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "latin1");
  head.writeUInt32BE(8 + entries.reduce((n, e) => n + e.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

/** An .ico file from PNGs keyed by size (256 at most). */
export function ico(pngs) {
  const sizes = ICO_SIZES.filter((s) => pngs[s]);
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = s === 256 ? 0 : s; // 0 means 256
    head.writeUInt16LE(1, e + 4); // color planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(pngs[s].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += pngs[s].length;
  });
  return Buffer.concat([head, ...sizes.map((s) => pngs[s])]);
}

/**
 * Every icon an app needs from one source PNG: `{ icns, ico, png }`, where
 * `png` maps size → PNG bytes. The source must be square and at least
 * 512 px; sizes above it are skipped rather than blurred. `warnings` notes
 * anything worth fixing.
 */
export function makeIcons(source) {
  const img = decodePng(source);
  if (img.width !== img.height) throw new IconError(`the icon must be square (got ${img.width}×${img.height})`);
  if (img.width < 512)
    throw new IconError(`the icon must be at least 512×512 (got ${img.width}×${img.height}); 1024×1024 is best`);
  const warnings =
    img.width < 1024 ? [`the icon is ${img.width}×${img.width}; 1024×1024 looks sharp on Retina displays`] : [];
  const sizes = [...new Set([...ICNS_TYPES.map(([, s]) => s), ...ICO_SIZES])].filter((s) => s <= img.width);
  // Each size straight from the source: the area average is exact at any ratio.
  const png = Object.fromEntries(sizes.map((s) => [s, encodePng(resize(img, s))]));
  return { icns: icns(png), ico: ico(png), png, warnings };
}
