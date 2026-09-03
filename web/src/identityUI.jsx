// PIE — identity registration and the live check before an assessment.
//
// Two screens, one camera. Registration happens once and locks; the check runs
// before every assessment.
//
// WHAT THESE SCREENS ARE ALLOWED TO DECIDE
//   Nothing. They open a camera, compute a descriptor, and post it. Whether it
//   matches is answered by the server, against a template that never comes back
//   down the wire. The green tick below is a report of the server's answer, not
//   a substitute for it — which is why a candidate cannot get past it by
//   editing anything in this file.
//
// WHY THERE IS NO UPLOAD BUTTON
//   Not because it is hidden. There is no endpoint that accepts an image, and
//   the descriptor is computed from a live <video> element that only
//   getUserMedia can fill. A file picker here would be a different feature with
//   different security, and it is not one PIE has.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, Button, Alert, Badge, cx } from './kit.jsx';
import {
  load as loadModels, inspect, openCamera, closeCamera, averageDescriptors,
} from './faceIdentity.js';

/* ------------------------------------------------------------------ camera */
/**
 * Opens a camera into a <video>, and closes it on the way out.
 *
 * The cleanup is not a nicety. A camera left running after the component
 * unmounts leaves the recording light on, which to a candidate looks exactly
 * like being watched after the assessment ended.
 */
function useCamera(active) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [state, setState] = useState({ status: 'idle' });

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    setState({ status: 'opening' });

    (async () => {
      const r = await openCamera();
      if (cancelled) { if (r.ok) closeCamera(r.stream); return; }
      if (!r.ok) { setState({ status: 'error', detail: r.detail, reason: r.reason }); return; }
      streamRef.current = r.stream;
      if (videoRef.current) {
        videoRef.current.srcObject = r.stream;
        try { await videoRef.current.play(); } catch { /* autoplay policy; the frame still updates */ }
      }
      setState({ status: 'live' });
    })();

    return () => {
      cancelled = true;
      closeCamera(streamRef.current);
      streamRef.current = null;
    };
  }, [active]);

  return { videoRef, state };
}

