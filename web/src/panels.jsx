import React, { useEffect, useState } from 'react';
import {
  Icon, Button, Card, CardHead, Badge, Pill, Stat, Alert, Meter, Tooltip,
  Empty, Skeleton, Insight, Modal, cx,
} from './kit.jsx';
import { api } from './api.js';
import { SkillRadar, Gauge, BarList, CompareBars, Trajectory, Funnel, EvidenceMix, f2, pc } from './charts.jsx';

/* The four specialised agents plus the orchestrator services that support them.
   Order and names come from the server's own manifest; this map only supplies icons. */
export const STEP_ICON = {
  capability_intelligence: 'discover',
  jd_requirements: 'market',
  employer_readiness: 'employer',
  inclusive_matching: 'match',
  career_roadmap: 'learn',
  bias_audit: 'shield',
  explainability: 'sparkle',
};

export const AGENT_META = [
  { key: 'capability_intelligence', name: 'Capability Intelligence', kind: 'agent',   icon: 'discover' },
  { key: 'jd_requirements',         name: 'JD Requirement Extraction', kind: 'service', icon: 'market' },
  { key: 'employer_readiness',      name: 'Employer Readiness',      kind: 'service', icon: 'employer' },
  { key: 'inclusive_matching',      name: 'Inclusive Matching',      kind: 'agent',   icon: 'match' },
  { key: 'career_roadmap',          name: 'Career Roadmap',          kind: 'agent',   icon: 'learn' },
  { key: 'bias_audit',              name: 'Bias Audit',              kind: 'service', icon: 'shield' },
  { key: 'explainability',          name: 'Explainability',          kind: 'agent',   icon: 'sparkle' },
];

const VERIF = {
  api_derived:     { label: 'API-verified',   tone: 'ok',      dot: 'api' },
  issuer_verified: { label: 'Issuer-verified', tone: 'info',   dot: 'issuer' },
  self_reported:   { label: 'Self-reported',  tone: 'neutral', dot: 'self' },
};
export const verifOf = v => VERIF[v] || VERIF.self_reported;

/* ==================================================== ORCHESTRATOR PIPELINE */
export function Pipeline({ run, phase, onSelect, selected, pipeline }) {
  const steps = (pipeline?.length ? pipeline : AGENT_META).map(s => ({
    ...s, icon: STEP_ICON[s.key] || 'layers',
  }));
  let agentNo = 0;
  return (
    <div className="pipeline" role="list" aria-label="Career Orchestrator pipeline">
      {steps.map((a, i) => {
        const step = run?.steps.find(s => s.key === a.key);
        const isAgent = (step?.kind || a.kind) === 'agent';
        if (isAgent) agentNo += 1;
        // During the replay animation a step can be visually "done" before its
        // data has arrived, so every read below must tolerate a missing step.
        const state = step?.status === 'SKIPPED' ? 'skip'
          : phase === 99 ? (step?.status === 'SUCCESS' ? 'done' : step ? 'fail' : 'wait')
          : i < phase ? 'done' : i === phase ? 'running' : 'wait';
        const out = step && summarise(a.key, step.output);
        const label = (step?.agent || a.name || '').replace(/ Agent$/, '');
        return (
          <button key={a.key} role="listitem"
            className={cx('agent', state !== 'wait' && 'agent--active', `agent--${state}`,
              selected === a.key && 'agent--selected')}
            onClick={() => step && step.status !== 'SKIPPED' && onSelect?.(a.key)}
            aria-label={`${label}. ${state === 'done' ? 'Complete' : state === 'running' ? 'Running'
              : state === 'skip' ? 'Not required for this trigger' : 'Queued'}.`}>
            <div className="agent__n">{isAgent ? `Agent ${agentNo}` : 'Service'}</div>
            <div className="agent__icon"><Icon name={a.icon} size={16} /></div>
            <div className="agent__name">{label}</div>
            <div className="agent__state" style={{
              color: state === 'done' ? 'var(--ok-fg)' : state === 'running' ? 'var(--brand-600)'
                : state === 'fail' ? 'var(--crit-fg)' : 'var(--ink-4)',
            }}>
              {state === 'running' && <span className="spin" />}
              {state === 'done' && <Icon name="check" size={12} />}
              {state === 'wait' ? 'Queued' : state === 'running' ? 'Analysing…'
                : state === 'done' ? (step ? `Complete · ${step.ms}ms` : 'Complete')
                : state === 'skip' ? 'Not required' : 'Failed'}
            </div>
            {state === 'done' && step && out && <div className="agent__out">{out}</div>}
            {state === 'skip' && <div className="agent__out">Skipped by the orchestrator for this trigger.</div>}
          </button>
        );
      })}
    </div>
  );
}

