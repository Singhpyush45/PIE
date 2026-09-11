// Traces the reference bitmap into a small number of cubic beziers.
// Boundary walk -> corner split -> per-run smoothing (corners pinned) ->
// least-squares cubic fit that splits only where the error demands it.
import fs from 'node:fs';

const { w, h, ch, stride } = JSON.parse(fs.readFileSync('__px.json', 'utf8'));
const px = fs.readFileSync('__px.raw');
export const at = (x, y) => { const o = y * stride + x * ch; return [px[o], px[o + 1], px[o + 2]]; };
export const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const W = w, H = h;

/* ---------------------------------------------------------------- boundary */
const DIRS = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
export function trace(mask, start) {
  const get = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const out = [];
  let [cx, cy] = start, dir = 6;
  const first = `${cx},${cy}`;
  let guard = 0;
  do {
    out.push([cx, cy]);
    let moved = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8;
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (get(nx, ny)) { cx = nx; cy = ny; dir = d; moved = true; break; }
    }
    if (!moved) break;
  } while ((`${cx},${cy}` !== first || out.length < 4) && ++guard < 400000);
  return out;
}

/* Averages each point over a window that shrinks to nothing at the two ends,
   so a run can be de-jittered without dragging its corner endpoints inward. */
function smoothRun(pts, k) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const kk = Math.min(k, i, n - 1 - i);
    if (kk === 0) { out.push(pts[i]); continue; }
    let sx = 0, sy = 0;
    for (let j = -kk; j <= kk; j++) { sx += pts[i + j][0]; sy += pts[i + j][1]; }
    out.push([sx / (2 * kk + 1), sy / (2 * kk + 1)]);
  }
  return out;
}

/* ------------------------------------------------------------- bezier fit */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const norm = a => Math.hypot(a[0], a[1]);

function params(pts) {
  const t = [0];
  for (let i = 1; i < pts.length; i++) t.push(t[i - 1] + norm(sub(pts[i], pts[i - 1])));
  const L = t[t.length - 1] || 1;
  return t.map(v => v / L);
}

function fitCubic(pts) {
  const P0 = pts[0], P3 = pts[pts.length - 1], t = params(pts);
  let a11 = 0, a12 = 0, a22 = 0, b1 = [0, 0], b2 = [0, 0];
  for (let i = 0; i < pts.length; i++) {
    const u = t[i], m = 1 - u;
    const A1 = 3 * m * m * u, A2 = 3 * m * u * u;
    const base = [m ** 3 * P0[0] + u ** 3 * P3[0], m ** 3 * P0[1] + u ** 3 * P3[1]];
    const R = sub(pts[i], base);
    a11 += A1 * A1; a12 += A1 * A2; a22 += A2 * A2;
    b1 = [b1[0] + A1 * R[0], b1[1] + A1 * R[1]];
    b2 = [b2[0] + A2 * R[0], b2[1] + A2 * R[1]];
  }
  const det = a11 * a22 - a12 * a12;
  let P1, P2;
  if (Math.abs(det) < 1e-9) {
    P1 = [P0[0] + (P3[0] - P0[0]) / 3, P0[1] + (P3[1] - P0[1]) / 3];
    P2 = [P0[0] + 2 * (P3[0] - P0[0]) / 3, P0[1] + 2 * (P3[1] - P0[1]) / 3];
  } else {
    P1 = [(b1[0] * a22 - b2[0] * a12) / det, (b1[1] * a22 - b2[1] * a12) / det];
    P2 = [(b2[0] * a11 - b1[0] * a12) / det, (b2[1] * a11 - b1[1] * a12) / det];
  }
  let worst = 0, wi = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const u = t[i], m = 1 - u;
    const bx = m ** 3 * P0[0] + 3 * m * m * u * P1[0] + 3 * m * u * u * P2[0] + u ** 3 * P3[0];
    const by = m ** 3 * P0[1] + 3 * m * m * u * P1[1] + 3 * m * u * u * P2[1] + u ** 3 * P3[1];
    const e = Math.hypot(bx - pts[i][0], by - pts[i][1]);
    if (e > worst) { worst = e; wi = i; }
  }
  return { P0, P1, P2, P3, worst, wi };
}

function fitSeq(pts, tol, depth = 0) {
  const f = fitCubic(pts);
  if (f.worst <= tol || pts.length < 10 || depth > 8) return [f];
  const i = Math.min(Math.max(f.wi, 4), pts.length - 5);
  return [...fitSeq(pts.slice(0, i + 1), tol, depth + 1), ...fitSeq(pts.slice(i), tol, depth + 1)];
}

/* Corners: the sharpest points of high direction change, measured on the raw
   walk over a wide window so antialiasing wobble cannot fake one. */
function corners(pts, k, limit) {
  const n = pts.length, score = [];
  for (let i = 0; i < n; i++) {
    const a = sub(pts[(i - k + n) % n], pts[i]), b = sub(pts[(i + k) % n], pts[i]);
    const c = dot(a, b) / (norm(a) * norm(b) || 1);
    score.push(Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (score[i] > limit) continue;
    let best = true;
    for (let j = -k; j <= k; j++) if (score[(i + j + n) % n] < score[i]) { best = false; break; }
    if (best) out.push(i);
  }
  return out;
}

/** mask + seed pixel -> array of cubic segments in bitmap coordinates */
export function outline(mask, seed, { tol = 1.8, sm = 6, ck = 14, climit = 105 } = {}) {
  const raw = trace(mask, seed);
  if (raw.length < 16) return [];
  const n = raw.length;
  let cs = corners(raw, ck, climit);
  if (cs.length < 2) cs = [0, 1, 2, 3].map(i => Math.round(i * n / 4));
  const segs = [];
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i], b = cs[(i + 1) % cs.length];
    let run = a < b ? raw.slice(a, b + 1) : [...raw.slice(a), ...raw.slice(0, b + 1)];
    if (run.length < 4) continue;
    run = smoothRun(run, sm);
    segs.push(...fitSeq(run, tol));
  }
  return segs;
}

export function toPath(segs, sc = 1, p = 2) {
  const f = v => +v.toFixed(p);
  let d = `M${f(segs[0].P0[0] * sc)} ${f(segs[0].P0[1] * sc)}`;
  for (const s of segs)
    d += `C${f(s.P1[0] * sc)} ${f(s.P1[1] * sc)} ${f(s.P2[0] * sc)} ${f(s.P2[1] * sc)} `
       + `${f(s.P3[0] * sc)} ${f(s.P3[1] * sc)}`;
  return d + 'Z';
}
