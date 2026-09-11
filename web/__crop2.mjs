// Crops the brand-mark corner out of each verification screenshot and tiles the
// four (light/dark x landing/shell) into one image at 6x for eyeballing.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { png } from './__zoom.mjs';
function decode(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ct = 0, idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1, stride = w * ch;
  const px = Buffer.alloc(h * stride); let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      if (f === 1) cur[i] = (cur[i] + a) & 255;
      else if (f === 2) cur[i] = (cur[i] + b) & 255;
      else if (f === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    }
    cur.copy(px, y * stride); prev = cur;
  }
  return { w, h, ch, stride, px };
}
const Z = 6, CW = 70, CH = 60, GAP = 6;
const jobs = [['.shot-light-shell.png', 20, 12], ['.shot-dark-shell.png', 20, 12],
              ['.shot-light-landing.png', 248, 12], ['.shot-dark-landing.png', 248, 12]];
const OW = (CW * Z + GAP) * jobs.length, OH = CH * Z;
const out = Buffer.alloc(OW * OH * 3);
jobs.forEach(([file, x0, y0], k) => {
  const A = decode(file);
  for (let y = 0; y < CH * Z; y++) for (let x = 0; x < CW * Z; x++) {
    const i = (y0 + (y / Z | 0)) * A.stride + (x0 + (x / Z | 0)) * A.ch;
    const o = (y * OW + k * (CW * Z + GAP) + x) * 3;
    out[o] = A.px[i]; out[o + 1] = A.px[i + 1]; out[o + 2] = A.px[i + 2];
  }
});
png(OW, OH, out, '__tiles.png');
console.log('__tiles.png', `${OW}x${OH}`, jobs.map(j => j[0]).join('  '));
