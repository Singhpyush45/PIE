// PIE — the six specialist agents + the cross-cutting Explainability service.
// Every agent is deterministic and evidence-grounded. The LLM (OpenAI, Gemini,
// when configured) only *narrates* what these functions have already computed — it never
// produces a score. That is what makes the demo safe to run with no network.

import {
  ONTOLOGY, SKILL_BY_ID, LEARNING_RESOURCES, LEARNING_PROVIDERS,
  TRUST_TIER, SOURCE_TIER_CAP, PROHIBITED_INPUTS,
} from './data.js';

const MODEL_VERSION = 'pie-deterministic-1.3.0';
const NOW = new Date('2026-08-29');

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const round2 = n => Math.round(n * 100) / 100;

function monthsAgo(dateStr) {
  if (!dateStr) return 36;
  const [y, m] = dateStr.split('-').map(Number);
  return Math.max(0, (NOW.getFullYear() - y) * 12 + (NOW.getMonth() + 1 - (m || 1)));
}
// Recency decay: 1.0 fresh, ~0.72 at 3 years. Deliberately gentle — a break in
// employment must not become a hidden penalty on older but real evidence.
const recency = d => clamp(1 - monthsAgo(d) * 0.008, 0.62, 1);

function tierFor(v) {
  if (v === null || v === undefined) return 'Insufficient Data';
  if (v >= 0.75) return 'Strong';
  if (v >= 0.55) return 'Moderate';
  if (v >= 0.35) return 'Developing';
  return 'Emerging';
}
function potentialTier(v) {
  if (v >= 0.72) return 'High';
  if (v >= 0.52) return 'Moderate';
  return 'Developing';
}

/* ==================================================================
   AGENT 1 — SKILLS DISCOVERY
   Discovers and validates candidate skills across all evidence sources.
   ================================================================== */
export function skillsDiscoveryAgent(candidate) {
  const text = e => `${e.title || ''} ${e.text || ''}`.toLowerCase();
  const mentionsBySkill = {};

  for (const ev of candidate.evidence) {
    const hay = text(ev);
    for (const skill of ONTOLOGY) {
      const hit = skill.aliases.find(a => {
        const re = new RegExp(`(^|[^a-z0-9+#.])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`, 'i');
        return re.test(hay);
      });
      if (!hit) continue;
      const tier = TRUST_TIER[ev.verification];
      const cap = SOURCE_TIER_CAP[ev.source] ?? 0.5;
      const strength = clamp(Math.min(tier.weight, cap) * recency(ev.date));
      (mentionsBySkill[skill.id] ||= []).push({
        evidenceId: ev.id, evidenceTitle: ev.title, source: ev.source,
        verification: ev.verification, verificationLabel: tier.label,
        matchedTerm: hit, strength: round2(strength),
      });
    }
  }

  // Confidence: the strongest independent source sets the base; each further
  // independent source adds a progressively discounted increment. Repeating the same
  // claim inside one source adds nothing, and confidence is capped below certainty —
  // PIE never asserts that it knows a person's capability exactly.
  const skills = Object.entries(mentionsBySkill).map(([id, mentions]) => {
    const bySource = {};
    for (const m of mentions) bySource[m.source] = Math.max(bySource[m.source] || 0, m.strength);
    const ranked = Object.values(bySource).sort((a, b) => b - a);
    let acc = 0;
    ranked.forEach((s, i) => { acc += (1 - acc) * s * Math.pow(0.45, i); });
    const confidence = clamp(acc, 0, 0.92);
    const sources = [...new Set(mentions.map(m => m.source))];
    const corroborated = sources.length > 1;
    const s = SKILL_BY_ID[id];
    return {
      id, name: s.name, category: s.category,
      confidence: round2(confidence),
      level: tierFor(confidence),
      corroborated, sourceCount: sources.length, sources,
      mentions: mentions.sort((a, b) => b.strength - a.strength),
      conflict: false,
    };
  }).sort((a, b) => b.confidence - a.confidence);

  const dimensions = computeDimensions(candidate, skills);
  const potentialRaw = clamp(
    0.30 * (dimensions.technical.value ?? 0.4) +
    0.22 * (dimensions.learning.value ?? 0.4) +
    0.18 * (dimensions.problemSolving.value ?? 0.4) +
    0.12 * (dimensions.communication.value ?? 0.4) +
    0.18 * (dimensions.consistency.value ?? 0.4)
  );
  const growthRaw = clamp(
    0.58 * (dimensions.learning.value ?? 0.4) + 0.42 * (dimensions.consistency.value ?? 0.4)
  );

  return {
    agent: 'Skills Discovery Agent', modelVersion: MODEL_VERSION,
    profileVersion: `uep-${candidate.id}-${Date.now().toString(36)}`,
    evidenceCount: candidate.evidence.length,
    evidenceBySource: candidate.evidence.reduce((a, e) => (a[e.source] = (a[e.source] || 0) + 1, a), {}),
    skills, dimensions,
    potential: { value: round2(potentialRaw), tier: potentialTier(potentialRaw) },
    growthReadiness: { value: round2(growthRaw), tier: potentialTier(growthRaw) },
    excludedInputs: candidate.protectedContext || [],
  };
}

