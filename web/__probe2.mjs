import { at, lum, W, H } from './__trace.mjs';
const hex = ([r,g,b]) => '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
console.log('--- fold region grid (x 400..580 step 20, y 490..630 step 20)');
let hdr='y-x  '; for(let x=400;x<=580;x+=20) hdr+=String(x).padStart(9); console.log(hdr);
for(let y=490;y<=630;y+=20){ let line=String(y).padStart(4)+' ';
  for(let x=400;x<=580;x+=20) line += (hex(at(x,y))+'('+Math.round(lum(at(x,y)))+')').padStart(9);
  console.log(line); }
console.log('--- pill colour: top/mid/bottom of pill x 316-359 y 548-563');
for(const y of [549,551,555,559,562]) console.log(y, hex(at(338,y)));
console.log('--- pill mid colours');
for (const [x,y] of [[338,555],[443,447],[276,483],[390,555],[371,589],[280,555],[297,519]]) console.log(x,y,hex(at(x,y)));
console.log('--- top arc along length (outer->inner mid)');
for (const [x,y] of [[360,400],[400,345],[460,302],[540,270],[620,260],[700,268],[780,297],[840,358],[875,392]]) console.log(x,y,hex(at(x,y)));
console.log('--- bottom arc along length');
for (const [x,y] of [[470,941],[520,965],[600,977],[680,972],[760,950],[820,908],[880,838],[925,772],[948,660],[950,620]]) console.log(x,y,hex(at(x,y)));
console.log('--- pi bar: top edge / middle / bottom edge across x');
for (const x of [460,500,560,620,700,780,860,900,930]) {
  const col=[]; for (const y of [425,440,460,480,500,520,540]) col.push(hex(at(x,y)));
  console.log('x'+x, col.join(' '));
}
console.log('--- left leg down the middle');
for (const [x,y] of [[560,545],[555,580],[550,620],[540,680],[530,740],[515,800],[495,855],[490,880]]) console.log(x,y,hex(at(x,y)));
console.log('--- right leg down the middle');
for (const [x,y] of [[730,545],[730,590],[725,650],[715,720],[710,790],[730,850],[790,860],[830,800]]) console.log(x,y,hex(at(x,y)));
