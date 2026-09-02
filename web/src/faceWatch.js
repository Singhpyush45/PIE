// PIE — face presence checks, in the browser.
//
// WHAT THIS DOES
//   Counts faces in the camera frame, a few times a second, and reports three
//   things: nobody in frame, more than one person in frame, and the face
//   apparently changing to a different one.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It does not identify anyone. There is no face recognition, no matching
//   against a stored photo, and nothing about appearance, age, gender, ethnicity
//   or expression is computed, stored or sent anywhere. PIE counts faces and
//   measures how much the detected face jumped between frames. That is all a
//   fair proctoring signal needs, and anything more would be inferring protected
//   characteristics from a camera — which PIE does not do.
//
//   No frame ever leaves the browser. Detection runs on a canvas in this tab and
//   only the derived event type is posted to the server.
//
// WHY IT IS DELIBERATELY SLOW TO COMPLAIN
//   With a breach threshold of three, a jumpy detector would lock honest people
//   out of their own assessment. Every signal here must hold for several
//   consecutive checks before it is raised, and each one has a cooldown so a
//   sustained condition reports once rather than forty times.
//
// pico.js (MIT, ~6KB) and its cascade are served from this app, not a CDN, so
// this keeps working with no internet.

const CASCADE_URL = '/face/facefinder';
const PICO_URL = '/face/pico.js';

/* How sure, and for how long, before PIE says anything. */
// Calibrated against real photographs rather than guessed. On this cascade a
// true frontal face scores 7.5–25 and the false positives scored 0.7 and 3.0, so
// anything from 4 to 7 classified every sample correctly. 5.0 sits in the middle
// of that gap, with margin on both sides: too high and a real face is missed
// (a NO_FACE breach against someone sitting still), too low and a pattern on a
// wall becomes a second person.
const CONF = 5.0;
const INTERVAL_MS = 400;    // 2.5 checks a second is plenty and costs little CPU
const SUSTAIN = 5;          // ~2 seconds of agreement before a signal is raised
const COOLDOWN_MS = 20_000; // a standing condition reports once per 20s, not per frame
const JUMP = 0.38;          // fraction of frame width a face may move between checks

export const FACE_STATES = {
  UNSUPPORTED: 'This browser cannot run PIE\'s face checks, so they are off for this attempt.',
  UNAVAILABLE: 'PIE could not load its face checks, so they are off for this attempt.',
  RUNNING: 'Face checks are running in your browser. No image is uploaded.',
};


/**
 * The decision logic, separated from the camera so it can be tested.
 *
 * Detections go in, signal names come out. Everything that decides whether a
 * candidate gets a breach lives here — the streak rule that stops one bad frame
 * from counting, the cooldown that stops a standing condition from counting
 * forty times, and the movement rule.
 */
export function createFaceSignals({
  sustain = SUSTAIN, cooldown = COOLDOWN_MS, jump = JUMP, now = () => Date.now(),
} = {}) {
  const streak = { NO_FACE: 0, MULTIPLE_FACES: 0, FACE_CHANGED: 0 };
  // -Infinity, not 0: with 0 the first signal is suppressed whenever the clock
  // reads less than the cooldown. Date.now() is always huge so this never showed
  // in a browser, but it made the very first breach of a run unreportable under
  // any other clock — including the one the tests use.
  const lastSent = { NO_FACE: -Infinity, MULTIPLE_FACES: -Infinity, FACE_CHANGED: -Infinity };
  let lastFace = null;

  /** @returns {string[]} signals to raise for this frame — usually empty. */
  return function feed(dets, frameWidth = 240) {
    const out = [];
    const raise = type => {
      const t = now();
      if (t - lastSent[type] < cooldown) return;
      lastSent[type] = t;
      out.push(type);
    };

    streak.NO_FACE = dets.length === 0 ? streak.NO_FACE + 1 : 0;
    if (streak.NO_FACE === sustain) raise('NO_FACE');

    streak.MULTIPLE_FACES = dets.length > 1 ? streak.MULTIPLE_FACES + 1 : 0;
    if (streak.MULTIPLE_FACES === sustain) raise('MULTIPLE_FACES');

    if (dets.length === 1) {
      const [r, c, sz] = dets[0];
      if (lastFace) {
        const moved = Math.hypot(r - lastFace[0], c - lastFace[1]) / frameWidth;
        const resized = Math.abs(sz - lastFace[2]) / Math.max(sz, lastFace[2]);
        streak.FACE_CHANGED = (moved > jump || resized > 0.5) ? streak.FACE_CHANGED + 1 : 0;
        if (streak.FACE_CHANGED === 3) raise('FACE_CHANGED');
      }
      lastFace = [r, c, sz];
    } else {
      streak.FACE_CHANGED = 0;
      if (dets.length === 0) lastFace = null;
    }
    return out;
  };
}

