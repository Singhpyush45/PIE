// PIE ORCHESTRATOR — the control plane.
//
//                          PIE ORCHESTRATOR
//                                 |
//         +-------------+---------+---------+-------------+
//         |             |                   |             |
//   Capability     Explainability      Career Roadmap   Inclusive
//   Intelligence       Agent               Agent        Matching
//      Agent                                              Agent
//
// Supporting ORCHESTRATOR SERVICES (not agents): JD Requirement Extraction,
// Employer Readiness, Bias Audit, Human-in-the-Loop gate.
//
// Agents never call each other. Every hop goes through here, and this file is the
// only place that decides what data an agent is allowed to see.

import crypto from 'node:crypto';
import {
  skillsDiscoveryAgent as computeCapability,
  marketIntelligenceAgent as computeRoleModel,
  employerReadinessAgent as computeEmployerReadiness,
  inclusiveMatchingAgent as computeMatch,
  learningPathwayAgent as computeRoadmap,
  biasAuditAgent as computeBiasAudit,
  explain as computeExplainability,
  MODEL_VERSION,
} from './agents.js';
import {
  capabilityIntelligenceAgent, explainabilityAgent, careerRoadmapAgent,
  inclusiveMatchingAgent as interpretMatch, extractJdRequirements, providerStatus,
} from './ai/agents.js';
import { PROHIBITED_INPUTS } from './data.js';

/* ============================ THE FOUR SPECIALISED AGENTS ================== */
export const AGENT_MANIFEST = {
  capability_intelligence: {
    kind: 'agent', name: 'Capability Intelligence Agent', order: 1,
    handbookRole: 'Skills Discovery',
    responsibility: 'Analyse all evidence and extract demonstrated capability — technical, behavioural, transferable and non-traditional. Owns the Unified Candidate Evidence Profile.',
    reads: ['candidate.evidence', 'skill_ontology'],
    writes: ['unified_evidence_profile', 'skill_confidence', 'capability_dimensions'],
    denied: ['requisition', 'recruiter_notes', 'other_candidates', ...PROHIBITED_INPUTS],
    decisionBoundary: 'May assert capability with confidence. May NOT rank candidates, judge fitness for a role, or produce a hiring signal.',
    humanOversight: 'The candidate may dispute any discovered capability or confidence value; the dispute is recorded on the evidence item.',
  },
  inclusive_matching: {
    kind: 'agent', name: 'Inclusive Matching Agent', order: 4,
    handbookRole: 'Inclusive Matching',
    responsibility: 'Match capability to opportunity, skills-first and evidence-weighted, with protected and pedigree attributes withheld.',
    reads: ['skill_confidence', 'growth_readiness', 'role_competency_model'],
    writes: ['match_result', 'skill_gap'],
    denied: ['candidate.raw_evidence_text', 'candidate.context', 'employer_readiness_report', ...PROHIBITED_INPUTS],
    decisionBoundary: 'Produces a ranked recommendation only. It has NO effect until a human gate resolves.',
    humanOversight: 'Mandatory human gate — a recruiter decision is required before any outcome exists.',
  },
  career_roadmap: {
    kind: 'agent', name: 'Career Roadmap Agent', order: 5,
    handbookRole: 'Learning Pathway',
    responsibility: 'Convert skill gaps into a personalised, prerequisite-ordered development pathway routed to real learning providers.',
    reads: ['skill_gap', 'skill_confidence', 'learning_resource_registry'],
    writes: ['learning_pathway'],
    denied: ['recruiter_decision', 'match_result.ranking', 'other_candidates'],
    decisionBoundary: 'Recommends learning only. Cannot enrol a candidate anywhere or assert completion.',
    humanOversight: 'Candidate-controlled — accept, reorder or ignore.',
  },
  explainability: {
    kind: 'agent', name: 'Explainability Agent', order: 7,
    handbookRole: 'Explainability (cross-cutting)',
    responsibility: 'Explain strengths, gaps, matching rationale and improvement opportunities in user-facing language, anchored to specific evidence.',
    reads: ['ALL computed results (read-only)'],
    writes: ['explanation'],
    denied: ['WRITE access to any score, ranking or decision'],
    decisionBoundary: 'Explains only. An explanation it cannot ground in an evidence item is discarded rather than displayed.',
    humanOversight: 'Shown to both recruiter and candidate; a candidate may dispute any statement.',
  },
};

