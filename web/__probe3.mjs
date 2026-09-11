import { at, lum, W } from './__trace.mjs';
// For each row, show where the ribbon's dark underside lives.
for (let y = 495; y <= 625; y += 5) {
  let s = '';
  for (let x = 400; x <= 680; x += 4) {
    const c = at(x, y), L = lum(c);
    s += L > 60 ? '#' : L > 34 ? '*' : L > 8 && c[1] > c[0] + 2 ? '+' : L > 8 ? '-' : '.';
  }
  console.log(String(y).padStart(3), s);
}
