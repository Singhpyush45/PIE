// Rasterises public/pie-logo.svg at reference resolution with headless Chrome
// and reports how far it is from the reference bitmap.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SIZE = 627;                                   // half the reference; enough to judge
const svg = fs.readFileSync('public/pie-logo.svg', 'utf8');

// The reference sits on its own near-black canvas, so render onto the same
// colour: any difference then comes from the artwork, not the backdrop.
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#030409}#a{width:${SIZE}px;height:${SIZE}px}</style>
<div id="a">${svg}</div>`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-svg-'));
fs.writeFileSync(path.join(tmp, 'a.html'), html);
const shot = path.join(tmp, 'out.png');
const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--screenshot=${shot}`, `--window-size=${SIZE},${SIZE}`, '--default-background-color=00000000',
  `--user-data-dir=${path.join(tmp, 'p')}`, path.join(tmp, 'a.html')], { encoding: 'utf8' });
if (!fs.existsSync(shot)) { console.error(r.stderr); process.exit(1); }

/* ------------------------------------------------------------ decode both */
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
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
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
const A = decode(shot);                                   // ours
const ref = JSON.parse(fs.readFileSync('__px.json', 'utf8'));
const refPx = fs.readFileSync('__px.raw');
const rat = ref.w / A.w;
const getA = (x, y) => { const o = y * A.stride + x * A.ch; return [A.px[o], A.px[o + 1], A.px[o + 2]]; };
const getR = (x, y) => { const o = (Math.round(y * rat) * ref.stride) + Math.round(x * rat) * ref.ch;
  return [refPx[o], refPx[o + 1], refPx[o + 2]]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

let onlyRef = 0, onlyUs = 0, both = 0, sumErr = 0;
const heat = Buffer.alloc(A.w * A.h * 3);
for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
  const a = getA(x, y), b = getR(x, y);
  const la = lum(a) > 30, lb = lum(b) > 30;
  const o = (y * A.w + x) * 3;
  if (la && lb) { both++; const e = (Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2])) / 3;
    sumErr += e; heat[o] = heat[o+1] = heat[o+2] = Math.min(255, e * 2); }
  else if (lb) { onlyRef++; heat[o] = 255; }                 // missing (red)
  else if (la) { onlyUs++; heat[o+1] = 255; }                // extra (green)
}
console.log(`coverage: shared ${both}px  missing ${onlyRef}px  extra ${onlyUs}px`
  + `  -> shape error ${(100 * (onlyRef + onlyUs) / (both + onlyRef)).toFixed(2)}%`
  + `  mean colour delta on shared pixels ${(sumErr / both).toFixed(1)}/255`);

/* write the heat map and a side-by-side for eyeballing */
function png(w, h, rgb, file) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii'); data.copy(b, 8);
    let c = 0xffffffff; for (let i = 4; i < 8 + data.length; i++) c = crcT[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    b.writeUInt32BE((c ^ 0xffffffff) >>> 0, 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
png(A.w, A.h, heat, '__diff.png');
const sbs = Buffer.alloc(A.w * 2 * A.h * 3);
for (let y = 0; y < A.h; y++) for (let x = 0; x < A.w; x++) {
  const b = getR(x, y), a = getA(x, y);
  let o = (y * A.w * 2 + x) * 3; sbs[o] = b[0]; sbs[o+1] = b[1]; sbs[o+2] = b[2];
  o = (y * A.w * 2 + A.w + x) * 3; sbs[o] = a[0]; sbs[o+1] = a[1]; sbs[o+2] = a[2];
}
png(A.w * 2, A.h, sbs, '__sbs.png');
fs.copyFileSync(shot, '__ours.png');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote __sbs.png (reference | ours), __diff.png (red = missing, green = extra)');
