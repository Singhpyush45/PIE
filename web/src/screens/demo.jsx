import React, { useState } from 'react';
import { Icon, Button, Card, CardHead, Badge, Alert, Stat, cx } from '../kit.jsx';

/* The Grand Finale script — one deterministic story, in order, with the line to
   say on each beat. Steps that can jump the presenter to the right screen do. */

const STEPS = [
  { act: 'Set the scene', role: 'recruiter', view: 'r-overview',
    title: 'Sign in as Ananya Sharma (Recruiter)',
    say: 'Five candidates, one Data Quality / SDET role. Watch who ends up at the top — and who does not.' },
  { act: 'Set the scene', role: 'recruiter', view: 'r-pool',
    title: 'Open the candidate pool',
    say: 'Nikhil is a tier-1 graduate whose resume claims every required skill. He is fourth. Farah, Meera and Arjun can evidence theirs. That inversion is the whole product.' },
  { act: 'Set the scene', role: 'recruiter', view: 'r-compare',
    title: 'Compare candidates side by side',
    say: 'Same axes, same scales. Different radar shapes can both be valid — this is diagnostic, not a league table.' },
  { act: 'Capability', role: 'recruiter', view: 'r-candidate',
    title: 'Open Meera’s profile',
    say: 'A woman re-entering the workforce in a tier-2 city after a three-and-a-half year caregiving break — the exact persona the Hackfest brief names.' },
  { act: 'Capability', role: 'recruiter', view: 'r-candidate',
    title: 'Show the evidence, then GitHub and project evidence',
    say: 'Seven possible sources. GitHub is API-derived, so it outranks a resume claim — but repository activity is supporting evidence, never proof of skill.' },
  { act: 'Capability', role: 'recruiter', view: 'r-candidate',
    title: 'Capability Intelligence Agent',
    say: 'Problem Solving is gated — we refuse to infer it from resume keywords. Growth Readiness is the number a resume cannot express.' },
  { act: 'Capability', role: 'recruiter', view: 'r-candidate',
    title: 'Explainability Agent',
    say: 'Why matched, what the gap is, what to do about it — each line resolving to a named evidence item you can click into.' },
  { act: 'Capability', role: 'recruiter', view: 'r-candidate',
    title: 'Career Roadmap Agent',
    say: 'Prioritised skills, projects that produce verifiable evidence, milestones, and a reassessment point.' },
  { act: 'The role', role: 'recruiter', view: 'r-req',
    title: 'Open the requisition',
    say: 'Now the turn. We audited the job description, not just the candidates.' },
  { act: 'The role', role: 'recruiter', view: 'r-req',
    title: 'Employer readiness — the barrier is in the JD',
    say: 'Inclusion score 0.19. Six barriers. “No career gaps.” “Tier-1 institution.” “Digital native.” The bias was never in Meera.' },
  { act: 'Matching', role: 'recruiter', view: 'r-candidate',
    title: 'Inclusive Matching Agent',
    say: 'Skills-first and potential-adjusted, both always shown, never blended into one opaque number.' },
  { act: 'Matching', role: 'recruiter', view: 'r-candidate',
    title: 'Skill gaps and withheld inputs',
    say: 'Open the data-boundary panel: nineteen attributes were withheld from the matching agent, and the Bias Audit service independently verified they never arrived.' },
  { act: 'Matching', role: 'recruiter', view: 'r-pool',
    title: 'Generate a job-specific assessment',
    say: 'The blueprint comes from this role’s required capabilities intersected with her own evidence. It is not a generic question bank.' },
  { act: 'The candidate', role: 'candidate', view: 'c-dash',
    title: 'Switch to Meera’s workspace',
    say: 'Same engine, her view. Her gap and her pathway are hers whether or not anyone shortlists her.' },
  { act: 'The candidate', role: 'candidate', view: 'c-learning',
    title: 'Learning pathway → SAP Learning Hub',
    say: 'Objectives routed to SAP Learning Hub, student edition. Read the completion notice — we do not claim an API we have not verified.' },
  { act: 'The candidate', role: 'candidate', view: 'c-assess',
    title: 'Take the assessment: consent → device check → live',
    say: 'Consent first, with the timing and warning rules disclosed and frozen. Then the isolated assessment view — the sidebar is gone.' },
  { act: 'The candidate', role: 'candidate', view: 'c-assess',
    title: 'Trigger an integrity warning',
    say: 'Warning one of five, with what happened, what to do, and how many remain. Clear, never frightening, and never an automatic rejection.' },
  { act: 'Improvement', role: 'candidate', view: 'c-learning',
    title: 'Reassess after learning',
    say: 'Practice done, PIE re-scores server-side, the whole orchestrator re-runs. The match moves and a gap closes. That is the loop.' },
  { act: 'Governance', role: 'recruiter', view: 'r-bias',
    title: 'Bias audit',
    say: 'Read-only by construction. It flagged the requisition, and it warns the recruiter not to read thin evidence as low ability. A signal, never a proof.' },
  { act: 'Governance', role: 'admin', view: 'a-bias',
    title: 'Trust & Integrity review',
    say: 'A high-severity signal blocks the automated flow. A named human clears it, with a reason, before a recruiter can decide.' },
  { act: 'Governance', role: 'recruiter', view: 'r-candidate',
    title: 'Record the human decision',
    say: 'Everything so far has had zero effect on this person. A hiring outcome exists only once a named human acts, with a reason.' },
  { act: 'Governance', role: 'admin', view: 'a-audit',
    title: 'Audit trail',
    say: 'Every hop hashed and attributable, the AI recommendation recorded beside the human decision that overrode or accepted it.' },
  { act: 'Close', role: '*', view: 'sap',
    title: 'SAP integration readiness',
    say: 'Where SAP is real today, where an adapter is ready, and where it is honestly a future integration.' },
];

