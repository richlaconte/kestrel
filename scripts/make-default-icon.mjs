// Renders the default app icon (packages/kestrel/assets/icon.png, 1024×1024)
// from the site's logo: the bird on an accent rounded square, inset on
// Apple's icon grid (824 px body). Re-run after changing the logo:
//   node scripts/make-default-icon.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodePng } from "../packages/kestrel/src/icons.js";

const SIZE = 1024,
  INSET = 100,
  BODY = 824,
  SS = 4; // SS×SS samples per pixel
const k = BODY / 32; // the logo's viewBox is 32×32
const at = (x, y) => [INSET + x * k, INSET + y * k];

// site/index.html #logo: M6 19c5-1 8-4 10-9 1 3 3 5 6 6l4-1-3 3c-3 1-6 1-8 0l-3 6-1-5c-2 1-4 1-5 0z
const bird = [];
let cur = [6, 19];
bird.push(cur);
const line = (dx, dy) => {
  cur = [cur[0] + dx, cur[1] + dy];
  bird.push(cur);
};
const curve = (x1, y1, x2, y2, dx, dy) => {
  const [p0, p1, p2, p3] = [cur, [cur[0] + x1, cur[1] + y1], [cur[0] + x2, cur[1] + y2], [cur[0] + dx, cur[1] + dy]];
  for (let i = 1; i <= 32; i++) {
    const t = i / 32,
      u = 1 - t;
    bird.push([0, 1].map((j) => u ** 3 * p0[j] + 3 * u * u * t * p1[j] + 3 * u * t * t * p2[j] + t ** 3 * p3[j]));
  }
  cur = p3;
};
curve(5, -1, 8, -4, 10, -9);
curve(1, 3, 3, 5, 6, 6);
line(4, -1);
line(-3, 3);
curve(-3, 1, -6, 1, -8, 0);
line(-3, 6);
line(-1, -5);
curve(-2, 1, -4, 1, -5, 0);
const poly = bird.map(([x, y]) => at(x, y));

/** Coverage (0–1) of a nonzero-filled polygon, per pixel. */
function fillPolygon(pts) {
  const cov = new Float32Array(SIZE * SIZE);
  for (let sy = 0; sy < SIZE * SS; sy++) {
    const y = (sy + 0.5) / SS;
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i],
        [x1, y1] = pts[(i + 1) % pts.length];
      if (y0 <= y !== y1 <= y) xs.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    const row = Math.floor(sy / SS) * SIZE;
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (!wind) continue;
      const [a, b] = [xs[i][0], xs[i + 1][0]];
      for (let px = Math.max(0, Math.floor(a)); px < Math.min(SIZE, Math.ceil(b)); px++)
        for (let s = 0; s < SS; s++) {
          const x = px + (s + 0.5) / SS;
          if (x >= a && x < b) cov[row + px] += 1 / (SS * SS);
        }
    }
  }
  return cov;
}

/** Coverage of the rounded-square body. */
function fillBody() {
  const r = 8 * k,
    lo = INSET,
    hi = INSET + BODY;
  const cov = new Float32Array(SIZE * SIZE);
  for (let py = 0; py < SIZE; py++)
    for (let px = 0; px < SIZE; px++) {
      let n = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS,
            y = py + (sy + 0.5) / SS;
          const cx = Math.min(Math.max(x, lo + r), hi - r),
            cy = Math.min(Math.max(y, lo + r), hi - r);
          if (x >= lo && x < hi && y >= lo && y < hi && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) n++;
        }
      cov[py * SIZE + px] = n / (SS * SS);
    }
  return cov;
}

const body = fillBody(),
  wing = fillPolygon(poly);
const data = new Uint8Array(SIZE * SIZE * 4);
const top = [0xf0, 0x86, 0x50],
  bottom = [0xd8, 0x60, 0x2c]; // around --accent #e8743f
for (let i = 0; i < SIZE * SIZE; i++) {
  const t = Math.min(Math.max((Math.floor(i / SIZE) - INSET) / BODY, 0), 1);
  const w = Math.min(wing[i], 1);
  const bg = top.map((c, j) => c + (bottom[j] - c) * t);
  data.set([...bg.map((c) => Math.round(c + (255 - c) * w)), Math.round(255 * body[i])], i * 4);
}
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/kestrel/assets/icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng({ width: SIZE, height: SIZE, data }));
console.log(`wrote ${path.relative(process.cwd(), out)}`);