function computeDimensions(candidate, skills) {
  const ev = candidate.evidence;
  const byS = s => ev.filter(e => e.source === s);
  const dim = (value, refs, rationale, minEvidence = 1, have = 1) => {
    if (have < minEvidence) {
      return { value: null, tier: 'Insufficient Data', confidence: 0.2,
        evidenceRefs: refs, rationale: `${rationale} Below the minimum evidence threshold, so this dimension is reported as Insufficient Data rather than scored low.` };
    }
    // Ceiling of 0.93: PIE never reports near-certainty about a person's capability.
    value = clamp(value, 0, 0.93);
    return { value: round2(value), tier: tierFor(value),
      confidence: round2(clamp(0.45 + 0.12 * have)), evidenceRefs: refs, rationale };
  };

  // --- Technical Evidence: artefact-backed skills only
  const techCats = ['Programming', 'Data', 'Quality', 'Engineering', 'Backend', 'Frontend'];
  const techSkills = skills.filter(s => techCats.includes(s.category));
  const artefactBacked = techSkills.filter(s => s.sources.some(x => ['github', 'assessment', 'project'].includes(x)));
  const techTop = techSkills.slice(0, 6);
  const techVal = techTop.length
    ? techTop.reduce((a, s) => a + s.confidence, 0) / techTop.length * (artefactBacked.length ? 1 : 0.72)
    : 0;
  const technical = dim(techVal,
    artefactBacked.slice(0, 4).map(s => s.mentions[0].evidenceId),
    `Computed from ${techSkills.length} technical skills, ${artefactBacked.length} of them backed by repository, project or assessment artefacts rather than claims.`,
    1, techSkills.length);

  // --- Learning Ability: sequenced acquisition over time + breadth of new adoption
  const learningEv = [...byS('certificate'), ...byS('nontraditional')];
  const dated = learningEv.filter(e => e.date).map(e => monthsAgo(e.date)).sort((a, b) => b - a);
  const span = dated.length > 1 ? dated[0] - dated[dated.length - 1] : 0;
  const sequenced = dated.length > 1 && span >= 6;   // spread out, not crammed
  const newCats = new Set(skills.filter(s => s.sources.includes('certificate')).map(s => s.category));
  const learnVal = clamp(0.30 + 0.10 * Math.min(learningEv.length, 5) + (sequenced ? 0.14 : 0) + 0.06 * newCats.size);
  const learning = dim(learnVal, learningEv.slice(0, 4).map(e => e.id),
    `${learningEv.length} self-directed learning artefacts across ${newCats.size} skill categories, spread over ${span} months${sequenced ? ' — a sequenced pattern, not a single burst' : ''}.`,
    1, learningEv.length);

  // --- Problem Solving: evidence-gated. Never inferred from resume text.
  const psEvidence = ev.filter(e =>
    e.source === 'assessment' ||
    (['project', 'github'].includes(e.source) && /(built|designed|implemented|harness|suite|rewrote|resolution|optimis|validat|reconcil)/i.test(e.text || '')));
  const psVal = clamp(0.34 + 0.13 * psEvidence.length + (ev.some(e => e.source === 'assessment') ? 0.14 : 0));
  const problemSolving = dim(psVal, psEvidence.slice(0, 3).map(e => e.id),
    `Gated on ${psEvidence.length} artefact(s) showing a documented technical approach. Resume keyword presence alone is never accepted as evidence for this dimension.`,
    1, psEvidence.length);

  // --- Communication: text artefacts only. No audio, no video, no accent signal.
  const gh = byS('github');
  const highReadme = gh.filter(e => e.metrics?.readme_quality === 'high').length;
  const docSignals = ev.filter(e => /(readme|documentation|methodology|test strategy|documented|wrote)/i.test(`${e.title} ${e.text}`)).length;
  const commVal = clamp(0.34 + 0.11 * highReadme + 0.07 * Math.min(docSignals, 4));
  const communication = dim(commVal, gh.slice(0, 2).map(e => e.id),
    `Derived only from candidate-authored text artefacts: ${highReadme} repository README(s) rated high quality and ${docSignals} documentation signal(s). No audio, video or accent signal is used, and non-native English phrasing carries no penalty.`,
    1, highReadme + docSignals);

  // --- Consistency: sustained effort, measured over a rolling window
  const commits = gh.reduce((a, e) => a + (e.metrics?.commits || 0), 0);
  const active = gh.reduce((a, e) => Math.max(a, e.metrics?.months_active || 0), 0);
  const cadence = active ? commits / active : 0;                 // commits per active month
  const spread = new Set(ev.filter(e => e.date).map(e => e.date.slice(0, 4))).size;
  const consVal = clamp(0.24 + clamp(cadence / 12) * 0.42 + 0.09 * Math.min(spread, 4));
  const consistency = dim(consVal, gh.map(e => e.id),
    `${commits} commits across ${active} active months (${cadence.toFixed(1)}/month) with evidence spanning ${spread} calendar years. Measured as sustained cadence, not a single pre-application burst.`,
    1, gh.length);

  return { technical, learning, problemSolving, communication, consistency };
}