/* ======================== ORCHESTRATOR SERVICES (not agents) =============== */
export const SERVICE_MANIFEST = {
  jd_requirements: {
    kind: 'service', name: 'JD Requirement Extraction', order: 2,
    handbookRole: 'Market Intelligence',
    responsibility: 'Convert a job description into a weighted Role Competency Model: required capabilities, preferred capabilities and experience requirements.',
    reads: ['requisition.text', 'skill_ontology', 'market_demand_index'],
    writes: ['role_competency_model'],
    denied: ['candidate.*'],
    decisionBoundary: 'Never sees any candidate, so it cannot be influenced by who is in the pool.',
    humanOversight: 'The recruiter may adjust extracted weights before matching runs.',
  },
  employer_readiness: {
    kind: 'service', name: 'Employer Readiness', order: 3,
    handbookRole: 'Employer Readiness',
    responsibility: 'Audit the requisition itself for exclusionary, unnecessary or ambiguous requirements.',
    reads: ['requisition.text', 'role_competency_model'],
    writes: ['employer_readiness_report'],
    denied: ['candidate.*', 'matching_results'],
    decisionBoundary: 'Reports on the role only. May NOT alter the Role Competency Model or exclude any candidate.',
    humanOversight: 'Findings are advisory to the recruiter; editing a requisition is a human action.',
  },
  bias_audit: {
    kind: 'service', name: 'Bias Audit', order: 6,
    handbookRole: 'Bias Audit',
    responsibility: 'Independently audit capability inference, matching, ranking and generated insight for potential unfairness.',
    reads: ['ALL step outputs (read-only)', 'candidate.protected_context (for exclusion verification only)'],
    writes: ['bias_audit_report'],
    denied: ['WRITE access to every other artefact in the system'],
    decisionBoundary: 'Reports potential bias SIGNALS with evidence, confidence and recommended review. It may NEVER modify a score, ranking or recommendation, and it never claims bias is proven.',
    humanOversight: 'A high-severity signal blocks the automated flow and requires Trust & Integrity review.',
  },
};

export const PIPELINE = [...Object.entries(AGENT_MANIFEST), ...Object.entries(SERVICE_MANIFEST)]
  .map(([key, m]) => ({ key, ...m }))
  .sort((a, b) => a.order - b.order);

/* ------------------------------------------------------------ SCOPED PAYLOADS */
function manifestFor(key) { return AGENT_MANIFEST[key] || SERVICE_MANIFEST[key]; }

