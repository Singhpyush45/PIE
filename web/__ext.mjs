import fs from 'node:fs';
import { W, H } from './__trace.mjs';
const lab = new Int32Array(new Uint8Array(fs.readFileSync('__lab.bin')).buffer);
const comps = JSON.parse(fs.readFileSync('__comps.json','utf8'));
const byArea = a => comps.reduce((b,c)=>Math.abs(c.area-a)<Math.abs(b.area-a)?c:b);
for (const [nm,a] of [['tarc',10108],['barc',11953]]) {
  const c = byArea(a);
  let minY=[0,H], maxY=[0,0], minX=[W,0], maxX=[0,0];
  for(let y=c.y0;y<=c.y1;y++)for(let x=c.x0;x<=c.x1;x++){ if(lab[y*W+x]!==c.id) continue;
    if(y<minY[1])minY=[x,y]; if(y>maxY[1])maxY=[x,y]; if(x<minX[0])minX=[x,y]; if(x>maxX[0])maxX=[x,y]; }
  console.log(nm,'minY',minY,'maxY',maxY,'minX',minX,'maxX',maxX);
  // outer/inner edge at a few x for the ends
  const at_x = x => { let mn=-1,mx=-1; for(let y=c.y0;y<=c.y1;y++) if(lab[y*W+x]===c.id){ if(mn<0)mn=y; mx=y; } return [mn,mx]; };
  const at_y = y => { let mn=-1,mx=-1; for(let x=c.x0;x<=c.x1;x++) if(lab[y*W+x]===c.id){ if(mn<0)mn=x; mx=x; } return [mn,mx]; };
  console.log('  cols', [c.x0,c.x0+8,c.x0+20,c.x1-20,c.x1-8,c.x1].map(x=>`x${x}:${at_x(x)}`).join(' '));
  console.log('  rows', [c.y0,c.y0+8,c.y0+20,c.y1-20,c.y1-8,c.y1].map(y=>`y${y}:${at_y(y)}`).join(' '));
}
