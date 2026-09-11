import { at, lum, W, H } from './__trace.mjs';
const X0=400,Y0=480,X1=660,Y1=640;
const test=(c)=>lum(c)>11 && c[1]>c[0]+4;
for(let y=Y0;y<=Y1;y+=4){
  let line=String(y).padStart(4)+' ';
  for(let x=X0;x<=X1;x+=4){ const c=at(x,y); line += lum(c)>30 ? '#' : test(c) ? '+' : '.'; }
  console.log(line);
}
// blob sizes in the shade-only mask (excluding bright)
const m=new Uint8Array(W*H);
for(let y=Y0;y<=Y1;y++)for(let x=X0;x<=X1;x++){const c=at(x,y); if(test(c)) m[y*W+x]=1;}
const seen=new Uint8Array(W*H); const blobs=[];
for(let y=Y0;y<=Y1;y++)for(let x=X0;x<=X1;x++){const i=y*W+x; if(!m[i]||seen[i])continue;
  const st=[i];seen[i]=1;let n=0,a=W,b=0,c2=H,d=0;
  while(st.length){const j=st.pop();const jx=j%W,jy=(j-jx)/W;n++;if(jx<a)a=jx;if(jx>b)b=jx;if(jy<c2)c2=jy;if(jy>d)d=jy;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const k=(jy+dy)*W+jx+dx; if(m[k]&&!seen[k]){seen[k]=1;st.push(k);}}}
  blobs.push({n,x:[a,b],y:[c2,d]});}
blobs.sort((p,q)=>q.n-p.n); console.log(blobs.slice(0,6));
