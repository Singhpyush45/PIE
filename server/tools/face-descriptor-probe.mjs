// PIE — regenerate server/test/fixtures/descriptors.json.
//
// Runs the REAL face-recognition model in a REAL browser over
// server/test/fixtures/one-face.jpg and three mild variations of it, and writes
// out the descriptors plus the numbers that matter.
//
//   node server/tools/face-descriptor-probe.mjs
//
// This exists because a wrong assumption about those numbers — that the model
// emits unit vectors, when it emits vectors about 1.39 long — broke live
// verification while every synthetic test passed. Measuring beats assuming, and
// the fixture it produces is what the identity tests assert against.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ROOT = path.join(REPO, 'web', 'public');
const FIX = path.join(REPO, 'server', 'test', 'fixtures', 'one-face.jpg');
const MIME = {'.json':'application/json','.bin':'application/octet-stream','.jpg':'image/jpeg','.js':'text/javascript','.html':'text/html'};
const srv = http.createServer((req,res)=>{
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = u === '/face.jpg' ? FIX
    : u === '/faceapi.js' ? path.join(REPO, 'web', 'node_modules', '@vladmandic', 'face-api', 'dist', 'face-api.esm.js')
    : path.join(ROOT, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, {'content-type': MIME[path.extname(f)] || 'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});
await new Promise(r=>srv.listen(0,'127.0.0.1',r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const pg = await b.newPage();

await pg.goto(BASE + '/x.html').catch(()=>{});
await pg.setContent(`<html><body><img id="im" src="${BASE}/face.jpg"><canvas id="c"></canvas></body></html>`);
await pg.waitForFunction(() => document.getElementById('im').complete);

const out = await pg.evaluate(async (BASE) => {
  const fa = await import(BASE + '/faceapi.js');
  await fa.nets.tinyFaceDetector.loadFromUri(BASE + '/face/models');
  await fa.nets.faceLandmark68Net.loadFromUri(BASE + '/face/models');
  await fa.nets.faceRecognitionNet.loadFromUri(BASE + '/face/models');
  const img = document.getElementById('im');

  const opts = new fa.TinyFaceDetectorOptions({inputSize:416, scoreThreshold:0.5});
  const norm = v => Math.sqrt(v.reduce((a,x)=>a+x*x,0));
  const dist = (a,bb) => Math.sqrt(a.reduce((s,x,i)=>s+(x-bb[i])**2,0));

  // Several passes over the same image with small changes, to stand in for
  // "the same person on consecutive frames".
  const variants = [];
  for (const [w,h,filter] of [[img.naturalWidth,img.naturalHeight,'none'],
                              [Math.round(img.naturalWidth*0.92),Math.round(img.naturalHeight*0.92),'none'],
                              [img.naturalWidth,img.naturalHeight,'brightness(1.15)'],
                              [img.naturalWidth,img.naturalHeight,'contrast(1.12)']]) {
    const c = document.createElement('canvas'); c.width=w; c.height=h;
    const ctx = c.getContext('2d'); ctx.filter = filter; ctx.drawImage(img,0,0,w,h);
    const r = await fa.detectAllFaces(c, opts).withFaceLandmarks().withFaceDescriptors();
    if (r.length === 1) variants.push(Array.from(r[0].descriptor));
  }
  if (!variants.length) return { error: 'no face detected in the fixture' };

  const norms = variants.map(norm);
  const mean = new Array(128).fill(0);
  for (const d of variants) for (let i=0;i<128;i++) mean[i]+=d[i];
  for (let i=0;i<128;i++) mean[i]/=variants.length;
  const meanNorm = norm(mean);
  const unit = mean.map(v=>v/meanNorm);

  return {
    descriptors: variants,
    samples: variants.length,
    rawNorms: norms.map(n=>+n.toFixed(4)),
    meanNorm: +meanNorm.toFixed(4),
    sameFaceDistances_raw: variants.slice(1).map(d=>+dist(variants[0],d).toFixed(4)),
    distance_rawSample_vs_rawMean: +dist(variants[0], mean).toFixed(4),
    distance_rawSample_vs_UNITmean: +dist(variants[0], unit).toFixed(4),
  };
}, BASE);

const { descriptors, ...summary } = out;
console.log(JSON.stringify(summary, null, 2));

const round = v => v.map(x => +x.toFixed(6));
fs.writeFileSync(path.join(REPO, 'server', 'test', 'fixtures', 'descriptors.json'), JSON.stringify({
  note: 'Real 128-number descriptors from @vladmandic/face-api faceRecognitionNet, computed in a real '
    + 'browser from fixtures/one-face.jpg and three mild variations of it (a slight rescale, a '
    + 'brightness change, a contrast change). They stand in for the same person on consecutive camera '
    + 'frames. Regenerate with server/tools/face-descriptor-probe.mjs.',
  model: 'face-api/faceRecognitionNet',
  measured: summary,
  samples: descriptors.map(round),
}, null, 1));
console.log('\n  wrote server/test/fixtures/descriptors.json');
await b.close(); srv.close();
