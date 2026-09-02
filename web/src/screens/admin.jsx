import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import {
  Icon, Button, Card, CardHead, Badge, Stat, Alert, Meter, Empty, Skeleton, Modal, cx,
} from '../kit.jsx';
import { AuditPanel } from '../panels.jsx';

const ACTIONS = [
  { key: 'CLEAR_FOR_EVALUATION', label: 'Clear for evaluation', variant: 'ok', icon: 'check' },
  { key: 'REQUEST_RETAKE', label: 'Request retake', variant: 'secondary', icon: 'refresh' },
  { key: 'ESCALATE', label: 'Escalate', variant: 'warn', icon: 'alert' },
  { key: 'MARK_UNRESOLVED', label: 'Mark unresolved', variant: 'danger-ghost', icon: 'x' },
];

export default function AdminScreens({ ctx }) {
  const { nav } = ctx;
  switch (nav.view) {
    case 'a-overview': return <Overview ctx={ctx} />;
    case 'a-bias': return <BiasReviews ctx={ctx} />;
    case 'a-attempts': return <Attempts ctx={ctx} />;
    case 'a-proctoring': return <Proctoring ctx={ctx} />;
    case 'a-decisions': return <Decisions ctx={ctx} />;
    case 'a-audit': return <Audit ctx={ctx} />;
    case 'a-people': return <People ctx={ctx} />;
    default: return null;
  }
}

