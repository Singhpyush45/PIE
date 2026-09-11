import fs from 'node:fs';
const { w, h, ch, stride } = JSON.parse(fs.readFileSync('__px.json','utf8'));
const px = fs.readFileSync('__px.raw');
const at = (x,y) => { const o=y*stride+x*ch; return [px[o],px[o+1],px[o+2]]; };
const lum = ([r,g,b]) => 0.2126*r + 0.7152*g + 0.0722*b;
const on = (x,y) => lum(at(x,y)) > 26;
// bbox
let x0=w,y0=h,x1=0,y1=0;
for (let y=0;y<h;y++) for (let x=0;x<w;x++) if (on(x,y)) { if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; }
console.log('bbox', {x0,y0,x1,y1,bw:x1-x0+1,bh:y1-y0+1});
// ascii map 78 cols
const COLS=78, ROWS=44;
let out='';
for (let r=0;r<ROWS;r++){
  let line='';
  for (let c=0;c<COLS;c++){
    const xa=Math.round(c*w/COLS), xb=Math.round((c+1)*w/COLS);
    const ya=Math.round(r*h/ROWS), yb=Math.round((r+1)*h/ROWS);
    let n=0,t=0,R=0,G=0,B=0;
    for(let y=ya;y<yb;y+=2)for(let x=xa;x<xb;x+=2){t++;if(on(x,y)){n++;const p=at(x,y);R+=p[0];G+=p[1];B+=p[2];}}
    const f=n/t;
    if(f<0.06){line+=' ';continue;}
    R/=n;G/=n;B/=n;
    // letter by hue family
    const k = (G>R+18 && G>=B-30) ? 'T' : (B>G+40 ? 'B' : 'C');
    line += f>0.6 ? k : f>0.3 ? k.toLowerCase() : '.';
  }
  out += line.replace(/\s+$/,'') + '\n';
}
console.log(out);
