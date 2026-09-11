// PIE — face IDENTITY, in the browser.
//
// THE DIFFERENCE THAT MATTERS
//   faceWatch.js counts faces. It answers "is somebody there, and is it more
//   than one person". It cannot tell you WHO. This file answers a different
//   question — "is this the same person who registered" — and that is face
//   verification, not face detection. Conflating the two is the single most
//   common overclaim in this area, so PIE keeps them in separate files with
//   separate vocabulary.
//
// WHAT IT PRODUCES
//   A 128-number descriptor from a ResNet trained for face recognition
//   (@vladmandic/face-api, MIT). Two descriptors of the same person land close
//   together in that space; two people land far apart. PIE never keeps the
//   photograph — the descriptor is computed from the frame and the frame is
//   discarded.
//
//   The descriptor is not reversible into a picture. It is still biometric data
//   about a specific person, and it is treated that way: it goes straight to the
//   server, is never written to localStorage or sessionStorage, and is never put
//   in a URL.
//
// WHERE THE DECISION IS MADE
//   Not here. This file computes a descriptor and posts it. Whether it MATCHES
//   is decided on the server, against a template the browser never sees. A
//   comparison done in the browser would be a comparison an attacker can edit.
//
// WHAT THIS IS NOT
//   It is not liveness detection and it is not anti-spoofing. A descriptor
//   computed from a photograph held up to the camera is a valid descriptor.
//   PIE does not claim otherwise anywhere in the product.
//
// Models are served from this app (/face/models), not a CDN, so a demo works
// with no internet — the same choice faceWatch.js makes for pico.js.

const MODEL_URL = '/face/models';

/**
 * How close two descriptors must be to be called the same person.
 *
 * 0.6 is the figure this model family is characterised at, and it applies to
 * the descriptor EXACTLY AS THE MODEL PRODUCES IT. That last part matters: the
 * network's final layer is a plain fully-connected layer with no L2
 * normalisation, so a real descriptor has a norm around 1.39, not 1. Rescaling
 * one side of a comparison and not the other moves the distance by more than
 * the difference between two faces does — measured at 0.39 against 0.06 for the
 * same face — so nothing here normalises anything.
 */
export const MATCH_THRESHOLD = 0.6;

let apiPromise = null;
let ready = false;

/**
 * Loads face-api and its weights. ~7MB, once, lazily.
 *
 * Deliberately not imported at the top of the app: nobody registering an account
 * or reading a job description should pay for a face-recognition model. It loads
 * the first time an identity screen opens.
 */
export async function load(onProgress) {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    onProgress?.('Loading the identity model…');
    const faceapi = await import('@vladmandic/face-api');
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    ready = true;
    onProgress?.(null);
    return faceapi;
  })();
  return apiPromise;
}

export const isReady = () => ready;

/* ------------------------------------------------------------------ detect */
/**
 * Looks at one video frame.
 *
 * @returns {Promise<{faces:number, descriptor:number[]|null, box:object|null,
 *                    quality:{score:number, reasons:string[]}}>}
 */
export async function inspect(video) {
  const faceapi = await load();
  if (!video || video.readyState < 2 || !video.videoWidth) {
    return { faces: 0, descriptor: null, box: null, quality: { score: 0, reasons: ['The camera is not ready yet.'] } };
  }

  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 });
  const results = await faceapi
    .detectAllFaces(video, options)
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (!results.length) {
    return { faces: 0, descriptor: null, box: null,
      quality: { score: 0, reasons: ['No face is visible. Move into the centre of the frame.'] } };
  }
  if (results.length > 1) {
    return { faces: results.length, descriptor: null, box: null,
      quality: { score: 0, reasons: [`${results.length} faces are visible. Only you should be in frame.`] } };
  }

  const [only] = results;
  const box = only.detection.box;
  const quality = assess(box, video, only.detection.score);

  return {
    faces: 1,
    // A plain array, so it serialises. Float32Array becomes {"0":0.1,…} in JSON,
    // which arrives at the server as an object and silently is not a vector.
    descriptor: Array.from(only.descriptor),
    box: { x: box.x, y: box.y, width: box.width, height: box.height },
    quality,
  };
}

/**
 * Is this frame good enough to register from?
 *
 * A bad registration template is worse than no template: it will fail the
 * candidate at every future assessment, and they will have no idea why. So the
 * bar for CAPTURING is deliberately higher than the bar for matching later.
 */
function assess(box, video, score) {
  const reasons = [];
  const frameArea = video.videoWidth * video.videoHeight;
  const share = (box.width * box.height) / frameArea;

  if (share < 0.045) reasons.push('Move closer — your face should fill more of the frame.');
  if (share > 0.6) reasons.push('Move back a little.');

  const cx = (box.x + box.width / 2) / video.videoWidth;
  const cy = (box.y + box.height / 2) / video.videoHeight;
  if (cx < 0.25 || cx > 0.75) reasons.push('Move to the centre of the frame.');
  if (cy < 0.2 || cy > 0.8) reasons.push('Centre your face vertically.');

  if (score < 0.72) reasons.push('Your face is not clearly visible — try better lighting.');

  return { score, share, reasons };
}

/* ------------------------------------------------------------------ camera */
/**
 * Opens the camera, or explains in plain words why it could not.
 *
 * The browser's own errors are names like NotAllowedError, which mean nothing to
 * a candidate about to sit an assessment.
 */
export async function openCamera({ width = 640, height = 480 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'UNSUPPORTED',
      detail: 'This browser cannot open a camera. Try Chrome, Edge, Firefox or Safari.' };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' },
      audio: false,
    });
    return { ok: true, stream };
  } catch (e) {
    const detail = {
      NotAllowedError: 'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.',
      NotFoundError: 'No camera was found on this device.',
      NotReadableError: 'The camera is already in use by another application. Close it and try again.',
      OverconstrainedError: 'This camera does not support the requested resolution.',
      SecurityError: 'The camera can only be used over HTTPS or on localhost.',
    }[e.name] || `The camera could not be opened (${e.name || 'unknown error'}).`;
    return { ok: false, reason: e.name || 'UNKNOWN', detail };
  }
}

export function closeCamera(stream) {
  try { stream?.getTracks?.().forEach(t => t.stop()); } catch { /* already stopped */ }
}

/* ---------------------------------------------------------------- averaging */
/**
 * Averages several descriptors into one.
 *
 * A single frame catches one expression, one angle, one moment of lighting.
 * Registering from three or four and averaging gives a template that
 * generalises.
 *
 * A PLAIN mean, with no rescaling afterwards. An earlier version divided by the
 * length to make a unit vector, on the assumption that the model emits unit
 * vectors. It does not — `FaceRecognitionNet.forwardInput` ends at a matMul with
 * no normalisation, and a real descriptor measures about 1.39 long. So that step
 * put the registered template in one space and every later live capture in
 * another, and the gap it opened (0.39) was six times the distance between two
 * captures of the same face (0.06). Registration succeeded, every verification
 * afterwards failed, and nothing in either message pointed at arithmetic.
 */
export function averageDescriptors(list) {
  const valid = (list || []).filter(d => Array.isArray(d) && d.length === 128);
  if (!valid.length) return null;
  const out = new Array(128).fill(0);
  for (const d of valid) for (let i = 0; i < 128; i += 1) out[i] += d[i];
  for (let i = 0; i < 128; i += 1) out[i] /= valid.length;
  return out;
}

/** Euclidean distance. Exported so a test can assert the same maths the server
 *  uses, rather than each side having its own idea of what "close" means. */
export function distance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}