/* ------------------------------------------------------- action dialog */
function ActionDialog({ open, onClose, onSubmit, subject, busy }) {
  const [action, setAction] = useState('CLEAR_FOR_EVALUATION');
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) { setAction('CLEAR_FOR_EVALUATION'); setReason(''); } }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={`Review — ${subject || ''}`}
      footer={
        <div className="row">
          <span className="t-12 muted" style={{ flex: 1 }}>
            Every action is recorded with your name, the time and this reason.
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit({ action, reason })}>Record action</Button>
        </div>
      }>
      <div className="stack">
        <Alert tone="warn" title="A signal is not a finding">
          A bias signal is an indicator that a human should look. It is not proof, and a locked
          attempt is never an automatic rejection. Your judgement is the decision here.
        </Alert>
        <div className="field">
          <label>Action</label>
          <div className="grid g-2" style={{ gap: 8 }}>
            {ACTIONS.map(a => (
              <button key={a.key} type="button"
                className={cx('checkline', action === a.key && 'checkline--on')}
                onClick={() => setAction(a.key)}>
                <Icon name={a.icon} size={15} style={{ marginTop: 1 }} />
                <span className="t-13" style={{ fontWeight: 600 }}>{a.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="reason">Reason <span className="muted">(required)</span></label>
          <textarea id="reason" className="input" rows={3} value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="What did you look at, and why is this the right action?" />
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- overview */
function Overview({ ctx }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.adminOverview().then(setD).catch(e => ctx.notify('crit', e.message)); }, [ctx]);
  if (!d) return <Skeleton lines={5} />;
  const c = d.counts;
  return (
    <div className="stack">
      <Alert tone="info" title="What this workspace is for" icon="shield">{d.principle}</Alert>
      <div className="grid g-4">
        <Card><Stat label="Open bias reviews" value={c.openBiasReviews}
          tone={c.openBiasReviews ? 'warn' : 'ok'} icon="shield" /></Card>
        <Card><Stat label="High severity" value={c.highSeverityBias}
          tone={c.highSeverityBias ? 'crit' : 'ok'} icon="alert"
          detail="blocks the automated flow" /></Card>
        <Card><Stat label="Locked attempts" value={c.lockedAttempts}
          tone={c.lockedAttempts ? 'warn' : 'ok'} icon="lock"
          detail="awaiting human review, never auto-rejected" /></Card>
        <Card><Stat label="Human decisions" value={c.humanDecisions} icon="user"
          detail="every outcome has a named reviewer" /></Card>
      </div>
      <div className="grid g-2">
        <Card flush>
          <CardHead icon="shield" title="Start here"
            sub="The queues that block someone's application from moving" />
          <div className="card__body">
            <div className="grid" style={{ gap: 10 }}>
              <Button variant="secondary" iconRight="right" onClick={() => ctx.nav.go('a-bias')}
                style={{ justifyContent: 'space-between' }}>
                Bias reviews <Badge tone={c.openBiasReviews ? 'warn' : 'ok'}>{c.openBiasReviews} open</Badge>
              </Button>
              <Button variant="secondary" iconRight="right" onClick={() => ctx.nav.go('a-attempts')}
                style={{ justifyContent: 'space-between' }}>
                Assessment integrity <Badge tone={c.lockedAttempts ? 'warn' : 'ok'}>{c.lockedAttempts} locked</Badge>
              </Button>
              <Button variant="secondary" iconRight="right" onClick={() => ctx.nav.go('a-proctoring')}
                style={{ justifyContent: 'space-between' }}>
                Proctoring events <Badge tone="neutral">{c.proctoringEvents}</Badge>
              </Button>
            </div>
          </div>
        </Card>
        <Card flush>
          <CardHead icon="lock" title="Standing constraints"
            sub="These hold regardless of what any reviewer decides" />
          <div className="card__body">
            {[
              'AI can analyse, recommend, rank and explain. It cannot make a final employment decision.',
              'A locked assessment attempt is submitted for review, never converted into a rejection.',
              'Raw camera and microphone media is not retained — only derived integrity events.',
              'Bias signals are potential indicators. PIE never claims bias is proven.',
              'Every action in this workspace is written to the audit trail with a reason.',
            ].map(t => (
              <div key={t} className="row" style={{ gap: 9, padding: '8px 0', borderTop: '1px solid var(--line-1)', alignItems: 'flex-start' }}>
                <Icon name="check" size={14} style={{ color: 'var(--ok-fg)', flex: 'none', marginTop: 2 }} />
                <span className="t-13">{t}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- bias reviews */
function BiasReviews({ ctx }) {
  const [rows, setRows] = useState(null);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.adminBias().then(r => setRows(r.reviews)).catch(e => ctx.notify('crit', e.message)), [ctx]);
  useEffect(() => { load(); }, [load]);

  async function act({ action, reason }) {
    setBusy(true);
    try {
      await api.adminBiasAction(target.id, { action, reason });
      ctx.notify('ok', `${action.replace(/_/g, ' ').toLowerCase()} recorded.`);
      setTarget(null); load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  if (!rows) return <Skeleton lines={5} />;
  if (!rows.length) return <Card pad><Empty icon="shield" title="No bias reviews yet">
    Reviews appear here when a requisition or a match raises a potential bias signal.
  </Empty></Card>;

  return (
    <div className="stack">
      <Alert tone="warn" title="Language matters here">
        These are <b>potential bias signals</b>, not proven bias. Each one is an indicator that a
        human should look at something specific. You remain responsible for the judgement.
      </Alert>
      {rows.map(r => (
        <Card key={r.id} flush className={r.severity === 'High' ? 'card' : undefined}
          style={r.severity === 'High' ? { borderColor: 'var(--crit-line)' } : undefined}>
          <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Icon name="shield" size={16} style={{ color: r.severity === 'High' ? 'var(--crit-fg)' : 'var(--warn-fg)' }} />
            <div style={{ flex: 1, minWidth: 180 }}>
              <h3>{r.subjectType === 'requisition' ? 'Requisition' : 'Match'} — {r.requisition || r.candidate || r.subjectId}</h3>
              <div className="sub">{r.signalCount} signal(s) · {new Date(r.createdAt).toLocaleString()}</div>
            </div>
            <Badge tone={r.severity === 'High' ? 'crit' : r.severity === 'Medium' ? 'warn' : 'ok'}>
              {r.severity} severity
            </Badge>
            <Badge tone={r.status === 'OPEN' ? 'warn' : r.status === 'CLEARED' ? 'ok' : 'neutral'} dot>
              {r.status}
            </Badge>
            {r.status === 'OPEN' && (
              <Button variant="primary" size="sm" onClick={() => setTarget(r)}>Review</Button>
            )}
          </div>
          <div className="card__body">
            {(r.signals || []).slice(0, 4).map((s, i) => (
              <div key={i} style={{ padding: '9px 0', borderTop: i ? '1px solid var(--line-1)' : 'none' }}>
                <div className="row row--wrap" style={{ gap: 8 }}>
                  <b className="t-13">{s.signal || s.finding}</b>
                  {s.severity && <Badge tone={s.severity === 'High' ? 'crit' : 'warn'}>{s.severity}</Badge>}
                </div>
                {s.matchedText && <div className="mono t-12" style={{ color: 'var(--crit-fg)', marginTop: 4 }}>“{s.matchedText}”</div>}
                <div className="t-12 muted" style={{ marginTop: 4 }}>{s.impact || s.reason}</div>
                {(s.suggestion || s.recommendedReview) && (
                  <div className="t-12" style={{ color: 'var(--ok-fg)', marginTop: 4 }}>
                    → {s.suggestion || s.recommendedReview}
                  </div>
                )}
              </div>
            ))}
            {r.reviewedBy && (
              <Alert tone="ok" title={`Actioned by ${r.reviewedBy}`}>
                {r.reviewAction?.replace(/_/g, ' ')} — “{r.reviewReason}” ({new Date(r.reviewedAt).toLocaleString()})
              </Alert>
            )}
          </div>
        </Card>
      ))}
      <ActionDialog open={Boolean(target)} onClose={() => setTarget(null)} onSubmit={act} busy={busy}
        subject={target?.requisition || target?.candidate || target?.subjectId} />
    </div>
  );
}

/* ------------------------------------------------------ locked attempts */
function Attempts({ ctx }) {
  const [rows, setRows] = useState(null);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.adminAttempts().then(r => setRows(r.attempts)).catch(e => ctx.notify('crit', e.message)), [ctx]);
  useEffect(() => { load(); }, [load]);

  async function act({ action, reason }) {
    setBusy(true);
    try {
      await api.adminAttemptAction(target.id, { action, reason });
      ctx.notify('ok', `${action.replace(/_/g, ' ').toLowerCase()} recorded.`);
      setTarget(null); load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  if (!rows) return <Skeleton lines={5} />;
  if (!rows.length) return <Card pad><Empty icon="lock" title="No assessment attempts yet">
    Attempts appear here once a candidate starts a job-specific assessment.
  </Empty></Card>;

  return (
    <div className="stack">
      <Alert tone="info" title="A locked attempt is a request for review">
        Reaching the warning threshold submits and locks an attempt. It never rejects anyone. Nothing
        happens to that application until you record an action here.
      </Alert>
      <Card flush>
        <CardHead icon="lock" title="Assessment integrity" sub={`${rows.length} attempt(s)`} />
        <div className="tablewrap">
          <table className="dt">
            <thead><tr>
              <th>Candidate</th><th>Role</th><th>State</th><th>Questions</th><th className="num">Warnings</th>
              <th className="num">Events</th><th className="num">Score</th><th>Integrity</th><th />
            </tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.id}>
                  <td style={{ fontWeight: 600 }}>{a.candidate || '—'}</td>
                  <td>{a.requisition || <span className="muted">general</span>}</td>
                  <td><Badge tone={a.state === 'LOCKED_FOR_REVIEW' ? 'crit' : a.state === 'COMPLETED' ? 'ok' : 'info'}>
                    {(a.state || '').replace(/_/g, ' ')}</Badge></td>
                  {/* Where this paper came from. A reviewer weighing a locked
                      attempt needs to know whether the questions were written
                      for the role or drawn from the fixed bank. */}
                  <td>
                    <div className="row row--wrap" style={{ gap: 4 }}>
                      {a.questionSources?.ai_generated
                        ? <Badge tone="ai">{a.questionSources.ai_generated} AI</Badge> : null}
                      {a.questionSources?.verified_bank
                        ? <Badge tone="neutral">{a.questionSources.verified_bank} bank</Badge> : null}
                      {!a.questionSources && <span className="muted t-12">—</span>}
                    </div>
                    {a.aiProvider && <span className="t-11 muted">{a.aiProvider}</span>}
                  </td>
                  <td className="num tnum">{a.warningCount ?? 0}</td>
                  <td className="num tnum">{a.events}</td>
                  <td className="num tnum">{a.overall != null ? Math.round(a.overall * 100) + '%' : '—'}</td>
                  <td>{a.integrityStatus
                    ? <Badge tone={a.integrityStatus === 'CLEARED' ? 'ok' : 'warn'}>{a.integrityStatus.replace(/_/g, ' ')}</Badge>
                    : <span className="muted t-12">—</span>}</td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      <Button variant="ghost" size="sm" icon="camera"
                        onClick={() => ctx.nav.push('a-proctoring', { attemptId: a.id, title: `Events — ${a.candidate}` })}>
                        Events
                      </Button>
                      {(a.requiresHumanReview || a.integrityStatus === 'LOCKED_FOR_REVIEW') && (
                        <Button variant="primary" size="sm" onClick={() => setTarget(a)}>Review</Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <ActionDialog open={Boolean(target)} onClose={() => setTarget(null)} onSubmit={act} busy={busy}
        subject={target?.candidate} />
    </div>
  );
}

/* -------------------------------------------------------- proctoring log */
function Proctoring({ ctx }) {
  const [d, setD] = useState(null);
  const attemptId = ctx.nav.params.attemptId;
  useEffect(() => { api.adminProctoring(attemptId).then(setD).catch(e => ctx.notify('crit', e.message)); },
    [attemptId, ctx]);
  if (!d) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      <Alert tone="info" title="Derived events only" icon="camera">{d.notice}</Alert>
      {!d.events.length ? (
        <Card pad><Empty icon="camera" title="No proctoring events recorded">
          Events appear here as candidates take proctored assessments.
        </Empty></Card>
      ) : (
        <Card flush>
          <CardHead icon="camera" title="Proctoring events" sub={`${d.events.length} event(s)`} />
          <div className="tablewrap" style={{ maxHeight: 620, overflowY: 'auto' }}>
            <table className="dt">
              <thead><tr><th>Time</th><th>Candidate</th><th>Event</th><th>Severity</th><th>Source</th><th>Detail</th></tr></thead>
              <tbody>
                {d.events.map(e => (
                  <tr key={e.id}>
                    <td className="mono faint">{new Date(e.timestamp).toLocaleTimeString()}</td>
                    <td>{e.candidate || '—'}</td>
                    <td><span className="mono t-12">{e.eventType}</span></td>
                    <td><Badge tone={e.severity === 'WARNING' ? 'warn' : 'neutral'}>{e.severity}</Badge></td>
                    <td className="t-12 muted">{e.source}{e.metadata?.simulated ? ' · simulated' : ''}</td>
                    <td className="t-12 muted">
                      {e.metadata?.detection || e.metadata?.reason || '—'}
                      {e.metadata?.count ? ` · warning ${e.metadata.count}/${e.metadata.threshold}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------- human decisions */
function Decisions({ ctx }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.adminDecisions().then(setD).catch(e => ctx.notify('crit', e.message)); }, [ctx]);
  if (!d) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      <Alert tone="ok" title="Where authority sits" icon="user">{d.notice}</Alert>
      {!d.decisions.length ? (
        <Card pad><Empty icon="user" title="No human decisions recorded yet">
          Decisions appear here the moment a recruiter acts on a run.
        </Empty></Card>
      ) : d.decisions.map(x => (
        <Card key={x.id} flush>
          <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Icon name="user" size={16} style={{ color: 'var(--ok-fg)' }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <h3>{x.action.replace(/_/g, ' ')} — {x.candidate}</h3>
              <div className="sub">{x.requisition || 'no requisition'} · {new Date(x.at).toLocaleString()}</div>
            </div>
            {x.override && <Badge tone="crit" icon="alert">Overrode the AI recommendation</Badge>}
            <Badge tone="neutral">{x.reviewer}</Badge>
          </div>
          <div className="card__body">
            <dl className="insight__chain" style={{ borderTop: 0 }}>
              <div className="insight__link"><dt>Reason</dt><dd>{x.reason}</dd></div>
              <div className="insight__link"><dt>AI said</dt><dd>{x.aiRecommendation}</dd></div>
              <div className="insight__link"><dt>Reviewer</dt><dd>{x.reviewer} ({x.reviewerEmail}) · {x.reviewerRole}</dd></div>
            </dl>
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ audit trail */
function Audit({ ctx }) {
  const [d, setD] = useState(null);
  const [filter, setFilter] = useState('');
  const load = useCallback(a => api.adminAudit(a).then(setD).catch(e => ctx.notify('crit', e.message)), [ctx]);
  useEffect(() => { load(filter); }, [filter, load]);
  if (!d) return <Skeleton lines={6} />;
  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="history" title="Full audit trail"
          sub={`${d.events.length} event(s)`}
          right={
            <select className="input" style={{ width: 240 }} value={filter} onChange={e => setFilter(e.target.value)}>
              <option value="">All actions</option>
              {d.actions.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
          } />
      </Card>
      <AuditPanel audit={d.events} onRefresh={() => load(filter)} />
    </div>
  );
}

/* ----------------------------------------------------------------- people */
function People({ ctx }) {
  const [d, setD] = useState(null);
  useEffect(() => { api.adminPeople().then(setD).catch(e => ctx.notify('crit', e.message)); }, [ctx]);
  if (!d) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      <div className="grid g-3">
        <Card><Stat label="Candidates" value={d.candidates.length} icon="users" /></Card>
        <Card><Stat label="Recruiters" value={d.recruiters.length} icon="brief" /></Card>
        <Card><Stat label="Applications" value={d.applications.length} icon="layers" /></Card>
      </div>
      <div className="grid g-2">
        <Card flush>
          <CardHead icon="users" title="Candidates" />
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Name</th><th className="num">Evidence</th><th>Onboarding</th></tr></thead>
              <tbody>{d.candidates.map(c => (
                <tr key={c.id}>
                  <td><b>{c.name}</b><div className="t-11 muted clamp2">{c.headline}</div></td>
                  <td className="num tnum">{c.evidenceCount}</td>
                  <td><Badge tone={c.onboardingComplete ? 'ok' : 'warn'}>
                    {c.onboardingComplete ? 'Complete' : 'In progress'}</Badge></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
        <Card flush>
          <CardHead icon="brief" title="Recruiters" />
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Name</th><th>Organization</th><th className="num">Requisitions</th></tr></thead>
              <tbody>{d.recruiters.map(r => (
                <tr key={r.id}>
                  <td><b>{r.name}</b><div className="t-11 muted">{r.title}</div></td>
                  <td>{r.organization}</td>
                  <td className="num tnum">{r.requisitions}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
