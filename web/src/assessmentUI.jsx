import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Icon, Button, Card, CardHead, Badge, Pill, Stat, Alert, Meter, Empty, Skeleton, cx } from './kit.jsx';
import { TimerRing, BarList, f2, pc } from './charts.jsx';
import { api } from './api.js';
import { IdentityCheck } from './identityUI.jsx';
import { NoRolesYet } from './screens/candidate.jsx';
import { watchFaces } from './faceWatch.js';

const mmss = s => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, Math.floor(s % 60))).padStart(2, '0')}`;

/* ============================================================ CONSENT (§17) */
function Consent({ policy, onAccept, onCancel, blueprint, languages = [], language = 'en', onLanguage }) {
  const [checks, setChecks] = useState({ monitor: false, rules: false, data: false });
  const all = Object.values(checks).every(Boolean);
  const t = policy?.timing || {};
  const toggle = k => setChecks(c => ({ ...c, [k]: !c[k] }));

  return (
    <div className="assess stack">
      <Card flush>
        <CardHead icon="lock" eyebrow="Before you begin" title="Security &amp; privacy notice"
          sub="Read this in full. Nothing is monitored until you accept, and the rules cannot change once you start."
          right={<Badge tone="info" dot>Consent required</Badge>} />
        <div className="card__body stack">
          {/* The claim and its limits come from the frozen policy, so the screen
              cannot drift into promising more than the engine delivers. */}
          <Alert tone="warn" title="What this monitoring is, and what it is not">
            <p>{policy?.integrityClaim}</p>
            {policy?.integrityLimits?.length > 0 && (
              <>
                <p style={{ marginBottom: 4 }}><b>What it cannot see:</b></p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {policy.integrityLimits.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </>
            )}
            <p style={{ marginTop: 8 }}>That is why no warning here rejects you automatically. Signals are
              context for a human reviewer, and the final decision about you is always made by a person.</p>
          </Alert>

          <Alert tone="info" title="What we monitor, and only while the assessment is open">
            <p>Your camera and microphone status, whether your screen is shared, and whether the assessment
              window stays focused. Signals are evaluated for integrity events only.</p>
            <p><b>Raw camera and microphone recordings are not retained.</b> Only derived integrity events —
              type, timestamp and duration — are stored, and they are never used to infer anything about who
              you are.</p>
          </Alert>

          <div className="grid g-2">
            <Card flush>
              <CardHead title="Timing rules" sub="Server-authoritative. The clock cannot be paused, extended or replayed." />
              <div className="tablewrap">
                <table className="dt">
                  <thead><tr><th>Question type</th><th className="num">Time</th><th>On expiry</th><th>Go back?</th></tr></thead>
                  <tbody>
                    {Object.entries(t).map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ fontWeight: 600 }}>{v.label}</td>
                        <td className="num tnum">
                          {v.byDifficulty
                            ? Object.entries(v.byDifficulty).map(([d, s]) => (
                                <div key={d} style={{ whiteSpace: 'nowrap' }}>
                                  <span className="muted" style={{ fontWeight: 400 }}>{d} </span>
                                  {s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} sec`}
                                </div>
                              ))
                            : v.seconds >= 60 && v.seconds % 60 === 0 ? `${v.seconds / 60} min` : `${v.seconds} sec`}
                        </td>
                        <td className="t-12 muted">{v.expiry}</td>
                        <td><Badge tone="neutral">{v.back ? 'Yes' : 'No'}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="stack">
              <Card flush>
                <CardHead title="Integrity warnings" sub="You will always be told what happened and what to do." />
                <div className="card__body">
                  <div className="row" style={{ marginBottom: 12 }}>
                    <Stat label="Warning threshold" value={`${policy?.warnings?.threshold ?? 5}`}
                      detail="Reaching it submits and locks your attempt for human review — it is never an automatic rejection." />
                  </div>
                  <Alert tone="warn" title="If your attempt is locked">
                    A Trust &amp; Integrity Administrator reviews it before any result is treated as final.
                    No decision about you is made automatically.
                  </Alert>
                </div>
              </Card>
              {languages.length > 1 && (
                <Card flush>
                  <CardHead icon="users" title="Language"
                    sub="Skills-first means you are assessed on the job, not on your English." />
                  <div className="card__body stack">
                    <div className="field">
                      <label htmlFor="assess-lang">Question language</label>
                      <select id="assess-lang" className="input" value={language}
                        onChange={e => onLanguage?.(e.target.value)}>
                        {languages.map(l => (
                          <option key={l.code} value={l.code}>
                            {l.native}{l.native === l.name ? '' : ` — ${l.name}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    {language !== 'en' && (
                      <Alert tone="info" title="What changes, and what does not">
                        <p>Questions written for this role are generated in your chosen language. Code,
                          identifiers and technical terms stay in their original form.</p>
                        <p>PIE's reviewed question bank is English-only. If it is used to complete your
                          paper, part of the assessment will be in English — the result page tells you
                          when that happened. Your score is unaffected either way.</p>
                      </Alert>
                    )}
                  </div>
                </Card>
              )}
              {blueprint && (
                <Card flush>
                  <CardHead title="What you will be assessed on"
                    sub="Built from your own evidence — not a generic question set." />
                  <div className="card__body">
                    <div className="row row--wrap" style={{ gap: 6, marginBottom: 10 }}>
                      {blueprint.skillCoverage.map(s => <Badge key={s} tone="info">{s}</Badge>)}
                    </div>
                    <div className="row" style={{ gap: 16 }}>
                      <Pill><Icon name="file" size={11} />{blueprint.questionCount} questions</Pill>
                      <Pill><Icon name="clock" size={11} />≈ {Math.round(blueprint.estimatedSeconds / 60)} min</Pill>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          </div>

          <div className="grid" style={{ gap: 10 }}>
            {[
              ['monitor', 'I consent to camera, microphone and screen-share monitoring for the duration of this assessment.'],
              ['rules', `I understand the timing is server-controlled, I cannot return to a finalised question, and ${policy?.warnings?.threshold ?? 5} integrity warnings will submit and lock my attempt for human review.`],
              ['data', 'I understand raw media is not retained, only derived integrity events, and that I can request a copy or deletion of my data.'],
            ].map(([k, label]) => (
              <label key={k} className={cx('checkline', checks[k] && 'checkline--on')}>
                <input type="checkbox" checked={checks[k]} onChange={() => toggle(k)} />
                <span className="t-13">{label}</span>
              </label>
            ))}
          </div>

          <div className="row">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" size="lg" icon="right" disabled={!all}
              onClick={() => onAccept({ accepted: true, checks })}>
              Accept and run device check
            </Button>
          </div>
          {!all && <div className="t-12 muted" style={{ textAlign: 'right' }}>
            All three statements must be accepted before the assessment can start.</div>}
        </div>
      </Card>
    </div>
  );
}

/**
 * Where this paper came from.
 *
 * A candidate is entitled to know that their questions were written for the job
 * they applied to rather than pulled from a fixed list, and a recruiter reading
 * a score needs to know what produced it. Both are answered by the same facts,
 * so this is one component used on both sides.
 *
 * It reports counts, never content: which questions were rejected, and what the
 * remaining pool looks like, would let a candidate prepare against it.
 */
export function Provenance({ blueprint, compact = false }) {
  if (!blueprint) return null;
  const mix = blueprint.sourceMix || {};
  const ai = mix.ai_generated || 0;
  const bank = mix.verified_bank || 0;
  const g = blueprint.generation || {};
  const rejected = g.rejectedCount ?? 0;

  if (compact) {
    return (
      <div className="row row--wrap" style={{ gap: 6 }}>
        {ai > 0 && <Badge tone="ai" icon="sparkle">{ai} AI-written</Badge>}
        {bank > 0 && <Badge tone="neutral">{bank} verified bank</Badge>}
        {rejected > 0 && <Badge tone="warn">{rejected} rejected</Badge>}
      </div>
    );
  }

  return (
    <Card flush>
      <CardHead icon="shield" title="How this paper was built"
        sub="Question provenance — recorded at the moment the attempt started."
        right={<Badge tone={ai > 0 ? 'ai' : 'neutral'} dot>{ai > 0 ? 'Generated for this role' : 'Verified bank'}</Badge>} />
      <div className="card__body stack">
        <div className="row row--wrap" style={{ gap: 16 }}>
          <Pill><Icon name="sparkle" size={11} />{ai} written for this job</Pill>
          <Pill><Icon name="check" size={11} />{bank} from the verified bank</Pill>
          {rejected > 0 && <Pill><Icon name="alert" size={11} />{rejected} rejected by validation</Pill>}
          {g.provider && <Pill><Icon name="orchestr" size={11} />{g.provider}</Pill>}
        </div>

        <p className="t-13" style={{ margin: 0 }}>
          Every generated question is checked for a valid answer key, unambiguous options and
          relevance to this role before it can be shown. A question that fails any check is
          replaced, never repaired.
        </p>

        {/* The places where PIE could not fully honour the blueprint. Saying so
            is the difference between a report and a claim. */}
        {(blueprint.repetitionRelaxed || blueprint.typeSubstituted
          || (blueprint.unfilledTypes || []).length > 0 || blueprint.competencyEquivalent === false) && (
          <Alert tone="warn" title="Where this paper differs from the blueprint">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {blueprint.repetitionRelaxed && (
                <li>The unseen question pool was too small, so this attempt reuses questions from an
                  earlier one. Compare it with that attempt accordingly.</li>
              )}
              {blueprint.typeSubstituted && (
                <li>One or more slots were filled with a different question type to keep the paper
                  at full length.</li>
              )}
              {(blueprint.unfilledTypes || []).length > 0 && (
                <li>Not supplied at all: {blueprint.unfilledTypes.join(', ').replace(/_/g, ' ')}.</li>
              )}
              {blueprint.competencyEquivalent === false && (
                <li>The paper reaches outside the role's skills, so it is not directly comparable
                  with another candidate's.</li>
              )}
            </ul>
          </Alert>
        )}
      </div>
    </Card>
  );
}


/* ============================================================ LIVE ATTEMPT */
/**
 * What PIE is actually watching: the camera, the shared screen, and the face
 * count derived from the camera.
 *
 * It is deliberately not dismissible. A candidate is being monitored for the
 * duration; being able to hide the evidence of that makes the monitoring feel
 * more covert, not less, and a hidden preview is also the one state where a dead
 * camera goes unnoticed until a breach fires.
 *
 * Both previews are LOCAL. No frame is uploaded, streamed or recorded — only the
 * derived event names reach the server.
 */
function IntegrityView({ mediaRef, screenRef, lost, faceState, faceCount }) {
  const camRef = useRef(null);
  const scrRef = useRef(null);

  useEffect(() => {
    for (const [el, stream] of [[camRef.current, mediaRef?.current], [scrRef.current, screenRef?.current]]) {
      if (!el || !stream) continue;
      if (el.srcObject !== stream) el.srcObject = stream;
      const p = el.play?.();
      if (p?.catch) p.catch(() => { /* autoplay policy — the placeholder stays */ });
    }
  }, [mediaRef, screenRef, lost]);

  const faceTone = faceCount === 1 ? 'ok' : faceCount === 0 ? 'warn' : faceCount > 1 ? 'crit' : 'neutral';
  const faceLabel = faceState !== 'RUNNING' ? 'Face checks off'
    : faceCount == null ? 'Starting…'
      : faceCount === 1 ? 'One person in frame'
        : faceCount === 0 ? 'Nobody in frame'
          : `${faceCount} people in frame`;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="selfview">
        {/* Named explicitly. The face watcher used to take the first
            .selfview__video on the page, which is the camera only for as long as
            nobody reorders this panel. */}
        <video ref={camRef} autoPlay playsInline muted className="selfview__video" data-pie-camera="1" />
        <span className="selfview__tag">
          <span className={cx('selfview__dot', lost && 'is-lost')} />
          {lost ? 'Camera lost' : 'Camera'}
        </span>
        {lost && (
          <div className="selfview__ph">
            <Icon name="alert" size={15} />
            <span>Reconnect your camera to continue</span>
          </div>
        )}
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <Badge tone={faceTone} dot>{faceLabel}</Badge>
        {faceState && faceState !== 'RUNNING' && (
          <span className="t-11 muted">not available in this browser</span>
        )}
      </div>

      <div className="selfview selfview--screen">
        <video ref={scrRef} autoPlay playsInline muted className="selfview__video selfview__video--screen" />
        <span className="selfview__tag"><span className="selfview__dot" />Shared screen</span>
      </div>

      <p className="selfview__note">
        Both previews stay on your device — nothing is uploaded, streamed or recorded.
        PIE counts faces; it never identifies anyone, and nothing about your appearance
        or background is inferred or stored.
      </p>
    </div>
  );
}

/* ========================================================== PREFLIGHT (§18) */
function Preflight({ onReady, onBack, mediaRef, screenRef }) {
  const [arming, setArming] = useState(false);
  const [state, setState] = useState({ camera: 'pending', mic: 'pending', screen: 'idle', browser: 'pending' });
  const [err, setErr] = useState(null);
  const [stream, setStream] = useState(null);
  const videoRef = useRef(null);

  const runChecks = useCallback(async () => {
    setErr(null);
    setState(s => ({ ...s, camera: 'checking', mic: 'checking', browser: 'checking' }));
    const okBrowser = typeof navigator.mediaDevices?.getUserMedia === 'function'
      && typeof document.documentElement.requestFullscreen === 'function';
    setState(s => ({ ...s, browser: okBrowser ? 'ok' : 'fail' }));

    // "Try again" must not leave the previous camera running.
    if (mediaRef.current) {
      mediaRef.current.getTracks().forEach(t => t.stop());
      mediaRef.current = null;
      setStream(null);
    }

    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      mediaRef.current = s;
      setStream(s);
      setState(prev => ({
        ...prev,
        camera: s.getVideoTracks().length ? 'ok' : 'fail',
        mic: s.getAudioTracks().length ? 'ok' : 'fail',
      }));
    } catch (e) {
      setState(s => ({ ...s, camera: 'fail', mic: 'fail' }));
      setErr(e.name === 'NotAllowedError'
        ? 'Camera and microphone permission was declined by the browser.'
        : `Device check could not complete (${e.name || 'unknown error'}).`);
    }
  }, [mediaRef]);

  useEffect(() => { runChecks(); }, [runChecks]);

  // The stream can only be attached AFTER the <video> element is in the DOM.
  // Doing it inside runChecks ran while videoRef was still null, so the preview
  // stayed blank even though the camera reported Ready.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    // Some browsers will not start a muted autoplay video without being asked.
    const p = v.play?.();
    if (p?.catch) p.catch(() => { /* autoplay policy — the poster stays visible */ });
  }, [stream]);

  const rows = [
    ['camera', 'Camera', 'camera'], ['mic', 'Microphone', 'mic'],
    ['browser', 'Browser capability', 'monitor'],
  ];
  const ready = state.camera === 'ok' && state.mic === 'ok' && state.browser === 'ok';

  return (
    <div className="assess stack">
      <Card flush>
        <CardHead icon="monitor" eyebrow="Step 2 of 2" title="Device &amp; browser check"
          sub="Run before the clock starts, so a technical problem never costs you assessment time." />
        <div className="card__body">
          <div className="grid g-2 devcheck">
            <div>
              <div className="statusrail">
                {rows.map(([k, label, icon]) => (
                  <div key={k} className={cx('statusrow', state[k] === 'ok' && 'statusrow--on', state[k] === 'fail' && 'statusrow--off')}>
                    <Icon name={icon} size={15} />
                    <span className="lbl">{label}</span>
                    {state[k] === 'checking' && <span className="spin" />}
                    <Badge tone={state[k] === 'ok' ? 'ok' : state[k] === 'fail' ? 'crit' : 'neutral'}
                      icon={state[k] === 'ok' ? 'check' : state[k] === 'fail' ? 'x' : undefined}>
                      {state[k] === 'ok' ? 'Ready' : state[k] === 'fail' ? 'Blocked' : 'Checking…'}
                    </Badge>
                  </div>
                ))}
              </div>

              {err && (
                <Alert tone="crit" title="Device check could not be completed">
                  <p>{err}</p>
                  <p>Allow access in your browser’s address bar and try again. You can also continue in
                    <b> demo mode</b>, where proctoring signals are simulated and clearly labelled as such.</p>
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button variant="secondary" size="sm" icon="refresh" onClick={runChecks}>Try again</Button>
                    <Button variant="ghost" size="sm" onClick={() => onReady({ camera: false, mic: false, screen: false, demoMode: true })}>
                      Continue in demo mode
                    </Button>
                  </div>
                </Alert>
              )}

              <Alert tone="info" title="Nothing is recorded">
                This preview never leaves your device — it is not uploaded, streamed or stored.
                PIE keeps derived integrity events only.
              </Alert>
            </div>

            <div>
              {/* The <video> is always mounted so its ref exists before the stream
                  arrives; the placeholder sits on top until the camera is live. */}
              <div className="campreview">
                <video ref={videoRef} autoPlay playsInline muted
                  className={cx('campreview__video', state.camera === 'ok' && 'is-live')} />
                {state.camera !== 'ok' && (
                  <div className="campreview__ph">
                    <Icon name="camera" size={26} />
                    <div className="t-12">{state.camera === 'fail' ? 'Camera unavailable' : 'Requesting camera…'}</div>
                  </div>
                )}
                {state.camera === 'ok' && (
                  <span className="campreview__live"><span className="dot" />Live · this device only</span>
                )}
              </div>
            </div>
          </div>

          <div className="row" style={{ marginTop: 20 }}>
            <Button variant="ghost" onClick={onBack}>Back</Button>
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" size="lg" icon="play" disabled={!ready || arming}
              onClick={async () => {
                setArming(true); setErr(null);
                // Screen share and fullscreen BOTH need a user gesture, so they
                // are requested here, on the click, rather than after the
                // attempt starts — a browser silently refuses either one when it
                // is asked for out of band.
                let screen = false;
                try {
                  const disp = await navigator.mediaDevices.getDisplayMedia({
                    video: { displaySurface: 'monitor' }, audio: false,
                  });
                  screenRef.current = disp;
                  screen = true;
                } catch {
                  setArming(false);
                  setErr('Screen sharing was not shared. The assessment needs it — choose your whole screen when the browser asks.');
                  return;
                }
                try { await document.documentElement.requestFullscreen?.(); } catch { /* the attempt handles a refusal as a warning */ }
                onReady({ camera: true, mic: true, screen, demoMode: false });
              }}>
              {arming ? 'Starting…' : 'Share screen and start'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================ LIVE ATTEMPT */
function Live({ attempt, question, onAnswer, onProctor, busy, demoMode, mediaRef, screenRef }) {
  const [faceState, setFaceState] = useState(null);
  const [faceCount, setFaceCount] = useState(null);
  const [choice, setChoice] = useState(null);
  const [multi, setMulti] = useState([]);
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(question?.seconds ?? 0);
  const [camLost, setCamLost] = useState(false);
  const [runOut, setRunOut] = useState(null);
  const [running, setRunning] = useState(false);
  const [pasteBlocked, setPasteBlocked] = useState(0);
  const submitted = useRef(false);

  useEffect(() => {
    setChoice(null); setMulti([]); setCode(question?.starter || '');
    setRunOut(null);
    submitted.current = false;
  }, [question?.questionId]);

  // Server-authoritative countdown: the deadline comes from the server, the client only renders it.
  useEffect(() => {
    if (!question) return;
    const tick = () => {
      const rem = (question.deadlineAt - Date.now()) / 1000;
      setLeft(rem);
      if (rem <= 0 && !submitted.current) {
        submitted.current = true;
        onAnswer({ questionId: question.questionId, response: currentResponse(), token: question.token, expired: true });
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.questionId, question?.deadlineAt]);

  // Face checks run for the whole attempt against the same camera element the
  // candidate can see. Started once, not per question — restarting the detector
  // on every question would reset its streaks and make sustained conditions
  // unreportable.
  useEffect(() => {
    if (demoMode) { setFaceState('OFF_DEMO'); return undefined; }
    let watcher = null;
    let cancelled = false;
    const video = document.querySelector('video[data-pie-camera]');
    if (!video) { setFaceState('UNAVAILABLE'); return undefined; }

    watchFaces(video, {
      onSignal: type => onProctor(type),
      onCount: setFaceCount,
      onState: ({ state }) => setFaceState(state),
    }).then(w => { if (cancelled) w.stop(); else watcher = w; })
      .catch(() => setFaceState('UNAVAILABLE'));

    return () => { cancelled = true; watcher?.stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode]);

  // Leaving fullscreen is a breach, and PIE offers the way back rather than
  // only complaining — the candidate cannot re-enter it without a gesture.
  const [needsFullscreen, setNeedsFullscreen] = useState(false);
  useEffect(() => {
    const check = () => setNeedsFullscreen(!document.fullscreenElement);
    check();
    document.addEventListener('fullscreenchange', check);
    return () => document.removeEventListener('fullscreenchange', check);
  }, []);

  /**
   * Blocks paste and drop into the answer box.
   *
   * This raises the effort of pasting a prepared answer; it does not make it
   * impossible, and PIE does not claim otherwise. A second device, an OS-level
   * paste, or a browser extension all defeat it. It is one layer, recorded for
   * the recruiter as context — never as an automatic penalty.
   */
  const onPasteAttempt = e => {
    e.preventDefault();
    setPasteBlocked(n => n + 1);
    onProctor('PASTE_BLOCKED');
  };

  // Real browser integrity signals.
  useEffect(() => {
    if (!question) return;
    const onVis = () => { if (document.hidden) onProctor('FOCUS_LOST'); };
    const onFs = () => { if (!document.fullscreenElement) onProctor('FULLSCREEN_EXIT'); };
    document.addEventListener('visibilitychange', onVis);
    document.addEventListener('fullscreenchange', onFs);
    const s = mediaRef?.current;
    const vt = s?.getVideoTracks?.()[0];
    const at = s?.getAudioTracks?.()[0];
    const camEnd = () => { setCamLost(true); onProctor('CAMERA_LOST'); };
    const micEnd = () => onProctor('MIC_LOST');
    vt?.addEventListener('ended', camEnd);
    at?.addEventListener('ended', micEnd);

    // Stopping the screen share mid-attempt is the browser's own "Stop sharing"
    // button, which fires 'ended' on the display track.
    const st = screenRef?.current?.getVideoTracks?.()[0];
    const scrEnd = () => onProctor('SCREEN_ENDED');
    st?.addEventListener('ended', scrEnd);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('fullscreenchange', onFs);
      vt?.removeEventListener('ended', camEnd);
      at?.removeEventListener('ended', micEnd);
      st?.removeEventListener('ended', scrEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question?.questionId]);

  const currentResponse = () => question?.type === 'multi_select' ? multi
    : question?.type?.startsWith('coding') || question?.type === 'debugging' ? code : choice;

  if (!question) return <Skeleton lines={5} />;

  const total = question.seconds;
  const frac = Math.max(0, left / total);
  const lastWarn = attempt.warnings[attempt.warnings.length - 1];
  const answered = attempt.cursor;
  const isCoding = question.type.startsWith('coding') || question.type === 'debugging';
  const canSubmit = isCoding ? code.trim().length > 0
    : question.multi ? multi.length > 0 : choice != null;

  return (
    <div className="assess stack">
      {/* --- sticky status bar --- */}
      <div className="assess__bar">
        <div className="row" style={{ gap: 12 }}>
          <TimerRing remaining={left} total={total} />
          <div className={cx('timer', frac <= 0.2 ? 'timer--crit' : frac <= 0.5 ? 'timer--warn' : '')}>
            <span className="timer__v" aria-live="off">{mmss(left)}</span>
            <span className="t-11 muted">left</span>
          </div>
        </div>
        <div className="divider" style={{ width: 1, height: 34, margin: 0, background: 'var(--line-2)' }} />
        <div>
          <div className="eyebrow">Question {question.index} of {question.total}</div>
          <div className="qdots" style={{ marginTop: 5 }} role="img"
            aria-label={`${answered} of ${question.total} questions finalised`}>
            {Array.from({ length: question.total }).map((_, i) => (
              <span key={i} className={cx('qdot', i < answered && 'qdot--done', i === answered && 'qdot--now')} />
            ))}
          </div>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="info">{question.typeLabel}</Badge>
          <Badge tone="neutral">{question.difficulty}</Badge>
          <Badge tone="ai" icon="target">{question.skillName}</Badge>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="t-11 muted nowrap">Warnings</span>
          <div className="warnpips" role="img"
            aria-label={`${attempt.warningCount} of ${attempt.policy.warnings.threshold} integrity warnings used`}>
            {Array.from({ length: attempt.policy.warnings.threshold }).map((_, i) => (
              <span key={i} className={cx('warnpip', i < attempt.warningCount &&
                (attempt.warningCount >= attempt.policy.warnings.threshold - 1 ? 'warnpip--crit' : 'warnpip--used'))} />
            ))}
          </div>
          <span className="tnum t-12" style={{ fontWeight: 700 }}>
            {attempt.warningCount}/{attempt.policy.warnings.threshold}
          </span>
        </div>
      </div>

      {needsFullscreen && !demoMode && (
        <div className="warnbanner warnbanner--crit" role="alert">
          <div className="row" style={{ gap: 10, alignItems: 'center' }}>
            <Icon name="alert" size={18} style={{ flex: 'none' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>The assessment is not in fullscreen</div>
              <p style={{ margin: '3px 0 0', fontSize: 13 }}>
                This is recorded as an integrity event. Return to fullscreen to continue.
              </p>
            </div>
            <Button size="sm" variant="secondary"
              onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
              Re-enter fullscreen
            </Button>
          </div>
        </div>
      )}

      {/* --- warning banner --- */}
      {lastWarn && lastWarn.counted && (
        <div className={cx('warnbanner', lastWarn.remaining <= 1 && 'warnbanner--crit')} role="alert">
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <Icon name="alert" size={18} style={{ flex: 'none', marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>
                Integrity warning {lastWarn.count} of {lastWarn.threshold} — {lastWarn.signal}
              </div>
              <p style={{ margin: 0, fontSize: 13 }}>{lastWarn.action}</p>
              <p style={{ margin: '4px 0 0', fontSize: 12, opacity: .85 }}>
                Detected by: {lastWarn.detection}. {lastWarn.remaining} warning{lastWarn.remaining === 1 ? '' : 's'} remaining
                before your attempt is submitted and locked for human review.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="grid g-2-1">
        {/* --- question --- */}
        <Card flush>
          <CardHead eyebrow={`${question.typeLabel} · ${question.difficulty}`}
            title={`Question ${question.index}`}
            sub={`Assessing: ${question.skillName}`}
            right={<Badge tone="neutral" icon="lock">Forward-only</Badge>} />
          <div className="card__body stack">
            <p style={{ fontSize: 15, lineHeight: 1.6, color: 'var(--ink-1)', margin: 0 }}>{question.prompt}</p>

            {question.options && (
              <div className="grid" style={{ gap: 9 }} role={question.multi ? 'group' : 'radiogroup'}
                aria-label="Answer options">
                {question.options.map((o, i) => {
                  const on = question.multi ? multi.includes(i) : choice === i;
                  return (
                    <button key={i} className={cx('opt', on && 'opt--on')}
                      role={question.multi ? 'checkbox' : 'radio'} aria-checked={on}
                      onClick={() => question.multi
                        ? setMulti(m => m.includes(i) ? m.filter(x => x !== i) : [...m, i])
                        : setChoice(i)}>
                      <span className="opt__key">{question.multi ? (on ? '✓' : '') : String.fromCharCode(65 + i)}</span>
                      <span>{o}</span>
                    </button>
                  );
                })}
                {question.multi && <div className="t-12 muted">Select all that apply.</div>}
              </div>
            )}

            {isCoding && (
              <div className="field">
                <label htmlFor="code">Your solution</label>
                <textarea id="code" className="codebox" value={code} spellCheck={false}
                  onChange={e => setCode(e.target.value)} aria-describedby="code-hint"
                  onPaste={onPasteAttempt} onDrop={onPasteAttempt}
                  onContextMenu={e => e.preventDefault()} />
                <span className="hint" id="code-hint">
                  Scored server-side against a protected rubric. The rubric is never sent to your browser.
                  {' '}Pasting is disabled here — type your solution.
                </span>
                {pasteBlocked > 0 && (
                  <p className="pasteblock" role="status">
                    Paste blocked ({pasteBlocked}{pasteBlocked === 1 ? ' attempt' : ' attempts'}).
                    This is recorded for the recruiter as context, not as a penalty.
                  </p>
                )}

                {question.reviewOnly && (
                  <Alert tone="info" title="This answer is read by a person">
                    {question.reviewReason || 'PIE does not run this kind of answer, so a recruiter reads it themselves.'}
                    {' '}There is nothing to run against — write the best answer you can and submit it.
                  </Alert>
                )}

                {/* Examples the candidate may run against. The hidden tests are
                    counted, never listed — knowing how many there are is fair,
                    knowing what they contain is not. */}
                {question.examples?.length > 0 && (
                  <div className="field">
                    <label>Examples</label>
                    <div className="tablewrap">
                      <table className="dt dt--tight">
                        <thead><tr><th>Input</th><th>Expected</th><th>Result</th></tr></thead>
                        <tbody>
                          {question.examples.map(ex => {
                            const r = runOut?.results?.find(x => x.id === ex.id);
                            return (
                              <tr key={ex.id}>
                                <td className="mono t-12">{JSON.stringify(ex.input)}</td>
                                <td className="mono t-12">{JSON.stringify(ex.expected)}</td>
                                <td>
                                  {!r ? <span className="muted t-12">—</span>
                                    : r.passed ? <Badge tone="ok" dot>passed</Badge>
                                    : <span className="row" style={{ gap: 6 }}>
                                        <Badge tone="crit" dot>failed</Badge>
                                        <span className="mono t-11 muted">{r.error || `got ${r.got}`}</span>
                                      </span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
                      <Button size="sm" variant="secondary" icon="play" disabled={running || !code.trim()}
                        onClick={async () => {
                          setRunning(true); setRunOut(null);
                          try { setRunOut(await api.runCode(attempt.attemptId, { questionId: question.questionId, code })); }
                          catch (e) { setRunOut({ executed: false, error: e.message, results: [] }); }
                          setRunning(false);
                        }}>
                        {running ? 'Running…' : 'Run against examples'}
                      </Button>
                      <span className="t-11 muted">
                        Running does not submit, and does not affect your score.
                        {question.hiddenTestCount > 0 &&
                          ` Your submission is also checked against ${question.hiddenTestCount} test${question.hiddenTestCount === 1 ? '' : 's'} you cannot see.`}
                      </span>
                    </div>
                    {runOut?.error && (
                      <p className="pasteblock" role="status" style={{ marginTop: 8 }}>{runOut.error}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="row">
              <span className="t-12 muted">
                On expiry: {question.expiryBehaviour.toLowerCase()}. You cannot return to this question.
              </span>
              <span className="spacer" style={{ flex: 1 }} />
              <Button variant="primary" size="lg" iconRight="right" disabled={busy || !canSubmit}
                onClick={() => {
                  submitted.current = true;
                  onAnswer({ questionId: question.questionId, response: currentResponse(), token: question.token });
                }}>
                {question.index === question.total ? 'Submit and finish' : 'Submit and continue'}
              </Button>
            </div>
          </div>
        </Card>

        {/* --- integrity rail --- */}
        <div className="stack">
          <Card flush>
            <CardHead icon="shield" title="Integrity monitoring"
              sub={demoMode ? 'Demo mode — signals are simulated' : 'Active for this attempt only'} />
            <div className="card__body">
              <div className="statusrail">
                {[['Camera', 'camera', !demoMode], ['Microphone', 'mic', !demoMode],
                  ['Window focus', 'monitor', true], ['Integrity monitoring', 'shield', true]].map(([label, icon, on]) => (
                  <div key={label} className={cx('statusrow', on && 'statusrow--on')}>
                    <Icon name={icon} size={14} />
                    <span className="lbl">{label}</span>
                    <Badge tone={on ? 'ok' : 'neutral'} dot>{on ? 'Active' : 'Simulated'}</Badge>
                  </div>
                ))}
              </div>
              {/* What PIE is watching, for as long as the attempt is open. */}
              <IntegrityView mediaRef={mediaRef} screenRef={screenRef} lost={camLost}
                faceState={faceState} faceCount={faceCount} />
            </div>
          </Card>

          <Card flush>
            <CardHead title="Simulate an integrity event" sub="Demonstration control — shows the warning UX on stage" />
            <div className="card__body">
              <div className="row row--wrap" style={{ gap: 7 }}>
                {[['MULTIPLE_FACES', 'Multiple faces'], ['NO_FACE', 'No face'],
                  ['SCREEN_ENDED', 'Screen share ended'], ['NETWORK_LOST', 'Network blip']].map(([t, l]) => (
                  <Button key={t} variant="secondary" size="sm" onClick={() => onProctor(t)}>{l}</Button>
                ))}
              </div>
            </div>
          </Card>

          {attempt.warnings.length > 0 && (
            <Card flush>
              <CardHead title="Warning history" sub={`${attempt.warningCount} counted`} />
              <div className="card__body" style={{ maxHeight: 200, overflowY: 'auto' }}>
                {attempt.warnings.map((w, i) => (
                  <div key={i} style={{ padding: '7px 0', borderBottom: '1px solid var(--line-1)' }}>
                    <div className="row" style={{ gap: 7 }}>
                      <Badge tone={w.counted ? 'warn' : 'info'}>{w.counted ? `#${w.count}` : 'info'}</Badge>
                      <span className="t-12" style={{ fontWeight: 600 }}>{w.signal}</span>
                      <span className="spacer" style={{ flex: 1 }} />
                      <span className="t-11 faint mono">{new Date(w.at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================================================================= RESULT */
function Result({ attempt, onDone, onRetake }) {
  const r = attempt.result;
  if (!r) return <Skeleton lines={4} />;
  const locked = r.requiresHumanReview;
  return (
    <div className="assess stack">
      <Card flush style={{ borderColor: locked ? 'var(--warn-line)' : 'var(--ok-line)' }}>
        <div className="card__head" style={{ background: locked ? 'var(--warn-bg)' : 'var(--ok-bg)', alignItems: 'center' }}>
          <Icon name={locked ? 'alert' : 'check'} size={20}
            style={{ color: locked ? 'var(--warn-fg)' : 'var(--ok-fg)' }} />
          <div style={{ flex: 1 }}>
            <div className="eyebrow" style={{ color: locked ? 'var(--warn-fg)' : 'var(--ok-fg)' }}>
              {locked ? 'Attempt locked for review' : 'Assessment complete'}
            </div>
            <h3>{locked ? 'A human will review this attempt' : `You scored ${pc(r.overall)}`}</h3>
          </div>
        </div>
        <div className="card__body stack">
          {locked ? (
            <Alert tone="warn" title="What happens next">{r.reviewNotice}</Alert>
          ) : (
            <>
              <div className="grid g-3">
                <Card pad><Stat label="Overall" value={pc(r.overall)} tone="ok" /></Card>
                <Card pad><Stat label="Questions finalised" value={`${r.answered}/${r.total}`} /></Card>
                <Card pad><Stat label="Integrity warnings" value={r.warningCount}
                  tone={r.warningCount ? 'warn' : 'ok'} /></Card>
              </div>
              <Card flush>
                <CardHead title="Skill breakdown" sub="This is what becomes evidence — one source of seven" />
                <div className="card__body">
                  <BarList items={r.skillBreakdown.map(s => ({
                    key: s.skillId, label: s.skill, value: s.score, meta: `${s.questions} question${s.questions === 1 ? '' : 's'}`,
                    tip: `${s.skill}: ${pc(s.score)} across ${s.questions} question(s), scored server-side.`,
                  }))} />
                </div>
              </Card>
              <Provenance blueprint={attempt.blueprint} />
              <Alert tone="info" title="How this is used">
                The assessment result joins your resume, projects, GitHub, certificates, hackathons and
                non-traditional evidence in the Unified Candidate Evidence Profile. It carries a high trust
                tier because PIE administered it — but it is <b>one source of seven</b>, never the whole picture.
              </Alert>
            </>
          )}
          <div className="row">
            <Button variant="ghost" onClick={onRetake}>Back to dashboard</Button>
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" icon="orchestr" onClick={onDone}>
              Re-run my Career Orchestrator with this evidence
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================= CONTAINER */
export default function AssessmentFlow({ ctx, onFinished, onExit }) {
  const [stage, setStage] = useState('pick');
  const [policy, setPolicy] = useState(null);
  const [blueprint, setBlueprint] = useState(null);
  const [languages, setLanguages] = useState([]);
  const [language, setLanguage] = useState('en');
  const [consent, setConsent] = useState(null);
  const [attempt, setAttempt] = useState(null);
  const [question, setQuestion] = useState(null);
  const [busy, setBusy] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null);      // { requisitionId, applicationId, title }
  // Held between the device check and the identity check, because the identity
  // check sits between choosing to start and actually starting.
  const [pending, setPending] = useState(null);
  const mediaRef = useRef(null);
  const screenRef = useRef(null);

  const apps = ctx.boot?.applications || [];
  const openReqs = ctx.boot?.openRequisitions || [];

  useEffect(() => {
    api.policy().then(r => setPolicy(r.policy)).catch(() => {});
    // A failure here just leaves the assessment in English — it never blocks a start.
    api.assessmentLanguages().then(r => setLanguages(r.languages || [])).catch(() => {});
    return () => {
      mediaRef.current?.getTracks?.().forEach(t => t.stop());
      screenRef.current?.getTracks?.().forEach(t => t.stop());
    };
  }, []);

  // Isolated mode: hide the shell for the whole live attempt.
  useEffect(() => {
    ctx.setExamMode?.(stage === 'live');
  }, [stage, ctx]);

  async function choose(t) {
    setTarget(t); setBusy(true); setError(null);
    try {
      setBlueprint(await api.blueprint({ requisitionId: t.requisitionId }));
      setStage('consent');
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  // A curated demo persona has no email and no registered face; the server
  // exempts them, so asking them for an identity check would be theatre.
  const needsIdentity = !ctx.user?.isDemo;

  const steps = needsIdentity
    ? ['Choose role', 'Consent', 'Device check', 'Identity', 'Assessment', 'Result']
    : ['Choose role', 'Consent', 'Device check', 'Assessment', 'Result'];
  const stepIdx = needsIdentity
    ? { pick: 0, consent: 1, preflight: 2, identity: 3, live: 4, result: 5 }[stage]
    : { pick: 0, consent: 1, preflight: 2, live: 3, result: 4 }[stage];

  /**
   * The device check is done. For a real candidate the next thing is the
   * identity check, not the assessment — the attempt is created only once the
   * server has issued a verification, and the server refuses to create one
   * without it either way.
   */
  function begin(pf) {
    setDemoMode(Boolean(pf.demoMode));
    if (needsIdentity) { setPending(pf); setError(null); setStage('identity'); return; }
    launch(pf, null);
  }

  async function launch(pf, identityCheckId) {
    setBusy(true); setError(null);
    try {
      const r = await api.startAssessment({
        consent, preflight: pf, language, identityCheckId,
        requisitionId: target?.requisitionId, applicationId: target?.applicationId,
      });
      setAttempt(r.attempt); setQuestion(r.question); setStage('live');
    } catch (e) { setError(e.message); setStage(needsIdentity ? 'identity' : 'preflight'); }
    setBusy(false);
  }

  async function answer(body) {
    setBusy(true);
    try {
      const r = await api.answer(attempt.attemptId, body);
      setAttempt(r.attempt); setQuestion(r.question);
      if (!r.question) {
        const f = await api.finishAssessment(attempt.attemptId);
        setAttempt(f.attempt); setStage('result');
      }
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function proctor(type) {
    try {
      const r = await api.proctor(attempt.attemptId, type, true);
      setAttempt(r.attempt); setQuestion(r.question);
      if (r.attempt.state !== 'IN_PROGRESS') {
        const f = await api.finishAssessment(attempt.attemptId);
        setAttempt(f.attempt); setStage('result');
      }
    } catch { /* proctoring must never break the attempt */ }
  }

  /** Leaving a live attempt is confirmed, logged, and preserves state. */
  async function leave() {
    if (stage !== 'live') { onExit?.(); return; }
    if (!window.confirm('Leave the assessment?\n\nYour attempt is preserved and this exit is recorded as an integrity event. The timer does not stop.')) return;
    try { await api.abandonAssessment(attempt.attemptId, 'Candidate exited the assessment view'); } catch { /* best effort */ }
    ctx.setExamMode?.(false);
    onExit?.();
  }

  return (
    <div className="stack">
      <div className="row stepbar" style={{ gap: 12, flexWrap: 'wrap' }}>
        {/* Two renderings of the same progress, because five labelled steps do
            not fit on a phone. The full rail was overflowing its container:
            "Assessment" was clipped mid-word and "Result" was off-screen
            entirely, which reads as a broken layout rather than a wide one.
            CSS picks one; both are the same information. */}
        <div className="steps" aria-label="Assessment progress" style={{ flex: 1, minWidth: 0 }}>
          {steps.map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <div className={cx('steps__line', i <= stepIdx && 'steps__line--done')} />}
              <div className={cx('steps__node', i < stepIdx && 'steps__node--done', i === stepIdx && 'steps__node--now')}>
                <span className="steps__dot">{i < stepIdx ? '\u2713' : i + 1}</span>
                <span className="steps__label">{s}</span>
              </div>
            </React.Fragment>
          ))}
        </div>
        <div className="stepsmini" aria-hidden="true">
          <div className="stepsmini__row">
            <span className="stepsmini__now">{steps[stepIdx]}</span>
            <span className="stepsmini__count">{stepIdx + 1} of {steps.length}</span>
          </div>
          <div className="stepsmini__track">
            <span className="stepsmini__fill" style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }} />
          </div>
        </div>
        {stage === 'live' && (
          <Button variant="danger-ghost" size="sm" icon="x" onClick={leave}>Leave assessment</Button>
        )}
      </div>

      {error && <Alert tone="crit" title="Something went wrong">
        <p>{error}</p>
        <Button variant="secondary" size="sm" icon="refresh" onClick={() => setError(null)}>Dismiss</Button>
      </Alert>}

      {stage === 'pick' && (
        <Card flush>
          <CardHead icon="target" title="Which role are you being assessed for?"
            sub="The questions come from that role's required capabilities crossed with your own evidence — never a generic bank." />
          <div className="card__body stack">
            {apps.filter(a => a.status === 'ASSESSMENT_REQUIRED').length > 0 && (
              <>
                <div className="eyebrow">Requested by a recruiter</div>
                {apps.filter(a => a.status === 'ASSESSMENT_REQUIRED').map(a => (
                  <button key={a.id} className="repocard" disabled={busy}
                    onClick={() => choose({ requisitionId: a.requisitionId, applicationId: a.id, title: a.requisitionTitle })}>
                    <Icon name="brief" size={16} style={{ marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b className="t-13">{a.requisitionTitle}</b>
                      <div className="t-12 muted">{a.company}</div>
                    </div>
                    <Badge tone="warn" dot>Assessment required</Badge>
                  </button>
                ))}
              </>
            )}
            <div className="eyebrow" style={{ marginTop: 8 }}>Or practise against an open role</div>
            {openReqs.map(r => (
              <button key={r.id} className="repocard" disabled={busy}
                onClick={() => choose({ requisitionId: r.id, title: r.title })}>
                <Icon name="brief" size={16} style={{ marginTop: 2 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b className="t-13">{r.title}</b>
                  <div className="t-12 muted">{r.company} · {r.location}</div>
                </div>
                <Icon name="right" size={15} className="faint" />
              </button>
            ))}
            {!openReqs.length && <NoRolesYet what="An assessment" />}
          </div>
        </Card>
      )}

      {stage === 'consent' && (
        <Consent policy={policy} blueprint={blueprint} onCancel={() => setStage('pick')}
          languages={languages} language={language} onLanguage={setLanguage}
          onAccept={c => { setConsent(c); setStage('preflight'); }} />
      )}
      {stage === 'identity' && (
        <Card>
          <CardHead icon="shield" eyebrow="Step 4" title="Verify your identity"
            sub="Only the candidate this account belongs to may sit this assessment." />
          <IdentityCheck
            requisitionId={target?.requisitionId}
            onVerified={id => launch(pending, id)}
            onBack={() => setStage('preflight')} />
        </Card>
      )}
      {stage === 'preflight' && (
        <Preflight mediaRef={mediaRef} screenRef={screenRef} onBack={() => setStage('consent')} onReady={begin} />
      )}
      {stage === 'live' && attempt && (
        <Live attempt={attempt} question={question} onAnswer={answer} onProctor={proctor}
          busy={busy} demoMode={demoMode} mediaRef={mediaRef} screenRef={screenRef} />
      )}
      {stage === 'result' && (
        <Result attempt={attempt} onRetake={onExit} onDone={() => onFinished?.()} />
      )}
    </div>
  );
}
