import { at, lum, W, H } from './__trace.mjs';
for (const TH of [14,16,18,20,22]) {
  const m=new Uint8Array(W*H);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++) if(lum(at(x,y))>TH) m[y*W+x]=1;
  const seen=new Uint8Array(W*H); const blobs=[];
  for(let i=0;i<m.length;i++){ if(!m[i]||seen[i])continue; const st=[i];seen[i]=1;
    let n=0,a=W,b=0,c=H,d=0;
    while(st.length){const j=st.pop();const jx=j%W,jy=(j-jx)/W;n++;
      if(jx<a)a=jx;if(jx>b)b=jx;if(jy<c)c=jy;if(jy>d)d=jy;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=jx+dx,ny=jy+dy;
        if(nx<0||ny<0||nx>=W||ny>=H)continue; const k=ny*W+nx; if(m[k]&&!seen[k]){seen[k]=1;st.push(k);}}}
    if(n>400) blobs.push({n,x:[a,b],y:[c,d]});}
  blobs.sort((p,q)=>q.n-p.n);
  console.log('th='+TH, 'blobs>400:', blobs.length, blobs.slice(0,4).map(b=>`${b.n} x${b.x} y${b.y}`).join(' | '));
}
