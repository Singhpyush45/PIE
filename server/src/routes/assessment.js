// Assessment routes — job-specific generation, secure delivery, proctoring.
//
// The blueprint is derived from the REQUISITION's required capabilities intersected
// with the candidate's own evidence, so it is never a generic random assessment.

import * as db from '../store.js';
import {
  requireAuth, requireRole, rateLimit, str, bad,
  materializeCandidate, publicApp, advanceApplication,
} from '../lib.js';
import {
  ASSESSMENT_POLICY, WARNING_MATRIX, buildBlueprint, startAttempt, getAttempt,
  currentQuestion, submitAnswer, recordProctorEvent, finalizeAttempt,
  attemptToEvidence, publicAttempt, questionOf,
} from '../assessment.js';
import { LANGUAGES } from '../assessmentAI.js';
import { execute, capabilities } from '../execution/runner.js';
import { marketIntelligenceAgent, skillsDiscoveryAgent } from '../agents.js';

/** Skills to assess = what the ROLE requires, prioritised by what the candidate's
 *  evidence already touches (so the assessment probes real, relevant ground). */
function targetSkillsFor(candidate, requisition) {
  if (!requisition) return null;
  const model = marketIntelligenceAgent(requisition).roleCompetencyModel;
  const required = model.competencies.filter(c => c.mandatory).map(c => c.id);
  const preferred = model.competencies.filter(c => !c.mandatory).map(c => c.id);
  const held = new Set(skillsDiscoveryAgent(candidate).skills.map(s => s.id));
  const overlap = required.filter(s => held.has(s));
  const rest = required.filter(s => !held.has(s));
  return [...overlap, ...rest, ...preferred.filter(s => held.has(s))];
}

/** A candidate may only act on their own attempt. Prevents id guessing. */
function ownAttempt(req, attemptId) {
  const a = getAttempt(attemptId);
  if (!a) return { ok: false, code: 404, error: 'Attempt not found.' };
  if (req.user.role === 'candidate' && a.candidateId !== req.user.candidateProfileId)
    return { ok: false, code: 403, error: 'That attempt belongs to another candidate.' };
  return { ok: true, attempt: a };
}

