import fs from 'node:fs';
import zlib from 'node:zlib';
const buf = fs.readFileSync('public/pie-logo.png');
let p = 8, w=0, h=0, bd=0, ct=0, idat=[];
while (p < buf.length) {
  const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p+4, p+8);
  const data = buf.subarray(p+8, p+8+len);
  if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
  if (type === 'IDAT') idat.push(data);
  if (type === 'IEND') break;
  p += 12 + len;
}
console.log({ w, h, bitDepth: bd, colorType: ct });
const raw = zlib.inflateSync(Buffer.concat(idat));
const ch = ct === 6 ? 4 : ct === 2 ? 3 : 1;
const stride = w * ch;
const px = Buffer.alloc(h * stride);
let prev = Buffer.alloc(stride);
for (let y = 0; y < h; y++) {
  const f = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  const cur = Buffer.from(line);
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
    if (f === 1) cur[i] = (cur[i] + a) & 255;
    else if (f === 2) cur[i] = (cur[i] + b) & 255;
    else if (f === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 255;
    else if (f === 4) { const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
      cur[i] = (cur[i] + (pa<=pb&&pa<=pc ? a : pb<=pc ? b : c)) & 255; }
  }
  cur.copy(px, y * stride); prev = cur;
}
const at = (x, y) => { const o = y*stride + x*ch; return [px[o], px[o+1], px[o+2]]; };
const hex = ([r,g,b]) => '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
globalThis.__at = at; globalThis.__hex = hex; globalThis.__w = w; globalThis.__h = h;
fs.writeFileSync('__px.raw', px);
fs.writeFileSync('__px.json', JSON.stringify({ w, h, ch, stride }));
console.log('corner', hex(at(5,5)), 'center-bg', hex(at(60, 600)));
