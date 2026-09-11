import { at, lum } from './__trace.mjs';
for (let y = 505; y <= 545; y += 2) {
  let s = '';
  for (let x = 500; x <= 620; x += 2) {
    const c = at(x, y), L = lum(c);
    s += L > 60 ? '#' : L > 34 ? '*' : L > 20 ? ':' : L > 7 ? '+' : '.';
  }
  console.log(String(y).padStart(3), s);
}
