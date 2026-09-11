import fs from 'node:fs';
let s = fs.readFileSync('public/pie-logo.svg', 'utf8');
const c = { gA: '#ff0000', gB: '#0000ff', gP: '#ff8800', gF: '#8800ff', gL: '#00ff00', gD: '#ffff00' };
for (const [k, v] of Object.entries(c)) s = s.replaceAll(`url(#${k})`, v);
fs.writeFileSync('__dbg.svg', s);