/* ==================================================================
   AGENT 2 — MARKET INTELLIGENCE
   Job description + market signal -> weighted Role Competency Model.
   ================================================================== */
export function marketIntelligenceAgent(requisition) {
  const raw = requisition.text;
  const lower = raw.toLowerCase();

  const sliceBetween = (startRe, endRes) => {
    const s = lower.search(startRe);
    if (s < 0) return '';
    let e = lower.length;
    for (const r of endRes) {
      const i = lower.slice(s + 5).search(r);
      if (i >= 0) e = Math.min(e, s + 5 + i);
    }
    return lower.slice(s, e);
  };
  const requiredBlock  = sliceBetween(/required:/, [/preferred:/, /candidate requirements:/, /we evaluate/]);
  const preferredBlock = sliceBetween(/preferred:/, [/candidate requirements:/, /we evaluate/]);

  const find = block => ONTOLOGY.filter(s => s.aliases.some(a =>
    new RegExp(`(^|[^a-z0-9+#.])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`, 'i').test(block)));

  const req = find(requiredBlock);
  const pref = find(preferredBlock).filter(s => !req.some(r => r.id === s.id));

  const competencies = [
    ...req.map(s => ({ id: s.id, name: s.name, category: s.category, mandatory: true,
      requiredLevel: 0.70, weight: 1.0, marketDemand: s.demand })),
    ...pref.map(s => ({ id: s.id, name: s.name, category: s.category, mandatory: false,
      requiredLevel: 0.50, weight: 0.4, marketDemand: s.demand })),
  ];

  const seniorityMatch = raw.match(/(\d+)\+?\s*years?/i);
  const demandIndex = competencies.length
    ? round2(competencies.reduce((a, c) => a + c.marketDemand * c.weight, 0) /
             competencies.reduce((a, c) => a + c.weight, 0)) : 0;

  return {
    agent: 'Market Intelligence Agent', modelVersion: MODEL_VERSION,
    requisitionId: requisition.id, title: requisition.title,
    roleCompetencyModel: {
      version: 1, competencies,
      mandatoryCount: req.length, preferredCount: pref.length,
      statedYears: seniorityMatch ? Number(seniorityMatch[1]) : null,
      marketDemandIndex: demandIndex,
    },
    highestDemandSkills: [...competencies].sort((a, b) => b.marketDemand - a.marketDemand).slice(0, 4)
      .map(c => ({ name: c.name, demand: c.marketDemand })),
    note: 'Market demand indices are illustrative reference values held in the PIE skill ontology, not a live market data feed.',
  };
}

