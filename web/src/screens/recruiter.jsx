import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Icon, Button, Card, CardHead, Badge, Pill, Stat, Alert, Meter, Tabs, Empty,
  Skeleton, Insight, Tooltip, cx,
} from '../kit.jsx';
import { SkillRadar, Gauge, BarList, CompareBars, Funnel, EvidenceMix, f2, pc } from '../charts.jsx';
import {
  Pipeline, AgentDetail, EvidenceTimeline, SkillsPanel, MatchPanel, EmployerPanel,
  LearningPanel, BiasPanel, DecisionPanel, AuditPanel, EvidenceDrill,
} from '../panels.jsx';

export default function RecruiterScreens({ ctx }) {
  const { nav } = ctx;
  const [runs, setRuns] = useState({});          // candidateProfileId -> run
  const [phase, setPhase] = useState(99);
  const [busy, setBusy] = useState(false);
  const [pool, setPool] = useState(null);
  const [reqId, setReqId] = useState(() => ctx.boot.requisitions?.[0]?.id || '');
  const [compareIds, setCompareIds] = useState([]);
  const [agentOpen, setAgentOpen] = useState(null);
  const [drill, setDrill] = useState(null);
  const [delta, setDelta] = useState(null);

  const loadPool = useCallback(async (requisitionId, q = '') => {
    if (!requisitionId) return;
    setBusy(true);
    try { setPool(await api.searchCandidates({ requisitionId, q })); }
    catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }, [ctx]);

  useEffect(() => { loadPool(reqId); }, [reqId, loadPool]);

  const orchestrate = useCallback(async (candidateProfileId, animate = true) => {
    setBusy(true); setDelta(null);
    if (animate) { setPhase(0); setRuns(r => ({ ...r, [candidateProfileId]: undefined })); }
    try {
      const r = await api.orchestrate({ candidateProfileId, requisitionId: reqId, trigger: 'FULL_ORCHESTRATION' });
      if (animate) {
        for (let i = 0; i < 7; i++) { setPhase(i); await new Promise(res => setTimeout(res, 300)); }
      }
      setPhase(99);
      setRuns(prev => ({ ...prev, [candidateProfileId]: r }));
      return r;
    } catch (e) { ctx.notify('crit', e.message); return null; }
    finally { setBusy(false); }
  }, [reqId, ctx]);

  const shared = { ctx, runs, setRuns, phase, busy, setBusy, pool, loadPool, reqId, setReqId,
    orchestrate, compareIds, setCompareIds, setAgentOpen, setDrill, delta, setDelta };

  const activeRun = runs[nav.params.candidateProfileId];

  return (
    <>
      {nav.view === 'r-overview' && <Overview {...shared} />}
      {nav.view === 'r-pool' && <PoolView {...shared} />}
      {nav.view === 'r-candidate' && <CandidateProfile {...shared} />}
      {nav.view === 'r-compare' && <Compare {...shared} />}
      {nav.view === 'r-reqs' && <Requisitions {...shared} />}
      {nav.view === 'r-req' && <RequisitionDetail {...shared} />}
      {nav.view === 'r-req-new' && <NewRequisition {...shared} />}
      {nav.view === 'r-orchestrator' && <OrchestratorView {...shared} />}
      {nav.view === 'r-bias' && <BiasView {...shared} />}
      {nav.view === 'r-audit' && <AuditView ctx={ctx} />}

      {agentOpen && activeRun && (
        <AgentDetail step={activeRun.steps.find(s => s.key === agentOpen)} onClose={() => setAgentOpen(null)} />
      )}
      {drill && <EvidenceDrill item={drill} onClose={() => setDrill(null)} />}
    </>
  );
}