function summarise(key, o) {
  if (!o) return null;
  try {
    switch (key) {
      case 'capability_intelligence': return `${o.skills.length} capabilities · ${o.evidenceCount} evidence items`;
      case 'jd_requirements': return `${o.roleCompetencyModel.mandatoryCount} required · ${o.roleCompetencyModel.preferredCount} preferred`;
      case 'employer_readiness': return `${o.findings.length} barrier${o.findings.length === 1 ? '' : 's'} · inclusion ${f2(o.inclusionScore)}`;
      case 'inclusive_matching': return `Match ${f2(o.potentialAdjusted)} · ${o.gaps.length} gaps`;
      case 'career_roadmap': return `${o.objectives.length} objectives · ${o.totalHours}h`;
      case 'bias_audit': return `${o.signalCount} signal${o.signalCount === 1 ? '' : 's'} · ${o.highestSeverity}`;
      case 'explainability': return `${o.strengths.length} strengths · ${o.improvements.length} gaps explained`;
      default: return null;
    }
  } catch { return null; }
}

/* --------------------------------------------- agent detail (data boundary) */
export function AgentDetail({ step, onClose }) {
  if (!step) return null;
  return (
    <Modal open onClose={onClose} title={step.agent}>
      <div className="stack">
        <p className="lede" style={{ margin: 0 }}>{step.responsibility}</p>
        <div className="grid g-2">
          <Card pad>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Inputs granted</div>
            {step.inputsGranted.map(i => (
              <div key={i} className="row" style={{ gap: 8, marginBottom: 5 }}>
                <Icon name="check" size={13} style={{ color: 'var(--ok-fg)' }} />
                <span className="mono">{i}</span>
              </div>
            ))}
          </Card>
          <Card pad>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--crit-fg)' }}>
              Withheld by the orchestrator ({step.inputsWithheld.length})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {step.inputsWithheld.map(i => (
                <span key={i} className="badge badge--crit mono" style={{ fontSize: 10 }}>{i}</span>
              ))}
            </div>
          </Card>
        </div>
        <Alert tone="neutral" title="Decision boundary">{step.decisionBoundary}</Alert>
        <Alert tone="info" title="Human oversight">{step.humanOversight}</Alert>
        <Card flush>
          <CardHead eyebrow="Output validation" title="Checks run by the orchestrator"
            sub="A failing check rejects the agent's output rather than displaying it" />
          <div className="card__body" style={{ paddingTop: 8 }}>
            {step.validation.checks.map(c => (
              <div key={c.name} style={{ display: 'flex', gap: 10, padding: '8px 0', borderTop: '1px solid var(--line-1)' }}>
                <Icon name={c.pass ? 'check' : 'x'} size={15}
                  style={{ color: c.pass ? 'var(--ok-fg)' : 'var(--crit-fg)', flex: 'none', marginTop: 1 }} />
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontWeight: 600, color: 'var(--ink-1)' }}>{c.name}</div>
                  {c.detail && <div className="t-12 muted" style={{ marginTop: 2 }}>{c.detail}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </Modal>
  );
}

/* ================================================================ EVIDENCE */
export function EvidenceTimeline({ evidence, onDrill }) {
  if (!evidence?.length) {
    return <Empty icon="file" title="No evidence connected yet"
      action={<Button variant="primary" icon="plug">Add evidence</Button>}>
      Upload a resume, connect GitHub, or add projects and certificates — every source strengthens the profile.
    </Empty>;
  }
  const sorted = [...evidence].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return (
    <div className="tl">
      {sorted.map(e => {
        const v = verifOf(e.verification);
        return (
          <div className="tl__item" key={e.id}>
            <span className={`tl__dot tl__dot--${v.dot}`} />
            <div className="row row--wrap" style={{ gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</span>
              <Badge tone={v.tone} dot>{v.label}</Badge>
              <Badge tone="neutral">{e.source}</Badge>
              <span className="t-11 faint mono">{e.date}</span>
              {onDrill && (
                <Button variant="ghost" size="sm" icon="eye" onClick={() => onDrill(e)}>Evidence</Button>
              )}
            </div>
            <div className="t-12 muted" style={{ lineHeight: 1.55 }}>{e.text}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================ SKILL PANELS */
export function SkillsPanel({ discovery, limit }) {
  const items = (limit ? discovery.skills.slice(0, limit) : discovery.skills).map(s => ({
    key: s.id, label: s.name, value: s.confidence,
    meta: s.corroborated ? `${s.sourceCount} sources` : 'single source',
    tone: s.confidence >= 0.7 ? 'var(--seq-4)' : s.confidence >= 0.4 ? 'var(--seq-3)' : 'var(--seq-2)',
    tip: `${s.name}: confidence ${f2(s.confidence)} from ${s.sources.join(', ')}. ${s.corroborated ? 'Corroborated across independent sources.' : 'Single source — held at lower confidence.'}`,
  }));
  return <BarList items={items} />;
}

/* ============================================================ MATCH PANEL */
export function MatchPanel({ matching, onDrill }) {
  return (
    <div className="stack">
      <div className="grid g-3">
        <Card pad><Gauge value={matching.skillsFirstScore} label="Skills-first match"
          sub="evidence vs. required skills" tone="var(--series-1)" /></Card>
        <Card pad><Gauge value={matching.growthUplift} label="Growth uplift" size={150}
          sub="capped at +0.10, never negative" tone="var(--ai-solid)" /></Card>
        <Card pad><Gauge value={matching.potentialAdjusted} label="Potential-adjusted"
          sub="both scores are always shown" tone="var(--series-3)" /></Card>
      </div>

      <Insight
        title="How this match was produced"
        insight={`${matching.matchTier} — skills-first ${f2(matching.skillsFirstScore)}, potential-adjusted ${f2(matching.potentialAdjusted)}.`}
        evidence={`${matching.breakdown.length} role competencies compared against the candidate's confidence-weighted skill map. ${matching.breakdown.filter(b => b.evidence.length).length} of them resolve to named evidence items.`}
        reasoning={matching.disclosure}
        confidence={matching.potentialAdjusted}
        recommendation="Review recommended. This score has no effect until a recruiter records a decision."
        uncertainty={matching.gaps.length ? `${matching.gaps.length} skill(s) below the required level — see the gap analysis.` : null}
        badge={<Badge tone="ai" dot>AI recommendation</Badge>}
      />

      <Card flush>
        <CardHead eyebrow="Per-skill breakdown" title="Every number resolves to evidence"
          sub="Coverage is candidate confidence divided by the level the role requires" />
        <div className="tablewrap">
          <table className="dt">
            <thead><tr>
              <th>Skill</th><th>Type</th><th className="num">Required</th><th className="num">Candidate</th>
              <th style={{ width: 160 }}>Coverage</th><th>Status</th><th>Grounded in</th>
            </tr></thead>
            <tbody>
              {matching.breakdown.map(b => (
                <tr key={b.skillId}>
                  <td style={{ fontWeight: 600 }}>{b.name}</td>
                  <td><Badge tone={b.mandatory ? 'ai' : 'neutral'}>{b.mandatory ? 'Mandatory' : 'Preferred'}</Badge></td>
                  <td className="num tnum">{f2(b.requiredLevel)}</td>
                  <td className="num tnum">{f2(b.candidateConfidence)}</td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <Meter value={b.coverage} label={`${b.name} coverage`} />
                      <span className="tnum t-12" style={{ fontWeight: 700, width: 36 }}>{pc(b.coverage)}</span>
                    </div>
                  </td>
                  <td>
                    <Badge tone={b.status === 'Strong' ? 'ok' : b.status === 'Missing' ? 'crit' : 'warn'}
                      icon={b.status === 'Strong' ? 'check' : b.status === 'Missing' ? 'x' : 'alert'}>
                      {b.status}
                    </Badge>
                  </td>
                  <td>
                    {b.evidence.length ? b.evidence.map((e, i) => (
                      <button key={i} onClick={() => onDrill?.(e)}
                        style={{ display: 'block', background: 'none', border: 0, padding: 0, cursor: onDrill ? 'pointer' : 'default',
                          fontSize: 11.5, color: 'var(--ink-2)', textAlign: 'left', textDecoration: onDrill ? 'underline dotted' : 'none' }}>
                        {e.title}
                      </button>
                    )) : <span className="t-12 faint">no evidence found</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ======================================================== EMPLOYER PANEL */
export function EmployerPanel({ employer }) {
  return (
    <div className="stack">
      <div className="grid g-3">
        <Card><Stat label="Requisition inclusion score" value={f2(employer.inclusionScore)}
          tone={employer.inclusionScore >= 0.8 ? 'ok' : employer.inclusionScore >= 0.55 ? 'warn' : 'crit'}
          detail={employer.inclusionTier}
          hint="How free the job description is of criteria that exclude capable candidates before capability is assessed." /></Card>
        <Card><Stat label="Barriers detected" value={employer.findings.length}
          tone={employer.findings.length ? 'crit' : 'ok'}
          detail={`${employer.findings.filter(f => f.severity === 'High').length} high severity`} /></Card>
        <Card><Stat label="Skill clarity" value={employer.skillClarity} tone="brand"
          detail="Whether the role states enough concrete skills to match on" /></Card>
      </div>

      <Alert tone={employer.findings.length ? 'warn' : 'ok'} title="What PIE did with these clauses">
        {employer.estimatedPoolImpact}
      </Alert>

      {employer.findings.length ? (
        <div className="grid g-2">
          {employer.findings.map(f => (
            <Card key={f.id} flush>
              <div className="card__head" style={{ alignItems: 'center' }}>
                <Icon name="alert" size={16} style={{ color: f.severity === 'High' ? 'var(--crit-fg)' : 'var(--warn-fg)' }} />
                <h3 style={{ flex: 1, fontSize: 13 }}>{f.finding}</h3>
                <Badge tone={f.severity === 'High' ? 'crit' : 'warn'}>{f.severity}</Badge>
              </div>
              <div className="card__body">
                <div style={{ background: 'var(--crit-bg)', border: '1px solid var(--crit-line)',
                  borderRadius: 'var(--r-sm)', padding: '8px 11px', marginBottom: 12 }}>
                  <div className="eyebrow" style={{ color: 'var(--crit-fg)', marginBottom: 3 }}>Matched text</div>
                  <span className="mono" style={{ color: 'var(--crit-fg)' }}>“{f.matchedText}”</span>
                </div>
                <dl className="insight__chain" style={{ borderTop: 0 }}>
                  <div className="insight__link"><dt>Barrier</dt><dd>{f.barrier}</dd></div>
                  <div className="insight__link"><dt>Impact</dt><dd>{f.impact}</dd></div>
                  <div className="insight__link"><dt>Rewrite</dt><dd style={{ color: 'var(--ok-fg)' }}>{f.suggestion}</dd></div>
                </dl>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card pad><Empty icon="check" title="No exclusionary clauses detected">
          This requisition is evaluated purely on its stated skills.
        </Empty></Card>
      )}
    </div>
  );
}

/* ======================================================== LEARNING PANEL */
export function LearningPanel({ learning, gaps, delta, onReassess, busy, candidateView }) {
  return (
    <div className="stack">
      <div className="grid g-4">
        <Card><Stat label="Open gaps" value={gaps.length} tone="warn" icon="target" /></Card>
        <Card><Stat label="Objectives" value={learning.objectives.length} tone="brand" icon="learn"
          detail="prerequisite-ordered" /></Card>
        <Card><Stat label="Estimated effort" value={`${learning.totalHours}h`} tone="ai" icon="clock" /></Card>
        <Card><Stat label="PIE-verified" value={learning.verifiedResourceCount} icon="book"
          detail="student edition resources" /></Card>
      </div>

      {delta && (
        <Card pad className="fadein" style={{ borderColor: 'var(--ok-line)' }}>
          <div className="row" style={{ marginBottom: 14 }}>
            <Icon name="check" size={18} style={{ color: 'var(--ok-fg)' }} />
            <div>
              <div className="eyebrow" style={{ color: 'var(--ok-fg)' }}>Reassessment complete — evidence updated</div>
              <h3>{delta.skill} gap closed</h3>
            </div>
          </div>
          <div className="grid g-2">
            <Trajectory label="Match score" points={[
              { label: 'Before', value: delta.matchBefore, note: 'Skills-first match before the pathway' },
              { label: 'After', value: delta.matchAfter, note: 'After reassessment produced new evidence' },
            ]} />
            <div className="grid g-2" style={{ alignContent: 'start' }}>
              <Card pad><Stat label="Skills-first" value={`${f2(delta.matchBefore)} → ${f2(delta.matchAfter)}`} tone="ok" /></Card>
              <Card pad><Stat label="Potential-adjusted" value={`${f2(delta.potentialBefore)} → ${f2(delta.potentialAfter)}`} tone="ok" /></Card>
              <Card pad><Stat label="Open gaps" value={`${delta.gapsBefore} → ${delta.gapsAfter}`} tone="ok" /></Card>
              <Card pad><Stat label="Growth readiness" value={`${f2(delta.growthBefore)} → ${f2(delta.growthAfter)}`} /></Card>
            </div>
          </div>
          <Alert tone="info" title="What produced the new evidence">
            The full orchestrator re-ran on the updated evidence profile. <b>External-provider completion was not
            asserted</b> — the new evidence comes from a PIE reassessment scored server-side, because no verified
            Learning Hub completion API exists.
          </Alert>
        </Card>
      )}

      {learning.objectives.map(o => (
        <Card key={o.objectiveId} flush>
          <div className="card__head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="steps__dot" style={{ background: 'var(--brand-500)', borderColor: 'var(--brand-500)', color: '#fff' }}>
              {o.sequence}
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <h3 style={{ fontSize: 15 }}>{o.skill}</h3>
              <div className="sub">{o.milestone}</div>
            </div>
            <Badge tone={o.priority.startsWith('Mandatory') ? 'crit' : 'info'}>{o.priority}</Badge>
            <Badge tone="neutral">{o.tier}</Badge>
            <Pill><Icon name="clock" size={11} />{o.estimatedHours}h</Pill>
            <Button variant="ok" size="sm" icon="check" disabled={busy} onClick={() => onReassess(o.skillId)}>
              {candidateView ? 'I’ve completed this — reassess me' : 'Completed → Reassess'}
            </Button>
          </div>
          <div className="card__body">
            <div className="row" style={{ gap: 12, marginBottom: 14 }}>
              <span className="t-12 muted nowrap">Current {f2(o.from)}</span>
              <Meter value={o.from} target={o.to} height="lg" label={`${o.skill} progress toward target`} />
              <span className="t-12 nowrap" style={{ fontWeight: 600 }}>Target {f2(o.to)}</span>
            </div>
            {o.prerequisites.length > 0 && (
              <Alert tone="warn" title="Prerequisite first">{o.prerequisites.join(', ')}</Alert>
            )}
            <div className="grid" style={{ gap: 10, marginTop: 12 }}>
              {o.resources.map(r => {
                // A PIE practice task is the only resource whose completion PIE
                // can actually verify, so it is the one that gets the emphasis.
                const isPractice = r.provider === 'PIE_PRACTICE';
                return (
                  <div key={r.resource_id} style={{
                    border: `1px solid ${isPractice ? 'var(--accent-500)' : 'var(--line-2)'}`,
                    borderRadius: 'var(--r-md)', padding: 'var(--s-4)',
                    background: isPractice ? 'var(--accent-50)' : 'var(--surface-2)',
                  }}>
                    <div className="row row--wrap" style={{ gap: 8, marginBottom: 8 }}>
                      <Badge tone={isPractice ? 'ok' : 'neutral'} icon={isPractice ? 'target' : 'ext'}>
                        {r.providerName}
                      </Badge>
                      <Badge tone="neutral">{r.learning_type}</Badge>
                      <Badge tone="neutral">{r.difficulty}</Badge>
                      <Pill><Icon name="clock" size={11} />{r.hours}h</Pill>
                      <Pill>Verification: <b>{r.verification_status}</b></Pill>
                      <span className="spacer" style={{ flex: 1 }} />
                      {r.external_url && (
                        <a className="btn btn--primary btn--sm" href={r.external_url} target="_blank" rel="noreferrer">
                          <Icon name="ext" size={14} />Start learning
                        </a>
                      )}
                    </div>
                    <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 3 }}>{r.title}</div>
                    <div className="t-12 muted" style={{ lineHeight: 1.55 }}>{r.description}</div>
                    <div className="row" style={{ gap: 7, marginTop: 9, alignItems: 'flex-start' }}>
                      <Icon name={r.completion_verification === 'PIE_REASSESSMENT' ? 'check' : 'info'} size={13}
                        style={{ color: r.completion_verification === 'PIE_REASSESSMENT' ? 'var(--ok-fg)' : 'var(--ink-3)', marginTop: 2, flex: 'none', opacity: r.completion_verification === 'PIE_REASSESSMENT' ? 1 : .7 }} />
                      <span className="t-11" style={{ color: r.completion_verification === 'PIE_REASSESSMENT' ? 'var(--ok-fg)' : 'var(--ink-3)', lineHeight: 1.5 }}>
                        {r.completionNotice}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      ))}

      <Alert tone="info" title="What PIE can and cannot verify">{learning.integrationNotice}</Alert>
    </div>
  );
}

/* ============================================================ BIAS PANEL */
export function BiasPanel({ bias }) {
  return (
    <div className="stack">
      <div className="grid g-3">
        <Card><Stat label="Signals raised" value={bias.signalCount}
          tone={bias.highestSeverity === 'High' ? 'crit' : bias.highestSeverity === 'Medium' ? 'warn' : 'ok'}
          icon="shield" /></Card>
        <Card><Stat label="Highest severity" value={bias.highestSeverity}
          tone={bias.highestSeverity === 'High' ? 'crit' : 'warn'} /></Card>
        <Card><Stat label="Write access" value="None" tone="ok" detail="report-only by construction" icon="lock" /></Card>
      </div>
      <Alert tone="ok" title="Assurance" icon="lock">{bias.assurance}</Alert>
      {bias.signals.map(s => (
        <Insight key={s.auditId}
          title={`${s.auditId} · ${s.signal}`}
          evidence={s.evidence}
          reasoning={s.reason}
          confidence={s.confidence}
          recommendation={s.recommendedReview}
          badge={<Badge tone={s.severity === 'High' ? 'crit' : s.severity === 'Medium' ? 'warn'
            : s.severity === 'None' ? 'ok' : 'info'} icon={s.severity === 'None' ? 'check' : 'alert'}>
            {s.severity === 'None' ? 'Clear' : `${s.severity} severity`}</Badge>}
        />
      ))}
    </div>
  );
}

/* ======================================================== DECISION PANEL */
/**
 * The plain-English brief a recruiter reads before deciding.
 *
 * Fetched separately from the run: a language model must never be able to delay
 * or break a match result, and a brief that fails should cost the brief only.
 *
 * What is NOT sent to write it: the candidate's name, institution, employment
 * history or anything else that could smuggle pedigree back into a skills-first
 * decision. The panel says so, because a recruiter should know what the
 * narrator was and was not given.
 */
function DecisionBrief({ runId }) {
  const [brief, setBrief] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    api.runBrief(runId)
      .then(r => { if (live) setBrief(r.brief); })
      .catch(e => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [runId]);

  if (err) return null;
  if (!brief) return <Card flush><div className="card__body"><Skeleton lines={3} /></div></Card>;

  const n = brief.narrative;
  return (
    <Card flush>
      <CardHead icon="brief" eyebrow="Decision brief" title="What the evidence supports"
        sub="Written from PIE's computed result — every number here was calculated before any model was called."
        right={<Badge tone={n ? 'ai' : 'neutral'} dot>{n ? brief.provider : 'Deterministic'}</Badge>} />
      <div className="card__body stack">
        {n ? (
          <>
            <p className="lede" style={{ margin: 0 }}>{n.headline}</p>
            <div>
              <div className="eyebrow">Strengths</div>
              <p style={{ margin: '4px 0 0' }}>{n.strengths}</p>
            </div>
            {n.gaps && (
              <div>
                <div className="eyebrow">Gaps against this role</div>
                <p style={{ margin: '4px 0 0' }}>{n.gaps}</p>
              </div>
            )}
            {n.decisionHinges && (
              <div>
                <div className="eyebrow">What this decision turns on</div>
                <p style={{ margin: '4px 0 0' }}>{n.decisionHinges}</p>
              </div>
            )}
          </>
        ) : (
          <p style={{ margin: 0 }}>{brief.fallback}</p>
        )}
        <p className="note">
          <Icon name="info" size={12} className="note__i" />
          <span>
            The narrator was given skills, coverage scores, gaps and assessment results — and
            deliberately not the candidate's name, institution or history. {brief.note}
          </span>
        </p>
      </div>
    </Card>
  );
}

export function DecisionPanel({ run, onDecide, busy, actor, setActor, note, setNote }) {
  const decided = run.status === 'DECIDED';
  const bias = run.result.bias;
  const x = run.result.explainability;

  return (
    <div className="stack">
      {/* Read this before the numbers: it is the same evidence in sentences. */}
      <DecisionBrief runId={run.runId} />

      <div className="grid g-2">
        <Card flush>
          <CardHead icon="check" eyebrow="Explainability service" title="Strengths"
            sub="Each claim resolves to a named evidence item" />
          <div className="card__body">
            {x.strengths.map((s, i) => (
              <div key={i} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-1)' }}>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{s.claim}</span>
                  <Meter value={s.confidence} label="confidence" />
                  <span className="tnum t-12" style={{ fontWeight: 700 }}>{f2(s.confidence)}</span>
                </div>
                {s.grounding.map((g, j) => (
                  <div key={j} className="t-11 muted" style={{ marginTop: 3, paddingLeft: 2 }}>↳ {g}</div>
                ))}
              </div>
            ))}
          </div>
        </Card>
        <Card flush>
          <CardHead icon="target" eyebrow="Explainability service" title="Improvement areas"
            sub="Stated limits are shown, not hidden" />
          <div className="card__body">
            {x.improvements.map((s, i) => (
              <div key={i} style={{ padding: '9px 0', borderBottom: '1px solid var(--line-1)' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{s.claim}</div>
                {s.grounding.map((g, j) => (
                  <div key={j} className="t-11 muted" style={{ marginTop: 3 }}>↳ {g}</div>
                ))}
              </div>
            ))}
            <Alert tone="warn" title="Stated limitations">{x.limitations.join(' ')} {x.rule}</Alert>
          </div>
        </Card>
      </div>

      <Card flush style={{ borderColor: decided ? 'var(--ok-line)' : 'var(--crit-line)' }}>
        <div className="card__head" style={{ background: decided ? 'var(--ok-bg)' : 'var(--crit-bg)', alignItems: 'center' }}>
          <Icon name={decided ? 'check' : 'lock'} size={18}
            style={{ color: decided ? 'var(--ok-fg)' : 'var(--crit-fg)' }} />
          <div style={{ flex: 1 }}>
            <div className="eyebrow" style={{ color: decided ? 'var(--ok-fg)' : 'var(--crit-fg)' }}>
              {decided ? 'Human decision recorded' : 'Mandatory human gate'}
            </div>
            <h3>{decided ? run.decision.action.replace(/_/g, ' ') : 'No hiring outcome exists yet'}</h3>
          </div>
          <Badge tone={decided ? 'ok' : 'crit'} dot>{decided ? 'Decided' : 'Awaiting human'}</Badge>
        </div>
        <div className="card__body">
          {decided ? (
            <div className="stack">
              <p className="lede" style={{ margin: 0 }}>
                Recorded by <b>{run.decision.actor}</b> at {new Date(run.decision.at).toLocaleString()}.
                {run.decision.note && <> Reason: “{run.decision.note}”</>}
              </p>
              <Alert tone="ok" title="Authority">{run.decision.authority} The AI recommendations that
                preceded it remain advisory and unchanged in the audit trail.</Alert>
            </div>
          ) : (
            <div className="stack">
              <p className="lede" style={{ margin: 0 }}>
                Everything above is an <b>AI recommendation</b> with no effect on this candidate. A hiring
                outcome exists only once a named human records a decision here. The orchestrator cannot
                satisfy this gate itself, under any configuration.
              </p>
              {bias.highestSeverity === 'High' && (
                <Alert tone="crit" title="Bias Audit raised a high-severity signal">
                  Review the Bias Audit tab before deciding — the barrier it found is in the requisition,
                  not in the candidate.
                </Alert>
              )}
              <div className="grid g-2">
                <div className="field">
                  <label htmlFor="actor">Deciding recruiter</label>
                  <input id="actor" className="input" value={actor} onChange={e => setActor(e.target.value)}
                    placeholder="name@company.com" />
                  <span className="hint">Recorded in the audit trail against this decision.</span>
                </div>
                <div className="field">
                  <label htmlFor="note">Reason for the decision</label>
                  <input id="note" className="input" value={note} onChange={e => setNote(e.target.value)}
                    placeholder="Why this decision?" />
                  <span className="hint">
                    Overrides of an AI recommendation should always carry a reason.
                    <b> The candidate sees this text.</b> PIE writes their feedback from the
                    evidence and gaps, but your words are shown alongside it — write them as
                    something you would say to them.
                  </span>
                </div>
              </div>
              <div className="row row--wrap">
                <Button variant="ok" icon="check" disabled={busy || !actor}
                  onClick={() => onDecide('PROCEED_TO_INTERVIEW')}>Proceed to interview</Button>
                <Button variant="primary" icon="users" disabled={busy || !actor}
                  onClick={() => onDecide('SHORTLIST')}>Shortlist</Button>
                <Button variant="secondary" icon="clock" disabled={busy || !actor}
                  onClick={() => onDecide('HOLD')}>Hold</Button>
                <Button variant="danger-ghost" icon="x" disabled={busy || !actor}
                  onClick={() => onDecide('REJECT')}>Reject</Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ============================================================ AUDIT PANEL */
export function AuditPanel({ audit, onRefresh }) {
  const ACT = {
    RUN_START: 'brand', AGENT_INVOKE: 'neutral', HUMAN_GATE_OPENED: 'warn',
    HUMAN_DECISION_RECORDED: 'ok', REASSESSMENT_COMPLETED: 'ok', INTEGRITY_WARNING: 'warn',
    ATTEMPT_LOCKED: 'crit', NARRATION_GENERATED: 'ai',
  };
  if (!audit.length) {
    return <Card pad><Empty icon="history" title="No audit events yet"
      action={<Button variant="secondary" icon="refresh" onClick={onRefresh}>Refresh</Button>}>
      Every orchestrator hop, integrity event and human decision is written here as it happens.
    </Empty></Card>;
  }
  return (
    <Card flush>
      <CardHead eyebrow="Orchestrator audit trail" title="Every hop, hashed and attributable"
        sub={`${audit.length} events`}
        right={<Button variant="secondary" size="sm" icon="refresh" onClick={onRefresh}>Refresh</Button>} />
      <div className="tablewrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
        <table className="dt">
          <thead><tr><th style={{ width: 96 }}>Time</th><th style={{ width: 190 }}>Actor</th>
            <th style={{ width: 210 }}>Event</th><th>Detail</th></tr></thead>
          <tbody>
            {[...audit].reverse().map((e, i) => (
              <tr key={i}>
                <td className="mono faint">{new Date(e.ts).toLocaleTimeString()}</td>
                <td className="mono" style={{ color: 'var(--ai-fg)' }}>{e.actor}</td>
                <td><Badge tone={ACT[e.action] || 'neutral'}>{e.action.replace(/_/g, ' ')}</Badge></td>
                <td className="t-12 muted">
                  {e.note || e.note2 || ''}
                  {e.inputHash && <> · in <span className="mono">{e.inputHash}</span>
                    {e.outputHash && <> → out <span className="mono">{e.outputHash}</span></>}</>}
                  {e.withheldInputs ? ` · ${e.withheldInputs} inputs withheld` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ======================================================== EVIDENCE DRILL */
export function EvidenceDrill({ item, evidence, onClose }) {
  if (!item) return null;
  const full = evidence?.find(e => e.id === item.id || e.title === item.title) || item;
  const v = verifOf(full.verification);
  return (
    <Modal open onClose={onClose} title="Evidence detail">
      <div className="stack">
        <div className="row row--wrap">
          <Badge tone={v.tone} dot>{v.label}</Badge>
          {full.source && <Badge tone="neutral">{full.source}</Badge>}
          {full.date && <Pill><Icon name="clock" size={11} />{full.date}</Pill>}
        </div>
        <h3>{full.title}</h3>
        <p className="lede">{full.text || 'No extended description recorded for this item.'}</p>
        <Alert tone="neutral" title="How this evidence is weighted">
          Trust tier <b>{v.label}</b>. API-derived evidence outranks issuer-verified, which outranks
          self-reported. A skill claimed in one source alone is held at lower confidence than one
          corroborated across independent sources — and confidence is never silently upgraded.
        </Alert>
      </div>
    </Modal>
  );
}

export { Funnel, EvidenceMix, SkillRadar, Gauge, BarList, CompareBars, Trajectory, f2, pc };