export function registerAssessmentRoutes(app) {
  app.get('/api/assessment/policy', (_req, res) =>
    res.json({ policy: ASSESSMENT_POLICY, warningMatrix: WARNING_MATRIX }));

  /* -------------------------------------------------------------- sandbox */
  // What the execution layer can actually do, said plainly. A recruiter writing
  // test cases needs to know whether they will be run.
  app.get('/api/assessment/sandbox', requireAuth, async (_req, res) => {
    res.json({ sandbox: await capabilities() });
  });

  /* ------------------------------------------------------------ languages */
  // What the candidate may choose, and what changes if they do. Served rather
  // than hard-coded in the UI so the honesty notes stay with the capability.
  app.get('/api/assessment/languages', requireAuth, (_req, res) => {
    res.json({
      languages: LANGUAGES,
      note: 'Generated questions are written in your chosen language. The verified question bank is English-only, so if PIE falls back to it your paper will be mixed — the assessment tells you when that happens.',
    });
  });

  /* ------------------------------------------------------------ blueprint */
  app.post('/api/assessment/blueprint', requireAuth, (req, res) => {
    const profileId = req.user.role === 'candidate'
      ? req.user.candidateProfileId : str(req.body?.candidateProfileId, 60);
    const candidate = materializeCandidate(profileId);
    if (!candidate) return bad(res, 'Unknown candidate profile.');
    const requisition = req.body?.requisitionId ? db.findById('requisitions', str(req.body.requisitionId, 60)) : null;
    const targetSkills = targetSkillsFor(candidate, requisition);
    const blueprint = buildBlueprint({ candidate, targetSkills });
    res.json({
      ...blueprint,
      derivedFrom: requisition
        ? `Required capabilities for "${requisition.title}", prioritised by the candidate's own evidence.`
        : 'The candidate’s own evidence (no target role selected).',
      requisitionId: requisition?.id || null,
    });
  });

  /* ---------------------------------------------------------------- start */
  app.post('/api/assessment/start', requireAuth, requireRole('candidate'), rateLimit(20, 60_000), async (req, res) => {
    const profileId = req.user.candidateProfileId;
    const candidate = materializeCandidate(profileId);
    if (!candidate) return bad(res, 'Unknown candidate profile.');

    const applicationId = str(req.body?.applicationId, 60);
    const application = applicationId ? db.findById('applications', applicationId) : null;
    if (application && application.candidateProfileId !== profileId)
      return res.status(403).json({ error: 'That application belongs to another candidate.' });

    const requisitionId = application?.requisitionId || str(req.body?.requisitionId, 60);
    const requisition = requisitionId ? db.findById('requisitions', requisitionId) : null;

    // Anti-repetition: never ask this candidate a question family they have
    // already been given. Families are recorded on each finished attempt.
    const bannedFamilies = new Set(
      db.filter('assessmentAttempts', x => x.candidateProfileId === profileId)
        .flatMap(x => x.questionFamilies || []));

    try {
      const a = await startAttempt({
        candidate, targetSkills: targetSkillsFor(candidate, requisition),
        gaps: req.body?.gaps || [],
        role: requisition?.title || null,
        jobText: requisition?.text || null,
        bannedFamilies,
        // Validated against the supported list; anything else falls back to
        // English rather than being passed to the model as free text.
        language: str(req.body?.language, 8),
        // Whose questions. The RECRUITER decides this on the requisition — a
        // candidate cannot ask for the AI-generated paper instead, which is why
        // it is read from the requisition and never from the request body.
        mode: requisition?.assessmentMode || undefined,
        recruiterQuestions: requisition
          ? db.filter('recruiterQuestions', q => q.requisitionId === requisition.id && !q.archived)
          : [],
        consent: req.body?.consent, preflight: req.body?.preflight,
      });
      a.requisitionId = requisition?.id || null;
      a.applicationId = application?.id || null;

      db.insert('assessmentAttempts', {
        id: a.attemptId, candidateProfileId: profileId,
        requisitionId: a.requisitionId, applicationId: a.applicationId,
        policyId: a.policy.policyId, state: a.state, startedAt: a.startedAt,
        questionCount: a.blueprint.questionCount, skillCoverage: a.blueprint.skillCoverage,
        // Recorded so the NEXT assessment for this candidate can avoid them.
        questionFamilies: a.questions.map(q => q.familyId).filter(Boolean),
        questionSources: a.blueprint.sourceMix,
        aiProvider: a.blueprint.generation?.provider || null,
        language: a.blueprint.language,
        mode: a.blueprint.mode,
        recruiterAuthored: a.blueprint.recruiterAuthored,
      });
      if (application) advanceApplication(application.id, 'ASSESSMENT_REQUIRED', { assessmentAttemptId: a.attemptId });

      db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'ATTEMPT_STARTED',
        subjectType: 'assessmentAttempt', subjectId: a.attemptId,
        meta: { candidateProfileId: profileId, requisitionId: a.requisitionId },
        note: `Consent recorded and warning threshold ${a.policy.warnings.threshold} frozen. `
          + `${a.blueprint.questionCount} questions covering ${a.blueprint.skillCoverage.join(', ')}`
          + `${requisition ? `, built for "${requisition.title}"` : ''}. `
          + `Mode: ${a.blueprint.modeLabel}. `
          + `Sources: ${Object.entries(a.blueprint.sourceMix).map(([k, v]) => `${v} ${k}`).join(', ')}`
          + `${a.blueprint.generation?.rejected?.length ? `; ${a.blueprint.generation.rejected.length} generated question(s) rejected by validation` : ''}.` });

      res.json({ attempt: publicAttempt(a), question: currentQuestion(a) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  /* ---------------------------------------------------------------- state */
  app.get('/api/assessment/:id', requireAuth, (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    res.json({ attempt: publicAttempt(own.attempt), question: currentQuestion(own.attempt) });
  });

  /* --------------------------------------------------------------- answer */
  app.post('/api/assessment/:id/answer', requireAuth, requireRole('candidate'), async (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    try {
      // The client never sends a score. Grading is server-side against a protected rubric.
      const { attempt } = await submitAnswer(own.attempt, {
        questionId: str(req.body?.questionId, 60),
        response: req.body?.response,
        token: str(req.body?.token, 80),
        expired: Boolean(req.body?.expired),
      });
      db.update('assessmentAttempts', attempt.attemptId, { state: attempt.state, cursor: attempt.cursor });
      db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'QUESTION_FINALIZED',
        subjectType: 'assessmentAttempt', subjectId: attempt.attemptId,
        meta: { candidateProfileId: attempt.candidateId },
        note: `${req.body?.questionId} finalised${req.body?.expired ? ' on timer expiry' : ''}. Forward-only: it cannot be reopened.` });
      res.json({ attempt: publicAttempt(attempt), question: currentQuestion(attempt) });
    } catch (e) { res.status(409).json({ error: e.message }); }
  });

  /* ------------------------------------------------------------------- run
     "Run" is a debugging aid, not a submission. It executes the candidate's
     current code against the VISIBLE tests only and returns what happened.
     Hidden tests are not run here and their existence is not detailed — a Run
     button that quietly reported hidden results would be the leak the whole
     hidden/visible split exists to prevent. */
  app.post('/api/assessment/:id/run', requireAuth, requireRole('candidate'), rateLimit(40, 60_000), async (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });

    const q = questionOf(own.attempt, str(req.body?.questionId, 60));
    if (!q) return bad(res, 'Unknown question.');
    if (!(q.type.startsWith('coding') || q.type === 'debugging'))
      return bad(res, 'That question is not a coding question.');
    if (own.attempt.finalized.find(f => f.questionId === q.id))
      return bad(res, 'That question is already finalised.');

    const visible = (q.tests || []).filter(t => !t.hidden);
    if (!visible.length) return res.json({ executed: false, error: 'This question has no example tests to run against.', results: [] });

    const r = await execute({
      language: q.language || 'python',
      code: String(req.body?.code || '').slice(0, 40_000),
      entryPoint: q.entryPoint || 'solve',
      tests: visible,
    });
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'CODE_RUN',
      subjectType: 'assessmentAttempt', subjectId: own.attempt.attemptId,
      note: `Ran example tests for ${q.id}. Running does not finalise the question and does not affect scoring.` });

    res.json({
      executed: r.executed, ok: r.ok, error: r.error === 'NO_SANDBOX'
        ? 'Code execution is unavailable right now. Your answer will still be recorded and reviewed by a person.'
        : r.error,
      results: r.results,
      note: 'These are the example tests. Your submission is also checked against additional tests you cannot see.',
    });
  });

  /* ------------------------------------------------------------ proctoring */
  app.post('/api/assessment/:id/proctor', requireAuth, requireRole('candidate'), (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const type = str(req.body?.type, 40);
    if (!WARNING_MATRIX[type]) return bad(res, 'Unknown proctoring event type.');

    const before = own.attempt.state;
    recordProctorEvent(own.attempt, type);
    const last = own.attempt.warnings[own.attempt.warnings.length - 1];

    db.insert('proctoringEvents', {
      attemptId: own.attempt.attemptId, candidateProfileId: own.attempt.candidateId,
      eventType: type, timestamp: db.now(),
      severity: last?.counted ? 'WARNING' : 'INFO',
      source: str(req.body?.source, 40) || 'browser',
      metadata: { detection: last?.detection || null, count: last?.count ?? null,
        threshold: own.attempt.policy.warnings.threshold, simulated: Boolean(req.body?.simulated) },
    });

    if (last?.counted) {
      db.audit({ actor: 'service:proctoring', action: 'INTEGRITY_WARNING',
        subjectType: 'assessmentAttempt', subjectId: own.attempt.attemptId,
        meta: { candidateProfileId: own.attempt.candidateId },
        note: `${last.signal} — warning ${last.count}/${last.threshold}.` });
    }
    if (before !== own.attempt.state) {
      db.update('assessmentAttempts', own.attempt.attemptId,
        { state: own.attempt.state, integrityStatus: 'LOCKED_FOR_REVIEW' });
      if (own.attempt.applicationId)
        db.update('applications', own.attempt.applicationId, { integrityStatus: 'LOCKED_FOR_REVIEW' });
      db.audit({ actor: 'service:proctoring', action: 'ATTEMPT_LOCKED',
        subjectType: 'assessmentAttempt', subjectId: own.attempt.attemptId,
        meta: { candidateProfileId: own.attempt.candidateId },
        note: 'Warning threshold reached. Attempt submitted and locked pending human review. No automatic rejection was made.' });
    }
    res.json({ attempt: publicAttempt(own.attempt), question: currentQuestion(own.attempt) });
  });

  /* --------------------------------------------------------------- finish */
  app.post('/api/assessment/:id/finish', requireAuth, requireRole('candidate'), (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const a = own.attempt;
    if (a.state === 'IN_PROGRESS') finalizeAttempt(a, 'COMPLETED');

    const ev = attemptToEvidence(a);
    let evidenceRow = null;
    if (ev && !db.find('evidence', e => e.id === ev.id)) {
      evidenceRow = db.insert('evidence', {
        id: ev.id, candidateProfileId: a.candidateId,
        type: 'assessment', source: 'assessment',
        verification: 'api_derived', trustTier: 'API-DERIVED',
        title: ev.title, text: ev.text, date: ev.date, status: 'INGESTED', capabilities: [],
      });
      db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'ASSESSMENT_EVIDENCE_ADDED',
        subjectType: 'evidence', subjectId: evidenceRow.id,
        meta: { candidateProfileId: a.candidateId },
        note: `${ev.title} written to the evidence profile as one source of seven.` });
    }

    db.update('assessmentAttempts', a.attemptId, {
      state: a.state, completedAt: a.completedAt,
      overall: a.result?.overall ?? null, warningCount: a.warningCount,
      requiresHumanReview: Boolean(a.result?.requiresHumanReview),
    });
    if (a.applicationId) {
      advanceApplication(a.applicationId, a.result?.requiresHumanReview ? 'UNDER_REVIEW' : 'ASSESSMENT_COMPLETED');
    }

    res.json({ attempt: publicAttempt(a), evidenceAdded: Boolean(evidenceRow) });
  });

  /* --------------------------------------------------------- leave attempt */
  app.post('/api/assessment/:id/abandon', requireAuth, requireRole('candidate'), (req, res) => {
    const own = ownAttempt(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    db.insert('proctoringEvents', {
      attemptId: own.attempt.attemptId, candidateProfileId: own.attempt.candidateId,
      eventType: 'ATTEMPT_EXITED', timestamp: db.now(), severity: 'INFO', source: 'candidate',
      metadata: { reason: str(req.body?.reason, 200) || 'Candidate left the assessment' },
    });
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'ATTEMPT_EXITED',
      subjectType: 'assessmentAttempt', subjectId: own.attempt.attemptId,
      meta: { candidateProfileId: own.attempt.candidateId },
      note: 'Candidate left an active assessment. Attempt state was preserved, not discarded.' });
    res.json({ ok: true, attempt: publicAttempt(own.attempt) });
  });
}