/* ==================================================================
   AGENT 5 — EMPLOYER READINESS  (runs before matching: audits the ROLE)
   ================================================================== */
const EXCLUSION_RULES = [
  { id: 'ER-GAP', re: /no career gaps?|continuous (industry )?experience|uninterrupted (employment|experience)/i,
    severity: 'High', barrier: 'Continuity bias (F3)',
    finding: 'The requisition requires continuous experience with no career gaps.',
    impact: 'Removes carers, people returning after medical or family leave, and career changers — disproportionately women — before capability is ever assessed.',
    suggestion: 'Replace with a demonstrable-capability requirement, e.g. “Able to demonstrate current capability in Python test automation, by any evidence route.”' },
  { id: 'ER-TIER', re: /tier[- ]?1 institution|iit|nit|premier institute|top[- ]tier (college|university)/i,
    severity: 'High', barrier: 'Pedigree bias (F2)',
    finding: 'The requisition names institution tier as a preference.',
    impact: 'Institution tier measures prior access, not capability, and excludes first-generation and tier-2/3 candidates.',
    suggestion: 'Remove the institution clause. If the underlying need is fundamentals, state the fundamentals and assess them directly.' },
  { id: 'ER-AGE', re: /digital native|young,? high[- ]energy|recent graduates? only|energetic young/i,
    severity: 'High', barrier: 'Age proxy',
    finding: 'The requisition contains age-proxy language (“digital native”, “young, high-energy team”).',
    impact: 'Signals an age preference and deters older and returning candidates; carries legal risk in several jurisdictions.',
    suggestion: 'Describe the working style you actually mean, e.g. “comfortable adopting new tooling quickly”.' },
  { id: 'ER-LANG', re: /native[- ](level )?english|native speaker|mother[- ]tongue english/i,
    severity: 'Medium', barrier: 'Language proxy',
    finding: 'The requisition requires native-level English.',
    impact: 'Filters on accent and first language rather than on the communication the role needs.',
    suggestion: 'State the actual requirement, e.g. “Able to write clear technical documentation and defect reports in English.”' },
  { id: 'ER-RELOC', re: /relocate .{0,20}immediately|must relocate|on[- ]?site only/i,
    severity: 'Medium', barrier: 'Geographic exclusion',
    finding: 'The requisition mandates immediate relocation.',
    impact: 'Excludes candidates with caregiving responsibilities and candidates in tier-2/3 cities, even where the work is remote-capable.',
    suggestion: 'State whether the role is genuinely location-bound; if not, offer remote or hybrid with a defined onsite cadence.' },
  { id: 'ER-YEARS', re: /(\d+)\+?\s*years?/i, severity: 'Medium', barrier: 'Experience-duration proxy',
    finding: 'The requisition sets a minimum years-of-experience bar.',
    impact: 'Years of employment is a weak proxy for capability and systematically penalises anyone whose skill was acquired outside formal employment.',
    suggestion: 'Keep the years figure as guidance, but add an explicit equivalence route: “or demonstrable equivalent capability by portfolio or assessment.”',
    onlyIf: m => Number(m[1]) >= 4 },
];

