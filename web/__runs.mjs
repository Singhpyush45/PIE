import fs from 'node:fs';
const { w, h, ch, stride } = JSON.parse(fs.readFileSync('__px.json','utf8'));
const px = fs.readFileSync('__px.raw');
const at = (x,y) => { const o=y*stride+x*ch; return [px[o],px[o+1],px[o+2]]; };
const lum = ([r,g,b]) => 0.2126*r+0.7152*g+0.0722*b;
const on = (x,y) => lum(at(x,y)) > 30;
const hex = ([r,g,b]) => '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
for (const y of [255,270,290,310,330,360,400,440,470,500,530,560,590,620,650,700,750,800,850,900,930,960,980]) {
  const runs=[]; let s=-1;
  for (let x=0;x<w;x++){ const v=on(x,y); if(v&&s<0)s=x; if(!v&&s>=0){ if(x-s>2) runs.push([s,x-1]); s=-1; } }
  if(s>=0) runs.push([s,w-1]);
  console.log('y='+y, runs.map(([a,b])=>`${a}-${b}(${b-a+1})${hex(at(Math.round((a+b)/2),y))}`).join(' '));
}