function scope(key, full) {
  const m = manifestFor(key);
  const withheld = [];
  const p = {};
  switch (key) {
    case 'capability_intelligence':
      p.candidate = { id: full.candidate.id, evidence: full.candidate.evidence,
        protectedContext: full.candidate.protectedContext };
      withheld.push('requisition', 'role_competency_model', 'recruiter_context', 'other_candidates');
      break;
    case 'jd_requirements':
      p.requisition = full.requisition;
      withheld.push('candidate', 'unified_evidence_profile', 'skill_confidence');
      break;
    case 'employer_readiness':
      p.requisition = full.requisition; p.market = full.market;
      withheld.push('candidate', 'skill_confidence', 'match_result');
      break;
    case 'inclusive_matching':
      // Only the capability map + growth readiness. No raw evidence text, no context.
      p.discovery = {
        skills: (full.discovery?.skills || []).map(s => ({
          id: s.id, name: s.name, category: s.category, confidence: s.confidence,
          corroborated: s.corroborated, sources: s.sources,
          mentions: s.mentions.map(x => ({ evidenceId: x.evidenceId, evidenceTitle: x.evidenceTitle, verificationLabel: x.verificationLabel })),
        })),
        growthReadiness: full.discovery?.growthReadiness,
        // Names only — the interpretation layer needs to know which dimensions are
        // unscored, but never gets the dimension data or the evidence behind it.
        insufficientDimensions: Object.entries(full.discovery?.dimensions || {})
          .filter(([, v]) => v.tier === 'Insufficient Data').map(([k]) => k),
      };
      p.market = full.market;
      withheld.push('candidate.context', 'candidate.protectedContext', 'raw_evidence_text',
        'employer_readiness_report', ...PROHIBITED_INPUTS.slice(0, 6));
      break;
    case 'career_roadmap':
      p.gaps = full.matching?.gaps || []; p.discovery = full.discovery;
      withheld.push('match_result.ranking', 'recruiter_decision', 'other_candidates');
      break;
    case 'bias_audit':
      p.all = full;
      withheld.push('WRITE access to all artefacts');
      break;
    case 'explainability':
      p.all = full;
      withheld.push('WRITE access to all scores, rankings and decisions');
      break;
  }
  return { payload: p, withheld, manifest: m };
}

const hash = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 12);

/* ============================== SELECTIVE INVOCATION =======================
   The orchestrator does NOT run every agent for every operation. Each trigger
   declares the minimum pipeline it needs.                                    */
export const TRIGGERS = {
  RESUME_UPLOADED:      ['capability_intelligence'],
  GITHUB_CONNECTED:     ['capability_intelligence'],
  EVIDENCE_ADDED:       ['capability_intelligence'],
  CANDIDATE_ASKS_GAP:   ['capability_intelligence', 'jd_requirements', 'inclusive_matching', 'career_roadmap', 'explainability'],
  RECRUITER_CREATES_JD: ['jd_requirements', 'employer_readiness', 'bias_audit'],
  CANDIDATE_APPLIES:    ['capability_intelligence', 'jd_requirements', 'inclusive_matching', 'explainability'],
  ASSESSMENT_COMPLETED: ['capability_intelligence', 'jd_requirements', 'inclusive_matching', 'career_roadmap', 'bias_audit', 'explainability'],
  FULL_ORCHESTRATION:   ['capability_intelligence', 'jd_requirements', 'employer_readiness', 'inclusive_matching', 'career_roadmap', 'bias_audit', 'explainability'],
};

