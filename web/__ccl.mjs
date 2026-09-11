import fs from 'node:fs';
const { w, h, ch, stride } = JSON.parse(fs.readFileSync('__px.json','utf8'));
const px = fs.readFileSync('__px.raw');
const at = (x,y) => { const o=y*stride+x*ch; return [px[o],px[o+1],px[o+2]]; };
const lum = ([r,g,b]) => 0.2126*r+0.7152*g+0.0722*b;
const mask = new Uint8Array(w*h);
for (let y=0;y<h;y++) for (let x=0;x<w;x++) mask[y*w+x] = lum(at(x,y)) > 30 ? 1 : 0;
const lab = new Int32Array(w*h).fill(-1);
let n=0; const comps=[];
const stack=[];
for (let i=0;i<w*h;i++){
  if(!mask[i]||lab[i]>=0) continue;
  const id=n++; let area=0,x0=w,y0=h,x1=0,y1=0,R=0,G=0,B=0;
  stack.push(i); lab[i]=id;
  while(stack.length){
    const j=stack.pop(); const x=j%w, y=(j-x)/w;
    area++; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
    const c=at(x,y); R+=c[0];G+=c[1];B+=c[2];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=w||ny>=h) continue;
      const k=ny*w+nx; if(mask[k]&&lab[k]<0){lab[k]=id;stack.push(k);}
    }
  }
  comps.push({id,area,x0,y0,x1,y1,cx:Math.round((x0+x1)/2),cy:Math.round((y0+y1)/2),
    col:'#'+[R/area,G/area,B/area].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('')});
}
comps.sort((a,b)=>b.area-a.area);
console.log('components:', comps.length);
for (const c of comps.filter(c=>c.area>150))
  console.log(`area=${String(c.area).padStart(6)} x:${c.x0}-${c.x1} y:${c.y0}-${c.y1} w=${c.x1-c.x0+1} h=${c.y1-c.y0+1} mean=${c.col}`);
fs.writeFileSync('__lab.bin', Buffer.from(new Uint8Array(lab.buffer)));
fs.writeFileSync('__comps.json', JSON.stringify(comps));
