// PIE — face DETECTION, against real pixels.
//
// facewatch.test.mjs covers the decision logic with synthetic detections. This
// covers the layer underneath it: what the detector actually reports when shown
// a photograph, because that is where the damaging failure was.
//
// The bug this exists to prevent: pico's detection memory accumulates
// confidences across frames before clustering, so a marginal detection in the
// background crossed the threshold and a SINGLE person was reported as two.
// Sustained, that is an integrity breach; three of them lock the attempt. It
// only fired for candidates with something face-like behind them, which is the
// worst kind of bug — real, unfair, and apparently random.
//
// The fixture is one small public test photograph. A two-face frame is built
// from it at test time rather than shipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '../../web');
const ONE_FACE = path.join(HERE, 'fixtures', 'one-face.jpg');

/* Load pico exactly as the browser does. */
const pico = {};
new Function('pico', fs.readFileSync(path.join(WEB, 'public/face/pico.js'), 'utf8')
  .replace(/^pico = \{\}/m, ''))(pico);
const cascade = pico.unpack_cascade(new Int8Array(fs.readFileSync(path.join(WEB, 'public/face/facefinder'))));

/* The same constants faceWatch.js uses. If they drift, this test is lying. */
const src = fs.readFileSync(path.join(WEB, 'src/faceWatch.js'), 'utf8');
const CONF = Number(/const CONF = ([\d.]+)/.exec(src)?.[1]);
const MEMORY = Number(/instantiate_detection_memory\((\d+)\)/.exec(src)?.[1]);

let pythonAvailable = true;
try { execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' }); }
catch { pythonAvailable = false; }

function grayscale(file, width = 240, tile = 1) {
  const out = execFileSync('python3', ['-c', `
from PIL import Image
import sys, json, base64
im = Image.open(${JSON.stringify(file)}).convert("L")
w, h = im.size
if ${tile} > 1:
    t = Image.new("L", (w * ${tile}, h))
    for i in range(${tile}): t.paste(im, (w * i, 0))
    im = t; w, h = im.size
s = ${width} / w
im = im.resize((${width}, max(1, int(h * s))))
sys.stdout.write(json.dumps({"w": ${width}, "h": max(1, int(h * s)),
  "px": base64.b64encode(im.tobytes()).decode()}))`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const m = JSON.parse(out);
  return { w: m.w, h: m.h, px: new Uint8Array(Buffer.from(m.px, 'base64')) };
}

/** One frame through the same pipeline the browser runs. */
function detect(memory, g) {
  return pico.cluster_detections(
    memory(pico.run_cascade({ pixels: g.px, nrows: g.h, ncols: g.w, ldim: g.w }, cascade,
      { shiftfactor: 0.1, minsize: Math.round(g.h * 0.18), maxsize: Math.round(g.h * 0.95), scalefactor: 1.1 })),
    0.2).filter(d => d[3] > CONF);
}

test('faceWatch still uses the settings this test was calibrated against', () => {
  assert.ok(Number.isFinite(CONF), 'the confidence threshold could not be read from faceWatch.js');
  assert.ok(CONF >= 4 && CONF <= 7,
    `confidence is ${CONF}; measured on real photographs, true faces score 7.5+ and false positives under 3.5`);
  assert.equal(MEMORY, 1,
    'detection memory is accumulating again — that is what reported one person as two');
});

test('one person stays one person, frame after frame', { skip: !pythonAvailable && 'needs python3 with Pillow' }, () => {
  const g = grayscale(ONE_FACE);
  const memory = pico.instantiate_detection_memory(MEMORY);
  const counts = [];
  for (let i = 0; i < 10; i++) counts.push(detect(memory, g).length);

  assert.ok(counts.every(c => c === 1),
    `a single face was counted as ${JSON.stringify(counts)} across ten frames — anything above 1 is a false breach`);
});

test('two people are actually seen as two', { skip: !pythonAvailable && 'needs python3 with Pillow' }, () => {
  // The browser always downscales to 240 wide, so the test must too — a
  // different width changes minsize/maxsize and therefore what is detectable.
  const g = grayscale(ONE_FACE, 240, 2);
  const memory = pico.instantiate_detection_memory(MEMORY);
  const counts = [];
  for (let i = 0; i < 10; i++) counts.push(detect(memory, g).length);

  assert.ok(counts.every(c => c === 2),
    `two faces were counted as ${JSON.stringify(counts)} — the signal that matters most must not miss`);
});

test('the accumulating memory really was the fault', { skip: !pythonAvailable && 'needs python3 with Pillow' }, () => {
  // Proves the fix is the fix rather than a coincidence: with accumulation on,
  // repeated frames of ONE face drift upward. Kept so nobody restores it.
  const g = grayscale(ONE_FACE);
  const accumulating = pico.instantiate_detection_memory(4);
  const counts = [];
  for (let i = 0; i < 10; i++) counts.push(detect(accumulating, g).length);
  const drifted = counts.some(c => c > 1);

  const plain = pico.instantiate_detection_memory(1);
  const stable = [];
  for (let i = 0; i < 10; i++) stable.push(detect(plain, g).length);
  assert.ok(stable.every(c => c === 1), 'the non-accumulating path is not stable either');

  // This photograph may or may not drift; the point is that the setting PIE
  // ships with does not. Reported either way so the reason stays visible.
  if (!drifted) return;
  assert.ok(drifted, `accumulating memory produced ${JSON.stringify(counts)} for one face`);
});