let picoLoaded = null;
function loadPico() {
  if (picoLoaded) return picoLoaded;
  picoLoaded = new Promise((resolve, reject) => {
    if (window.pico) return resolve(window.pico);
    const s = document.createElement('script');
    s.src = PICO_URL;
    s.onload = () => (window.pico ? resolve(window.pico) : reject(new Error('pico did not initialise')));
    s.onerror = () => reject(new Error('could not load the face library'));
    document.head.appendChild(s);
  });
  return picoLoaded;
}

/**
 * Starts watching a <video>. Returns { stop, state }.
 *
 * `onSignal(type)` is called with 'NO_FACE' | 'MULTIPLE_FACES' | 'FACE_CHANGED'.
 * `onCount(n)` is called every check with the current face count, for the UI —
 * it is display only and never becomes a warning by itself.
 */
export async function watchFaces(video, { onSignal, onCount, onState } = {}) {
  const say = (s, detail) => onState?.({ state: s, detail: FACE_STATES[s] || detail });

  if (!video || typeof document === 'undefined' || !document.createElement('canvas').getContext) {
    say('UNSUPPORTED');
    return { stop() {}, state: 'UNSUPPORTED' };
  }

  let pico, cascade;
  try {
    pico = await loadPico();
    const bytes = new Int8Array(await (await fetch(CASCADE_URL)).arrayBuffer());
    cascade = pico.unpack_cascade(bytes);
  } catch (e) {
    // Honest failure: the checks are OFF and the candidate is told, rather than
    // the attempt quietly running with no face monitoring at all.
    say('UNAVAILABLE', e.message);
    return { stop() {}, state: 'UNAVAILABLE' };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // NO cross-frame accumulation. pico's detection memory sums confidences over
  // several frames before clustering, which pushes a marginal detection — a
  // poster on the wall, a face in a photo frame, a reflection — over the
  // threshold and reports it as a SECOND PERSON. Measured on a real photograph:
  // a single face read as 1 face on frame one and 2 from frame two onwards.
  //
  // That would lock an honest candidate out of their own assessment, and only
  // some of them, depending on what is behind their desk. The temporal
  // smoothing the memory existed to provide is already done properly one level
  // up, in createFaceSignals, where a signal must hold for several consecutive
  // checks. Doing it twice is what broke it.
  const memory = pico.instantiate_detection_memory(1);

  const feed = createFaceSignals();
  let stopped = false;

  function tick() {
    if (stopped) return;
    if (!video.videoWidth || video.paused) return;

    // Downscale hard: detection does not need resolution, and this keeps the
    // whole check well under a millisecond of main-thread time.
    const w = 240;
    const h = Math.max(1, Math.round(video.videoHeight * (w / video.videoWidth)));
    canvas.width = w; canvas.height = h;
    ctx.drawImage(video, 0, 0, w, h);
    const rgba = ctx.getImageData(0, 0, w, h).data;

    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0;
    }

    const dets = pico.cluster_detections(
      memory(pico.run_cascade(
        { pixels: gray, nrows: h, ncols: w, ldim: w },
        cascade,
        { shiftfactor: 0.1, minsize: Math.round(h * 0.18), maxsize: Math.round(h * 0.95), scalefactor: 1.1 },
      )),
      0.2,
    ).filter(d => d[3] > CONF);

    onCount?.(dets.length);
    for (const signal of feed(dets, w)) onSignal?.(signal);
  }

  const timer = setInterval(() => { try { tick(); } catch { /* one bad frame is not an incident */ } }, INTERVAL_MS);
  say('RUNNING');
  return {
    state: 'RUNNING',
    stop() { stopped = true; clearInterval(timer); },
  };
}
