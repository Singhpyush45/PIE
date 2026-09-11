// 2-up zoom on a region: reference (left) beside our render (right).
import fs from 'node:fs';
import zlib from 'node:zlib';

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
export function png(w, h, rgb, file) {
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

const [X, Y, CW, CH, Z, out] = process.argv.slice(2);
if (X !== undefined) {
const x0 = +X, y0 = +Y, cw = +CW, chh = +CH, z = +Z || 2;
const ref = JSON.parse(fs.readFileSync('__px.json', 'utf8'));
const refPx = fs.readFileSync('__px.raw');
const A = decode('__ours.png');
const sc = ref.w / A.w;                                     // reference px per render px
const W = cw * z, H = chh * z, GAP = 8;
const buf = Buffer.alloc((W * 2 + GAP) * H * 3);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = x0 + Math.floor(x / z), sy = y0 + Math.floor(y / z);
  let o = (y * (W * 2 + GAP) + x) * 3, i = sy * ref.stride + sx * 3;
  buf[o] = refPx[i]; buf[o+1] = refPx[i+1]; buf[o+2] = refPx[i+2];
  const ax = Math.round(sx / sc), ay = Math.round(sy / sc);
  o = (y * (W * 2 + GAP) + W + GAP + x) * 3; i = ay * A.stride + ax * A.ch;
  buf[o] = A.px[i]; buf[o+1] = A.px[i+1]; buf[o+2] = A.px[i+2];
}
png(W * 2 + GAP, H, buf, out || '__zoom.png');
console.log(out || '__zoom.png', `${W * 2 + GAP}x${H}`);
}