export function employerReadinessAgent(requisition, rcm) {
  const findings = [];
  for (const rule of EXCLUSION_RULES) {
    const m = requisition.text.match(rule.re);
    if (!m) continue;
    if (rule.onlyIf && !rule.onlyIf(m)) continue;
    findings.push({
      id: rule.id, severity: rule.severity, barrier: rule.barrier,
      finding: rule.finding, matchedText: m[0].trim(),
      impact: rule.impact, suggestion: rule.suggestion,
    });
  }
  const penalty = findings.reduce((a, f) => a + (f.severity === 'High' ? 0.18 : 0.09), 0);
  const inclusionScore = round2(clamp(1 - penalty));
  const clarity = rcm.roleCompetencyModel.mandatoryCount >= 3 ? 'Clear' : 'Under-specified';

  return {
    agent: 'Employer Readiness Agent', modelVersion: MODEL_VERSION,
    requisitionId: requisition.id,
    inclusionScore, inclusionTier: inclusionScore >= 0.8 ? 'Inclusive'
      : inclusionScore >= 0.55 ? 'Needs Review' : 'Exclusionary',
    skillClarity: clarity,
    findings,
    estimatedPoolImpact: findings.length
      ? `${findings.filter(f => f.severity === 'High').length} high-severity barrier(s) remove candidates before any capability is assessed. PIE matches on the skills block only — the clauses above are reported to the employer, never applied to candidates.`
      : 'No exclusionary clauses detected. The requisition is evaluated on its stated skills.',
    humanAction: findings.length ? 'RECRUITER_REVIEW_RECOMMENDED' : 'NONE',
  };
}

/* ==================================================================
   AGENT 3 — INCLUSIVE MATCHING
   ================================================================== */
export function inclusiveMatchingAgent(discovery, market) {
  const byId = Object.fromEntries(discovery.skills.map(s => [s.id, s]));
  const comps = market.roleCompetencyModel.competencies;

  const breakdown = comps.map(c => {
    const held = byId[c.id];
    const confidence = held ? held.confidence : 0;
    const coverage = clamp(confidence / c.requiredLevel);
    return {
      skillId: c.id, name: c.name, mandatory: c.mandatory,
      requiredLevel: c.requiredLevel, weight: c.weight,
      candidateConfidence: confidence, coverage: round2(coverage),
      status: coverage >= 0.95 ? 'Strong' : coverage >= 0.55 ? 'Partial' : held ? 'Weak' : 'Missing',
      corroborated: held ? held.corroborated : false,
      evidence: held ? held.mentions.slice(0, 2).map(m => ({ id: m.evidenceId, title: m.evidenceTitle, verification: m.verificationLabel })) : [],
    };
  });

  const wsum = comps.reduce((a, c) => a + c.weight, 0) || 1;
  const skillsFirstScore = round2(breakdown.reduce((a, b) => a + b.weight * b.coverage, 0) / wsum);

  // Potential-adjusted score: an explicit, disclosed uplift for candidates who are
  // close and demonstrably moving. It NEVER lowers a score and is always shown separately.
  const gr = discovery.growthReadiness.value;
  const nearMiss = breakdown.filter(b => b.mandatory && b.coverage >= 0.45 && b.coverage < 0.95).length;
  const uplift = round2(clamp(gr * 0.10 * Math.min(nearMiss, 3) / 3, 0, 0.10));
  const potentialAdjusted = round2(clamp(skillsFirstScore + uplift));

  const gaps = breakdown
    .filter(b => b.coverage < 0.95)
    .map(b => ({
      skillId: b.skillId, name: b.name, mandatory: b.mandatory,
      currentConfidence: b.candidateConfidence, requiredLevel: b.requiredLevel,
      category: b.status === 'Missing' ? 'Missing' : 'Weak',
      severity: round2(b.weight * (1 - b.coverage)),
    }))
    .sort((a, b) => b.severity - a.severity);

  return {
    agent: 'Inclusive Matching Agent', modelVersion: MODEL_VERSION,
    skillsFirstScore, potentialAdjusted, growthUplift: uplift,
    matchTier: potentialAdjusted >= 0.75 ? 'Strong Match'
      : potentialAdjusted >= 0.55 ? 'Developing Match' : 'Early Match',
    breakdown, gaps,
    inputsExcluded: PROHIBITED_INPUTS,
    disclosure: `Matching used only the ${comps.length} skills in the Role Competency Model, each weighted by whether the requisition marked it mandatory or preferred. Institution, employment continuity, gap duration, gender, age and location were not available to this agent.`,
    recommendation: 'REVIEW_RECOMMENDED',
    humanGate: true,
  };
}

