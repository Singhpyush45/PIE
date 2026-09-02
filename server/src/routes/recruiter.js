// Recruiter workspace routes: requisitions, JD intelligence, candidate discovery.

import * as db from '../store.js';
import {
  requireAuth, requireRole, rateLimit, str, bad, sanitize,
  publicReq, publicApp, publicProfile, ownsRequisition, materializeCandidate,
} from '../lib.js';
import { marketIntelligenceAgent, employerReadinessAgent, skillsDiscoveryAgent, inclusiveMatchingAgent } from '../agents.js';
import { extractJdRequirements } from '../ai/agents.js';
import { validateQuestion, ASSESSMENT_MODES, MODE_IDS, isAssessmentMode, DEFAULT_MODE } from '../assessmentAI.js';
import { execute, capabilities, LANGUAGES as EXEC_LANGUAGES } from '../execution/runner.js';

/**
 * What a recruiter may see of their own question.
 *
 * The answer key IS included here — the recruiter wrote it and has to be able to
 * check it. It is the CANDIDATE-facing serialiser (publicQuestion) that strips
 * keys, and these two must never be confused.
 */
const publicAuthoredQuestion = q => ({
  id: q.id, type: q.type, difficulty: q.difficulty, skill: q.skill,
  prompt: q.prompt, options: q.options || null, answer: q.answer ?? null,
  explain: q.explain, keywords: q.keywords || null,
  starterCode: q.starterCode || null, rubric: q.rubric || null,
  language: q.language || null, entryPoint: q.entryPoint || null,
  reviewOnly: Boolean(q.reviewOnly),
  // The author wrote these and must be able to check them — including the
  // hidden ones. This serialiser is recruiter-only; publicQuestion is the one
  // that faces candidates.
  tests: q.tests || null,
  authorEmail: q.authorEmail, createdAt: q.createdAt,
});