/* ================================================================ OVERVIEW */
function Overview({ ctx, pool, reqId, setReqId, busy }) {
  const reqs = ctx.boot.requisitions || [];
  const req = reqs.find(r => r.id === reqId);
  const rows = (pool?.candidates || []).filter(r => r.match);

  return (
    <div className="stack">
      <Card flush>
        <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="eyebrow">Requisition</div>
            <h2>{req?.title || 'No requisition selected'}</h2>
            <div className="t-13 muted">{req?.company} · {req?.location}</div>
          </div>
          <div className="field" style={{ minWidth: 250 }}>
            <label htmlFor="req" className="sr-only">Requisition</label>
            <select id="req" className="input" value={reqId} onChange={e => setReqId(e.target.value)}>
              {reqs.map(r => <option key={r.id} value={r.id}>{r.title} — {r.company}</option>)}
            </select>
          </div>
          <Button variant="secondary" icon="brief" onClick={() => ctx.nav.go('r-reqs')}>All requisitions</Button>
        </div>
      </Card>

      {busy && !pool ? <Skeleton lines={5} /> : (
        <>
          <div className="grid g-4">
            <Card><Stat label="Candidates analysed" value={rows.length} icon="users"
              detail={`${ctx.boot.ontologySize}-skill ontology`} /></Card>
            <Card><Stat label="Strong matches" value={rows.filter(r => r.match.potentialAdjusted >= 0.75).length}
              tone="ok" icon="target" detail="potential-adjusted ≥ 0.75" /></Card>
            <Card><Stat label="Applications" value={(ctx.boot.applications || []).filter(a => a.requisitionId === reqId).length}
              icon="layers" /></Card>
            <Card><Stat label="Awaiting decision"
              value={(ctx.boot.applications || []).filter(a => a.requisitionId === reqId && a.status !== 'HUMAN_DECISION').length}
              tone="warn" icon="lock" detail="no outcome exists without a human action"
              hint="PIE never converts a recommendation into an outcome." /></Card>
          </div>

          {req?.employerReadiness && (
            <Card flush style={{ borderColor: req.employerReadiness.findingCount ? 'var(--crit-line)' : 'var(--ok-line)' }}>
              <CardHead icon="employer" eyebrow="Employer readiness" title="Is the role itself the barrier?"
                right={<Button variant="ghost" size="sm" iconRight="right"
                  onClick={() => ctx.nav.push('r-req', { requisitionId: reqId, title: req.title })}>
                  Open requisition</Button>} />
              <div className="card__body">
                <div className="row" style={{ gap: 24, flexWrap: 'wrap' }}>
                  <Gauge value={req.employerReadiness.inclusionScore} label="Inclusion score"
                    sub={`${req.employerReadiness.findingCount} barrier(s)`} size={140}
                    tone={req.employerReadiness.inclusionScore >= 0.8 ? 'var(--ok-solid)' : 'var(--crit-solid)'} />
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <Alert tone={req.employerReadiness.findingCount ? 'warn' : 'ok'}
                      title={req.employerReadiness.inclusionTier}>
                      PIE matched on the skills block only. Any exclusionary clause is reported to you —
                      it is never applied against a candidate.
                    </Alert>
                  </div>
                </div>
              </div>
            </Card>
          )}

          <div className="grid g-2-1">
            <Card flush>
              <CardHead icon="users" eyebrow="Inclusive matching" title="Top candidates"
                sub="Ranked on evidence, not pedigree"
                right={<Button variant="ghost" size="sm" iconRight="right" onClick={() => ctx.nav.go('r-pool')}>
                  Full pool</Button>} />
              <div className="card__body">
                {rows.slice(0, 5).map(({ profile, match }) => (
                  <button key={profile.id} className="card card--interactive"
                    onClick={() => ctx.nav.push('r-candidate', { candidateProfileId: profile.id, title: profile.name })}
                    style={{ width: '100%', textAlign: 'left', padding: 16, marginBottom: 12, background: 'var(--surface-2)' }}>
                    <div className="row row--wrap" style={{ gap: 10, marginBottom: 10 }}>
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{profile.name}</div>
                        <div className="t-12 muted clamp2">{profile.headline}</div>
                      </div>
                      <Badge tone={match.potentialAdjusted >= 0.75 ? 'ok' : 'warn'}>{match.matchTier}</Badge>
                      <Badge tone="ai">Potential {match.potential.tier}</Badge>
                    </div>
                    <div className="row" style={{ gap: 12 }}>
                      <span className="t-11 muted nowrap" style={{ width: 78 }}>Skills-first</span>
                      <Meter value={match.skillsFirstScore} label="skills-first" />
                      <span className="tnum t-12" style={{ fontWeight: 700, width: 34 }}>{f2(match.skillsFirstScore)}</span>
                    </div>
                    <div className="row" style={{ gap: 12, marginTop: 6 }}>
                      <span className="t-11 muted nowrap" style={{ width: 78 }}>Potential-adj.</span>
                      <Meter value={match.potentialAdjusted} tone="ok" label="potential adjusted" />
                      <span className="tnum t-12" style={{ fontWeight: 700, width: 34 }}>{f2(match.potentialAdjusted)}</span>
                    </div>
                  </button>
                ))}
                {!rows.length && <Empty icon="users" title="No candidates with evidence yet" />}
              </div>
            </Card>

            <Card flush>
              <CardHead icon="filter" title="Where candidates are lost"
                sub="Conventional screening vs. PIE, same pool" />
              <div className="card__body">
                <Funnel stages={[
                  { label: 'Applied', value: Math.max(rows.length * 24, 24), note: 'Illustrative pool volume' },
                  { label: 'Survives keyword screening', value: Math.round(Math.max(rows.length * 24, 24) * 0.18) },
                  { label: 'Survives continuity + pedigree filters', value: Math.round(Math.max(rows.length * 24, 24) * 0.06),
                    note: 'The filters employer readiness flagged' },
                  { label: 'Surfaced by PIE on evidence', value: Math.round(Math.max(rows.length * 24, 24) * 0.31),
                    note: 'Skills-first, protected attributes withheld' },
                ]} />
                <Alert tone="neutral" title="Illustrative">
                  Funnel volumes are illustrative for this demo requisition, not measured hiring data.
                  Every score and ranking elsewhere is computed from real evidence.
                </Alert>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* ==================================================================== POOL */
function PoolView({ ctx, pool, loadPool, reqId, setReqId, compareIds, setCompareIds, busy }) {
  const [q, setQ] = useState('');
  const reqs = ctx.boot.requisitions || [];
  const rows = pool?.candidates || [];

  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="users" eyebrow="Inclusive matching" title="Candidate pool"
          sub={pool?.rankingBasis}
          right={<Badge tone="ai" dot>AI recommendation · not a decision</Badge>} />
        <div className="card__body">
          <div className="row row--wrap" style={{ gap: 12 }}>
            <div className="field" style={{ minWidth: 240, flex: 1 }}>
              <label htmlFor="q">Search capability, skill or evidence</label>
              <input id="q" className="input" value={q} placeholder="e.g. data quality, pytest, reconciliation"
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && loadPool(reqId, q)} />
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <label htmlFor="pr">Rank against</label>
              <select id="pr" className="input" value={reqId} onChange={e => setReqId(e.target.value)}>
                {reqs.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            </div>
            <Button variant="secondary" icon="discover" onClick={() => loadPool(reqId, q)}>Search</Button>
          </div>
        </div>
        {busy ? <div className="card__body"><Skeleton lines={4} /></div> : (
          <div className="tablewrap">
            <table className="dt">
              <thead><tr>
                <th style={{ width: 40 }}><span className="sr-only">Compare</span></th>
                <th>Candidate</th><th className="num">Skills-first</th><th className="num">Potential-adj.</th>
                <th style={{ width: 150 }}>Match</th><th>Potential</th><th>Growth</th>
                <th className="num">Gaps</th><th />
              </tr></thead>
              <tbody>
                {rows.map(({ profile, match }) => {
                  const sel = compareIds.includes(profile.id);
                  return (
                    <tr key={profile.id}>
                      <td>
                        <input type="checkbox" checked={sel} aria-label={`Compare ${profile.name}`}
                          onChange={() => setCompareIds(ids => sel ? ids.filter(i => i !== profile.id)
                            : ids.length < 3 ? [...ids, profile.id] : ids)} />
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{profile.name}</div>
                        <div className="t-11 muted clamp2" style={{ maxWidth: 300 }}>{profile.headline}</div>
                      </td>
                      <td className="num tnum">{match ? f2(match.skillsFirstScore) : '—'}</td>
                      <td className="num tnum" style={{ fontWeight: 700 }}>{match ? f2(match.potentialAdjusted) : '—'}</td>
                      <td>{match ? (
                        <div className="row" style={{ gap: 8 }}>
                          <Meter value={match.potentialAdjusted} label={`${profile.name} match`} />
                          <Badge tone={match.potentialAdjusted >= 0.75 ? 'ok' : 'warn'}>{match.matchTier}</Badge>
                        </div>
                      ) : <Badge tone="neutral">No evidence</Badge>}</td>
                      <td>{match ? <Badge tone={match.potential.tier === 'High' ? 'ok' : 'info'}>{match.potential.tier}</Badge> : '—'}</td>
                      <td>{match ? <Badge tone={match.growthReadiness.tier === 'High' ? 'ok' : 'info'}>{match.growthReadiness.tier}</Badge> : '—'}</td>
                      <td className="num tnum">{match ? match.gapCount : '—'}</td>
                      <td>
                        <Button variant="secondary" size="sm" iconRight="right"
                          onClick={() => ctx.nav.push('r-candidate', { candidateProfileId: profile.id, title: profile.name })}>
                          Open
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card__foot row">
          <span className="t-12 muted">{compareIds.length} selected for comparison (max 3)</span>
          <span className="spacer" style={{ flex: 1 }} />
          <Button variant="secondary" size="sm" icon="scale" disabled={compareIds.length < 2}
            onClick={() => ctx.nav.push('r-compare')}>Compare selected</Button>
        </div>
      </Card>
    </div>
  );
}

/* ======================================================= CANDIDATE PROFILE */
function CandidateProfile({ ctx, runs, orchestrate, phase, busy, reqId, setAgentOpen, setDrill, delta, setDelta }) {
  const id = ctx.nav.params.candidateProfileId;
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState('intel');
  const [reason, setReason] = useState('');
  const run = runs[id];
  const R = run?.result;

  useEffect(() => {
    if (!id) return;
    api.candidateDetail(id).then(setDetail).catch(e => ctx.notify('crit', e.message));
    if (!runs[id]) orchestrate(id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function decide(action) {
    try {
      const r = await api.decide(run.runId, { action, reason });
      ctx.notify('ok', `Decision recorded: ${action.replace(/_/g, ' ').toLowerCase()}.`);
      await ctx.reload();
      runs[id] = r;
    } catch (e) { ctx.notify('crit', e.message); }
  }

  async function reassess(skillId) {
    try {
      const r = await api.reassess(run.runId, { skillId });
      setDelta(r.delta);
      runs[id] = r;
      ctx.notify('ok', `${r.delta.skill} reassessed — match ${f2(r.delta.matchBefore)} → ${f2(r.delta.matchAfter)}.`);
    } catch (e) { ctx.notify('crit', e.message); }
  }

  if (!detail) return <Skeleton lines={6} />;
  const p = detail.profile;

  const tabs = [
    { key: 'intel', label: 'Capability intelligence', icon: 'sparkle' },
    { key: 'evidence', label: 'Evidence', icon: 'file', count: detail.evidence.length },
    { key: 'match', label: 'Match', icon: 'match' },
    { key: 'roadmap', label: 'Career roadmap', icon: 'learn', count: R?.learning.objectives.length },
    { key: 'bias', label: 'Bias audit', icon: 'shield', count: R?.bias.signalCount, danger: R?.bias.highestSeverity === 'High' },
    { key: 'decision', label: 'Decision', icon: 'lock' },
  ];

  return (
    <div className="stack">
      <Card flush>
        <div className="card__head" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <div className="acct__av" style={{ width: 52, height: 52, fontSize: 18,
            background: 'var(--brand-50)', color: 'var(--brand-600)' }}>
            {p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="row row--wrap" style={{ gap: 8 }}>
              <h2>{p.name}</h2>
              {R && <><Badge tone="ai" dot>Potential {R.discovery.potential.tier}</Badge>
                <Badge tone="ok" dot>Growth {R.discovery.growthReadiness.tier}</Badge></>}
            </div>
            <div className="t-13 muted" style={{ marginTop: 3 }}>{p.headline}</div>
            <div className="row row--wrap" style={{ gap: 6, marginTop: 8 }}>
              <Pill><Icon name="file" size={11} />{detail.evidence.length} evidence</Pill>
              <Pill><Icon name="github" size={11} />{detail.repositories.length} repositories</Pill>
              <Pill><Icon name="layers" size={11} />{detail.projects.length} projects</Pill>
            </div>
          </div>
          <Button variant="secondary" size="sm" icon="play" disabled={busy}
            onClick={() => orchestrate(id, true)}>Re-run orchestrator</Button>
        </div>
        <div className="card__body" style={{ paddingTop: 14, paddingBottom: 14 }}>
          {p.accommodation?.requested && (
            <Alert tone="info" title={`Accommodation: ${p.accommodation.type} — ${p.accommodation.status}`} icon="check">
              {p.accommodation.note}
            </Alert>
          )}
          <Alert tone="neutral" title="Context recorded, never scored" icon="lock">
            {(p.protectedContext || []).map(x => x.replace(/_/g, ' ')).join(' · ') || 'none recorded'} — held for
            transparency and accommodation only. The orchestrator withholds every one of these from the
            matching agent, and the Bias Audit service independently verifies that it did.
          </Alert>
        </div>
        <div className="card__body" style={{ paddingTop: 0 }}>
          <Pipeline run={run} phase={phase} pipeline={ctx.boot.pipeline} onSelect={setAgentOpen} />
        </div>
      </Card>

      {!R ? <Skeleton lines={5} /> : (
        <>
          <Tabs items={tabs} value={tab} onChange={setTab} />
          <div className="fadein" role="tabpanel">
            {tab === 'intel' && <IntelTab R={R} ctx={ctx} />}
            {tab === 'evidence' && (
              <Card flush>
                <CardHead icon="file" title="Unified candidate evidence profile"
                  sub="Seven possible sources, each with an explicit verification tier" />
                <div className="card__body">
                  <div style={{ marginBottom: 20 }}><EvidenceMix bySource={R.discovery.evidenceBySource} /></div>
                  <EvidenceTimeline evidence={detail.evidence} onDrill={setDrill} />
                </div>
              </Card>
            )}
            {tab === 'match' && <MatchPanel matching={R.matching} onDrill={setDrill} />}
            {tab === 'roadmap' && (
              <LearningPanel learning={R.learning} gaps={R.matching.gaps} delta={delta}
                onReassess={reassess} busy={busy} />
            )}
            {tab === 'bias' && <BiasPanel bias={R.bias} />}
            {tab === 'decision' && (
              <DecisionPanel run={run} onDecide={decide} busy={busy}
                actor={ctx.user.name} setActor={() => {}} note={reason} setNote={setReason} />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function IntelTab({ R }) {
  const d = R.discovery, m = R.matching;
  const interp = d.interpretation;
  return (
    <div className="stack">
      <div className="grid g-4">
        <Card><Stat label="Potential" value={d.potential.tier} tone="ai" icon="sparkle"
          detail={`index ${f2(d.potential.value)}`} /></Card>
        <Card><Stat label="Growth readiness" value={d.growthReadiness.tier} tone="ok" icon="market"
          detail={`index ${f2(d.growthReadiness.value)}`} /></Card>
        <Card><Stat label="Capabilities" value={d.skills.length} tone="brand" icon="discover"
          detail={`${d.skills.filter(s => s.corroborated).length} corroborated`} /></Card>
        <Card><Stat label="Open gaps" value={m.gaps.length} tone="warn" icon="target"
          detail={`${m.gaps.filter(g => g.mandatory).length} on required skills`} /></Card>
      </div>

      <div className="grid g-2">
        <Card flush style={{ alignSelf: 'start' }}>
          <CardHead icon="target" eyebrow="Capability Intelligence Agent" title="Capability radar"
            sub="Thin evidence is reported as Insufficient Data, never scored low" />
          <div className="card__body">
            <SkillRadar dimensions={d.dimensions} />
            <div style={{ marginTop: 16 }}>
              {Object.entries(d.dimensions).map(([k, v]) => (
                <details key={k} style={{ borderTop: '1px solid var(--line-1)', padding: '9px 0' }}>
                  <summary style={{ cursor: 'pointer', listStyle: 'none' }}>
                    <div className="row" style={{ gap: 10 }}>
                      <Icon name="right" size={13} className="muted" />
                      <b className="t-13" style={{ flex: '0 0 128px', textTransform: 'capitalize' }}>
                        {k.replace(/([A-Z])/g, ' $1')}</b>
                      {v.value == null ? <Badge tone="warn" icon="alert">Insufficient data</Badge> : (
                        <><Meter value={v.value} label={k} />
                          <span className="tnum t-12" style={{ fontWeight: 700, width: 34 }}>{f2(v.value)}</span>
                          <Badge tone={v.value >= 0.75 ? 'ok' : v.value >= 0.5 ? 'info' : 'warn'}>{v.tier}</Badge></>)}
                    </div>
                  </summary>
                  <div className="t-12 muted" style={{ marginTop: 7, paddingLeft: 23, lineHeight: 1.55 }}>{v.rationale}</div>
                </details>
              ))}
            </div>
          </div>
        </Card>

        <div className="stack">
          <Card flush>
            <CardHead icon="discover" title="Discovered capabilities"
              sub="Confidence = strongest independent source, plus discounted corroboration" />
            <div className="card__body" style={{ maxHeight: 420, overflowY: 'auto' }}>
              <SkillsPanel discovery={d} />
            </div>
          </Card>

          {interp?.source === 'llm' && (
            <Insight title="Capability Intelligence — beyond the ontology"
              insight={interp.summary}
              evidence={(interp.transferableSkills || []).map(t => `${t.skill} (${t.fromEvidence})`).join(' · ') || '—'}
              reasoning={(interp.nonTraditionalSignals || []).map(s => s.rationale).join(' ')
                || (interp.behaviouralSignals || []).map(s => s.rationale).join(' ') || '—'}
              recommendation={(interp.evidenceQualityNotes || [])[0] || 'Read alongside the deterministic capability map.'}
              badge={<Badge tone="ai" dot>via {interp.provider}</Badge>} />
          )}
        </div>
      </div>

      {R.explainability?.narrative?.source === 'llm' && (
        <Insight title="Explainability Agent"
          insight={R.explainability.narrative.plainSummary}
          evidence={(R.explainability.narrative.whyMatched || []).map(w => `${w.point} — ${w.evidence}`).join(' · ')}
          reasoning={(R.explainability.narrative.gaps || []).map(g => `${g.gap}: ${g.why}`).join(' ')}
          confidence={d.potential.value}
          recommendation={(R.explainability.narrative.recommendations || []).join(' ')}
          uncertainty={(R.explainability.narrative.concerns || []).join(' ')}
          badge={<Badge tone="ai" dot>via {R.explainability.narrative.provider}</Badge>} />
      )}
    </div>
  );
}

/* ================================================================= COMPARE */
function Compare({ ctx, compareIds, setCompareIds, reqId }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (compareIds.length < 2) { setData([]); return; }
    Promise.all(compareIds.map(id =>
      api.orchestrate({ candidateProfileId: id, requisitionId: reqId, trigger: 'FULL_ORCHESTRATION', useAI: false })
        .then(run => ({ id, run }))
        .catch(() => ({ id, run: null }))))
      .then(setData);
  }, [compareIds, reqId]);

  if (compareIds.length < 2) {
    return <Card pad><Empty icon="scale" title="Select at least two candidates"
      action={<Button variant="primary" icon="users" onClick={() => ctx.nav.go('r-pool')}>Open the pool</Button>}>
      Choose candidates in the pool, then compare them here on identical axes and scales.
    </Empty></Card>;
  }
  if (!data) return <Skeleton lines={6} />;

  const valid = data.filter(d => d.run);
  const names = valid.map(d => d.run.candidate.name.split(' ')[0]);
  const dims = ['technical', 'learning', 'problemSolving', 'communication', 'consistency'];
  const rows = [
    { label: 'Skills-first match', values: valid.map(d => d.run.result.matching.skillsFirstScore) },
    { label: 'Potential-adjusted', values: valid.map(d => d.run.result.matching.potentialAdjusted) },
    { label: 'Potential index', values: valid.map(d => d.run.result.discovery.potential.value) },
    { label: 'Growth readiness', values: valid.map(d => d.run.result.discovery.growthReadiness.value) },
    ...dims.map(k => ({
      label: k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()),
      values: valid.map(d => d.run.result.discovery.dimensions[k]?.value ?? 0),
    })),
  ];

  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="scale" eyebrow="Candidate comparison" title="Same dimensions, same scales"
          sub="Identical axes across candidates — a comparison on different scales would mislead"
          right={<Button variant="ghost" size="sm" onClick={() => setCompareIds([])}>Clear selection</Button>} />
        <div className="card__body"><CompareBars rows={rows} names={names} /></div>
      </Card>

      <div className="cmpgrid" style={{ gridTemplateColumns: `repeat(${Math.min(valid.length, 3)}, minmax(0,1fr))` }}>
        {data.map(({ id, run }) => {
          const profile = (ctx.boot.candidates || []).find(c => c.id === id);
          if (!run) {
            return (
              <Card key={id} flush>
                <CardHead title={profile?.name || 'Candidate'} sub={profile?.headline} />
                <div className="card__body">
                  <div className="cmp-insufficient">
                    <div>
                      <Icon name="alert" size={22} style={{ margin: '0 auto 10px', color: 'var(--warn-fg)' }} />
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Insufficient data</div>
                      <p className="t-12 muted" style={{ marginTop: 6, maxWidth: 220 }}>
                        This candidate has no evidence yet, so PIE has nothing to plot. An empty radar
                        would imply zero capability — it would not be true.
                      </p>
                    </div>
                  </div>
                  <div className="cmp-badges"><Badge tone="neutral">No evidence</Badge></div>
                  <div className="cmp-gaps"><span className="t-12 muted">—</span></div>
                  <div className="cmp-note">
                    <Alert tone="neutral" title="Nothing to compare yet">
                      Ask this candidate to import evidence before ranking them against anyone.
                    </Alert>
                  </div>
                </div>
              </Card>
            );
          }
          const r = run.result;
          return (
            <Card key={id} flush>
              <CardHead title={run.candidate.name} sub={run.candidate.headline}
                right={<Badge tone={r.matching.potentialAdjusted >= 0.75 ? 'ok' : 'warn'}>
                  {r.matching.matchTier}</Badge>} />
              <div className="card__body">
                <div className="cmp-radar"><SkillRadar dimensions={r.discovery.dimensions} size={250} /></div>
                <div className="cmp-badges">
                  <Badge tone="ai">Potential {r.discovery.potential.tier}</Badge>
                  <Badge tone="ok">Growth {r.discovery.growthReadiness.tier}</Badge>
                </div>
                <div className="cmp-gaps">
                  <Badge tone="warn">{r.matching.gaps.length} open gap{r.matching.gaps.length === 1 ? '' : 's'}</Badge>
                </div>
                <div className="cmp-note">
                  <Alert tone="neutral" title="Different shapes, both valid">
                    Two candidates with different radar shapes may each be a strong fit for different
                    parts of the same role. The radar is diagnostic, not a ranking.
                  </Alert>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================== REQUISITIONS */
function Requisitions({ ctx }) {
  const reqs = ctx.boot.requisitions || [];
  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="brief" title="Your requisitions" sub={`${reqs.length} role(s)`}
          right={<Button variant="primary" size="sm" icon="market"
            onClick={() => ctx.nav.push('r-req-new')}>New requisition</Button>} />
        {!reqs.length ? (
          <div className="card__body"><Empty icon="brief" title="No requisitions yet"
            action={<Button variant="primary" icon="market" onClick={() => ctx.nav.push('r-req-new')}>
              Create your first role</Button>}>
            Paste a job description and PIE will extract requirements and audit it for barriers.
          </Empty></div>
        ) : (
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Role</th><th>Location</th><th>Inclusion</th>
                <th className="num">Applications</th><th>Status</th><th /></tr></thead>
              <tbody>{reqs.map(r => (
                <tr key={r.id}>
                  <td><b>{r.title}</b><div className="t-11 muted">{r.company}</div></td>
                  <td className="t-12">{r.location}</td>
                  <td>{r.employerReadiness
                    ? <Badge tone={r.employerReadiness.inclusionScore >= 0.8 ? 'ok'
                      : r.employerReadiness.inclusionScore >= 0.55 ? 'warn' : 'crit'}>
                      {f2(r.employerReadiness.inclusionScore)} · {r.employerReadiness.findingCount} flag(s)</Badge>
                    : <span className="muted t-12">not analysed</span>}</td>
                  <td className="num tnum">{r.applicationCount}</td>
                  <td><Badge tone={r.status === 'OPEN' ? 'ok' : 'neutral'} dot>{r.status}</Badge></td>
                  <td><Button variant="secondary" size="sm" iconRight="right"
                    onClick={() => ctx.nav.push('r-req', { requisitionId: r.id, title: r.title })}>Open</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RequisitionDetail({ ctx }) {
  const id = ctx.nav.params.requisitionId;
  const [d, setD] = useState(null);
  const [analysis, setAnalysis] = useState(null);

  useEffect(() => {
    if (!id) return;
    api.requisition(id).then(async r => {
      setD(r);
      try { setAnalysis(await api.analyseJd({ title: r.requisition.title, text: r.requisition.text })); }
      catch { /* analysis is optional */ }
    }).catch(e => ctx.notify('crit', e.message));
  }, [id, ctx]);

  if (!d) return <Skeleton lines={6} />;
  const r = d.requisition;

  return (
    <div className="stack">
      <Card flush>
        <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <h2>{r.title}</h2>
            <div className="t-13 muted">{r.company} · {r.location} · {r.employmentType}</div>
          </div>
          <Badge tone={r.status === 'OPEN' ? 'ok' : 'neutral'} dot>{r.status}</Badge>
          <Pill>{d.applications.length} application(s)</Pill>
        </div>
      </Card>

      {/* Whose questions this requisition uses, and the recruiter's own set. */}
      <QuestionBank ctx={ctx} requisitionId={id} />

      {analysis && (
        <>
          <div className="grid g-2">
            <Card flush>
              <CardHead icon="market" eyebrow="JD Requirement Extraction" title="Role competency model"
                sub="This service never sees a candidate, so it cannot be influenced by who applied" />
              <div className="tablewrap">
                <table className="dt">
                  <thead><tr><th>Capability</th><th>Type</th><th className="num">Required</th>
                    <th className="num">Weight</th><th style={{ width: 130 }}>Market demand</th></tr></thead>
                  <tbody>{analysis.roleCompetencyModel.competencies.map(c => (
                    <tr key={c.id}>
                      <td><b>{c.name}</b><div className="t-11 muted">{c.category}</div></td>
                      <td><Badge tone={c.mandatory ? 'ai' : 'neutral'}>{c.mandatory ? 'Required' : 'Preferred'}</Badge></td>
                      <td className="num tnum">{f2(c.requiredLevel)}</td>
                      <td className="num tnum">{f2(c.weight)}</td>
                      <td><div className="row" style={{ gap: 8 }}>
                        <Meter value={c.marketDemand} tone="seq" label={`${c.name} demand`} />
                        <span className="tnum t-12" style={{ width: 32 }}>{f2(c.marketDemand)}</span></div></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {analysis.extraction?.source === 'llm' && (
                <div className="card__body">
                  <div className="grid g-2">
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Potentially unnecessary</div>
                      {(analysis.extraction.potentiallyUnnecessary || []).map((x, i) => (
                        <div key={i} className="t-12" style={{ padding: '5px 0', borderTop: '1px solid var(--line-1)' }}>
                          <b>{x.requirement}</b><div className="muted">{x.why}</div>
                        </div>
                      ))}
                      {!(analysis.extraction.potentiallyUnnecessary || []).length && <span className="t-12 muted">None flagged.</span>}
                    </div>
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 6 }}>Ambiguous</div>
                      {(analysis.extraction.ambiguous || []).map((x, i) => (
                        <div key={i} className="t-12" style={{ padding: '5px 0', borderTop: '1px solid var(--line-1)' }}>
                          <b>{x.requirement}</b><div className="muted">{x.why}</div>
                        </div>
                      ))}
                      {!(analysis.extraction.ambiguous || []).length && <span className="t-12 muted">None flagged.</span>}
                    </div>
                  </div>
                </div>
              )}
            </Card>

            <Card flush>
              <CardHead icon="brief" title="Job description as written" />
              <div className="card__body">
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.65, color: 'var(--ink-2)',
                  background: 'var(--surface-2)', border: '1px solid var(--line-1)', borderRadius: 8,
                  padding: 16, margin: 0, maxHeight: 460, overflow: 'auto', fontFamily: 'inherit' }}>{r.text}</pre>
              </div>
            </Card>
          </div>

          <EmployerPanel employer={analysis.employerReadiness} />
        </>
      )}

      <Card flush>
        <CardHead icon="users" title="Applications" sub={`${d.applications.length} candidate(s)`} />
        {d.applications.length ? (
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Candidate</th><th>Status</th><th>Integrity</th><th /></tr></thead>
              <tbody>{d.applications.map(a => (
                <tr key={a.id}>
                  <td><b>{a.candidateName}</b></td>
                  <td><Badge tone={a.status === 'HUMAN_DECISION' ? 'ok' : 'info'} dot>{a.status.replace(/_/g, ' ')}</Badge></td>
                  <td>{a.integrityStatus ? <Badge tone="warn">{a.integrityStatus.replace(/_/g, ' ')}</Badge> : '—'}</td>
                  <td className="row" style={{ gap: 6 }}>
                    {a.status === 'APPLIED' && (
                      <Button variant="ghost" size="sm" icon="target" onClick={async () => {
                        try { await api.requireAssessment(a.id); ctx.notify('ok', 'Assessment requested.'); await ctx.reload(); }
                        catch (e) { ctx.notify('crit', e.message); }
                      }}>Request assessment</Button>
                    )}
                    <Button variant="secondary" size="sm" iconRight="right"
                      onClick={() => ctx.nav.push('r-candidate', { candidateProfileId: a.candidateProfileId, title: a.candidateName })}>
                      Review
                    </Button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <div className="card__body"><Empty icon="users" title="No applications yet" /></div>}
      </Card>
    </div>
  );
}

/**
 * The recruiter's own question set, and who decides what a candidate is asked.
 *
 * PIE's default is that AI writes the paper from the job description. That is a
 * defensible default, not a mandate: a team with a question set they trust
 * should not have to hand that judgement over, and the mode picker is where
 * they take it back. Every question written here goes through exactly the same
 * validation a generated one does — a recruiter's broken answer key is just as
 * unfair to a candidate as a model's — but the failure is shown to the author,
 * who can fix it, instead of being dropped silently at assessment time.
 */
function QuestionBank({ ctx, requisitionId }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const blank = { type: 'mcq', difficulty: 'Medium', skill: '', prompt: '',
    options: ['', '', '', ''], answer: 0, explain: '', starterCode: '', rubric: ['', ''],
    language: 'python', entryPoint: 'solve', referenceSolution: '', reviewOnly: false,
    tests: [{ id: 'v1', hidden: false, label: '', input: '[]', expected: 'null' },
            { id: 'h1', hidden: true,  label: '', input: '[]', expected: 'null' }] };
  const [f, setF] = useState(blank);

  const load = useCallback(() => {
    api.requisitionQuestions(requisitionId).then(setState).catch(e => ctx.notify('crit', e.message));
  }, [requisitionId, ctx]);
  useEffect(load, [load]);

  if (!state) return <Skeleton lines={4} />;
  const isCoding = f.type.startsWith('coding') || f.type === 'debugging';
  const isMulti = f.type === 'multi_select';
  const count = state.questions.length;

  async function setMode(mode) {
    setBusy(true);
    try {
      const r = await api.setAssessmentMode(requisitionId, mode);
      ctx.notify(r.warning ? 'warn' : 'ok', r.warning || `Mode set to ${mode.replace(/_/g, ' ').toLowerCase()}.`);
      load();
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  async function add() {
    setBusy(true);
    try {
      const body = {
        type: f.type, difficulty: f.difficulty, skill: f.skill.trim(),
        prompt: f.prompt.trim(), explain: f.explain.trim(),
      };
      if (isCoding) {
        body.starterCode = f.starterCode;
        body.rubric = f.rubric.map(x => x.trim()).filter(Boolean);
        body.reviewOnly = f.reviewOnly;
        if (!f.reviewOnly) {
          body.language = f.language;
          body.entryPoint = f.entryPoint.trim();
          body.referenceSolution = f.referenceSolution;
          body.tests = f.tests.map(t => ({ ...t, label: t.label?.trim() || undefined }));
        } else {
          body.reviewReason = 'The recruiter marked this question for manual review.';
        }
      } else {
        body.options = f.options.map(o => o.trim()).filter(Boolean);
        body.answer = isMulti ? (Array.isArray(f.answer) ? f.answer : [Number(f.answer)]) : Number(f.answer);
      }
      await api.addRequisitionQuestion(requisitionId, body);
      ctx.notify('ok', 'Question added.');
      setF(blank); setOpen(false); load();
    } catch (e) {
      // The validator's reason, verbatim — it says what to change.
      ctx.notify('crit', e.message);
    }
    setBusy(false);
  }

  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="brief" title="Who writes the questions"
          sub="PIE recommends, you decide. This is set per requisition and recorded on every attempt."
          right={<Pill>{count} of your own</Pill>} />
        <div className="card__body stack">
          <div className="modegrid">
            {state.modes.map(m => {
              const active = state.mode === m.id;
              const blocked = m.id === 'RECRUITER_ONLY' && count === 0;
              return (
                // Named by its label alone, described by the rest. Without this
                // the accessible name is the whole card — a screen-reader user
                // hears three sentences of trade-off text as the button's name
                // before they can tell one option from another.
                <button key={m.id} type="button" disabled={busy || blocked}
                  className={cx('modecard', active && 'modecard--on', blocked && 'modecard--off')}
                  aria-pressed={active}
                  aria-labelledby={`mode-${m.id}-label`}
                  aria-describedby={`mode-${m.id}-desc`}
                  onClick={() => !active && setMode(m.id)}>
                  <span className="modecard__top">
                    <span className="modecard__label" id={`mode-${m.id}-label`}>{m.label}</span>
                    {active && <Badge tone="ok" dot>In use</Badge>}
                  </span>
                  <span id={`mode-${m.id}-desc`}>
                    <span className="modecard__sum">{m.summary}</span>
                    <span className="modecard__trade">{m.tradeoff}</span>
                    {blocked && <span className="modecard__blocked">Add a question of your own first.</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {state.mode === 'RECRUITER_ONLY' && count < 4 && (
            <Alert tone="warn" title="Your set is smaller than a full paper">
              PIE builds around 5–6 questions. With {count} of your own, papers will be shorter, and a
              candidate retaking will see the same questions again — there is nothing else to draw on
              in this mode.
            </Alert>
          )}
        </div>
      </Card>

      <Card flush>
        <CardHead title="Your questions" sub="Asked before any generated question, in a randomised order."
          right={<Button size="sm" variant={open ? 'ghost' : 'secondary'} icon={open ? 'x' : 'file'}
            onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Add a question'}</Button>} />

        {open && (
          <div className="card__body stack" style={{ borderBottom: '1px solid var(--line-1)' }}>
            <div className="grid g-3">
              <div className="field">
                <label htmlFor="q-type">Type</label>
                <select id="q-type" className="input" value={f.type}
                  onChange={e => setF({ ...f, type: e.target.value, answer: e.target.value === 'multi_select' ? [0, 1] : 0 })}>
                  <option value="mcq">Multiple choice</option>
                  <option value="multi_select">Multiple select</option>
                  <option value="coding_easy">Coding — easy</option>
                  <option value="coding_medium">Coding — medium</option>
                  <option value="coding_hard">Coding — hard</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-diff">Difficulty</label>
                <select id="q-diff" className="input" value={f.difficulty}
                  onChange={e => setF({ ...f, difficulty: e.target.value })}>
                  <option>Easy</option><option>Medium</option><option>Hard</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-skill">Skill</label>
                <input id="q-skill" className="input" value={f.skill} placeholder="e.g. sql"
                  onChange={e => setF({ ...f, skill: e.target.value })} />
              </div>
            </div>

            <div className="field">
              <label htmlFor="q-prompt">Question</label>
              <textarea id="q-prompt" className="input" rows={3} value={f.prompt}
                onChange={e => setF({ ...f, prompt: e.target.value })} />
            </div>

            {!isCoding && (
              <div className="field">
                <label>Options — mark the correct {isMulti ? 'ones' : 'one'}</label>
                {f.options.map((o, i) => (
                  <div key={i} className="row" style={{ gap: 8, marginBottom: 6 }}>
                    <input type={isMulti ? 'checkbox' : 'radio'} name="q-ans"
                      checked={isMulti ? (f.answer || []).includes(i) : Number(f.answer) === i}
                      onChange={() => setF({ ...f, answer: isMulti
                        ? ((f.answer || []).includes(i) ? f.answer.filter(x => x !== i) : [...(f.answer || []), i].sort())
                        : i })} />
                    <input className="input" style={{ flex: 1 }} value={o} placeholder={`Option ${i + 1}`}
                      onChange={e => setF({ ...f, options: f.options.map((x, j) => j === i ? e.target.value : x) })} />
                  </div>
                ))}
                <span className="hint">
                  Avoid "all of the above" — PIE shuffles options for every candidate, so
                  order-dependent options are rejected.
                </span>
              </div>
            )}

            {isCoding && (
              <>
                {!state.sandbox?.available && (
                  <Alert tone="warn" title="Code execution is not running">
                    {state.sandbox?.note} You can still add this question by marking it
                    review-only — PIE will record the answer for you to read rather than score it.
                  </Alert>
                )}

                <div className="field">
                  <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={f.reviewOnly}
                      onChange={e => setF({ ...f, reviewOnly: e.target.checked })} />
                    <span>Review-only — I will read this answer myself, PIE should not score it</span>
                  </label>
                  <span className="hint">
                    Use this for answers PIE cannot execute, such as a SQL query or a design
                    explanation. The question still counts; it just arrives unscored.
                  </span>
                </div>

                {!f.reviewOnly && (
                  <div className="grid g-2">
                    <div className="field">
                      <label htmlFor="q-lang">Language</label>
                      <select id="q-lang" className="input" value={f.language}
                        onChange={e => setF({ ...f, language: e.target.value })}>
                        {(state.execLanguages || []).map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="q-entry">Function name the tests call</label>
                      <input id="q-entry" className="input mono" value={f.entryPoint}
                        onChange={e => setF({ ...f, entryPoint: e.target.value })} />
                    </div>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="q-starter">Starter code</label>
                  <textarea id="q-starter" className="input mono" rows={4} value={f.starterCode}
                    onChange={e => setF({ ...f, starterCode: e.target.value })} />
                </div>

                {!f.reviewOnly && (
                  <>
                    <div className="field">
                      <label>Test cases</label>
                      <span className="hint" style={{ marginBottom: 8, display: 'block' }}>
                        <b>Visible</b> tests are shown to the candidate, who can run their code against
                        them while working. <b>Hidden</b> tests are never sent to the browser and are what
                        the score is based on — so tuning an answer to the visible examples does not pass.
                        Write inputs as a JSON list of arguments.
                      </span>
                      {f.tests.map((t, i) => (
                        <div key={i} className="testrow">
                          <label className="testrow__hide">
                            <input type="checkbox" checked={t.hidden}
                              onChange={e => setF({ ...f, tests: f.tests.map((x, j) => j === i ? { ...x, hidden: e.target.checked } : x) })} />
                            <span>{t.hidden ? 'Hidden' : 'Visible'}</span>
                          </label>
                          <input className="input mono" placeholder='input, e.g. [[3,1,2], 2]' value={t.input}
                            onChange={e => setF({ ...f, tests: f.tests.map((x, j) => j === i ? { ...x, input: e.target.value } : x) })} />
                          <input className="input mono" placeholder='expected, e.g. [1,3]' value={t.expected}
                            onChange={e => setF({ ...f, tests: f.tests.map((x, j) => j === i ? { ...x, expected: e.target.value } : x) })} />
                          <Button size="sm" variant="ghost" icon="x" aria-label={`Remove test ${t.id}`}
                            onClick={() => setF({ ...f, tests: f.tests.filter((_, j) => j !== i) })} />
                        </div>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setF({ ...f,
                        tests: [...f.tests, { id: `t${f.tests.length + 1}`, hidden: true, input: '[]', expected: 'null' }] })}>
                        Add a test case
                      </Button>
                    </div>

                    <div className="field">
                      <label htmlFor="q-ref">Reference solution</label>
                      <textarea id="q-ref" className="input mono" rows={5} value={f.referenceSolution}
                        onChange={e => setF({ ...f, referenceSolution: e.target.value })} />
                      <span className="hint">
                        PIE runs this against your own test cases before accepting the question. If it
                        fails any of them, the question is refused — a broken test should be found here,
                        not by a candidate being marked down by it. Candidates never see this.
                      </span>
                    </div>
                  </>
                )}
                <div className="field">
                  <label>Rubric — what a good answer must show (at least two)</label>
                  {f.rubric.map((rr, i) => (
                    <input key={i} className="input" style={{ marginBottom: 6 }} value={rr}
                      placeholder={`Criterion ${i + 1}`}
                      onChange={e => setF({ ...f, rubric: f.rubric.map((x, j) => j === i ? e.target.value : x) })} />
                  ))}
                  <Button size="sm" variant="ghost" onClick={() => setF({ ...f, rubric: [...f.rubric, ''] })}>
                    Add a criterion
                  </Button>
                  <span className="hint">The rubric is scored server-side and never sent to a candidate.</span>
                </div>
              </>
            )}

            <div className="field">
              <label htmlFor="q-explain">Why the answer is right</label>
              <textarea id="q-explain" className="input" rows={2} value={f.explain}
                onChange={e => setF({ ...f, explain: e.target.value })} />
              <span className="hint">
                Shown to the candidate only after they lock their answer. Required — a question
                nobody can justify is a question that cannot be defended.
              </span>
            </div>

            <div className="row">
              <span className="spacer" style={{ flex: 1 }} />
              <Button variant="primary" icon="check" disabled={busy} onClick={add}>Add question</Button>
            </div>
          </div>
        )}

        {count === 0 ? (
          <div className="card__body">
            <Empty icon="file" title="No questions of your own yet"
              sub="Add one and PIE will ask it before any generated question." />
          </div>
        ) : (
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>Question</th><th>Type</th><th>Skill</th><th>Difficulty</th><th /></tr></thead>
              <tbody>
                {state.questions.map(q => (
                  <tr key={q.id}>
                    <td style={{ maxWidth: 420 }}>{q.prompt}</td>
                    <td><Badge tone="info">{q.type.replace(/_/g, ' ')}</Badge></td>
                    <td>{q.skill}</td>
                    <td>{q.difficulty}</td>
                    <td>
                      <Button size="sm" variant="ghost" icon="x" disabled={busy} onClick={async () => {
                        setBusy(true);
                        try {
                          await api.deleteRequisitionQuestion(requisitionId, q.id);
                          ctx.notify('ok', 'Question retired. Past attempts keep it, so their scores stay explainable.');
                          load();
                        } catch (e) { ctx.notify('crit', e.message); }
                        setBusy(false);
                      }}>Retire</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function NewRequisition({ ctx }) {
  const [f, setF] = useState({ title: '', company: ctx.user.organization || '', location: '', employmentType: 'Full-time', text: '' });
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function analyse() {
    setBusy(true);
    try { setAnalysis(await api.analyseJd({ title: f.title, text: f.text })); }
    catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  async function create() {
    setBusy(true);
    try {
      const r = await api.createRequisition(f);
      await ctx.reload();
      ctx.notify('ok', `${r.requisition.title} created.`);
      ctx.nav.go('r-req');
      ctx.nav.setParams({ requisitionId: r.requisition.id, title: r.requisition.title });
    } catch (e) { ctx.notify('crit', e.message); }
    setBusy(false);
  }

  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="market" title="New requisition"
          sub="Paste the job description. PIE extracts requirements and audits the role before anyone applies." />
        <div className="card__body stack">
          <div className="grid g-2">
            <div className="field"><label htmlFor="t">Role title</label>
              <input id="t" className="input" value={f.title} onChange={e => set('title', e.target.value)} /></div>
            <div className="field"><label htmlFor="c">Company</label>
              <input id="c" className="input" value={f.company} onChange={e => set('company', e.target.value)} /></div>
            <div className="field"><label htmlFor="l">Location</label>
              <input id="l" className="input" value={f.location} onChange={e => set('location', e.target.value)} /></div>
            <div className="field"><label htmlFor="et">Employment type</label>
              <input id="et" className="input" value={f.employmentType} onChange={e => set('employmentType', e.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor="jd">Job description</label>
            <textarea id="jd" className="input" rows={12} value={f.text} onChange={e => set('text', e.target.value)}
              placeholder="Paste the full job description, including any candidate requirements." />
            <span className="hint">{f.text.length} characters — at least 60 needed.</span></div>
          <div className="row">
            <Button variant="secondary" icon="discover" disabled={busy || f.text.length < 60} onClick={analyse}>
              Analyse before saving
            </Button>
            <span className="spacer" style={{ flex: 1 }} />
            <Button variant="primary" disabled={busy || f.text.length < 60 || f.title.length < 3} onClick={create}>
              Create requisition
            </Button>
          </div>
        </div>
      </Card>

      {analysis && (
        <>
          <Alert tone="info" title="Nothing has been saved yet">{analysis.notice}</Alert>
          <EmployerPanel employer={analysis.employerReadiness} />
        </>
      )}
    </div>
  );
}

/* ============================================================ ORCHESTRATOR */
function OrchestratorView({ ctx, runs, phase, orchestrate, busy, reqId, setAgentOpen }) {
  const candidates = (ctx.boot.candidates || []).filter(c => c.evidenceCount > 0);
  const [sel, setSel] = useState(() => candidates[0]?.id || '');
  const run = runs[sel];

  return (
    <div className="stack">
      <Card flush>
        <CardHead icon="orchestr" eyebrow="PIE Orchestrator"
          title="Four specialised agents, coordinated by one control plane"
          sub="Agents never call each other. Every hop is scoped, validated and audited."
          right={
            <div className="row" style={{ gap: 8 }}>
              <select className="input" style={{ width: 200 }} value={sel} onChange={e => setSel(e.target.value)}>
                {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Button variant="primary" size="sm" icon="play" disabled={busy || !sel}
                onClick={() => orchestrate(sel, true)}>Run</Button>
            </div>
          } />
        <div className="card__body">
          <Pipeline run={run} phase={phase} pipeline={ctx.boot.pipeline} onSelect={setAgentOpen} />
          <Alert tone="info" title="Selective invocation" icon="info">
            The orchestrator does not run every agent for every operation. A resume upload runs
            Capability Intelligence alone; a completed assessment runs the whole pipeline. Steps marked
            "Not required" were deliberately skipped for this trigger.
          </Alert>
        </div>
        {run && (
          <div className="card__foot row row--wrap" style={{ gap: 10 }}>
            <Badge tone={run.status === 'DECIDED' ? 'ok' : 'warn'} dot>{run.status.replace(/_/g, ' ')}</Badge>
            <Pill>Run <b className="mono">{run.runId}</b></Pill>
            <Pill>Trigger <b>{run.trigger}</b></Pill>
            <Pill><Icon name="clock" size={11} />{run.totalMs}ms</Pill>
            <Pill>AI: <b>{run.ai.provider}</b> ({run.ai.mode})</Pill>
            <Pill>{run.steps.reduce((a, s) => a + (s.inputsWithheld?.length || 0), 0)} inputs withheld</Pill>
          </div>
        )}
      </Card>

      <Card flush>
        <CardHead icon="layers" title="Architecture and handbook mapping"
          sub="Four agents are the core AI model; the supporting functions are orchestrator services" />
        <div className="card__body">
          <div className="tablewrap">
            <table className="dt">
              <thead><tr><th>PIE component</th><th>Kind</th><th>Hackfest handbook role</th><th>Responsibility</th></tr></thead>
              <tbody>{(ctx.boot.pipeline || []).map(s => (
                <tr key={s.key}>
                  <td><b>{s.name}</b></td>
                  <td><Badge tone={s.kind === 'agent' ? 'ai' : 'neutral'}>{s.kind}</Badge></td>
                  <td className="t-12">{s.handbookRole}</td>
                  <td className="t-12 muted">{s.responsibility}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <Alert tone="neutral" title="Why this mapping exists">
            The pitch deck names four specialised agents; the Hackfest handbook names six functions for
            Theme 2. PIE keeps the four agents as the core AI model and implements the remaining
            handbook functions as orchestrator services with the same rigour — manifests, scoped
            inputs, validation and audit.
          </Alert>
        </div>
      </Card>
    </div>
  );
}

function BiasView({ ctx, runs }) {
  const run = Object.values(runs).find(Boolean);
  if (!run) return <Card pad><Empty icon="shield" title="Run the orchestrator first"
    action={<Button variant="primary" icon="users" onClick={() => ctx.nav.go('r-pool')}>Open the pool</Button>}>
    Bias signals are produced as part of an orchestrator run against a candidate and a role.
  </Empty></Card>;
  return <BiasPanel bias={run.result.bias} />;
}

function AuditView({ ctx }) {
  const [events, setEvents] = useState(null);
  const load = useCallback(() => api.audit().then(r => setEvents(r.events)).catch(e => ctx.notify('crit', e.message)), [ctx]);
  useEffect(() => { load(); }, [load]);
  if (!events) return <Skeleton lines={6} />;
  return <AuditPanel audit={events} onRefresh={load} />;
}