/* ------------------------------------------------------------------ RUN ENGINE */
export async function runOrchestration({
  candidate, requisition, runId, trigger = 'FULL_ORCHESTRATION', useAI = true,
}) {
  const wanted = new Set(TRIGGERS[trigger] || TRIGGERS.FULL_ORCHESTRATION);
  const steps = [];
  const audit = [];
  const t0 = Date.now();
  const ai = providerStatus();

  // Without a target role there is nothing to model, audit or match against, so
  // those steps are dropped rather than run on missing inputs.
  const NEEDS_REQUISITION = ['jd_requirements', 'employer_readiness', 'inclusive_matching', 'career_roadmap'];
  if (!requisition) for (const k of NEEDS_REQUISITION) wanted.delete(k);

  /** Every step declares what it needs; a missing dependency skips it, never crashes. */
  const DEPENDS_ON = {
    employer_readiness: ['market'],
    inclusive_matching: ['discovery', 'market'],
    career_roadmap: ['discovery', 'matching'],
    bias_audit: ['discovery'],
    explainability: ['discovery'],
  };

  const skip = (key, reason) => {
    const m = manifestFor(key);
    steps.push({ key, agent: m.name, kind: m.kind, handbookRole: m.handbookRole,
      order: m.order, status: 'SKIPPED', ms: 0, reason });
    return null;
  };

  const exec = async (key, fn, fullCtx) => {
    if (!wanted.has(key)) {
      return skip(key, requisition
        ? `Not required by trigger ${trigger}. The orchestrator runs the minimum pipeline for each operation.`
        : 'No target role was supplied, so there is nothing for this step to work against.');
    }
    const missing = (DEPENDS_ON[key] || []).filter(d => !fullCtx[d]);
    if (missing.length) {
      return skip(key, `Upstream output missing (${missing.join(', ')}). The orchestrator skips a step rather than running it on incomplete inputs.`);
    }
    const { payload, withheld, manifest } = scope(key, fullCtx);
    const started = Date.now();
    let output = null, status = 'SUCCESS', error = null;
    try { output = await fn(payload); }
    catch (e) { status = 'FAILED'; error = e.message; }
    const ms = Date.now() - started;

    const validation = validate(key, output);
    if (status !== 'FAILED' && !validation.ok) status = 'REJECTED';

    steps.push({
      key, agent: manifest.name, kind: manifest.kind, handbookRole: manifest.handbookRole,
      order: manifest.order, status, ms, error,
      responsibility: manifest.responsibility,
      inputsGranted: Object.keys(payload),
      inputsWithheld: withheld,
      decisionBoundary: manifest.decisionBoundary,
      humanOversight: manifest.humanOversight,
      validation, output,
    });
    audit.push({
      ts: new Date().toISOString(), runId, actor: `${manifest.kind}:${key}`, action: 'PIPELINE_STEP',
      inputHash: hash(payload), outputHash: output ? hash(output) : null,
      modelVersion: MODEL_VERSION, aiProvider: ai.provider, status, durationMs: ms,
      withheldInputs: withheld.length,
      note: `${manifest.name} invoked by the orchestrator. Direct agent-to-agent calls are not possible.`,
    });
    return output;
  };

  const ctx = { candidate, requisition };

  /* --- 1. Capability Intelligence Agent (deterministic + LLM interpretation) --- */
  ctx.discovery = await exec('capability_intelligence', async p => {
    const det = computeCapability(p.candidate);
    det.interpretation = useAI
      ? await capabilityIntelligenceAgent({ candidate: p.candidate, evidence: p.candidate.evidence, deterministic: det })
      : { source: 'deterministic-only' };
    return det;
  }, ctx);

  /* --- 2. JD Requirement Extraction (service) --- */
  ctx.market = await exec('jd_requirements', async p => {
    const det = computeRoleModel(p.requisition);
    det.extraction = useAI
      ? await extractJdRequirements({ text: p.requisition.text, deterministicModel: det.roleCompetencyModel })
      : { source: 'deterministic-only' };
    return det;
  }, ctx);

  /* --- 3. Employer Readiness (service) --- */
  ctx.employer = await exec('employer_readiness',
    async p => computeEmployerReadiness(p.requisition, p.market), ctx);

  /* --- 4. Inclusive Matching Agent --- */
  ctx.matching = await exec('inclusive_matching', async p => {
    const det = computeMatch(p.discovery, p.market);
    det.interpretation = useAI
      ? await interpretMatch({ matching: det, deterministic: p.discovery, requisition })
      : { source: 'deterministic-only' };
    return det;
  }, ctx);

  /* --- 5. Career Roadmap Agent --- */
  ctx.learning = await exec('career_roadmap', async p => {
    const det = computeRoadmap(p.gaps, p.discovery);
    det.pathway = useAI
      ? await careerRoadmapAgent({ deterministic: p.discovery, gaps: p.gaps, learning: det, targetRole: requisition?.title })
      : { source: 'deterministic-only' };
    return det;
  }, ctx);

  /* --- 6. Bias Audit (service) --- */
  ctx.bias = await exec('bias_audit', async p => computeBiasAudit({
    candidate: p.all.candidate, discovery: p.all.discovery, market: p.all.market,
    matching: p.all.matching, employer: p.all.employer,
  }), ctx);

  /* --- 7. Explainability Agent --- */
  ctx.explainability = await exec('explainability', async p => {
    if (!p.all.matching) {
      // Evidence-only run: explain the capability picture, with no role to match against.
      return {
        service: 'Explainability Service', modelVersion: MODEL_VERSION,
        strengths: p.all.discovery.skills.filter(s => s.confidence >= 0.6).slice(0, 5).map(s => ({
          claim: `${s.name} — ${s.level.toLowerCase()} capability`,
          confidence: s.confidence,
          grounding: s.mentions.slice(0, 2).map(m => `${m.verificationLabel}: ${m.evidenceTitle}`),
        })),
        improvements: [],
        dimensions: Object.entries(p.all.discovery.dimensions).map(([k, d]) => ({ dimension: k, ...d })),
        limitations: ['No target role was supplied, so no gap analysis was produced.'],
        rule: 'Any insight that cannot be resolved to at least one evidence item is discarded rather than displayed.',
      };
    }
    const det = computeExplainability(p.all.discovery, p.all.matching, p.all.market);
    det.narrative = useAI
      ? await explainabilityAgent({ deterministic: p.all.discovery, matching: p.all.matching, requisition })
      : { source: 'deterministic-only' };
    return det;
  }, ctx);

  const blocked = ctx.bias?.blocksDisplay;
  audit.push({
    ts: new Date().toISOString(), runId, actor: 'orchestrator', action: 'HUMAN_GATE_OPENED',
    status: 'AWAITING_HUMAN_DECISION', modelVersion: MODEL_VERSION,
    note: 'Pipeline complete. No hiring outcome exists. The run is held at the mandatory human gate until a recruiter records a decision.',
  });

  return {
    runId, trigger, startedAt: new Date(t0).toISOString(), totalMs: Date.now() - t0,
    ai: { provider: ai.provider, mode: ai.mode, note: ai.note },
    candidate: { id: candidate.id, name: candidate.name, headline: candidate.headline, context: candidate.context },
    requisition: requisition ? {
      id: requisition.id, title: requisition.title, company: requisition.company,
      location: requisition.location, text: requisition.text,
    } : null,
    steps: steps.sort((a, b) => a.order - b.order),
    audit,
    status: blocked ? 'BLOCKED_PENDING_INTEGRITY_REVIEW' : 'AWAITING_HUMAN_DECISION',
    decision: null,
    result: safeResult(ctx),
  };
}