export function registerRecruiterRoutes(app) {
  const asRecruiter = [requireAuth, requireRole('recruiter', 'admin')];

  /* -------------------------------------------------------- requisitions */
  app.get('/api/recruiter/requisitions', ...asRecruiter, (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.all('requisitions')
      : db.filter('requisitions', r => r.recruiterId === req.user.recruiterId);
    res.json({ requisitions: rows.map(publicReq) });
  });

  app.get('/api/recruiter/requisitions/:id', ...asRecruiter, (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    res.json({
      requisition: publicReq(own.requisition),
      applications: db.filter('applications', a => a.requisitionId === own.requisition.id).map(publicApp),
    });
  });

  app.post('/api/recruiter/requisitions', ...asRecruiter, rateLimit(30, 60_000), async (req, res) => {
    const title = sanitize(req.body?.title, 160);
    const text = sanitize(req.body?.text, 20_000);
    if (title.length < 3) return bad(res, 'A requisition needs a title.');
    if (text.length < 60) return bad(res, 'Paste the job description so PIE can extract requirements from it.');

    const org = db.findById('organizations', req.user.organizationId);
    const requisition = db.insert('requisitions', {
      recruiterId: req.user.recruiterId,
      organizationId: req.user.organizationId,
      title,
      company: sanitize(req.body?.company, 160) || org?.name || 'Unnamed organization',
      location: sanitize(req.body?.location, 120) || 'Not stated',
      employmentType: sanitize(req.body?.employmentType, 60) || 'Full-time',
      experience: sanitize(req.body?.experience, 160) || 'Not stated',
      educationRequirements: sanitize(req.body?.educationRequirements, 200) || 'Not stated',
      text, status: 'OPEN', demoDefault: false,
    });

    // Trigger: RECRUITER_CREATES_JD → requirement extraction + employer readiness + bias check.
    const market = marketIntelligenceAgent(requisition);
    const employer = employerReadinessAgent(requisition, market);
    const extraction = await extractJdRequirements({
      text: requisition.text, deterministicModel: market.roleCompetencyModel,
    });

    db.update('requisitions', requisition.id, {
      requiredSkills: market.roleCompetencyModel.competencies.filter(c => c.mandatory).map(c => c.name),
      preferredSkills: market.roleCompetencyModel.competencies.filter(c => !c.mandatory).map(c => c.name),
      employerReadiness: {
        inclusionScore: employer.inclusionScore, inclusionTier: employer.inclusionTier,
        findingCount: employer.findings.length,
      },
    });

    db.insert('biasAudits', {
      subjectType: 'requisition', subjectId: requisition.id,
      severity: employer.findings.some(f => f.severity === 'High') ? 'High'
        : employer.findings.length ? 'Medium' : 'None',
      signalCount: employer.findings.length,
      signals: employer.findings,
      status: employer.findings.length ? 'OPEN' : 'CLEAR',
      note: 'Potential bias signals detected in the requisition text. These are indicators requiring human review, not proof of bias.',
    });

    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'REQUISITION_CREATED',
      subjectType: 'requisition', subjectId: requisition.id,
      note: `${title} created. Employer readiness ${employer.inclusionScore} (${employer.inclusionTier}), ${employer.findings.length} potential barrier(s) flagged.` });

    res.status(201).json({
      requisition: publicReq(db.findById('requisitions', requisition.id)),
      intelligence: { market, employer, extraction },
    });
  });

  app.patch('/api/recruiter/requisitions/:id', ...asRecruiter, (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const patch = {};
    for (const f of ['title', 'company', 'location', 'employmentType', 'experience', 'educationRequirements'])
      if (req.body?.[f] !== undefined) patch[f] = sanitize(req.body[f], 200);
    if (req.body?.text !== undefined) patch.text = sanitize(req.body.text, 20_000);
    if (['OPEN', 'CLOSED', 'DRAFT'].includes(req.body?.status)) patch.status = req.body.status;
    const updated = db.update('requisitions', own.requisition.id, patch);
    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'REQUISITION_UPDATED',
      subjectType: 'requisition', subjectId: updated.id,
      note: `Updated: ${Object.keys(patch).join(', ') || 'nothing'}` });
    res.json({ requisition: publicReq(updated) });
  });


  /* ================================================= recruiter question bank
     A recruiter writing their own questions is the answer to "why should I
     trust an AI to decide what my candidates are asked?". PIE's position is
     that they should not have to. */

  // Validated the same way generated questions are. A recruiter's bad answer
  // key is exactly as unfair to a candidate as a model's, so the same checks
  // apply — but the failure is returned to the AUTHOR, who can fix it, rather
  // than silently dropping the question at assessment time.
  function readQuestion(body) {
    const type = str(body?.type, 20);
    const q = {
      type,
      difficulty: str(body?.difficulty, 10),
      skill: str(body?.skill, 60),
      prompt: sanitize(body?.prompt, 2000),
      explain: sanitize(body?.explain, 1000),
    };
    if (Array.isArray(body?.options)) q.options = body.options.slice(0, 6).map(o => sanitize(o, 400));
    if (type === 'multi_select') {
      q.answer = Array.isArray(body?.answer) ? body.answer.map(Number).filter(Number.isInteger) : [];
    } else if (type === 'mcq') {
      q.answer = Number(body?.answer);
    }
    if (Array.isArray(body?.keywords)) q.keywords = body.keywords.slice(0, 12).map(k => sanitize(k, 60));
    if (typeof body?.starterCode === 'string') q.starterCode = sanitize(body.starterCode, 4000);
    if (Array.isArray(body?.rubric)) q.rubric = body.rubric.slice(0, 10).map(r => sanitize(r, 300));

    if (type.startsWith('coding') || type === 'debugging') {
      q.reviewOnly = Boolean(body?.reviewOnly);
      if (q.reviewOnly) {
        q.reviewReason = sanitize(body?.reviewReason, 300)
          || 'Marked for recruiter review: this answer is not executed.';
      } else {
        q.language = str(body?.language, 20);
        q.entryPoint = str(body?.entryPoint, 60);
        // Test inputs and expected values are JSON, entered as JSON by the
        // author. Parsed here so a malformed one is rejected at authoring time
        // with a message, rather than blowing up inside the sandbox later.
        q.tests = (Array.isArray(body?.tests) ? body.tests : []).slice(0, 30).map((t, i) => {
          const one = { id: str(t?.id, 40) || `t${i + 1}`, hidden: Boolean(t?.hidden) };
          if (t?.label) one.label = sanitize(t.label, 120);
          try { one.input = typeof t?.input === 'string' ? JSON.parse(t.input) : t?.input; }
          catch { throw new Error(`Test "${one.id}": the input is not valid JSON. Write the arguments as a list, e.g. [[1,2,3], 2]`); }
          try { one.expected = typeof t?.expected === 'string' ? JSON.parse(t.expected) : t?.expected; }
          catch { throw new Error(`Test "${one.id}": the expected value is not valid JSON.`); }
          return one;
        });
      }
    }
    return q;
  }

  app.get('/api/recruiter/requisitions/:id/questions', ...asRecruiter, async (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const rows = db.filter('recruiterQuestions', q => q.requisitionId === own.requisition.id && !q.archived);
    res.json({
      questions: rows.map(publicAuthoredQuestion),
      mode: own.requisition.assessmentMode || DEFAULT_MODE,
      modes: Object.values(ASSESSMENT_MODES),
      sandbox: await capabilities(),
      execLanguages: Object.values(EXEC_LANGUAGES).map(l => ({ id: l.id, label: l.label })),
    });
  });

  app.post('/api/recruiter/requisitions/:id/questions', ...asRecruiter, rateLimit(60, 60_000), async (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });

    let draft;
    try { draft = readQuestion(req.body); }
    catch (e) { return bad(res, e.message); }

    const v = validateQuestion(draft, { targetSkills: [] });   // relevance is the recruiter's call, not PIE's
    if (!v.ok) return res.status(400).json({ error: v.detail, code: v.code });

    // A test suite nobody has run is a guess. Before the question can be used,
    // the recruiter's own reference solution must pass every test they wrote —
    // otherwise the first person to discover the suite is broken is a candidate
    // being marked down by it.
    if (Array.isArray(draft.tests) && draft.tests.length) {
      const reference = String(req.body?.referenceSolution || '');
      if (!reference.trim())
        return bad(res, 'Add a reference solution. PIE runs it against your test cases before accepting the question, so a broken test is caught here rather than by a candidate.');
      const run = await execute({
        language: draft.language, code: reference, entryPoint: draft.entryPoint, tests: draft.tests,
      });
      if (!run.executed)
        return bad(res, 'Code execution is unavailable, so PIE cannot check your test cases. Add the question once the sandbox is running, or mark it review-only.');
      if (!run.ok) return bad(res, `Your reference solution did not run: ${run.error}`);
      const failed = run.results.filter(r => !r.passed);
      if (failed.length)
        return bad(res, `Your reference solution fails ${failed.length} of your own test case(s): ${failed.map(f => `${f.id} returned ${f.got ?? f.error}`).join('; ')}. Fix the test or the solution before candidates see it.`);
    }

    const row = db.insert('recruiterQuestions', {
      ...draft,
      requisitionId: own.requisition.id,
      authorEmail: req.user.email,
      familyId: v.familyId,
      source: 'recruiter_authored',
      archived: false,
      createdAt: new Date().toISOString(),
    });
    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'QUESTION_AUTHORED',
      subjectType: 'requisition', subjectId: own.requisition.id,
      note: `Added a ${draft.type} question on "${draft.skill}" (${draft.difficulty}).` });
    res.status(201).json({ question: publicAuthoredQuestion(row) });
  });

  app.delete('/api/recruiter/requisitions/:id/questions/:qid', ...asRecruiter, (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const row = db.findById('recruiterQuestions', req.params.qid);
    if (!row || row.requisitionId !== own.requisition.id)
      return res.status(404).json({ error: 'Question not found on this requisition.' });
    // Archived, not deleted: an attempt already sat may reference it, and a
    // score has to stay explainable after the question is retired.
    db.update('recruiterQuestions', row.id, { archived: true, archivedAt: new Date().toISOString() });
    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'QUESTION_RETIRED',
      subjectType: 'requisition', subjectId: own.requisition.id,
      note: `Retired a ${row.type} question on "${row.skill}". Past attempts keep it for explainability.` });
    res.json({ ok: true });
  });

  app.put('/api/recruiter/requisitions/:id/assessment-mode', ...asRecruiter, (req, res) => {
    const own = ownsRequisition(req, req.params.id);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const mode = str(req.body?.mode, 20);
    if (!isAssessmentMode(mode)) return bad(res, `mode must be one of ${MODE_IDS.join(', ')}`);

    const authored = db.filter('recruiterQuestions',
      q => q.requisitionId === own.requisition.id && !q.archived).length;
    // Refused rather than silently producing an empty paper: RECRUITER_ONLY
    // with no questions is not a configuration, it is a broken assessment.
    if (mode === 'RECRUITER_ONLY' && authored === 0)
      return bad(res, 'Add at least one question of your own before switching to "Only my questions" — otherwise the assessment would have nothing to ask.');

    db.update('requisitions', own.requisition.id, { assessmentMode: mode });
    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'ASSESSMENT_MODE_SET',
      subjectType: 'requisition', subjectId: own.requisition.id,
      note: `Assessment mode set to ${ASSESSMENT_MODES[mode].label} with ${authored} authored question(s).` });
    res.json({ mode, authored, warning: mode === 'RECRUITER_ONLY' && authored < 4
      ? `Only ${authored} question(s) available, so papers will be shorter than PIE would otherwise build. Candidates retaking will see the same questions.`
      : null });
  });

  /* ----------------------------------------------- JD intelligence preview */
  app.post('/api/recruiter/jd/analyse', ...asRecruiter, rateLimit(30, 60_000), async (req, res) => {
    const text = sanitize(req.body?.text, 20_000);
    if (text.length < 60) return bad(res, 'Paste a job description to analyse.');
    const draft = { id: 'draft', title: sanitize(req.body?.title, 160) || 'Draft role', text };
    const market = marketIntelligenceAgent(draft);
    const employer = employerReadinessAgent(draft, market);
    const extraction = await extractJdRequirements({ text, deterministicModel: market.roleCompetencyModel });
    res.json({
      roleCompetencyModel: market.roleCompetencyModel,
      employerReadiness: employer,
      extraction,
      notice: 'Analysis of a draft. Nothing has been saved and no candidate was involved — the requirement extraction service never sees a candidate.',
    });
  });

  /* ------------------------------------------------- candidate discovery */
  app.get('/api/recruiter/candidates', ...asRecruiter, (req, res) => {
    const q = str(req.query?.q, 120).toLowerCase();
    const requisitionId = str(req.query?.requisitionId, 60);
    let profiles = db.all('candidateProfiles');

    if (q) {
      profiles = profiles.filter(p => {
        const ev = db.filter('evidence', e => e.candidateProfileId === p.id);
        const haystack = [p.name, p.headline, ...ev.map(e => `${e.title} ${e.text}`)].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    // Ranking, when a requisition is given, is capability/evidence driven only.
    let ranked = profiles.map(p => ({ profile: publicProfile(p) }));
    if (requisitionId) {
      const requisition = db.findById('requisitions', requisitionId);
      if (requisition) {
        const market = marketIntelligenceAgent(requisition);
        ranked = profiles.map(p => {
          const cand = materializeCandidate(p.id);
          if (!cand?.evidence.length) return { profile: publicProfile(p), match: null };
          const discovery = skillsDiscoveryAgent(cand);
          const match = inclusiveMatchingAgent(discovery, market);
          return {
            profile: publicProfile(p),
            match: {
              skillsFirstScore: match.skillsFirstScore,
              potentialAdjusted: match.potentialAdjusted,
              matchTier: match.matchTier,
              gapCount: match.gaps.length,
              potential: discovery.potential, growthReadiness: discovery.growthReadiness,
            },
          };
        }).sort((a, b) => (b.match?.potentialAdjusted ?? -1) - (a.match?.potentialAdjusted ?? -1));
      }
    }

    db.audit({ actor: req.user.email, actorRole: req.user.role, action: 'CANDIDATE_SEARCH',
      note: `Searched candidates${q ? ` for "${q}"` : ''}${requisitionId ? ` against ${requisitionId}` : ''}. Ranking uses capability evidence only.` });

    res.json({
      candidates: ranked,
      rankingBasis: 'Capability and evidence only. Institution, employment continuity, gap duration, gender, age and location are not available to the matching agent.',
    });
  });

  app.get('/api/recruiter/candidates/:id', ...asRecruiter, (req, res) => {
    const p = db.findById('candidateProfiles', req.params.id);
    if (!p) return res.status(404).json({ error: 'Candidate not found.' });
    db.audit({ actor: req.user.email, actorRole: req.user.role, action: 'CANDIDATE_VIEWED',
      subjectType: 'candidateProfile', subjectId: p.id, meta: { candidateProfileId: p.id },
      note: `${req.user.name} opened this candidate's evidence profile.` });
    res.json({
      profile: publicProfile(p),
      evidence: db.filter('evidence', e => e.candidateProfileId === p.id),
      projects: db.filter('projects', x => x.candidateProfileId === p.id),
      repositories: db.filter('githubRepositories', x => x.candidateProfileId === p.id),
      applications: db.filter('applications', a => a.candidateProfileId === p.id).map(publicApp),
    });
  });

  /* --------------------------------------------------------- applications */
  app.get('/api/recruiter/applications', ...asRecruiter, (req, res) => {
    const mine = req.user.role === 'admin'
      ? db.all('requisitions')
      : db.filter('requisitions', r => r.recruiterId === req.user.recruiterId);
    const ids = new Set(mine.map(r => r.id));
    res.json({ applications: db.filter('applications', a => ids.has(a.requisitionId)).map(publicApp) });
  });

  app.post('/api/recruiter/applications/:id/require-assessment', ...asRecruiter, (req, res) => {
    const a = db.findById('applications', req.params.id);
    if (!a) return res.status(404).json({ error: 'Application not found.' });
    const own = ownsRequisition(req, a.requisitionId);
    if (!own.ok) return res.status(own.code).json({ error: own.error });
    const updated = db.update('applications', a.id, { status: 'ASSESSMENT_REQUIRED' });
    db.audit({ actor: req.user.email, actorRole: 'recruiter', action: 'ASSESSMENT_REQUESTED',
      subjectType: 'application', subjectId: a.id,
      meta: { candidateProfileId: a.candidateProfileId, requisitionId: a.requisitionId },
      note: 'Recruiter requested a job-specific assessment for this application.' });
    res.json({ application: publicApp(updated) });
  });
}
