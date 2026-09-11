import fs from 'node:fs';
import zlib from 'node:zlib';
const { w, h, ch, stride } = JSON.parse(fs.readFileSync('__px.json','utf8'));
const px = fs.readFileSync('__px.raw');
export function crop(x0,y0,cw,chh,scale,out){
  const W=cw*scale, H=chh*scale;
  const raw = Buffer.alloc(H*(W*3+1));
  for(let y=0;y<H;y++){
    raw[y*(W*3+1)]=0;
    for(let x=0;x<W;x++){
      const sx=x0+Math.floor(x/scale), sy=y0+Math.floor(y/scale);
      const o=sy*stride+sx*ch, d=y*(W*3+1)+1+x*3;
      raw[d]=px[o];raw[d+1]=px[o+1];raw[d+2]=px[o+2];
    }
  }
  const chunk=(type,data)=>{const b=Buffer.alloc(8+data.length+4);b.writeUInt32BE(data.length,0);b.write(type,4,'ascii');
    data.copy(b,8);const crcT=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;crcT[n]=c>>>0;}
    let c=0xffffffff;for(let i=4;i<8+data.length;i++)c=crcT[(c^b[i])&0xff]^(c>>>8);b.writeUInt32BE((c^0xffffffff)>>>0,8+data.length);return b;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
  fs.writeFileSync(out,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
  console.log(out,W+'x'+H);
}
const a=process.argv.slice(2);
if(a.length) crop(+a[0],+a[1],+a[2],+a[3],+a[4],a[5]);