/* ==================================================================
   AGENT 4 — LEARNING PATHWAY
   ================================================================== */
const PREREQ = { dataquality: ['sql'], cicd: ['git'], docker: ['cicd'] };

export function learningPathwayAgent(gaps, discovery) {
  const held = Object.fromEntries(discovery.skills.map(s => [s.id, s.confidence]));
  const objectives = [];

  for (const gap of gaps) {
    const resources = LEARNING_RESOURCES.filter(r => r.skill === gap.skillId);
    if (!resources.length) continue;
    const unmetPrereqs = (PREREQ[gap.skillId] || []).filter(p => (held[p] || 0) < 0.5);
    objectives.push({
      objectiveId: `obj-${gap.skillId}`,
      skillId: gap.skillId, skill: gap.name,
      from: gap.currentConfidence, to: gap.requiredLevel,
      priority: gap.mandatory ? 'Mandatory-skill gap' : 'Preferred-skill gap',
      severity: gap.severity,
      tier: gap.currentConfidence < 0.2 ? 'Beginner' : gap.currentConfidence < 0.5 ? 'Intermediate' : 'Advanced',
      prerequisites: unmetPrereqs.map(p => SKILL_BY_ID[p].name),
      estimatedHours: resources.reduce((a, r) => a + r.hours, 0),
      resources: resources.map(r => ({
        ...r,
        providerName: LEARNING_PROVIDERS[r.provider].name,
        providerSource: LEARNING_PROVIDERS[r.provider].source,
        verification_status: LEARNING_PROVIDERS[r.provider].verification_status,
        completion_verification: LEARNING_PROVIDERS[r.provider].completion_verification,
        completionNotice: LEARNING_PROVIDERS[r.provider].completion_verification === 'NOT_AVAILABLE'
          ? 'External learning resource — completion cannot be verified by PIE; it rests on candidate-provided evidence.'
          : LEARNING_PROVIDERS[r.provider].completion_verification === 'PIE_REASSESSMENT'
            ? 'Completion is verified by PIE reassessment and produces new skill evidence.'
            : 'Candidate-declared completion only; recorded at the lowest evidence trust tier.',
      })),
      milestone: `Reassessment on ${gap.name}: raise confidence from ${gap.currentConfidence.toFixed(2)} to ${gap.requiredLevel.toFixed(2)}.`,
    });
  }

  // Prerequisite-respecting order, then severity.
  objectives.sort((a, b) => (a.prerequisites.length - b.prerequisites.length) || (b.severity - a.severity));
  objectives.forEach((o, i) => { o.sequence = i + 1; });

  return {
    agent: 'Learning Pathway Agent', modelVersion: MODEL_VERSION,
    objectives,
    totalHours: objectives.reduce((a, o) => a + o.estimatedHours, 0),
    // How much of the pathway PIE can actually verify, as opposed to link out to.
    verifiedResourceCount: objectives.reduce((a, o) => a + o.resources.filter(r => r.provider === 'PIE_PRACTICE').length, 0),
    integrationModel: 'LINK_REDIRECTION',
    integrationNotice: 'PIE routes the candidate to external learning resources by link. It does not own their account with any provider and claims no automated enrolment or completion API. Only a PIE practice task ends in a reassessment, which is the one completion PIE can actually verify.',
  };
}

