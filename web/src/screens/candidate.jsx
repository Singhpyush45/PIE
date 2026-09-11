import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { IdentityRegister } from '../identityUI.jsx';
import {
  Icon, Button, Card, CardHead, Badge, Pill, Stat, Alert, Meter, Tabs, Empty,
  Skeleton, Insight, Modal, cx,
} from '../kit.jsx';
import { SkillRadar, Gauge, BarList, EvidenceMix, Trajectory, f2, pc } from '../charts.jsx';
import {
  Pipeline, AgentDetail, EvidenceTimeline, SkillsPanel, MatchPanel, LearningPanel,
  BiasPanel, EvidenceDrill, verifOf,
} from '../panels.jsx';
import AssessmentFlow from '../assessmentUI.jsx';

export default function CandidateScreens({ ctx }) {
  const { nav } = ctx;
  const [run, setRun] = useState(null);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(-1);
  const [delta, setDelta] = useState(null);
  const [drill, setDrill] = useState(null);
  const [agentOpen, setAgentOpen] = useState(null);

  /** Run the orchestrator for this candidate against a chosen role. */
  const orchestrate = useCallback(async (requisitionId, trigger = 'CANDIDATE_ASKS_GAP', animate = true) => {
    setRunning(true); setDelta(null);
    if (animate) { setPhase(0); setRun(null); }
    try {
      const r = await api.orchestrate({ requisitionId, trigger });
      if (animate) {
        for (let i = 0; i < 7; i++) { setPhase(i); await new Promise(res => setTimeout(res, 300)); }
        setPhase(99);
      } else setPhase(99);
      setRun(r);
      return r;
    } catch (e) { ctx.notify('crit', e.message); return null; }
    finally { setRunning(false); }
  }, [ctx]);

  const shared = { ctx, run, setRun, running, phase, orchestrate, delta, setDelta,
    setDrill, setAgentOpen };

  return (
    <>
      {nav.view === 'c-dash' && <Dashboard {...shared} />}
      {nav.view === 'c-profile' && <Profile ctx={ctx} />}
      {nav.view === 'c-evidence' && <EvidenceView {...shared} />}
      {nav.view === 'c-import' && <ImportView ctx={ctx} />}
      {nav.view === 'c-jobs' && <Jobs {...shared} />}
      {nav.view === 'c-job' && <JobDetail {...shared} />}
      {nav.view === 'c-apps' && <Applications ctx={ctx} />}
      {nav.view === 'c-learning' && <Learning {...shared} />}
      {nav.view === 'c-match' && <MatchView {...shared} />}
      {nav.view === 'c-assess' && (
        <AssessmentFlow ctx={ctx}
          onExit={() => ctx.nav.go('c-dash')}
          onFinished={async () => { await ctx.reload(); ctx.nav.go('c-dash'); }} />
      )}

      {agentOpen && run && (
        <AgentDetail step={run.steps.find(s => s.key === agentOpen)} onClose={() => setAgentOpen(null)} />
      )}
      {drill && <EvidenceDrill item={drill} evidence={ctx.boot?.evidence} onClose={() => setDrill(null)} />}
    </>
  );
}

