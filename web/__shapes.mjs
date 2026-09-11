// Driver: builds the masks, traces every shape, writes __paths.json.
import fs from 'node:fs';
import { at, lum, W, H, outline, toPath } from './__trace.mjs';

const S = 100 / W;                                    // 1254px source -> 100 unit viewBox
const idx = (x, y) => y * W + x;

function maskFrom(test) {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (test(at(x, y), x, y)) m[idx(x, y)] = 1;
  return m;
}
function blobFrom(mask, seed) {
  const out = new Uint8Array(W * H), st = [idx(...seed)];
  out[st[0]] = 1;
  while (st.length) {
    const j = st.pop(), x = j % W, y = (j - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (mask[idx(nx, ny)] && !out[idx(nx, ny)]) { out[idx(nx, ny)] = 1; st.push(idx(nx, ny)); }
    }
  }
  return out;
}
function seedIn(mask, x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask[idx(x, y)]) return [x, y];
  return null;
}
const bbox = m => { let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { n++; const x = i % W, y = (i - x) / W;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { n, x0, y0, x1, y1 }; };

/* Morphological closing: seals the hairline dark channels that the shading
   leaves inside the glyph, without moving the silhouette's real edges. */
function close(mask, r) {
  const dil = new Uint8Array(W * H), out = new Uint8Array(W * H);
  const b = bbox(mask);
  for (let y = b.y0 - r; y <= b.y1 + r; y++) for (let x = b.x0 - r; x <= b.x1 + r; x++) {
    let hit = 0;
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r && mask[idx(x + dx, y + dy)]) { hit = 1; break; }
    if (hit) dil[idx(x, y)] = 1;
  }
  for (let y = b.y0 - r; y <= b.y1 + r; y++) for (let x = b.x0 - r; x <= b.x1 + r; x++) {
    let all = 1;
    for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++)
      if (dx * dx + dy * dy <= r * r && !dil[idx(x + dx, y + dy)]) { all = 0; break; }
    if (all) out[idx(x, y)] = 1;
  }
  return out;
}

/* Bridges one narrow dark channel without touching the rest of the outline:
   closes a padded copy of the window and ORs only the window back in. */
function seal(mask, [x0, y0, x1, y1, r]) {
  const sub = new Uint8Array(W * H);
  for (let y = y0 - r - 1; y <= y1 + r + 1; y++) for (let x = x0 - r - 1; x <= x1 + r + 1; x++)
    if (mask[idx(x, y)]) sub[idx(x, y)] = 1;
  const c = close(sub, r);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (c[idx(x, y)]) mask[idx(x, y)] = 1;
  return mask;
}

const bright = maskFrom(c => lum(c) > 30);
// Above this the bar, both legs and the ribbon's underside form one silhouette.
const solid = maskFrom(c => lum(c) > 20);
/* The motion dashes sit close enough to the ribbon's hook that their halo can
   bridge the two; keep the shading masks clear of them. */
const PILL = JSON.parse(fs.readFileSync('__comps.json', 'utf8'))
  .filter(c => c.area > 150 && c.area < 1000);
const near = (x, y) => PILL.some(p => x >= p.x0 - 7 && x <= p.x1 + 7 && y >= p.y0 - 7 && y <= p.y1 + 7);
/* Everything teal but too dark for `solid`: the ribbon's underside, its curled
   hook and the soft dark fringe along the bar's bottom edge. */
const teal = (c, x, y) => { const L = lum(c); return L > 7 && L <= 62 && c[1] > c[0] + 2 && !near(x, y); };
/* The almond of shading under the bar, plus the dimmer rounded tip where the
   ribbon finishes curling: that tip is brighter than the rest of the underside
   but still far below the bar, so it needs its own ceiling. */
const shade = maskFrom((c, x, y) => x > 413 && x < 548 && y > 497 && y < 613 && teal(c, x, y)
  && lum(c) <= (x < 482 && y > 552 ? 60 : 34));
const fringe = maskFrom((c, x, y) => x > 429 && x < 960 && y > 497 && y < 618 && teal(c, x, y));
// The silhouette the glyph is cut from: bright core plus that shading, so the
// leg/bar junctions stay continuous instead of opening into black slits. The one
// remaining channel — between the fold's tip and the left leg — is sealed, since
// a boundary walk down it makes the fitter bulge across the leg's top.
const glyph = seal(solid.map((v, i) => v || fringe[i]), [498, 512, 548, 592, 11]);

/* The ribbon passes over the left leg, and the leg carries its own cyan ramp, so
   the two need a seam. Take it from the artwork: for every column, the leg (and
   the shading under the bar) begins where the bar's bright surface ends. Cutting
   there gives a smooth edge instead of the ragged one a brightness threshold
   leaves, which otherwise lets the bar's gradient bulge through the leg's top. */
const legTop = new Int32Array(W).fill(H);
for (let x = 424; x <= 648; x++)
  for (let y = 505; y <= 620; y++) if (lum(at(x, y)) <= 60) { legTop[x] = y; break; }
/* …and the curl keeps its own lit edge: left of the leg proper the bright rim
   running down the ribbon's fold belongs to the bar, not to the leg. */
const legMask = new Uint8Array(W * H);
for (let x = 424; x <= 648; x++) for (let y = legTop[x]; y < H; y++)
  if (glyph[idx(x, y)] && !(x < 446 && y < 620)) legMask[idx(x, y)] = 1;

const jobs = {
  tarc:  { mask: bright,  seed: [613, 250], opt: { tol: 1.1, sm: 5 } },
  barc:  { mask: bright,  seed: [947, 577], opt: { tol: 1.1, sm: 5 } },
  pisil: { mask: glyph,   seed: [947, 413], opt: { tol: 1.2, sm: 5 }, close: 3 },
  lleg:  { mask: legMask, seed: [560, 700], opt: { tol: 1.3, sm: 5 } },
  fold:  { mask: shade,   seed: seedIn(shade, 452, 545, 500, 565), opt: { tol: 1.8, sm: 8, climit: 100 }, close: 3 },
};

const out = {};
for (const [name, j] of Object.entries(jobs)) {
  let m = blobFrom(j.mask, j.seed);
  if (j.close) m = close(m, j.close);
  const b = bbox(m);
  const seed = seedIn(m, b.x0, b.y0, b.x1, b.y1);
  const segs = outline(m, seed, j.opt);
  out[name] = toPath(segs, S);
  console.log(`${name}: area ${b.n} bbox ${b.x0}-${b.x1} / ${b.y0}-${b.y1}`
    + ` -> ${segs.length} curves, ${out[name].length} chars`);
}
fs.writeFileSync('__paths.json', JSON.stringify(out, null, 1));

/* motion dashes: rounded rects straight off the connected-component pass */
const pills = JSON.parse(fs.readFileSync('__comps.json', 'utf8'))
  .filter(c => c.area > 150 && c.area < 1000)
  .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  .map(c => [c.x0, c.y0, c.x1 - c.x0 + 1]);
console.log('pills', pills.length, JSON.stringify(pills));
fs.writeFileSync('__pills.json', JSON.stringify(pills));
