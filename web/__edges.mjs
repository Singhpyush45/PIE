import fs from 'node:fs';
const { w, h } = JSON.parse(fs.readFileSync('__px.json','utf8'));
const lab = new Int32Array(new Uint8Array(fs.readFileSync('__lab.bin')).buffer);
const comps = JSON.parse(fs.readFileSync('__comps.json','utf8'));
const big = comps.filter(c=>c.area>5000);
const byName = { pi: big.find(c=>c.area>70000), lleg: big.find(c=>c.area>30000&&c.area<40000),
                 barc: big.find(c=>c.area>11000&&c.area<13000), tarc: big.find(c=>c.area>10000&&c.area<11000) };
for (const [name,c] of Object.entries(byName)) console.log(name, c.id, `x:${c.x0}-${c.x1} y:${c.y0}-${c.y1}`);

// circle fit (Kasa) on point set
function fitCircle(pts){
  let Sx=0,Sy=0,Sxx=0,Syy=0,Sxy=0,Sxz=0,Syz=0,Sz=0,n=pts.length;
  for(const [x,y] of pts){const z=x*x+y*y;Sx+=x;Sy+=y;Sxx+=x*x;Syy+=y*y;Sxy+=x*y;Sxz+=x*z;Syz+=y*z;Sz+=z;}
  const A=[[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]], B=[Sxz,Syz,Sz];
  // solve 3x3
  for(let i=0;i<3;i++){
    let p=i; for(let r=i+1;r<3;r++) if(Math.abs(A[r][i])>Math.abs(A[p][i])) p=r;
    [A[i],A[p]]=[A[p],A[i]]; [B[i],B[p]]=[B[p],B[i]];
    for(let r=i+1;r<3;r++){const f=A[r][i]/A[i][i]; for(let cc=i;cc<3;cc++)A[r][cc]-=f*A[i][cc]; B[r]-=f*B[i];}
  }
  const s=[0,0,0];
  for(let i=2;i>=0;i--){let t=B[i]; for(let cc=i+1;cc<3;cc++)t-=A[i][cc]*s[cc]; s[i]=t/A[i][i];}
  const cx=s[0]/2, cy=s[1]/2, r=Math.sqrt(s[2]+cx*cx+cy*cy);
  let err=0; for(const [x,y] of pts) err+=Math.abs(Math.hypot(x-cx,y-cy)-r);
  return {cx:+cx.toFixed(1),cy:+cy.toFixed(1),r:+r.toFixed(1),err:+(err/n).toFixed(2),n};
}
for (const nm of ['tarc','barc']) {
  const c = byName[nm]; const outer=[], inner=[];
  for (let x=c.x0;x<=c.x1;x++){
    let mn=-1,mx=-1;
    for(let y=c.y0;y<=c.y1;y++) if(lab[y*w+x]===c.id){ if(mn<0)mn=y; mx=y; }
    if(mn<0) continue;
    if (mx-mn < 3) continue;
    if (nm==='tarc'){ outer.push([x,mn]); inner.push([x,mx]); } else { outer.push([x,mx]); inner.push([x,mn]); }
  }
  // trim the tapering tips (10% each end) for a cleaner fit
  const t = Math.round(outer.length*0.08);
  console.log(nm,'outer',fitCircle(outer.slice(t,-t||undefined)));
  console.log(nm,'inner',fitCircle(inner.slice(t,-t||undefined)));
  console.log(nm,'thickness by x:', outer.slice(0,0));
  const prof=[];
  for (let x=c.x0;x<=c.x1;x+=Math.round((c.x1-c.x0)/14)){
    let mn=-1,mx=-1; for(let y=c.y0;y<=c.y1;y++) if(lab[y*w+x]===c.id){ if(mn<0)mn=y; mx=y; }
    prof.push(`x${x}:${mn}-${mx}(${mx-mn+1})`);
  }
  console.log('  profile', prof.join(' '));
  // tips: extreme points
  const ends=[];
  for (const x of [c.x0,c.x0+1,c.x0+2,c.x1-2,c.x1-1,c.x1]) {
    let mn=-1,mx=-1; for(let y=c.y0;y<=c.y1;y++) if(lab[y*w+x]===c.id){ if(mn<0)mn=y; mx=y; }
    ends.push(`x${x}:${mn}-${mx}`);
  }
  console.log('  tips', ends.join(' '));
}
