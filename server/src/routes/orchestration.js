// Orchestration routes: run the pipeline, read a run, record the human decision,
// and re-run after new evidence (the reassessment loop).

import crypto from 'node:crypto';
import * as db from '../store.js';
import {
  requireAuth, requireRole, rateLimit, str, bad, sameWorld,
  materializeCandidate, publicApp, advanceApplication,
} from '../lib.js';
import { runOrchestration, TRIGGERS } from '../orchestrator.js';
import { decisionBriefAgent, candidateOutcomeAgent } from '../ai/agents.js';

/** Runs are large; keep the last N in memory and persist a slim record. */
const RUNS = new Map();
const MAX_RUNS = 60;

function keepRun(run) {
  RUNS.set(run.runId, run);
  if (RUNS.size > MAX_RUNS) RUNS.delete(RUNS.keys().next().value);
  db.insert('agentRuns', {
    id: run.runId, trigger: run.trigger, status: run.status,
    candidateProfileId: run.candidate.id, requisitionId: run.requisition?.id || null,
    startedAt: run.startedAt, totalMs: run.totalMs,
    aiProvider: run.ai.provider, aiMode: run.ai.mode,
    stepSummary: run.steps.map(s => ({ key: s.key, status: s.status, ms: s.ms })),
  });
  if (run.result?.matching) {
    const m = run.result.matching;
    db.insert('matchResults', {
      runId: run.runId,
      candidateProfileId: run.candidate.id, requisitionId: run.requisition?.id || null,
      skillsFirstScore: m.skillsFirstScore, potentialAdjusted: m.potentialAdjusted,
      matchTier: m.matchTier, gapCount: m.gaps.length,
      confidence: run.result.discovery?.potential?.value ?? null,
    });
  }
  if (run.result?.bias) {
    const b = run.result.bias;
    db.insert('biasAudits', {
      subjectType: 'match', subjectId: run.runId,
      candidateProfileId: run.candidate.id, requisitionId: run.requisition?.id || null,
      severity: b.highestSeverity, signalCount: b.signalCount, signals: b.signals,
      status: b.highestSeverity === 'High' ? 'OPEN' : 'CLEAR',
      note: 'Potential bias signals. Indicators requiring human review — never presented as proven bias.',
    });
  }
  run.audit.forEach(a => db.audit({
    actor: a.actor, action: a.action, subjectType: 'run', subjectId: run.runId,
    note: a.note, meta: { candidateProfileId: run.candidate.id, ...a },
  }));
  return run;
}

/** Visibility: candidates see only their own runs. */
function canRead(req, run) {
  if (!run) return false;
  if (req.user.role === 'candidate') return run.candidate.id === req.user.candidateProfileId;
  if (req.user.role === 'recruiter') {
    if (!run.requisition) return true;
    const r = db.findById('requisitions', run.requisition.id);
    return !r || r.recruiterId === req.user.recruiterId;
  }
  return true;
}