/* ================================================================ DASHBOARD */
function Dashboard({ ctx, run, running, phase, orchestrate, setDrill, setAgentOpen }) {
  const { boot, nav } = ctx;
  const profile = boot.profile;
  const evidence = boot.evidence || [];
  const [target, setTarget] = useState(() => boot.openRequisitions?.[0]?.id || '');

  useEffect(() => {
    if (!evidence.length || run || running) return;
    // With a target role, run the full gap pipeline. Without one — a new account
    // before any recruiter has posted a role — still build the capability profile,
    // because a candidate's own picture of themselves should not wait on an employer.
    if (target) orchestrate(target, 'CANDIDATE_ASKS_GAP', false);
    else orchestrate(null, 'EVIDENCE_ADDED', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, evidence.length]);

  if (!profile) return <Skeleton lines={5} />;

  /* --- onboarding state: no evidence yet --- */
  if (!evidence.length) {
    return (
      <div className="stack">
        <Card ai flush>
          <CardHead icon="sparkle" eyebrow={`Welcome, ${profile.name.split(' ')[0]}`}
            title="PIE needs evidence before it can see your capability"
            sub="Not a form. Not keywords. Things you have actually done." />
          <div className="card__body">
            <p className="lede">
              Upload a resume, connect GitHub, add a project, a certificate, a hackathon, or work you
              did outside formal employment. Every source strengthens the picture, and PIE always tells
              you how much it trusts each one.
            </p>
            <Button variant="primary" size="lg" icon="plug" onClick={() => nav.push('c-import')}>
              Import my evidence
            </Button>
          </div>
        </Card>

        <Journey ctx={ctx} />
        <div className="grid g-3">
          {[['file', 'Resume', 'Parsed into structured evidence. Nothing is invented — absent fields stay empty.'],
            ['github', 'GitHub', 'Repository signals as supporting evidence. Never treated as proof of skill.'],
            ['award', 'Certificates & projects', 'Self-reported evidence still counts; it is simply held at lower confidence.']].map(([i, t, d]) => (
            <Card key={t} pad>
              <div className="agent__icon" style={{ marginBottom: 10 }}><Icon name={i} size={16} /></div>
              <h3 style={{ fontSize: 14, marginBottom: 5 }}>{t}</h3>
              <p className="t-12 muted" style={{ margin: 0 }}>{d}</p>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const R = run?.result;
  const d = R?.discovery;
  const m = R?.matching;

  return (
    <div className="stack">
      <Card flush>
        <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <div className="acct__av" style={{ width: 48, height: 48, fontSize: 17,
            background: 'var(--brand-50)', color: 'var(--brand-600)' }}>
            {profile.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="eyebrow">Welcome back</div>
            <h2>{profile.name.split(' ')[0]}, here is what your evidence shows</h2>
            <div className="t-13 muted">{evidence.length} evidence items · {profile.headline}</div>
          </div>
          {(boot.openRequisitions || []).length > 0 && (
            <div className="field" style={{ minWidth: 240 }}>
              <label htmlFor="target" className="sr-only">Target role</label>
              <select id="target" className="input" value={target} onChange={e => setTarget(e.target.value)}>
                {boot.openRequisitions.map(r => (
                  <option key={r.id} value={r.id}>{r.title} — {r.company}</option>
                ))}
              </select>
            </div>
          )}
          <Button variant="primary" icon="target" onClick={() => nav.go('c-assess')}>Take an assessment</Button>
        </div>
      </Card>

      <Journey ctx={ctx} compact />

      {running && !R && <Card pad><Skeleton lines={4} /></Card>}

      {!running && !(boot.openRequisitions || []).length && (
        <Alert tone="info" icon="brief" title="No open roles to match against yet">
          PIE has built your capability profile from your evidence — that part is yours and does not
          depend on anyone hiring. Matching, skill gap and learning pathway need an open requisition,
          which a recruiter posts. Keep adding evidence in the meantime; every source strengthens the
          picture.
        </Alert>
      )}

      {R && (
        <>
          <div className="grid g-4">
            <Card><Stat label="Potential" value={d.potential.tier} tone="ai" icon="sparkle"
              detail="from all five capability dimensions" /></Card>
            <Card><Stat label="Growth readiness" value={d.growthReadiness.tier} tone="ok" icon="market"
              detail="how quickly you can close your gap" /></Card>
            <Card><Stat label="Capabilities evidenced" value={d.skills.length} tone="brand" icon="discover"
              detail={`${d.skills.filter(s => s.corroborated).length} corroborated across sources`} /></Card>
            <Card><Stat label="Gaps to close" value={m.gaps.length} tone="warn" icon="target"
              detail={`${R.learning.totalHours}h of learning mapped`} /></Card>
          </div>

          <Alert tone="ok" title="You get this whatever the outcome" icon="check">
            Your skill gap and learning pathway are yours regardless of whether any recruiter shortlists
            you. A rejection without a reason helps nobody — so PIE always tells you what was missing
            and what to do next.
          </Alert>

          <Card flush>
            <CardHead icon="orchestr" eyebrow="What ran on your evidence"
              title="Your Career Orchestrator run"
              sub="Four specialised agents, coordinated by the orchestrator. Select any step to see what it was allowed to read."
              right={<Button variant="secondary" size="sm" icon="play" disabled={running}
                onClick={() => orchestrate(target)}>Re-run</Button>} />
            <div className="card__body">
              <Pipeline run={run} phase={phase} pipeline={ctx.boot.pipeline} onSelect={setAgentOpen} />
            </div>
          </Card>

          <div className="grid g-2-1">
            <Card flush style={{ alignSelf: 'start' }}>
              <CardHead icon="target" eyebrow="Capability Intelligence Agent" title="Your capability radar"
                sub="Where evidence is thin, PIE says so instead of scoring you low." />
              <div className="card__body"><SkillRadar dimensions={d.dimensions} /></div>
            </Card>

            <div className="stack">
              <Card flush>
                <CardHead icon="check" title="Your strengths" sub="Each one traces to real evidence" />
                <div className="card__body">
                  {d.skills.filter(s => s.confidence >= 0.6).slice(0, 5).map(s => (
                    <div key={s.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-1)' }}>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="t-13" style={{ fontWeight: 600, flex: 1 }}>{s.name}</span>
                        <Meter value={s.confidence} tone="ok" label={s.name} />
                        <span className="tnum t-12" style={{ fontWeight: 700, width: 32 }}>{f2(s.confidence)}</span>
                      </div>
                      <div className="t-11 muted" style={{ marginTop: 3 }}>Evidenced by {s.sources.join(', ')}</div>
                    </div>
                  ))}
                </div>
              </Card>
              <Card flush>
                <CardHead icon="market" title="Growth opportunities"
                  right={<Button variant="ghost" size="sm" iconRight="right"
                    onClick={() => nav.go('c-learning')}>Pathway</Button>} />
                <div className="card__body">
                  {m.gaps.slice(0, 4).map(g => (
                    <div key={g.skillId} style={{ padding: '8px 0', borderBottom: '1px solid var(--line-1)' }}>
                      <div className="row" style={{ gap: 8, marginBottom: 5 }}>
                        <span className="t-13" style={{ fontWeight: 600, flex: 1 }}>{g.name}</span>
                        <Badge tone={g.mandatory ? 'crit' : 'warn'}>{g.mandatory ? 'Required' : 'Preferred'}</Badge>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="t-11 muted nowrap">{f2(g.currentConfidence)}</span>
                        <Meter value={g.currentConfidence} target={g.requiredLevel} label={g.name} />
                        <span className="t-11 nowrap" style={{ fontWeight: 600 }}>{f2(g.requiredLevel)}</span>
                      </div>
                    </div>
                  ))}
                  {!m.gaps.length && <Empty icon="check" title="No open gaps for this role">
                    Your evidence meets every requirement PIE could extract.
                  </Empty>}
                </div>
              </Card>
            </div>
          </div>

          {R.explainability?.narrative && (
            <Insight title="Explainability Agent — why this is what PIE sees"
              insight={R.explainability.narrative.plainSummary}
              evidence={(R.explainability.narrative.whyMatched || []).map(w => w.point).join(' · ') || '—'}
              reasoning={(R.explainability.narrative.gaps || []).map(g => `${g.gap}: ${g.why}`).join(' ') || '—'}
              confidence={d.potential.value}
              recommendation={(R.explainability.narrative.recommendations || [])[0] || 'Work the pathway, then reassess.'}
              uncertainty={(R.explainability.narrative.concerns || [])[0]}
              badge={<Badge tone="ai" dot>{R.explainability.narrative.source === 'llm'
                ? `via ${R.explainability.narrative.provider}` : 'deterministic'}</Badge>} />
          )}

          <div className="grid g-2">
            <Card flush>
              <CardHead icon="learn" title="Learning progress"
                right={<Button variant="primary" size="sm" iconRight="right"
                  onClick={() => nav.go('c-learning')}>Open pathway</Button>} />
              <div className="card__body">
                <BarList items={R.learning.objectives.map(o => ({
                  key: o.objectiveId, label: `${o.sequence}. ${o.skill}`,
                  value: o.from / o.to, display: `${f2(o.from)}/${f2(o.to)}`,
                  meta: `${o.estimatedHours}h · ${o.resources.length} resource(s)`,
                  tip: `${o.skill}: currently ${f2(o.from)}, target ${f2(o.to)}.`,
                }))} emptyLabel="No open objectives for this role." />
              </div>
            </Card>
            <Card flush>
              <CardHead icon="file" title="Evidence timeline"
                right={<Button variant="ghost" size="sm" iconRight="right"
                  onClick={() => nav.go('c-evidence')}>View all</Button>} />
              <div className="card__body" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <EvidenceTimeline evidence={evidence.slice(0, 5)} onDrill={setDrill} />
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================== PROFILE */
function Profile({ ctx }) {
  const p = ctx.boot.profile;
  const [form, setForm] = useState(() => ({
    name: p?.name || '', headline: p?.headline || '',
    githubUsername: p?.githubUsername || '',
    context: { location: '', education: '', priorExperience: '', constraints: '', ...(p?.context || {}) },
  }));
  const [busy, setBusy] = useState(false);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try { await api.updateProfile(form); await ctx.reload(); ctx.notify('ok', 'Profile updated.'); }
    catch (err) { ctx.notify('crit', err.message); }
    setBusy(false);
  }

  if (!p) return <Skeleton lines={4} />;
  return (
    <div className="stack" style={{ maxWidth: 780 }}>
      <IdentityCard ctx={ctx} />
      <form onSubmit={save} className="stack">
      <Card flush>
        <CardHead icon="user" title="Your profile" sub="Context only. None of this is scored." />
        <div className="card__body stack">
          <div className="grid g-2">
            <div className="field"><label htmlFor="n">Name</label>
              <input id="n" className="input" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div className="field"><label htmlFor="g">GitHub username</label>
              <input id="g" className="input" value={form.githubUsername}
                onChange={e => setForm(f => ({ ...f, githubUsername: e.target.value }))} placeholder="username" /></div>
          </div>
          <div className="field"><label htmlFor="h">Headline</label>
            <input id="h" className="input" value={form.headline}
              onChange={e => setForm(f => ({ ...f, headline: e.target.value }))} /></div>
          <div className="grid g-2">
            {[['location', 'Location'], ['education', 'Education'],
              ['priorExperience', 'Prior experience'], ['constraints', 'Working constraints']].map(([k, label]) => (
              <div className="field" key={k}><label htmlFor={k}>{label}</label>
                <input id={k} className="input" value={form.context[k] || ''}
                  onChange={e => setForm(f => ({ ...f, context: { ...f.context, [k]: e.target.value } }))} /></div>
            ))}
          </div>
          <Alert tone="neutral" title="What PIE does with this" icon="lock">
            Location, education and employment history are recorded as context for you and for
            accommodation. The orchestrator withholds them from the matching agent, and the Bias Audit
            service independently verifies they never arrived.
          </Alert>
          <div className="row">
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={busy}>Save profile</Button>
          </div>
        </div>
      </Card>
      </form>
    </div>
  );
}

/* ================================================================= IDENTITY */
/**
 * Registering the face that will be checked before every assessment.
 *
 * It lives on the profile page rather than interrupting the dashboard: a
 * candidate should be able to build their evidence, look around and decide,
 * rather than being met by a camera the moment they sign in. The assessment
 * flow asks for it at the point it is actually needed, and the server refuses
 * to start one without it, so nothing is lost by being unhurried here.
 *
 * There is no "change photo" control, because a candidate who could replace
 * their own registered face could hand the account to someone else.
 */
function IdentityCard({ ctx }) {
  const [identity, setIdentity] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => { api.identity().then(setIdentity).catch(() => setIdentity(null)); }, []);
  if (!identity || ctx.user?.isDemo) return null;

  if (identity.registered) {
    return (
      <Card flush>
        <CardHead icon="shield" title="Your identity"
          sub="Checked before every assessment"
          right={<Badge tone="ok" icon="check">Verified &amp; locked</Badge>} />
        <div className="card__body stack">
          <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
            Registered {new Date(identity.registeredAt).toLocaleDateString()}. PIE stores a numeric
            template, never a photograph, and it is held on the server rather than in this browser.
            Your identity is locked — only Trust &amp; Integrity can reset it, and a reset is recorded
            in the audit trail.
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card flush>
      <CardHead icon="shield" title="Register your identity"
        sub="Required before your first assessment"
        right={<Badge tone="warn" icon="alert">Not registered</Badge>} />
      <div className="card__body stack">
        {!identity.emailVerified && (
          <Alert tone="warn" title="Verify your email first">
            Your email address has not been confirmed yet, so identity registration is not open.
          </Alert>
        )}
        {identity.emailVerified && !open && (
          <>
            <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
              PIE checks that the person sitting an assessment is the person whose account it is.
              That check needs something to compare against, captured once, from your live camera.
            </p>
            <div><Button variant="primary" icon="camera" onClick={() => setOpen(true)}>
              Register my identity
            </Button></div>
          </>
        )}
        {identity.emailVerified && open && (
          <IdentityRegister
            onDone={r => { setIdentity({ ...identity, ...r }); setOpen(false); ctx.notify('ok', 'Identity registered and locked.'); }}
            onSkip={() => setOpen(false)}
          />
        )}
      </div>
    </Card>
  );
}

/* ================================================================= EVIDENCE */
function EvidenceView({ ctx, setDrill }) {
  const evidence = ctx.boot.evidence || [];
  const bySource = evidence.reduce((a, e) => (a[e.source] = (a[e.source] || 0) + 1, a), {});
  const [deleting, setDeleting] = useState(null);

  async function remove(id) {
    try { await api.deleteEvidence(id); await ctx.reload(); ctx.notify('ok', 'Evidence withdrawn.'); }
    catch (e) { ctx.notify('crit', e.message); }
    setDeleting(null);
  }

  return (
    <div className="stack">
      <div className="grid g-4">
        <Card><Stat label="Evidence items" value={evidence.length} icon="file" /></Card>
        <Card><Stat label="API-verified" value={evidence.filter(e => e.verification === 'api_derived').length}
          tone="ok" icon="check" /></Card>
        <Card><Stat label="Issuer-verified" value={evidence.filter(e => e.verification === 'issuer_verified').length}
          tone="brand" icon="award" /></Card>
        <Card><Stat label="Self-reported" value={evidence.filter(e => e.verification === 'self_reported').length}
          icon="user" detail="counts, at lower confidence" /></Card>
      </div>

      <Alert tone="info" title="Trust tier affects confidence, not your worth">
        API-derived evidence outranks issuer-verified, which outranks self-reported. That ordering
        reflects how independently verifiable something is — never how capable you are. A capability
        resting on one source is held at lower confidence and PIE says so out loud.
      </Alert>

      <Card flush>
        <CardHead icon="file" title="Your evidence"
          right={<Button variant="primary" size="sm" icon="plug"
            onClick={() => ctx.nav.push('c-import')}>Import more</Button>} />
        <div className="card__body">
          {evidence.length ? (
            <>
              <div style={{ marginBottom: 22 }}><EvidenceMix bySource={bySource} /></div>
              <EvidenceTimeline evidence={evidence} onDrill={setDrill} />
            </>
          ) : (
            <Empty icon="file" title="No evidence connected yet"
              action={<Button variant="primary" icon="plug" onClick={() => ctx.nav.push('c-import')}>Import evidence</Button>}>
              Upload a resume, connect GitHub, or add projects and certificates.
            </Empty>
          )}
        </div>
      </Card>

      {evidence.length > 0 && (
        <Card flush>
          <CardHead icon="lock" title="Withdraw evidence" sub="Your evidence is yours. Remove any item at any time." />
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Item</th><th>Source</th><th>Trust tier</th><th /></tr></thead>
              <tbody>{evidence.map(e => (
                <tr key={e.id}>
                  <td><b>{e.title}</b></td>
                  <td><Badge tone="neutral">{e.source}</Badge></td>
                  <td><Badge tone={verifOf(e.verification).tone} dot>{verifOf(e.verification).label}</Badge></td>
                  <td><Button variant="danger-ghost" size="sm" icon="x"
                    onClick={() => setDeleting(e)}>Withdraw</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)} title="Withdraw this evidence?"
        footer={<div className="row"><span className="spacer" style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="crit" onClick={() => remove(deleting.id)}>Withdraw</Button></div>}>
        <p className="lede">“{deleting?.title}” will be removed from your profile. Any capability that
          rested on it will drop in confidence or disappear. You can add it again later.</p>
      </Modal>
    </div>
  );
}

/* =================================================================== IMPORT */
function ImportView({ ctx }) {
  const [tab, setTab] = useState('resume');
  return (
    <div className="stack">
      <Tabs value={tab} onChange={setTab} items={[
        { key: 'resume', label: 'Resume', icon: 'file' },
        { key: 'github', label: 'GitHub', icon: 'github' },
        { key: 'scout', label: 'Evidence Scout', icon: 'plug' },
        { key: 'ask', label: 'Ask your evidence', icon: 'eye' },
        { key: 'project', label: 'Project', icon: 'layers' },
        { key: 'certificate', label: 'Certificate', icon: 'award' },
        { key: 'hackathon', label: 'Hackathon', icon: 'trophy' },
        { key: 'other', label: 'Other evidence', icon: 'users' },
      ]} />
      {tab === 'resume' && <ResumeImport ctx={ctx} />}
      {tab === 'github' && <GithubImport ctx={ctx} />}
      {tab === 'scout' && <EvidenceScoutCard ctx={ctx} />}
      {tab === 'ask' && <KnowledgeBaseCard ctx={ctx} />}
      {tab === 'project' && <ProjectImport ctx={ctx} />}
      {tab === 'certificate' && <CertificateImport ctx={ctx} />}
      {tab === 'hackathon' && <HackathonImport ctx={ctx} />}
      {tab === 'other' && <OtherImport ctx={ctx} />}
    </div>
  );
}

/**
 * The Evidence Scout — an agent that decides what to look at.
 *
 * The point of this screen is not the result; it is the LOG. An agent that
 * reaches into somebody's repositories and inbox has to be inspectable by the
 * person whose accounts they are, so every call is shown with the reason it was
 * made and the arguments PIE actually sent — including the ones PIE narrowed.
 * A refused call is shown too, in the same list. Hiding refusals would make the
 * agent look better and the product less trustworthy.
 */
function EvidenceScoutCard({ ctx }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState(null);
  const [login, setLogin] = useState('');

  const load = useCallback(async () => {
    try { setStatus(await api.corsairStatus()); }
    catch (e) { ctx.notify('warn', e.message); setStatus({ available: false }); }
  }, [ctx]);

  useEffect(() => { load(); }, [load]);

  async function connect(plugin) {
    setBusy(true);
    try {
      const r = await api.corsairConnect(plugin);
      // Corsair Hub runs the handshake on its own page. Opening it rather than
      // embedding it is deliberate: a consent screen inside someone else's
      // iframe is exactly the shape a phishing page has.
      window.open(r.connectUrl, '_blank', 'noopener');
      ctx.notify('ok', 'Finish authorising in the new tab, then come back and refresh.');
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  async function scout() {
    setBusy(true); setRun(null);
    try {
      const r = await api.corsairScout({ login: login.trim() || undefined });
      setRun(r);
      if (!r.callLog.length) ctx.notify('warn', r.notice);
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  if (!status) return <Card pad><Skeleton lines={4} /></Card>;

  if (!status.available) {
    return (
      <Card flush>
        <CardHead icon="plug" title="Evidence Scout" sub="Not available on this server" />
        <div className="card__body">
          <Alert tone="warn" title="Corsair is not configured here">
            {status.notice || 'The Scout reads through Corsair, which is not set up on this server.'}
          </Alert>
        </div>
      </Card>
    );
  }

  return (
    <Card flush>
      <CardHead icon="plug" eyebrow="Agent" title="Evidence Scout"
        sub="Decides which of your connected tools to look at, and shows you every call"
        right={run && <Badge tone={run.mode === 'AGENT' ? 'ok' : 'info'} dot>{run.mode}</Badge>} />

      <div className="card__body stack">
        <p className="lede">
          Most of PIE reasons over evidence you have already given it. This one goes and looks —
          your repositories, the commits on the ones that matter, whether they run CI, and any
          course or certificate mail you have. It chooses what to investigate; it cannot change a
          single score.
        </p>

        <Alert tone="info" title="What it can and cannot do" icon="lock">
          <p><b>{status.guarantee}</b></p>
          <p className="t-12">{status.scopeNotice}</p>
        </Alert>

        <div className="row row--wrap" style={{ gap: 8 }}>
          <Badge tone={status.connected ? 'ok' : 'off'} dot>
            GitHub {status.connected ? 'connected' : 'not connected'}
          </Badge>
          {!status.connected && (
            <Button size="sm" icon="github" disabled={busy} onClick={() => connect('github')}>
              Connect GitHub via Corsair
            </Button>
          )}
          <Button size="sm" variant="ghost" icon="book" disabled={busy} onClick={() => connect('gmail')}>
            Connect Gmail
          </Button>
        </div>

        {/* Before the button is pressed, not after.
            Corsair's Gmail plugin has fixed OAuth scopes — send, compose,
            modify, labels — and no read-only one. PIE uses none of them beyond
            two read calls, but the consent screen asks for all four, and a
            candidate who reads "PIE cannot send mail" and then sees "Send email
            on your behalf" on Google's page has been misled by us, however
            true the first sentence was about PIE. */}
        {status.gmailScopeNotice && (
          <Alert tone="warn" title="Gmail asks for more than PIE uses" icon="lock">
            <p className="t-12">{status.gmailScopeNotice}</p>
          </Alert>
        )}

        <div className="field">
          <label htmlFor="scout-login">GitHub username (optional)</label>
          <input id="scout-login" value={login} onChange={e => setLogin(e.target.value)}
            placeholder="leave blank to use your connected account" />
        </div>

        <div className="row row--wrap">
          <Button variant="primary" size="lg" icon="play" disabled={busy} onClick={scout}>
            {busy ? 'Scouting…' : 'Run the Evidence Scout'}
          </Button>
        </div>

        {run && (
          <>
            <Alert tone={run.mode === 'AGENT' ? 'ok' : 'warn'} title={run.notice}>
              <p className="t-12">{run.boundary}</p>
              {run.modelError && (
                // Why it degraded, in one sentence. A degraded agent that will
                // not say why is a bug report nobody can act on — but the
                // provider's raw JSON was not that explanation, it was just
                // noise with a stack of quotation marks in it.
                <p className="t-11 muted" style={{ marginTop: 6 }}>
                  {run.modelError} The evidence below was gathered with PIE's fixed plan.
                  <br /><span className="mono">node tools/ai-test.mjs</span> diagnoses the provider.
                </p>
              )}
            </Alert>

            <div className="stack" style={{ gap: 8 }}>
              <b className="t-13">Every call it made</b>
              {run.callLog.map((c, i) => (
                <div key={i} className={cx('callrow', !c.ok && 'callrow--refused')}>
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <Badge tone={c.ok ? 'ok' : 'warn'}>{c.ok ? 'ran' : c.reason}</Badge>
                    <span className="mono t-12">{c.operation}</span>
                  </div>
                  {c.why && <div className="t-12 muted">Why: {c.why}</div>}
                  {/* The arguments PIE sent, not the ones proposed — so a
                      narrowed Gmail query is visible as narrowed. */}
                  {c.sent && <div className="t-11 mono muted">sent: {JSON.stringify(c.sent)}</div>}
                  {c.summary && <div className="t-12">{c.summary}</div>}
                  {c.detail && <div className="t-11 muted">{c.detail}</div>}
                </div>
              ))}
              {!run.callLog.length && <Empty title="No calls were made" line={run.notice} />}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The knowledge base — questions answered from synced rows, and only those.
 *
 * The screen's job is to make the boundary visible. Two things are always on it:
 * how many rows were searched, and the provenance line saying the answer came
 * out of Corsair's database rather than a model's memory. Without those, an
 * answer here is indistinguishable from a guess — and a recruiter has no way to
 * tell which they are reading.
 */
function KnowledgeBaseCard({ ctx }) {
  const [synced, setSynced] = useState(null);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try { setSynced(await api.corsairSyncStatus()); }
    catch { setSynced({ ok: false, count: 0 }); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function sync() {
    setBusy(true);
    try {
      const r = await api.corsairSync({});
      ctx.notify('ok', r.detail || `${r.synced} repositories synced.`);
      await load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  async function ask(q) {
    const asked = (q ?? question).trim();
    if (!asked) return;
    setBusy(true); setResult(null);
    try { setResult(await api.corsairAsk(asked)); }
    catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  const count = synced?.count ?? 0;

  const EXAMPLES = [
    'which of these are JavaScript?',
    'anything that runs CI?',
    'what has been worked on for six months or more?',
    'show me everything',
  ];

  return (
    <Card flush>
      <CardHead icon="eye" eyebrow="Knowledge base" title="Ask your evidence"
        sub="Questions answered from repositories synced into Corsair's database"
        right={<Badge tone={count ? 'ok' : 'off'} dot>{count} synced</Badge>} />

      <div className="card__body stack">
        <p className="lede">
          Once your repositories are synced, PIE can answer questions about them without calling
          GitHub at all — a query against its own database. Ask in plain English.
        </p>

        <Alert tone="info" title="How an answer is produced" icon="lock">
          <p>A model reads your <b>question</b> and turns it into filters — languages, signals,
            keywords — chosen from a fixed list. PIE then applies those filters to the synced rows
            itself.</p>
          <p className="t-12">So the model helps work out what you asked. It never decides what the
            answer is, and it cannot return a repository that is not in the database. Every result
            below says why it matched.</p>
        </Alert>

        <div className="row row--wrap">
          <Button variant={count ? 'secondary' : 'primary'} icon="refresh" disabled={busy} onClick={sync}>
            {busy ? 'Working…' : count ? 'Re-sync from GitHub' : 'Sync my repositories'}
          </Button>
          {!count && <span className="t-12 muted">Nothing is synced yet — sync first, then ask.</span>}
        </div>

        <div className="field">
          <label htmlFor="kb-q">Your question</label>
          <input id="kb-q" value={question} disabled={!count}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') ask(); }}
            placeholder={count ? 'which of these use Python and run CI?' : 'sync first'} />
        </div>

        <div className="row row--wrap" style={{ gap: 6 }}>
          <Button variant="primary" icon="eye" disabled={busy || !count} onClick={() => ask()}>Ask</Button>
          {count > 0 && EXAMPLES.map(x => (
            <Button key={x} size="sm" variant="ghost" disabled={busy}
              onClick={() => { setQuestion(x); ask(x); }}>{x}</Button>
          ))}
        </div>

        {result && (
          <>
            {/* "PIE has not synced that" is not a warning — it is the system
                being precise about its own limits, which is the point. Warning
                yellow made a correct, careful answer look like a malfunction. */}
            <Alert
              tone={result.matches?.length ? 'ok' : (result.notObserved ? 'info' : 'warn')}
              title={result.answer}
            >
              {result.restated && <p className="t-12">Understood as: {result.restated}</p>}
              {result.filters?.length > 0 && (
                <p className="t-12">Filters applied: {result.filters.join(' · ')}</p>
              )}
              {/* The part of the question PIE did not answer, said out loud.
                  Without this the reader assumes everything asked was tested. */}
              {result.notObserved && (
                <p className="t-12"><b>Not checked:</b> {result.notObserved}</p>
              )}
              {/* Always shown. An answer without its provenance is a claim. */}
              <p className="t-11 muted" style={{ marginTop: 6 }}>{result.provenance}</p>
              {/* One quiet sentence, not the provider's raw JSON. The answer
                  above it is complete either way — the deterministic path is
                  the product, not a fallback for when the model works. */}
              {result.modelError && (
                <p className="t-11 muted">{result.modelError} The question was read by keyword instead.</p>
              )}
            </Alert>

            <div className="stack" style={{ gap: 8 }}>
              {(result.matches || []).map(m => (
                <div key={m.fullName} className="callrow">
                  <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                    <b className="t-13">{m.name}</b>
                    {m.language && <Badge tone="info">{m.language}</Badge>}
                    {m.stars > 0 && <span className="t-11 muted">{m.stars} stars</span>}
                    {m.pushedAt && <span className="t-11 muted">pushed {m.pushedAt}</span>}
                  </div>
                  {m.description && <div className="t-12">{m.description}</div>}
                  <div className="t-11 muted">Matched because: {m.because.join(' · ')}</div>
                </div>
              ))}
              {result.matches?.length === 0 && (
                <Empty title="No matches" line="Nothing in the synced rows satisfies that question. PIE does not widen the search to find something to say." />
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function ResumeImport({ ctx }) {
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [over, setOver] = useState(false);

  async function readFile(file) {
    if (!file) return;
    setFilename(file.name);
    if (/\.(txt|md|json|csv)$/i.test(file.name) || file.type.startsWith('text/')) {
      setText(await file.text());
    } else {
      ctx.notify('warn', `${file.name} is not plain text. Paste the resume content below — PIE will not guess at binary content it cannot read.`);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await api.uploadResume({ text, filename: filename || 'resume.txt' });
      setResult(r); await ctx.reload();
      ctx.notify('ok', `Resume stored. ${r.evidenceCount} evidence items on your profile.`);
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  return (
    <Card flush>
      <CardHead icon="file" title="Resume" sub="Parsed into structured evidence — nothing is invented" />
      <div className="card__body stack">
        <div className={cx('dropzone', over && 'dropzone--over')}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); readFile(e.dataTransfer.files[0]); }}
          onClick={() => document.getElementById('resumefile').click()}>
          <Icon name="file" size={26} style={{ margin: '0 auto 10px', color: 'var(--ink-3)' }} />
          <div style={{ fontWeight: 600, fontSize: 14 }}>Drop a .txt or .md resume, or click to choose</div>
          <div className="t-12 muted" style={{ marginTop: 4 }}>
            PDF and DOCX are not parsed in this demo — paste the text below instead.
          </div>
          <input id="resumefile" type="file" hidden accept=".txt,.md,.json,text/*"
            onChange={e => readFile(e.target.files[0])} />
        </div>
        <div className="field">
          <label htmlFor="rt">Resume text</label>
          <textarea id="rt" className="input" rows={10} value={text} onChange={e => setText(e.target.value)}
            placeholder="Paste your resume here…" />
          <span className="hint">{text.length} characters — at least 80 needed to parse.</span>
        </div>
        <Alert tone="info" title="What PIE will and will not do">
          It extracts only what is written. A section your resume does not have stays empty rather than
          being guessed. It never extracts age, gender, marital status or any protected attribute, even
          if your resume states them.
        </Alert>
        <div className="row">
          <span className="spacer" style={{ flex: 1 }} />
          <Button variant="primary" disabled={busy || text.length < 80} onClick={submit}>
            {busy ? 'Parsing…' : 'Add resume as evidence'}
          </Button>
        </div>
        {result && (
          <Alert tone={result.parsed ? 'ok' : 'warn'} title={result.parsed ? 'Parsed' : 'Stored without structured parsing'}>
            <p>{result.notice}</p>
            {result.parsed && (
              <p className="t-12">
                Extracted: {(result.parsed.skills || []).length} skills ·
                {' '}{(result.parsed.projects || []).length} projects ·
                {' '}{(result.parsed.certifications || []).length} certifications ·
                {' '}{(result.parsed.experience || []).length} roles
              </p>
            )}
          </Alert>
        )}
      </div>
    </Card>
  );
}

function GithubImport({ ctx }) {
  const [status, setStatus] = useState(null);
  const [repos, setRepos] = useState(null);
  const [selected, setSelected] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const st = await api.githubStatus();
      setStatus(st);
      if (st.connected) {
        const r = await api.githubRepositories();
        setRepos(r);
        setSelected(r.repositories.filter(x => x.imported).map(x => x.fullName || x.name));
      }
    } catch (e) { ctx.notify('crit', e.message); }
  }, [ctx]);

  useEffect(() => { load(); }, [load]);

  /* The candidate never types a username. They authorize PIE on github.com and
     GitHub redirects back; the token is exchanged and stored server-side. */
  async function connect() {
    setBusy(true);
    try {
      const r = await api.githubAuthorize();
      window.location.href = r.url;          // leaves the app; returns to /?github=…
    } catch (e) {
      if (e.data?.code === 'GITHUB_OAUTH_UNCONFIGURED') {
        // Honest fallback: show labelled demo repositories rather than failing.
        const r = await api.githubRepositories('meerak');
        setRepos(r); setSelected([]);
        ctx.notify('warn', 'GitHub authorization is not configured on this server — showing labelled demo repositories.');
      } else ctx.notify('crit', e.message);
      setBusy(false);
    }
  }

  async function importSelected() {
    setBusy(true);
    try {
      const r = await api.githubImport({ repositories: selected, username: repos?.login || 'meerak' });
      await ctx.reload();
      ctx.notify('ok', `${r.imported} repository/repositories imported as evidence.`);
      load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  async function disconnect(deleteEvidence) {
    setBusy(true);
    try {
      const r = await api.githubDisconnect({ deleteEvidence });
      await ctx.reload();
      ctx.notify('ok', r.notice);
      setRepos(null); setSelected([]); setDisconnecting(false);
      load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  if (!status) return <Card pad><Skeleton lines={4} /></Card>;

  const conn = status.connection;
  const list = (repos?.repositories || []).filter(r =>
    !q || `${r.name} ${r.description || ''} ${(r.languages || []).join(' ')}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <Card flush>
      <CardHead icon="github" title="GitHub"
        sub={conn ? `Connected as @${conn.login}` : 'Authorize PIE to read the repositories you choose'}
        right={conn
          ? <Badge tone="ok" dot>Connected</Badge>
          : <Badge tone={status.oauth.state === 'OAUTH_READY' ? 'info' : 'warn'} dot>
              {status.oauth.state === 'OAUTH_READY' ? 'Ready to connect' : 'Demo fixtures'}
            </Badge>} />

      <div className="card__body stack">
        {!conn && (
          <>
            <Alert tone="info" title="What PIE asks for" icon="lock">
              <p><b>{status.oauth.permissionStatement}</b></p>
              <p>Scopes requested: <span className="mono">{status.oauth.scopes.join(', ')}</span> — read only.
                Your access token is exchanged and stored on the server, encrypted. It is never sent to
                your browser and never appears in a URL.</p>
            </Alert>

            {status.oauth.state !== 'OAUTH_READY' && (
              <Alert tone="warn" title="GitHub authorization is not configured on this server">
                <p>{status.oauth.detail}</p>
                <p className="t-12">To enable it, set <span className="mono">{status.oauth.requires}</span> in
                  <span className="mono"> server/.env</span> with callback
                  <span className="mono"> {status.oauth.callbackUrl}</span>.</p>
              </Alert>
            )}

            <div className="row row--wrap">
              <Button variant="primary" size="lg" icon="github" disabled={busy} onClick={connect}>
                Connect GitHub
              </Button>
              {status.installUrl && (
                <a className="btn btn--secondary" href={status.installUrl} target="_blank" rel="noreferrer">
                  <Icon name="ext" size={14} />Choose repositories on GitHub
                </a>
              )}
            </div>
          </>
        )}

        {conn && (
          <div className="row row--wrap" style={{ gap: 10 }}>
            {conn.avatarUrl && <img src={conn.avatarUrl} alt="" width="34" height="34"
              style={{ borderRadius: '50%', border: '1px solid var(--line-2)' }} />}
            <div style={{ flex: 1, minWidth: 160 }}>
              <b className="t-13">@{conn.login}</b>
              <div className="t-11 muted">Connected {new Date(conn.connectedAt).toLocaleDateString()} ·
                scopes {conn.scopes} · token stored encrypted (fp {conn.tokenFingerprint})</div>
            </div>
            <Button variant="secondary" size="sm" icon="refresh" disabled={busy} onClick={load}>Refresh</Button>
            <Button variant="danger-ghost" size="sm" icon="x" disabled={busy}
              onClick={() => setDisconnecting(true)}>Disconnect</Button>
          </div>
        )}

        {repos && (
          <>
            <Alert tone={repos.mode === 'REAL' ? 'ok' : 'warn'}
              title={repos.mode === 'REAL' ? 'Your repositories' : 'Demo repository data'}>
              {repos.notice}
            </Alert>

            <div className="field">
              <label htmlFor="repoq">Search repositories</label>
              <input id="repoq" className="input" value={q} onChange={e => setQ(e.target.value)}
                placeholder="name, language or description" />
            </div>

            <div className="grid" style={{ gap: 8, maxHeight: 420, overflowY: 'auto' }}>
              {list.map(r => {
                const key = r.fullName || r.name;
                const on = selected.includes(key);
                return (
                  <label key={key} className={cx('repocard', on && 'repocard--on')}>
                    <input type="checkbox" checked={on} onChange={() =>
                      setSelected(s => (on ? s.filter(x => x !== key) : [...s, key]))} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="row row--wrap" style={{ gap: 7 }}>
                        <b className="t-13">{r.name}</b>
                        {(r.languages || []).slice(0, 3).map(l => <Badge key={l} tone="neutral">{l}</Badge>)}
                        <Badge tone={r.visibility === 'private' ? 'warn' : 'neutral'}>{r.visibility || 'public'}</Badge>
                        {r.imported && <Badge tone="ok" icon="check">Imported</Badge>}
                      </div>
                      <div className="t-12 muted" style={{ marginTop: 3 }}>{r.description || 'No description'}</div>
                      <div className="t-11 faint" style={{ marginTop: 3 }}>
                        {r.pushedAt ? `Updated ${r.pushedAt}` : ''}
                        {r.stars ? ` · ★ ${r.stars}` : ''}
                        {r.commits ? ` · ${r.commits} commits` : ''}
                        {r.hasTests ? ' · tests' : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
              {!list.length && <Empty icon="github" title="No repositories match that search" />}
            </div>

            <div className="row">
              <span className="t-12 muted" style={{ flex: 1 }}>
                {selected.length} selected · PIE analyses only what you choose
              </span>
              <Button variant="primary" disabled={busy || !selected.length} onClick={importSelected}>
                Import selected
              </Button>
            </div>
          </>
        )}

        <Alert tone="neutral" title="How PIE treats repository evidence">
          Languages, activity, tests, documentation and structure are read as <b>supporting evidence</b>
          {' '}for capability. Repository activity is never treated as proof of expertise, and PIE does not
          claim to have understood code it has not read.
        </Alert>
      </div>

      <Modal open={disconnecting} onClose={() => setDisconnecting(false)} title="Disconnect GitHub?"
        footer={
          <div className="row">
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setDisconnecting(false)}>Cancel</Button>
            <Button variant="secondary" disabled={busy} onClick={() => disconnect(false)}>
              Disconnect, keep evidence
            </Button>
            <Button variant="crit" disabled={busy} onClick={() => disconnect(true)}>
              Disconnect and delete evidence
            </Button>
          </div>
        }>
        <div className="stack">
          <p className="lede">
            Your stored access credential is destroyed either way, and PIE attempts to revoke it at
            GitHub. After this, PIE cannot read anything from your account until you reconnect.
          </p>
          <Alert tone="neutral" title="What happens to what you already imported">
            You choose. Keeping it leaves the repository evidence on your profile — you can still delete
            individual items from the Evidence Center. Deleting it removes every imported repository and
            its evidence now.
          </Alert>
        </div>
      </Modal>
    </Card>
  );
}

function ProjectImport({ ctx }) {
  const [f, setF] = useState({ name: '', description: '', technologies: '', role: '', problem: '', solution: '', repository: '', outcome: '', teamSize: '', duration: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.addProject({ ...f, technologies: f.technologies.split(',').map(s => s.trim()).filter(Boolean) });
      await ctx.reload();
      ctx.notify('ok', 'Project added as evidence.');
      setF({ name: '', description: '', technologies: '', role: '', problem: '', solution: '', repository: '', outcome: '', teamSize: '', duration: '' });
    } catch (err) { ctx.notify('crit', err.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <Card flush>
        <CardHead icon="layers" title="Project" sub="Projects are first-class evidence of capability" />
        <div className="card__body stack">
          <div className="grid g-2">
            <div className="field"><label htmlFor="pn">Project name</label>
              <input id="pn" className="input" required value={f.name} onChange={e => set('name', e.target.value)} /></div>
            <div className="field"><label htmlFor="pt">Technologies <span className="muted">(comma separated)</span></label>
              <input id="pt" className="input" value={f.technologies} onChange={e => set('technologies', e.target.value)}
                placeholder="Python, SQL, Docker" /></div>
          </div>
          <div className="field"><label htmlFor="pd">Description</label>
            <textarea id="pd" className="input" rows={3} value={f.description}
              onChange={e => set('description', e.target.value)} /></div>
          <div className="grid g-2">
            <div className="field"><label htmlFor="pp">Problem it solved</label>
              <textarea id="pp" className="input" rows={2} value={f.problem} onChange={e => set('problem', e.target.value)} /></div>
            <div className="field"><label htmlFor="ps">How you solved it</label>
              <textarea id="ps" className="input" rows={2} value={f.solution} onChange={e => set('solution', e.target.value)} /></div>
          </div>
          <div className="grid g-4">
            <div className="field"><label htmlFor="pr">Your role</label>
              <input id="pr" className="input" value={f.role} onChange={e => set('role', e.target.value)} /></div>
            <div className="field"><label htmlFor="prep">Repository</label>
              <input id="prep" className="input" value={f.repository} onChange={e => set('repository', e.target.value)} /></div>
            <div className="field"><label htmlFor="pts">Team size</label>
              <input id="pts" className="input" type="number" min="1" value={f.teamSize} onChange={e => set('teamSize', e.target.value)} /></div>
            <div className="field"><label htmlFor="pdur">Duration</label>
              <input id="pdur" className="input" value={f.duration} onChange={e => set('duration', e.target.value)} placeholder="3 months" /></div>
          </div>
          <div className="field"><label htmlFor="po">Outcome</label>
            <input id="po" className="input" value={f.outcome} onChange={e => set('outcome', e.target.value)}
              placeholder="What changed because this existed?" /></div>
          <Alert tone="neutral" title="Recorded as self-reported">
            A project you describe yourself is self-reported evidence. Linking a repository lets PIE
            corroborate it against API-derived signals, which raises confidence.
          </Alert>
          <div className="row"><span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={busy || f.name.length < 2}>Add project</Button></div>
        </div>
      </Card>
    </form>
  );
}

function OtherImport({ ctx }) {
  const [f, setF] = useState({ source: 'nontraditional', title: '', text: '', date: '', verifyRef: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      await api.addEvidence(f); await ctx.reload();
      ctx.notify('ok', 'Evidence added.');
      setF({ source: f.source, title: '', text: '', date: '', verifyRef: '' });
    } catch (err) { ctx.notify('crit', err.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <Card flush>
        <CardHead icon="users" title="Other evidence"
          sub="Capability built outside formal employment — the evidence most systems throw away" />
        <div className="card__body stack">
          <div className="field">
            <label>Type</label>
            <div className="grid g-4" style={{ gap: 8 }}>
              {[['nontraditional', 'Non-traditional', 'users'], ['learning', 'Learning', 'book'],
                ['open_source', 'Open source', 'github'], ['other', 'Something else', 'layers']].map(([v, l, i]) => (
                <button key={v} type="button" className={cx('checkline', f.source === v && 'checkline--on')}
                  onClick={() => set('source', v)}>
                  <Icon name={i} size={15} style={{ marginTop: 1 }} />
                  <span className="t-13" style={{ fontWeight: 600 }}>{l}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field"><label htmlFor="ot">Title</label>
            <input id="ot" className="input" required value={f.title} onChange={e => set('title', e.target.value)} /></div>
          <div className="field"><label htmlFor="ox">What it involved</label>
            <textarea id="ox" className="input" rows={3} value={f.text} onChange={e => set('text', e.target.value)}
              placeholder="What you actually did, and what skills it exercised." /></div>
          <div className="grid g-2">
            <div className="field"><label htmlFor="od">Date <span className="muted">(YYYY-MM)</span></label>
              <input id="od" className="input" value={f.date} onChange={e => set('date', e.target.value)} placeholder="2025-06" /></div>
            {f.source === 'certificate' && (
              <div className="field"><label htmlFor="ov">Verification reference <span className="muted">(optional)</span></label>
                <input id="ov" className="input" value={f.verifyRef} onChange={e => set('verifyRef', e.target.value)}
                  placeholder="Credential ID" />
                <span className="hint">A verification reference raises this to issuer-verified.</span></div>
            )}
          </div>
          {f.source === 'nontraditional' && (
            <Alert tone="ok" title="This is exactly the evidence most systems throw away" icon="check">
              Volunteering, community projects, caregiving-period study, mentoring — capability built
              outside formal employment is still capability. PIE reads it for signal.
            </Alert>
          )}
          <div className="row"><span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={busy || f.title.length < 3}>Add evidence</Button></div>
        </div>
      </Card>
    </form>
  );
}

/* ===================================================================== JOBS */
function Jobs({ ctx, orchestrate }) {
  const [jobs, setJobs] = useState(null);
  const load = useCallback(() => api.jobs().then(r => setJobs(r.requisitions)).catch(e => ctx.notify('crit', e.message)), [ctx]);
  useEffect(() => { load(); }, [load]);
  if (!jobs) return <Skeleton lines={5} />;
  return (
    <div className="stack">
      <Alert tone="info" title="Matching is skills-first">
        Your institution, employment continuity, gap duration and location are withheld from the
        matching agent. What it sees is your evidence and what the role actually requires.
      </Alert>
      {!jobs.length && <NoRolesYet what="Job matching" />}
      <div className="grid g-2">
        {jobs.map(j => (
          <Card key={j.id} className="card--interactive" pad
            onClick={() => ctx.nav.push('c-job', { requisitionId: j.id, title: j.title })}>
            <div className="row row--wrap" style={{ gap: 8, marginBottom: 8 }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <h3 style={{ fontSize: 15 }}>{j.title}</h3>
                <div className="t-12 muted">{j.company} · {j.location}</div>
              </div>
              {j.applied ? <Badge tone="ok" icon="check">Applied</Badge> : <Badge tone="neutral">{j.employmentType}</Badge>}
            </div>
            <div className="row row--wrap" style={{ gap: 6 }}>
              {(j.requiredSkills || []).slice(0, 5).map(s => <Badge key={s} tone="info">{s}</Badge>)}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function JobDetail({ ctx, run, running, orchestrate }) {
  const id = ctx.nav.params.requisitionId;
  const job = (ctx.boot.openRequisitions || []).find(r => r.id === id);
  const [applying, setApplying] = useState(false);
  const applied = (ctx.boot.applications || []).some(a => a.requisitionId === id && a.status !== 'DISCOVERED');

  useEffect(() => { if (id) orchestrate(id, 'CANDIDATE_ASKS_GAP', false); }, [id, orchestrate]);

  async function apply() {
    setApplying(true);
    try {
      await api.apply(id); await ctx.reload();
      ctx.notify('ok', 'Application submitted. The recruiter decides — PIE only recommends.');
    } catch (e) { ctx.notify('crit', e.message); }
    setApplying(false);
  }

  if (!job) return <Card pad><Empty icon="brief" title="Role not found" /></Card>;
  const m = run?.result?.matching;

  return (
    <div className="stack">
      <Card flush>
        <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2>{job.title}</h2>
            <div className="t-13 muted">{job.company} · {job.location} · {job.employmentType}</div>
          </div>
          {applied
            ? <Badge tone="ok" icon="check">Applied</Badge>
            : <Button variant="primary" icon="right" disabled={applying} onClick={apply}>Apply with my evidence</Button>}
        </div>
        <div className="card__body">
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, color: 'var(--ink-2)',
            background: 'var(--surface-2)', border: '1px solid var(--line-1)', borderRadius: 8,
            padding: 16, margin: 0, fontFamily: 'inherit', maxHeight: 320, overflow: 'auto' }}>{job.text}</pre>
        </div>
      </Card>

      {running && !m && <Card pad><Skeleton lines={4} /></Card>}
      {m && (
        <>
          <Card flush>
            <CardHead icon="match" eyebrow="Inclusive Matching Agent" title="How you match this role"
              sub="Both scores are always shown, never blended" />
            <div className="card__body">
              <div className="row" style={{ gap: 28, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Gauge value={m.skillsFirstScore} label="Skills-first" sub="evidence vs. requirements" />
                <Gauge value={m.potentialAdjusted} label="Potential-adjusted" sub="includes growth signal"
                  tone="var(--series-3)" />
              </div>
              <Alert tone="neutral" title="What was withheld">{m.disclosure}</Alert>
            </div>
          </Card>
          <MatchPanel matching={m} />
        </>
      )}
    </div>
  );
}

/* ============================================================= APPLICATIONS */
/**
 * What a candidate is told once a human has decided.
 *
 * A rejection here is not a one-line "no". It names what the evidence did
 * support, what this role needed that it did not cover, and the pathway that
 * closes the difference — because the difference between those two versions of
 * the same message is the difference between being filtered out and being told
 * how to get in.
 *
 * The reviewer's private note is deliberately absent. This is built from the
 * same evidence and gaps the system computed, which PIE can stand behind.
 */
function Outcome({ outcome, ctx }) {
  const n = outcome.narrative;
  const rejected = outcome.rejected;
  const tone = rejected ? 'warn' : outcome.action === 'PROCEED_TO_INTERVIEW' ? 'ok' : 'info';

  return (
    <div className="stack" style={{ marginBottom: 14 }}>
      <Alert tone={tone} title={n?.headline || `Your application is ${outcome.outcome}.`}>
        {n ? (
          <>
            <p>{n.whatWasStrong}</p>
            {n.whatWasMissing && <p><b>What this role needed that your evidence did not cover:</b> {n.whatWasMissing}</p>}
            {n.nextStep && <p>{n.nextStep}</p>}
            {n.whatIsNext && <p>{n.whatIsNext}</p>}
          </>
        ) : <p>{outcome.fallback}</p>}
      </Alert>

      {rejected && outcome.learningSteps?.length > 0 && (
        <Card flush>
          <CardHead icon="learn" eyebrow="Your pathway" title="What closes the gap"
            sub="Built from the specific capabilities this role required"
            right={<Button size="sm" variant="secondary" iconRight="right"
              onClick={() => ctx.nav.go('c-learning')}>Open learning pathway</Button>} />
          <div className="card__body">
            <div className="row row--wrap" style={{ gap: 6, marginBottom: 10 }}>
              {outcome.gaps.map(g => <Badge key={g.skill} tone="warn">{g.skill}</Badge>)}
            </div>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {outcome.learningSteps.map((step, i) => (
                <li key={i} style={{ marginBottom: 4 }}>{step}</li>
              ))}
            </ol>
          </div>
        </Card>
      )}

      {n && (
        <p className="note">
          <Icon name="info" size={12} className="note__i" />
          <span>{outcome.note}</span>
        </p>
      )}
    </div>
  );
}

function Applications({ ctx }) {
  const apps = ctx.boot.applications || [];
  const STATES = ['DISCOVERED', 'APPLIED', 'ASSESSMENT_REQUIRED', 'ASSESSMENT_COMPLETED', 'UNDER_REVIEW', 'HUMAN_DECISION'];
  if (!apps.length) return <Card pad><Empty icon="layers" title="No applications yet"
    action={<Button variant="primary" icon="brief" onClick={() => ctx.nav.go('c-jobs')}>Discover roles</Button>}>
    Applying puts your evidence in front of a recruiter — who makes every decision.
  </Empty></Card>;

  return (
    <div className="stack">
      {apps.map(a => (
        <Card key={a.id} flush>
          <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <h3>{a.requisitionTitle}</h3>
              <div className="sub">{a.company} · applied {new Date(a.appliedAt).toLocaleDateString()}</div>
            </div>
            {a.integrityStatus && <Badge tone="warn" icon="lock">{a.integrityStatus.replace(/_/g, ' ')}</Badge>}
            <Badge tone={a.status === 'HUMAN_DECISION' ? 'ok' : 'info'} dot>{a.status.replace(/_/g, ' ')}</Badge>
          </div>
          <div className="card__body">
            <div className="steps" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
              {STATES.map((s, i) => {
                const idx = STATES.indexOf(a.status);
                return (
                  <React.Fragment key={s}>
                    {i > 0 && <div className={cx('steps__line', i <= idx && 'steps__line--done')} style={{ minWidth: 12 }} />}
                    <div className={cx('steps__node', i < idx && 'steps__node--done', i === idx && 'steps__node--now')}>
                      <span className="steps__dot">{i < idx ? '✓' : i + 1}</span>
                      <span className="t-11">{s.replace(/_/g, ' ').toLowerCase()}</span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            {a.outcome && <Outcome outcome={a.outcome} ctx={ctx} />}

            {a.status === 'ASSESSMENT_REQUIRED' && (
              <Alert tone="info" title="An assessment is waiting">
                <p>The questions are generated from this role's required capabilities and your own evidence.</p>
                <Button variant="primary" size="sm" icon="target"
                  onClick={() => ctx.nav.go('c-assess')}>Start assessment</Button>
              </Alert>
            )}
            {a.decision && (
              <Alert tone={a.decision.action === 'REJECT' ? 'warn' : 'ok'}
                title={`${a.decision.action.replace(/_/g, ' ')} — decided by ${a.decision.reviewer}`}>
                “{a.decision.reason}” · {new Date(a.decision.at).toLocaleString()}
              </Alert>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ================================================================= LEARNING */
function Learning({ ctx, run, running, orchestrate, delta, setDelta }) {
  const [busy, setBusy] = useState(false);
  const target = (ctx.boot.openRequisitions || [])[0]?.id;
  useEffect(() => { if (!run && target) orchestrate(target, 'CANDIDATE_ASKS_GAP', false); }, [run, target, orchestrate]);

  async function reassess(skillId) {
    setBusy(true);
    try {
      const r = await api.reassess(run.runId, { skillId });
      setDelta(r.delta); await ctx.reload();
      ctx.notify('ok', `${r.delta.skill} reassessed — match ${f2(r.delta.matchBefore)} → ${f2(r.delta.matchAfter)}.`);
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  // With no open requisition there is no skill gap to build a pathway from, and
  // the panel would render a wall of zeros. Say why instead.
  if (!target) return <div className="stack"><NoRolesYet what="A learning pathway" /></div>;
  if (running || !run) return <Skeleton lines={6} />;
  const R = run.result;
  if (!R?.learning || R.learning.notRun) {
    return <div className="stack"><NoRolesYet what="A learning pathway" /></div>;
  }
  return (
    <div className="stack">
      {R.learning.pathway?.source === 'llm' && (
        <Insight title="Career Roadmap Agent"
          insight={R.learning.pathway.summary}
          evidence={(R.learning.pathway.prioritisedSkills || []).map(s => `${s.order}. ${s.skill}`).join(' · ')}
          reasoning={(R.learning.pathway.prioritisedSkills || []).map(s => s.why).join(' ')}
          recommendation={R.learning.pathway.reassessmentAdvice}
          badge={<Badge tone="ai" dot>via {R.learning.pathway.provider}</Badge>} />
      )}
      <LearningPanel learning={R.learning} gaps={R.matching.gaps} delta={delta}
        onReassess={reassess} busy={busy} candidateView />
    </div>
  );
}

function MatchView({ ctx, run }) {
  if (!run) return <Skeleton lines={5} />;
  return <MatchPanel matching={run.result.matching} />;
}

/* ============================================================ NO ROLES YET
   A brand-new PIE has no employers on it. That is a cold start, not a fault,
   and it is worth saying out loud on every screen it blanks out — otherwise a
   candidate reads an empty page as the product being broken.                */
export function NoRolesYet({ what }) {
  return (
    <Alert tone="info" icon="brief" title="No open roles yet — that is why this is empty">
      <p style={{ margin: '0 0 8px' }}>
        {what} needs an <b>open requisition</b>, and a requisition is something a recruiter posts.
        No one has posted one on this instance yet.
      </p>
      <p style={{ margin: 0 }}>
        Your capability profile does <b>not</b> wait for that — PIE has already built it from your
        evidence. To see the rest of the journey, ask a recruiter to post a role, or create a
        recruiter account yourself from the sign-in screen and post one.
      </p>
    </Alert>
  );
}

/* ================================================================== JOURNEY
   The candidate's actual progression, derived from their own data — never a
   decorative stepper. Each step knows whether it is done, current or ahead,
   and clicking one goes there. This is the answer to "what do I do next?".  */
export function Journey({ ctx, compact }) {
  const { boot, nav } = ctx;
  const evidence = boot?.evidence || [];
  const profile = boot?.profile;
  const apps = boot?.applications || [];

  const has = (src) => evidence.some(e => e.source === src);
  const ctxFields = profile?.context || {};
  const profileFilled = Boolean(ctxFields.targetRole || ctxFields.education || ctxFields.location);

  const steps = [
    { key: 'account',  view: null,          title: 'Account',   line: 'Signed in',
      done: true },
    { key: 'profile',  view: 'c-profile',   title: 'Profile',   line: 'Who you are and what you are aiming at',
      done: profileFilled },
    { key: 'resume',   view: 'c-import',    title: 'Resume',    line: 'Your history, parsed into evidence',
      done: has('resume') },
    { key: 'github',   view: 'c-import',    title: 'GitHub',    line: 'Repository signals — supporting, never proof',
      done: has('github') },
    { key: 'more',     view: 'c-import',    title: 'Projects, certificates, hackathons',
      line: 'Work that no resume line captures',
      done: evidence.some(e => ['project', 'certificate', 'hackathon', 'other'].includes(e.source)) },
    { key: 'capability', view: 'c-dash',    title: 'Capability profile',
      line: 'What your evidence actually shows',
      done: evidence.length >= 2 },
    { key: 'match',    view: 'c-jobs',      title: 'Job matching', line: 'Roles matched on skills, not pedigree',
      done: apps.length > 0 },
    { key: 'gap',      view: 'c-learning',  title: 'Skill gap & learning',
      line: 'Exactly what to learn, and where',
      done: apps.some(a => a.status && a.status !== 'DISCOVERED') },
    { key: 'assess',   view: 'c-assess',    title: 'Assessment', line: 'Prove capability you cannot yet evidence',
      done: apps.some(a => ['ASSESSMENT_COMPLETED', 'UNDER_REVIEW', 'HUMAN_DECISION'].includes(a.status)) },
    { key: 'decision', view: 'c-apps',      title: 'Recruiter decision',
      line: 'A named human decides — never the AI',
      done: apps.some(a => a.status === 'HUMAN_DECISION') },
  ];

  const currentIndex = steps.findIndex(s => !s.done);
  const doneCount = steps.filter(s => s.done).length;

  return (
    <Card flush>
      <CardHead icon="layers" eyebrow="Your journey"
        title={compact ? 'Where you are' : 'From account to decision'}
        sub={currentIndex < 0
          ? 'Every step complete. Your evidence is with a human reviewer.'
          : `Next: ${steps[currentIndex].title}`}
        right={<Badge tone={doneCount === steps.length ? 'ok' : 'info'}>
          {doneCount} of {steps.length}
        </Badge>} />
      <div className="card__body">
        <ol className="journey" aria-label="Candidate journey">
          {steps.map((s, i) => {
            const state = s.done ? 'done' : i === currentIndex ? 'now' : 'next';
            const Tag = s.view ? 'button' : 'div';
            return (
              <li key={s.key} className={cx('journey__step', `journey__step--${state}`)}>
                <Tag
                  className="journey__hit"
                  {...(s.view ? {
                    type: 'button',
                    onClick: () => nav.go(s.view),
                    'aria-label': `${s.title} — ${state === 'done' ? 'complete' : state === 'now' ? 'next step' : 'not started'}`,
                  } : {})}
                >
                  <span className="journey__dot" aria-hidden="true">
                    {s.done ? <Icon name="check" size={11} /> : i + 1}
                  </span>
                  <span className="journey__body">
                    <span className="journey__title">{s.title}</span>
                    {!compact && <span className="journey__line">{s.line}</span>}
                  </span>
                </Tag>
              </li>
            );
          })}
        </ol>
        {!compact && (
          <p className="t-11 faint" style={{ marginTop: 12, marginBottom: 0 }}>
            You can do these in any order. PIE reasons over whatever evidence exists and tells you how
            much it trusts each source — an incomplete profile is never held against you.
          </p>
        )}
      </div>
    </Card>
  );
}

/* ============================================================= CERTIFICATES
   A typed record, not a free-text note. The issuer and the credential
   reference are what let a recruiter check it themselves — which is the only
   thing that makes a certificate worth more than a claim.                   */
function CertificateImport({ ctx }) {
  const blank = { title: '', issuer: '', issuedOn: '', credentialId: '',
    verificationUrl: '', skills: '', summary: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  const verifiable = Boolean(f.credentialId.trim() || /^https?:\/\//i.test(f.verificationUrl.trim()));

  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.addCertificate({
        ...f,
        skills: f.skills.split(',').map(t => t.trim()).filter(Boolean),
      });
      await ctx.reload();
      ctx.notify('ok', r.notice || 'Certificate added.');
      setF(blank);
    } catch (err) { ctx.notify('crit', err.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <Card flush>
        <CardHead icon="award" title="Add a certificate"
          sub="Recorded as a typed record so a recruiter can verify it at the source" />
        <div className="card__body stack">
          <div className="grid g-2">
            <div className="field"><label htmlFor="ct">Certificate title</label>
              <input id="ct" className="input" required value={f.title}
                onChange={e => set('title', e.target.value)}
                placeholder="e.g. AWS Certified Developer — Associate" /></div>
            <div className="field"><label htmlFor="ci">Issuing organisation</label>
              <input id="ci" className="input" value={f.issuer}
                onChange={e => set('issuer', e.target.value)} placeholder="e.g. AWS, Google, Coursera" /></div>
          </div>

          <div className="grid g-3">
            <div className="field"><label htmlFor="cd">Issued <span className="muted">(YYYY-MM)</span></label>
              <input id="cd" className="input" value={f.issuedOn}
                onChange={e => set('issuedOn', e.target.value)} placeholder="2026-03" /></div>
            <div className="field"><label htmlFor="cc">Credential ID</label>
              <input id="cc" className="input" value={f.credentialId}
                onChange={e => set('credentialId', e.target.value)} placeholder="Optional" /></div>
            <div className="field"><label htmlFor="cv">Verification URL</label>
              <input id="cv" className="input" type="url" value={f.verificationUrl}
                onChange={e => set('verificationUrl', e.target.value)} placeholder="https://…" /></div>
          </div>

          <div className="field"><label htmlFor="cs">Skills it covers <span className="muted">(comma separated)</span></label>
            <input id="cs" className="input" value={f.skills}
              onChange={e => set('skills', e.target.value)} placeholder="Node.js, REST APIs, SQL" /></div>

          <div className="field"><label htmlFor="cm">What it required of you</label>
            <textarea id="cm" className="input" rows={3} value={f.summary}
              onChange={e => set('summary', e.target.value)}
              placeholder="A proctored exam? A built project? Say what you actually had to do — PIE reads this, not the badge." /></div>

          <Alert tone={verifiable ? 'ok' : 'neutral'} icon={verifiable ? 'check' : 'info'}
            title={verifiable ? 'This will be recorded as ISSUER-VERIFIED' : 'This will be recorded as SELF-REPORTED'}>
            {verifiable
              ? 'A recruiter can follow your reference and check it at the source. PIE does not contact the issuer on your behalf and never claims to have verified it itself.'
              : 'Self-reported evidence still counts — it is simply held at lower confidence. Add a credential ID or a verification URL to raise its trust tier.'}
          </Alert>

          <div className="row"><span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={busy || f.title.trim().length < 2}>
              {busy ? 'Adding…' : 'Add certificate'}
            </Button></div>
        </div>
      </Card>
    </form>
  );
}

/* =============================================================== HACKATHONS
   Where a great deal of real capability gets built, and where almost no
   hiring system looks. Typed so the role, the build and the outcome survive
   as three separate facts instead of one line on a resume.                  */
function HackathonImport({ ctx }) {
  const blank = { name: '', organiser: '', year: '', role: '', project: '',
    built: '', achievement: '', teamSize: '', technologies: '', link: '' };
  const [f, setF] = useState(blank);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function submit(e) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await api.addHackathon({
        ...f,
        technologies: f.technologies.split(',').map(t => t.trim()).filter(Boolean),
        teamSize: f.teamSize ? Number(f.teamSize) : null,
      });
      await ctx.reload();
      ctx.notify('ok', r.notice || 'Hackathon added.');
      setF(blank);
    } catch (err) { ctx.notify('crit', err.message); }
    setBusy(false);
  }

  return (
    <form onSubmit={submit}>
      <Card flush>
        <CardHead icon="trophy" title="Add a hackathon"
          sub="What you built under pressure, and what you were responsible for" />
        <div className="card__body stack">
          <div className="grid g-2">
            <div className="field"><label htmlFor="hn">Hackathon name</label>
              <input id="hn" className="input" required value={f.name}
                onChange={e => set('name', e.target.value)} placeholder="e.g. Hack &amp; Build 2026" /></div>
            <div className="field"><label htmlFor="ho">Organiser</label>
              <input id="ho" className="input" value={f.organiser}
                onChange={e => set('organiser', e.target.value)} placeholder="e.g. Nagarro" /></div>
          </div>

          <div className="grid g-3">
            <div className="field"><label htmlFor="hy">Year</label>
              <input id="hy" className="input" value={f.year}
                onChange={e => set('year', e.target.value)} placeholder="2026" /></div>
            <div className="field"><label htmlFor="hr">Your role</label>
              <input id="hr" className="input" value={f.role}
                onChange={e => set('role', e.target.value)} placeholder="e.g. Backend + orchestration" /></div>
            <div className="field"><label htmlFor="hs">Team size</label>
              <input id="hs" className="input" type="number" min="1" max="50" value={f.teamSize}
                onChange={e => set('teamSize', e.target.value)} placeholder="4" /></div>
          </div>

          <div className="field"><label htmlFor="hp">What you built</label>
            <input id="hp" className="input" value={f.project}
              onChange={e => set('project', e.target.value)} placeholder="Project name" /></div>

          <div className="field"><label htmlFor="hb">How you built it</label>
            <textarea id="hb" className="input" rows={4} value={f.built}
              onChange={e => set('built', e.target.value)}
              placeholder="The problem, the approach, the part you personally owned, and what broke. This is the part PIE reads for capability signal." /></div>

          <div className="grid g-2">
            <div className="field"><label htmlFor="ht">Technologies <span className="muted">(comma separated)</span></label>
              <input id="ht" className="input" value={f.technologies}
                onChange={e => set('technologies', e.target.value)} placeholder="Node.js, React, PostgreSQL" /></div>
            <div className="field"><label htmlFor="ha">Outcome <span className="muted">(optional)</span></label>
              <input id="ha" className="input" value={f.achievement}
                onChange={e => set('achievement', e.target.value)} placeholder="e.g. Finalist, or nothing at all" /></div>
          </div>

          <div className="field"><label htmlFor="hl">Repository or demo link <span className="muted">(optional)</span></label>
            <input id="hl" className="input" type="url" value={f.link}
              onChange={e => set('link', e.target.value)} placeholder="https://…" /></div>

          <Alert tone="info" icon="info" title="A placement is an outcome, not a skill">
            PIE reads what you built and what you owned — not what you won. An unplaced hackathon
            where you shipped something hard is stronger evidence than a win where you did not.
            This is recorded as SELF-REPORTED.
          </Alert>

          <div className="row"><span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" type="submit" disabled={busy || f.name.trim().length < 2}>
              {busy ? 'Adding…' : 'Add hackathon'}
            </Button></div>
        </div>
      </Card>
    </form>
  );
}