/**
 * A skipped step returns nothing. Rather than push null-handling into every
 * consumer, the orchestrator returns an explicit "not run" shape with the same
 * fields — so a partial run renders as an empty state, never as a crash.
 */
function safeResult(ctx) {
  return {
    discovery: ctx.discovery || null,
    market: ctx.market || {
      notRun: true, agent: 'JD Requirement Extraction',
      roleCompetencyModel: { competencies: [], mandatoryCount: 0, preferredCount: 0, marketDemandIndex: 0, statedYears: null, version: 0 },
      highestDemandSkills: [], note: 'Not run — no target role was supplied for this operation.',
    },
    employer: ctx.employer || {
      notRun: true, findings: [], inclusionScore: null, inclusionTier: 'Not assessed',
      skillClarity: 'Not assessed', humanAction: 'NONE',
      estimatedPoolImpact: 'Not run — this operation did not involve a requisition.',
    },
    matching: ctx.matching || {
      notRun: true, skillsFirstScore: 0, potentialAdjusted: 0, growthUplift: 0,
      matchTier: 'Not assessed', breakdown: [], gaps: [], inputsExcluded: PROHIBITED_INPUTS,
      humanGate: true, recommendation: 'NONE',
      disclosure: 'No target role was supplied, so no match was computed.',
    },
    learning: ctx.learning || {
      notRun: true, objectives: [], totalHours: 0, verifiedResourceCount: 0,
      integrationModel: 'LINK_REDIRECTION',
      integrationNotice: 'Not run — a learning pathway is generated from a skill gap against a target role.',
    },
    bias: ctx.bias || {
      notRun: true, signals: [], signalCount: 0, highestSeverity: 'None', blocksDisplay: false,
      assurance: 'Not run for this operation. The Bias Audit service cannot modify any score, ranking or recommendation.',
    },
    explainability: ctx.explainability || {
      notRun: true, strengths: [], improvements: [], dimensions: [], limitations: [],
      rule: 'Any insight that cannot be resolved to at least one evidence item is discarded rather than displayed.',
    },
  };
}