/* ==================================================================
   AGENT 6 — BIAS AUDIT   (reports; never silently modifies results)
   ================================================================== */
export function biasAuditAgent({ candidate, discovery, market, matching, employer }) {
  const signals = [];
  const add = (s) => signals.push({ ...s, auditId: `BA-${signals.length + 1}` });

  // 1. Prohibited-input verification
  const leaked = (candidate.protectedContext || []).filter(p =>
    JSON.stringify(matching.breakdown).toLowerCase().includes(p.toLowerCase()));
  add({
    signal: leaked.length ? 'Prohibited input reached the matching stage' : 'Prohibited inputs correctly excluded',
    severity: leaked.length ? 'High' : 'None',
    evidence: leaked.length
      ? `Detected: ${leaked.join(', ')}`
      : `${(candidate.protectedContext || []).length} protected context attribute(s) held on this candidate — ${(candidate.protectedContext || []).join(', ') || 'none'} — none of which appear in any matching input.`,
    confidence: 0.95,
    reason: 'The matching agent receives only the Role Competency Model and the candidate skill-confidence map. Protected context is stored for transparency and accommodation, and is never passed downstream.',
    recommendedReview: leaked.length ? 'BLOCK — escalate to Trust & Integrity Administrator' : 'None required',
  });

  // 2. Evidence sparsity — is a low score actually low data?
  const sparse = Object.entries(discovery.dimensions).filter(([, d]) => d.tier === 'Insufficient Data');
  const selfOnly = discovery.skills.filter(s => s.sources.every(x => ['resume', 'nontraditional', 'project'].includes(x)));
  if (sparse.length || selfOnly.length >= 3) {
    add({
      signal: 'Evidence sparsity may depress capability signal',
      severity: sparse.length ? 'Medium' : 'Low',
      evidence: `${sparse.length} dimension(s) reported as Insufficient Data. ${selfOnly.length} skill(s) rest only on self-reported evidence: ${selfOnly.slice(0, 4).map(s => s.name).join(', ') || '—'}.`,
      confidence: 0.78,
      reason: 'A candidate whose capability was built outside formal employment will have thinner verifiable evidence. Low confidence here reflects verification availability, not capability. Reading it as low capability is the exact bias PIE exists to prevent.',
      recommendedReview: 'Recruiter should read confidence as evidence availability, not as ability. Consider inviting a targeted reassessment before any negative decision.',
    });
  }

  // 3. Role-side barriers carried in from the Employer Readiness Agent
  if (employer.findings.length) {
    add({
      signal: 'Requisition contains exclusionary criteria',
      severity: employer.findings.some(f => f.severity === 'High') ? 'High' : 'Medium',
      evidence: employer.findings.map(f => `${f.id}: “${f.matchedText}” (${f.barrier})`).join(' · '),
      confidence: 0.9,
      reason: 'Bias in this pipeline is more likely to originate in the role definition than in the candidate data. PIE did not apply these clauses when matching, but a human applying them manually would reintroduce the bias PIE removed.',
      recommendedReview: 'Recruiter must consciously decide whether each flagged clause is a genuine job requirement. Recommend requisition revision before shortlisting.',
    });
  }

  // 4. Communication-dimension fairness check
  const comm = discovery.dimensions.communication;
  if (comm.value !== null && comm.value < 0.55) {
    add({
      signal: 'Communication dimension below mid-band — fairness check',
      severity: 'Low',
      evidence: `Communication = ${comm.value} (${comm.tier}), derived from ${comm.evidenceRefs.length} text artefact(s).`,
      confidence: 0.7,
      reason: 'Communication is computed only from candidate-authored text and carries no penalty for non-native English phrasing. A moderate score here reflects how much written material the candidate has published, not their fluency.',
      recommendedReview: 'Do not treat as an English-proficiency signal.',
    });
  }

  // 5. Ranking-vs-potential divergence
  if (matching.growthUplift > 0) {
    add({
      signal: 'Potential-adjusted score diverges from skills-first score',
      severity: 'None',
      evidence: `Skills-first ${matching.skillsFirstScore} → potential-adjusted ${matching.potentialAdjusted} (uplift +${matching.growthUplift}), from Growth Readiness ${discovery.growthReadiness.value}.`,
      confidence: 0.92,
      reason: 'The uplift is disclosed rather than hidden inside a single number. It can only raise a score, is capped at +0.10, and applies only where mandatory-skill coverage is already partial — i.e. where the candidate is genuinely close.',
      recommendedReview: 'Recruiter may rank on either score; both are shown.',
    });
  }

  // 6. Single-source dominance
  const dominant = Object.entries(discovery.evidenceBySource).sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] / discovery.evidenceCount > 0.5) {
    add({
      signal: 'Single evidence source dominates the profile',
      severity: 'Low',
      evidence: `${dominant[1]} of ${discovery.evidenceCount} evidence items come from “${dominant[0]}”.`,
      confidence: 0.74,
      reason: 'Concentration in one source narrows what the capability model can see and makes the profile sensitive to that source’s own biases.',
      recommendedReview: 'Consider prompting the candidate for additional evidence types before a final decision.',
    });
  }

  const highest = signals.some(s => s.severity === 'High') ? 'High'
    : signals.some(s => s.severity === 'Medium') ? 'Medium' : 'Low';

  return {
    agent: 'Bias Audit Agent', modelVersion: MODEL_VERSION,
    signals, signalCount: signals.filter(s => s.severity !== 'None').length,
    highestSeverity: highest,
    blocksDisplay: signals.some(s => s.severity === 'High' && s.recommendedReview.startsWith('BLOCK')),
    assurance: 'This agent has read-only access to the outputs of the other agents. It cannot modify any score, ranking, skill confidence or recommendation. Its only output is this report.',
  };
}

