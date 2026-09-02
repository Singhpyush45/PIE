// PIE — face-check decision logic.
//
// The detector itself is a fixed third-party cascade; what needed testing is
// PIE's own judgement on top of it, because that is what turns a flicker into
// an integrity breach against a real person. With the threshold at three, a
// detector that complains on one bad frame would lock honest candidates out of
// their own assessment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaceSignals } from '../../web/src/faceWatch.js';

const FACE = [50, 50, 40];      // [row, col, size]
const one = [FACE];
const none = [];
const two = [FACE, [50, 180, 40]];

test('one bad frame never becomes a breach', () => {
  const feed = createFaceSignals({ sustain: 5 });
  // Four frames with nobody in view, then back. Someone reached for a glass.
  for (let i = 0; i < 4; i++) assert.deepEqual(feed(none), []);
  assert.deepEqual(feed(one), [], 'a brief absence raised a breach');
});

test('a sustained absence does raise, exactly once', () => {
  const feed = createFaceSignals({ sustain: 5, cooldown: 20_000 });
  let raised = [];
  for (let i = 0; i < 40; i++) raised = raised.concat(feed(none));
  assert.deepEqual(raised, ['NO_FACE'], `40 empty frames produced ${raised.length} signals`);
});

test('a second person raises once, not once per frame', () => {
  const feed = createFaceSignals({ sustain: 5, cooldown: 20_000 });
  let raised = [];
  for (let i = 0; i < 30; i++) raised = raised.concat(feed(two));
  assert.deepEqual(raised, ['MULTIPLE_FACES']);
});

test('the cooldown expires, so a condition that recurs later is reported again', () => {
  let clock = 0;
  const feed = createFaceSignals({ sustain: 2, cooldown: 1000, now: () => clock });
  let raised = [];
  for (let i = 0; i < 4; i++) raised = raised.concat(feed(none));
  assert.deepEqual(raised, ['NO_FACE']);

  feed(one);                       // condition clears, streak resets
  clock += 5000;                   // and time passes
  raised = [];
  for (let i = 0; i < 4; i++) raised = raised.concat(feed(none));
  assert.deepEqual(raised, ['NO_FACE'], 'a genuinely new occurrence was swallowed by the cooldown');
});

test('normal fidgeting is not "the person changed"', () => {
  const feed = createFaceSignals({ sustain: 5, jump: 0.38 });
  let raised = [];
  // Someone shifting in their chair: a few percent of frame width per check.
  for (let i = 0; i < 30; i++) raised = raised.concat(feed([[50 + (i % 4), 50 + (i % 5), 40]]));
  assert.deepEqual(raised, [], 'ordinary movement was reported as a different person');
});

test('a face teleporting across the frame is reported', () => {
  const feed = createFaceSignals({ sustain: 5, jump: 0.38, cooldown: 20_000 });
  let raised = [];
  // Alternating between two positions far apart, sustained.
  for (let i = 0; i < 10; i++) raised = raised.concat(feed([[50, i % 2 ? 20 : 200, 40]]));
  assert.deepEqual(raised, ['FACE_CHANGED']);
});

test('losing the face resets the movement check rather than firing on return', () => {
  const feed = createFaceSignals({ sustain: 5, jump: 0.38 });
  feed([[50, 20, 40]]);
  for (let i = 0; i < 6; i++) feed(none);      // they walked away
  const raised = feed([[50, 200, 40]]);        // and came back to a different seat
  assert.ok(!raised.includes('FACE_CHANGED'),
    'returning to a different position after an absence was called a different person');
});