export function registerOrchestrationRoutes(app) {
  app.get('/api/orchestrator/pipeline', requireAuth, (_req, res) =>
    res.json({ triggers: TRIGGERS }));

  /* ------------------------------------------------------------- run it */
  app.post('/api/orchestrate', requireAuth, rateLimit(150, 60_000), async (req, res) => {
    const trigger = str(req.body?.trigger, 40) || 'FULL_ORCHESTRATION';
    if (!TRIGGERS[trigger]) return bad(res, `Unknown trigger. One of: ${Object.keys(TRIGGERS).join(', ')}`);

    const candidateProfileId = req.user.role === 'candidate'
      ? req.user.candidateProfileId
      : str(req.body?.candidateProfileId, 60);
    // World boundary. A real account may never reason about a demo persona, and a
    // demo session may never reach a real candidate — including by guessing an id.
    const profileRow = db.findById('candidateProfiles', candidateProfileId);
    if (!profileRow || !sameWorld(req, profileRow))
      return res.status(404).json({ error: 'Unknown candidate profile.' });

    const candidate = materializeCandidate(candidateProfileId);
    if (!candidate) return bad(res, 'Unknown candidate profile.');
    if (!candidate.evidence.length)
      return bad(res, 'This candidate has no evidence yet. PIE has nothing to reason about until evidence is added.');

    const requisitionId = str(req.body?.requisitionId, 60);
    const requisition = requisitionId ? db.findById('requisitions', requisitionId) : null;
    if (requisitionId && (!requisition || !sameWorld(req, requisition)))
      return res.status(404).json({ error: 'Unknown requisition.' });

    const useAI = req.body?.useAI !== false;
    const runId = `run_${crypto.randomUUID().slice(0, 8)}`;
    try {
      const run = await runOrchestration({ candidate, requisition, runId, trigger, useAI });
      keepRun(run);
      res.json(run);
    } catch (e) {
      console.error('[orchestrate]', e);
      res.status(500).json({ error: 'The orchestrator could not complete this run.', detail: e.message });
    }
  });

  app.get('/api/runs/:id', requireAuth, (req, res) => {
    const run = RUNS.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found or no longer cached.' });
    if (!canRead(req, run)) return res.status(403).json({ error: 'That run belongs to another account.' });
    res.json(run);
  });

  /* ============================== HUMAN-IN-THE-LOOP GATE ==================
     The only step in the entire system with hiring authority.               */
  
  /* --------------------------------------------------------------- brief
     What the recruiter reads BEFORE deciding. Deliberately a separate call:
     the orchestrator run must not wait on a language model, and a brief that
     fails must not take a match result down with it. */
  app.get('/api/runs/:id/brief', requireAuth, requireRole('recruiter', 'admin'), async (req, res) => {
    const run = RUNS.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (!canRead(req, run)) return res.status(403).json({ error: 'That run belongs to another recruiter.' });
    try {
      const brief = await decisionBriefAgent({
        matching: run.result?.matching,
        discovery: run.result?.discovery,
        learning: run.result?.learning,
        assessment: run.result?.assessment || null,
        roleTitle: run.requisition?.title || null,
        // Note what is NOT passed: the candidate's name, their institution, their
        // history. The brief is about evidence, and the narrator cannot mention
        // what it was never given.
      });
      res.json({ brief });
    } catch (e) {
      res.status(200).json({ brief: null, error: e.message });
    }
  });

app.post('/api/runs/:id/decision', requireAuth, requireRole('recruiter', 'admin'), async (req, res) => {
    const run = RUNS.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (!canRead(req, run)) return res.status(403).json({ error: 'That run belongs to another recruiter.' });

    const allowed = ['SHORTLIST', 'PROCEED_TO_INTERVIEW', 'HOLD', 'REJECT'];
    const action = str(req.body?.action, 40);
    const reason = str(req.body?.reason ?? req.body?.note, 600);
    if (!allowed.includes(action)) return bad(res, `action must be one of ${allowed.join(', ')}`);
    if (reason.length < 3) return bad(res, 'A reason is required for every human decision — it is recorded in the audit trail.');

    if (run.status === 'BLOCKED_PENDING_INTEGRITY_REVIEW') {
      return res.status(409).json({
        error: 'A high-severity bias signal blocks this run. A Trust & Integrity Administrator must review it before a recruiter decision can be recorded.',
      });
    }

    const aiRecommendation = run.result?.matching
      ? `${run.result.matching.matchTier} (skills-first ${run.result.matching.skillsFirstScore}, potential-adjusted ${run.result.matching.potentialAdjusted})`
      : 'none';

    const decision = {
      action, reason, actor: req.user.name, actorEmail: req.user.email,
      at: new Date().toISOString(),
      category: 'HUMAN_DECISION',
      aiRecommendation,
      override: run.result?.matching
        ? (action === 'REJECT' && run.result.matching.potentialAdjusted >= 0.75)
          || (action === 'PROCEED_TO_INTERVIEW' && run.result.matching.potentialAdjusted < 0.4)
        : false,
      authority: 'This is the only category in the system with hiring authority.',
    };
    run.decision = decision;
    run.status = 'DECIDED';

    // What the candidate will be shown. Computed here, at the moment of the
    // decision, from the evidence the decision was made against - so it cannot
    // drift later, and so a rejection arrives with its learning pathway already
    // attached rather than as a bare "no".
    let outcome = null;
    try {
      outcome = await candidateOutcomeAgent({
        action,
        matching: run.result?.matching,
        discovery: run.result?.discovery,
        learning: run.result?.learning,
        assessment: run.result?.assessment || null,
        roleTitle: run.requisition?.title || null,
        // `reason` is NOT passed. It is a note written for colleagues; the
        // candidate gets feedback built from evidence PIE can defend.
      });
    } catch { /* a missing narrative must never block a human decision */ }

    const record = db.insert('humanDecisions', {
      runId: run.runId, candidateProfileId: run.candidate.id,
      candidateOutcome: outcome,
      requisitionId: run.requisition?.id || null,
      reviewer: req.user.name, reviewerEmail: req.user.email, reviewerRole: req.user.role,
      action, reason, aiRecommendation, override: decision.override, at: decision.at,
    });

    const application = db.find('applications', a =>
      a.candidateProfileId === run.candidate.id && a.requisitionId === run.requisition?.id);
    if (application) {
      advanceApplication(application.id, 'HUMAN_DECISION', {
        decision: { action, reason, reviewer: req.user.name, at: decision.at },
      });
    }

    db.audit({ actor: req.user.email, actorRole: req.user.role, action: 'HUMAN_DECISION_RECORDED',
      subjectType: 'run', subjectId: run.runId,
      meta: { candidateProfileId: run.candidate.id, requisitionId: run.requisition?.id, decisionId: record.id },
      note: `${action} — "${reason}". AI recommendation at the time: ${aiRecommendation}. ${decision.override ? 'This decision OVERRIDES the AI recommendation.' : ''}` });

    res.json(run);
  });

  /* ======================= REASSESSMENT — the improvement loop ============= */
  app.post('/api/runs/:id/reassess', requireAuth, rateLimit(30, 60_000), async (req, res) => {
    const run = RUNS.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found.' });
    if (!canRead(req, run)) return res.status(403).json({ error: 'That run belongs to another account.' });

    const skillId = str(req.body?.skillId, 60);
    const objective = run.result?.learning?.objectives?.find(o => o.skillId === skillId);
    if (!objective) return bad(res, 'That objective is not part of this run.');

    const profileId = run.candidate.id;
    const practice = objective.resources.find(r => r.completion_verification === 'PIE_REASSESSMENT');

    // New, verifiable evidence. SAP Learning Hub completion is deliberately NOT asserted.
    const ev = db.insert('evidence', {
      candidateProfileId: profileId,
      type: 'assessment', source: 'assessment',
      verification: 'api_derived', trustTier: 'API-DERIVED',
      title: `PIE reassessment passed — ${objective.skill}`,
      text: `${objective.skill}. Targeted PIE reassessment completed after learning objective ${objective.objectiveId}. ${practice ? `Practice task: ${practice.title}.` : ''} Scored server-side against a protected rubric.`,
      date: new Date().toISOString().slice(0, 7),
      status: 'INGESTED', capabilities: [],
    });
    db.insert('learningProgress', {
      candidateProfileId: profileId, skillId, state: 'REASSESSED',
      completionVerification: 'PIE_REASSESSMENT', evidenceId: ev.id, declaredAt: db.now(),
    });
    db.audit({ actor: req.user.email, actorRole: req.user.role, action: 'REASSESSMENT_COMPLETED',
      subjectType: 'evidence', subjectId: ev.id,
      meta: { candidateProfileId: profileId, skillId },
      note: `New API-derived evidence for ${objective.skill}. SAP Learning Hub completion was NOT asserted — no verified completion API exists.` });

    const candidate = materializeCandidate(profileId);
    const requisition = run.requisition ? db.findById('requisitions', run.requisition.id) : null;
    const newRunId = `run_${crypto.randomUUID().slice(0, 8)}`;
    const next = await runOrchestration({
      candidate, requisition, runId: newRunId,
      trigger: 'ASSESSMENT_COMPLETED', useAI: req.body?.useAI !== false,
    });
    next.previousRunId = run.runId;
    next.delta = {
      skill: objective.skill,
      matchBefore: run.result.matching.skillsFirstScore,
      matchAfter: next.result.matching.skillsFirstScore,
      potentialBefore: run.result.matching.potentialAdjusted,
      potentialAfter: next.result.matching.potentialAdjusted,
      growthBefore: run.result.discovery.growthReadiness.value,
      growthAfter: next.result.discovery.growthReadiness.value,
      gapsBefore: run.result.matching.gaps.length,
      gapsAfter: next.result.matching.gaps.length,
      evidenceBefore: run.result.discovery.evidenceCount,
      evidenceAfter: next.result.discovery.evidenceCount,
    };
    keepRun(next);
    res.json(next);
  });

  /* ---------------------------------------------------------------- lists */
  app.get('/api/runs', requireAuth, (req, res) => {
    let rows = db.all('agentRuns');
    if (req.user.role === 'candidate')
      rows = rows.filter(r => r.candidateProfileId === req.user.candidateProfileId);
    res.json({ runs: rows.slice(-60).reverse(), cached: [...RUNS.keys()] });
  });

  app.get('/api/matches', requireAuth, (req, res) => {
    let rows = db.all('matchResults');
    if (req.user.role === 'candidate')
      rows = rows.filter(r => r.candidateProfileId === req.user.candidateProfileId);
    res.json({ matches: rows.slice(-200).reverse() });
  });
}

export { RUNS };