/* ==================================================================
   EXPLAINABILITY SERVICE (cross-cutting — not an agent)
   ================================================================== */
export function explain(discovery, matching, market) {
  const strengths = discovery.skills.filter(s => s.confidence >= 0.6).slice(0, 5).map(s => ({
    claim: `${s.name} — ${s.level.toLowerCase()} capability`,
    confidence: s.confidence,
    grounding: s.mentions.slice(0, 2).map(m => `${m.verificationLabel}: ${m.evidenceTitle}`),
  }));
  const improvements = matching.gaps.slice(0, 4).map(g => ({
    claim: `${g.name} — ${g.category.toLowerCase()} against this role`,
    confidence: 0.8,
    grounding: [`Role requires ${g.requiredLevel.toFixed(2)}; current evidence supports ${g.currentConfidence.toFixed(2)}.`],
  }));
  const dims = Object.entries(discovery.dimensions).map(([k, d]) => ({
    dimension: k, value: d.value, tier: d.tier, confidence: d.confidence,
    rationale: d.rationale, evidenceRefs: d.evidenceRefs,
  }));
  const limitations = [];
  for (const [k, d] of Object.entries(discovery.dimensions)) {
    if (d.tier === 'Insufficient Data') limitations.push(`${k}: reported as Insufficient Data — not scored low.`);
  }
  if (discovery.skills.some(s => !s.corroborated))
    limitations.push(`${discovery.skills.filter(s => !s.corroborated).length} skill(s) rest on a single evidence source and are held at lower confidence.`);

  return {
    service: 'Explainability Service', modelVersion: MODEL_VERSION,
    strengths, improvements, dimensions: dims, limitations,
    rule: 'Any insight that cannot be resolved to at least one evidence item is discarded rather than displayed.',
  };
}

export { MODEL_VERSION };