/* ---------------------------------------------------------------- VALIDATION */
function validate(key, out) {
  if (!out) return { ok: false, checks: [{ name: 'output_present', pass: false }] };
  const checks = [];
  const c = (name, pass, detail) => checks.push({ name, pass, detail });

  c('schema_present', typeof out === 'object');
  c('model_version_recorded', Boolean(out.modelVersion || out.service));

  if (key === 'capability_intelligence') {
    c('every_capability_has_evidence', out.skills.every(s => s.mentions?.length > 0),
      'A capability with no resolvable evidence reference is discarded, never displayed.');
    c('sparse_dimensions_not_scored_low',
      Object.values(out.dimensions).every(d => d.value !== null || d.tier === 'Insufficient Data'));
    c('llm_did_not_emit_scores',
      !out.interpretation || !JSON.stringify(out.interpretation).match(/"(score|matchScore|ranking)"\s*:/),
      'The LLM layer adds interpretation only; any numeric field it emits is dropped.');
  }
  if (key === 'inclusive_matching') {
    const hay = JSON.stringify(out.breakdown).toLowerCase();
    c('no_prohibited_inputs',
      !PROHIBITED_INPUTS.some(p => new RegExp(`(^|[^a-z])${p}([^a-z]|$)`).test(hay)),
      'Institution, continuity, gap duration, gender, age and location were not available to this agent.');
    c('human_gate_required', out.humanGate === true,
      'The match result carries no authority until a human decision is recorded.');
    c('uplift_capped', out.growthUplift <= 0.10, 'Growth uplift is capped at +0.10 and can never reduce a score.');
  }
  if (key === 'career_roadmap') {
    c('no_fabricated_completion', out.objectives.every(o => o.resources.every(r => r.completionNotice)),
      'No learning provider completion is asserted without a verified integration.');
    c('providers_are_registered', out.objectives.every(o => o.resources.every(r => r.providerName)));
  }
  if (key === 'bias_audit') {
    c('read_only', Boolean(out.assurance), 'Bias Audit holds no write access to any other artefact.');
    c('signals_have_evidence', out.signals.every(s => s.evidence && s.reason && s.recommendedReview));
    // Substance, not phrasing: no signal may claim bias is proven, and every one
    // must hand a human something to review.
    const PROOF_CLAIMS = /\b(proven|proves|proof of bias|confirmed bias|is biased|definitely|certainly)\b/i;
    c('signals_are_not_proof',
      out.signals.every(s => !PROOF_CLAIMS.test(`${s.signal} ${s.reason} ${s.evidence}`))
      && out.signals.every(s => Boolean(s.recommendedReview)),
      'Signals are reported as potential indicators requiring human review, never as proven bias.');
  }
  if (key === 'employer_readiness') {
    c('does_not_filter_candidates', out.humanAction !== 'AUTO_REJECT',
      'Findings are reported to the employer; they are never applied against candidates.');
  }
  if (key === 'explainability') {
    c('insights_are_grounded', out.strengths.every(s => s.grounding?.length > 0),
      'An insight that cannot be resolved to at least one evidence item is discarded.');
  }
  return { ok: checks.every(x => x.pass), checks };
}