/** The live view, with whatever the current check is saying about it. */
function CameraStage({ videoRef, cameraState, signal, mirrored = true }) {
  const tone = signal?.ok ? 'ok' : signal?.hard ? 'crit' : 'warn';
  return (
    <div style={{
      position: 'relative', borderRadius: 'var(--r-3, 14px)', overflow: 'hidden',
      background: '#101318', aspectRatio: '4 / 3', width: '100%',
      border: `2px solid var(--${tone === 'ok' ? 'ok' : tone === 'crit' ? 'crit' : 'line'}, #d7dce5)`,
    }}>
      <video
        ref={videoRef} muted playsInline autoPlay
        style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
          transform: mirrored ? 'scaleX(-1)' : 'none',
        }}
      />
      {cameraState.status !== 'live' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: '#c8cfda', fontSize: 13, textAlign: 'center', padding: 'var(--s-4, 16px)',
        }}>
          {cameraState.status === 'opening' ? 'Opening your camera…' : cameraState.detail || 'Camera unavailable'}
        </div>
      )}
      {cameraState.status === 'live' && signal && (
        <div style={{
          position: 'absolute', left: 12, right: 12, bottom: 12,
          background: 'rgba(12,15,20,0.82)', color: '#fff',
          borderRadius: 10, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.45,
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <Icon name={signal.ok ? 'check' : 'alert'} size={15} />
          <span>{signal.message}</span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- live loop */
/**
 * Runs the detector a few times a second while `active`.
 *
 * Slower than the video: the model is not free, and a candidate does not need
 * thirty opinions a second about whether they are centred.
 */
function useFaceSignal(videoRef, active, onFrame) {
  const [signal, setSignal] = useState(null);
  const [loading, setLoading] = useState(null);
  const latest = useRef(null);
  const cb = useRef(onFrame);
  cb.current = onFrame;

  useEffect(() => {
    if (!active) { setSignal(null); return undefined; }
    let stop = false;
    let timer = null;

    (async () => {
      try { await loadModels(m => !stop && setLoading(m)); }
      catch {
        if (!stop) setSignal({ ok: false, hard: true, message: 'The identity model could not be loaded. Reload the page and try again.' });
        return;
      }
      const tick = async () => {
        if (stop) return;
        try {
          const r = await inspect(videoRef.current);
          latest.current = r;
          cb.current?.(r);
          if (r.faces === 0) setSignal({ ok: false, message: 'No face detected — move into the frame.' });
          else if (r.faces > 1) setSignal({ ok: false, hard: true, message: `${r.faces} faces detected. Only you should be in frame.` });
          else if (r.quality.reasons.length) setSignal({ ok: false, message: r.quality.reasons[0] });
          else setSignal({ ok: true, message: 'One face detected · Face clearly visible · Ready' });
        } catch {
          setSignal({ ok: false, message: 'The camera frame could not be read.' });
        }
        if (!stop) timer = setTimeout(tick, 450);
      };
      tick();
    })();

    return () => { stop = true; clearTimeout(timer); };
  }, [active, videoRef]);

  return { signal, loading, latest };
}

/* ============================================================== REGISTRATION */
export function IdentityRegister({ onDone, onSkip, compact = false }) {
  const SAMPLES = 4;
  const [consented, setConsented] = useState(false);
  const [samples, setSamples] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { videoRef, state: cameraState } = useCamera(consented);
  const { signal, loading, latest } = useFaceSignal(videoRef, consented && cameraState.status === 'live');

  const ready = signal?.ok === true;
  const done = samples.length >= SAMPLES;

  const capture = useCallback(() => {
    const r = latest.current;
    if (!r?.descriptor || r.faces !== 1) return;
    setSamples(s => (s.length >= SAMPLES ? s : [...s, r.descriptor]));
  }, [latest]);

  async function submit() {
    setBusy(true); setError(null);
    try {
      const descriptor = averageDescriptors(samples);
      if (!descriptor) throw new Error('The captures did not produce a usable template. Try again.');
      const r = await api.registerIdentity({ descriptor, quality: signal?.ok ? 1 : 0 });
      onDone?.(r);
    } catch (e) {
      setError(e.message);
      setSamples([]);
      setBusy(false);
    }
  }

  if (!consented) {
    return (
      <div className="stack">
        <Alert tone="info" title="Before we open your camera" icon="shield">
          PIE uses a live camera capture to register your identity, so that only you can sit your own
          assessments. Uploading a photo is not supported.
          <br /><br />
          The picture is <strong>not kept</strong>. It is converted to a set of numbers on this device,
          the numbers are sent to PIE&rsquo;s server, and the image is discarded. Nobody at PIE sees a
          photograph of you, and the numbers are used for one thing: checking that the person starting
          an assessment is the person who registered.
          <br /><br />
          This works by comparing faces. It cannot tell a live person from a photograph held up to the
          camera — PIE does not claim otherwise.
        </Alert>
        <div style={{ display: 'flex', gap: 'var(--s-3, 10px)', flexWrap: 'wrap' }}>
          <Button variant="primary" size="lg" icon="camera" onClick={() => setConsented(true)}>
            Allow camera and continue
          </Button>
          {onSkip && <Button variant="secondary" size="lg" onClick={onSkip}>Not now</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {error && <Alert tone="crit" title="Could not register your identity">{error}</Alert>}
      {loading && <Alert tone="info" title="One moment">{loading}</Alert>}

      <div style={{ maxWidth: compact ? 340 : 460 }}>
        <CameraStage videoRef={videoRef} cameraState={cameraState} signal={signal} />
      </div>

      {cameraState.status === 'error' && (
        <Alert tone="crit" title="Camera unavailable">{cameraState.detail}</Alert>
      )}

      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {Array.from({ length: SAMPLES }, (_, i) => (
          <span key={i} aria-hidden style={{
            width: 34, height: 5, borderRadius: 3,
            background: i < samples.length ? 'var(--ok, #1f9d55)' : 'var(--line, #d7dce5)',
          }} />
        ))}
        <span className="t-12 muted" style={{ marginLeft: 8 }}>
          {samples.length} of {SAMPLES} captures
        </span>
      </div>

      <p className="t-12 muted" style={{ margin: 0, lineHeight: 1.55 }}>
        Four captures, so your identity is not recorded from one unlucky frame. Move your head a
        little between them and keep your face lit.
      </p>

      <div style={{ display: 'flex', gap: 'var(--s-3, 10px)', flexWrap: 'wrap' }}>
        {!done && (
          <Button variant="primary" size="lg" icon="camera" onClick={capture} disabled={!ready || busy}>
            Capture identity
          </Button>
        )}
        {done && (
          <Button variant="primary" size="lg" icon="shield" onClick={submit} disabled={busy}>
            {busy ? 'Registering…' : 'Register my identity'}
          </Button>
        )}
        {samples.length > 0 && !busy && (
          <Button variant="ghost" onClick={() => setSamples([])}>Start over</Button>
        )}
      </div>

      <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5 }}>
        Once registered, your identity is locked. You will not be able to change it yourself — only
        Trust &amp; Integrity can reset it, and the reset is recorded.
      </p>
    </div>
  );
}

/* ================================================================ THE CHECK */
/**
 * The live check before an assessment.
 *
 * On success it hands `onVerified` a checkId. That id is the ONLY thing that
 * gets an assessment started, it is spent on first use, and the server binds it
 * to this account — so passing it to anything else achieves nothing.
 */
export function IdentityCheck({ requisitionId, onVerified, onBack }) {
  const [phase, setPhase] = useState('live');    // live | checking | passed | failed
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const { videoRef, state: cameraState } = useCamera(phase === 'live');
  const { signal, loading, latest } = useFaceSignal(videoRef, phase === 'live' && cameraState.status === 'live');

  async function check() {
    const r = latest.current;
    if (!r?.descriptor || r.faces !== 1) return;
    setPhase('checking'); setError(null);
    try {
      const v = await api.verifyIdentity({ descriptor: r.descriptor, requisitionId });
      setResult(v);
      setPhase('passed');
    } catch (e) {
      setAttempts(n => n + 1);
      setError({ message: e.message, reason: e.data?.reason });
      setPhase('failed');
    }
  }

  if (phase === 'passed') {
    return (
      <div className="stack">
        <Alert tone="ok" title="Identity verified" icon="check">
          You are verified to take this assessment.
        </Alert>
        <Button variant="primary" size="lg" onClick={() => onVerified(result.checkId)}>
          Start the assessment
        </Button>
        <p className="t-11 faint" style={{ margin: 0 }}>
          This verification is good for one assessment and expires in a few minutes.
        </p>
      </div>
    );
  }

  if (phase === 'failed') {
    const notRegistered = error?.reason === 'NOT_REGISTERED';
    return (
      <div className="stack">
        <Alert tone="crit" title={notRegistered ? 'No identity registered' : 'Identity verification failed'}>
          {error?.message}
        </Alert>
        {!notRegistered && (
          <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
            If this is you, check that you are alone in frame, facing the camera, and reasonably well
            lit — then try once more. If it keeps failing, ask Trust &amp; Integrity to look at your
            registered identity rather than trying repeatedly.
          </p>
        )}
        <div style={{ display: 'flex', gap: 'var(--s-3, 10px)', flexWrap: 'wrap' }}>
          {!notRegistered && attempts < 3 && (
            <Button variant="primary" onClick={() => { setPhase('live'); setError(null); }}>Try again</Button>
          )}
          {onBack && <Button variant="secondary" onClick={onBack}>Back</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {loading && <Alert tone="info" title="One moment">{loading}</Alert>}
      <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Before this assessment starts, PIE checks that the person at the camera is the candidate whose
        identity is registered on this account. Look at the camera with nobody else in frame.
      </p>

      <div style={{ maxWidth: 420 }}>
        <CameraStage videoRef={videoRef} cameraState={cameraState} signal={signal} />
      </div>

      {cameraState.status === 'error' && (
        <Alert tone="crit" title="The assessment cannot start">{cameraState.detail}</Alert>
      )}

      <div style={{ display: 'flex', gap: 'var(--s-3, 10px)', flexWrap: 'wrap' }}>
        <Button variant="primary" size="lg" icon="shield"
          onClick={check} disabled={signal?.ok !== true || phase === 'checking'}>
          {phase === 'checking' ? 'Verifying…' : 'Verify my identity'}
        </Button>
        {onBack && <Button variant="secondary" size="lg" onClick={onBack}>Back</Button>}
      </div>

      <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5 }}>
        The check is made on PIE&rsquo;s server, against a template this browser never receives. It
        compares faces; it is not liveness detection.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ status */
/** A one-line summary of where a candidate stands. */
export function IdentityBadge({ identity }) {
  if (!identity) return null;
  return identity.registered
    ? <Badge tone="ok" icon="shield">Identity registered &amp; locked</Badge>
    : <Badge tone="warn" icon="alert">Identity not registered</Badge>;
}

export { useCamera, CameraStage };