export default function DemoMode({ ctx }) {
  const [done, setDone] = useState(() => new Set());
  const [cursor, setCursor] = useState(0);
  const acts = [...new Set(STEPS.map(s => s.act))];

  const jump = (i) => {
    const step = STEPS[i];
    setCursor(i);
    if (step.role === '*' || step.role === ctx.user.role) ctx.nav.go(step.view);
    else ctx.notify('warn', `This beat runs in the ${step.role} workspace — sign in as that role first.`);
  };

  const toggle = (i) => setDone(d => {
    const n = new Set(d);
    n.has(i) ? n.delete(i) : n.add(i);
    return n;
  });

  return (
    <div className="stack">
      <Card ai flush>
        <CardHead icon="play" eyebrow="Presenter mode" title="Grand Finale demo"
          sub="One deterministic story, in order. Every beat works offline."
          right={<Badge tone="ai" dot>{done.size}/{STEPS.length} covered</Badge>} />
        <div className="card__body">
          <Alert tone="ok" title="This runs with the network unplugged" icon="check">
            Every score, gap, ranking and audit signal is computed deterministically on the server.
            The language model only narrates. If OpenAI, GitHub and SAP are all unreachable, the story
            is identical — the service chips simply read offline.
          </Alert>
          <div className="row row--wrap" style={{ gap: 10, marginTop: 14 }}>
            <Button variant="primary" icon="play" onClick={() => jump(0)}>Start from the top</Button>
            <Button variant="secondary" icon="refresh" onClick={() => { setDone(new Set()); setCursor(0); }}>
              Reset checklist
            </Button>
            <span className="t-12 muted">Signed in as <b>{ctx.user.name}</b> ({ctx.user.role})</span>
          </div>
        </div>
      </Card>

      <div className="grid g-4">
        <Card><Stat label="Beats" value={STEPS.length} icon="layers" /></Card>
        <Card><Stat label="Acts" value={acts.length} icon="orchestr" detail={acts.join(' · ')} /></Card>
        <Card><Stat label="Workspaces" value="3" icon="users" detail="candidate · recruiter · admin" /></Card>
        <Card><Stat label="Runtime" value="~15 min" icon="clock" detail="plus 5 min Q&A" /></Card>
      </div>

      {acts.map(act => (
        <Card key={act} flush>
          <CardHead eyebrow="Act" title={act} />
          <div className="card__body">
            <div className="grid" style={{ gap: 8 }}>
              {STEPS.map((s, i) => s.act === act && (
                <div key={i} className={cx('demostep', done.has(i) && 'demostep--done', cursor === i && 'demostep--now')}>
                  <button className="demostep__n" onClick={() => toggle(i)}
                    aria-label={done.has(i) ? `Mark beat ${i + 1} not covered` : `Mark beat ${i + 1} covered`}
                    style={{ border: 'none', cursor: 'pointer' }}>
                    {done.has(i) ? '✓' : i + 1}
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row--wrap" style={{ gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</span>
                      <Badge tone={s.role === ctx.user.role || s.role === '*' ? 'ok' : 'neutral'}>
                        {s.role === '*' ? 'any role' : s.role}
                      </Badge>
                    </div>
                    <div className="demostep__say">“{s.say}”</div>
                  </div>
                  <Button variant="ghost" size="sm" iconRight="right" onClick={() => jump(i)}>Go</Button>
                </div>
              ))}
            </div>
          </div>
        </Card>
      ))}

      <Card pad>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Closing line</div>
        <p style={{ fontSize: 16, lineHeight: 1.65, margin: 0, color: 'var(--ink-1)' }}>
          “PIE didn’t decide to hire Meera. It made her visible, told her exactly what to learn, told
          the employer their job description was the problem — and then got out of the way.”
        </p>
      </Card>
    </div>
  );
}
