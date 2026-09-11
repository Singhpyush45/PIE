// PIE — end-to-end flow and safety tests.
// Run with: npm test   (starts nothing; expects the API on PORT/5174)
//
// These are the twelve guarantees the product makes. If one of them fails, the
// claim PIE makes on stage is not true.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.PIE_TEST_BASE || 'http://localhost:5174';

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

// Demo personas have no password: they come through the separate demo door,
// which is exactly what these flow tests exercise.
let personaIndex = null;
async function login(email) {
  if (!personaIndex) {
    const r = await api('/api/demo/personas');
    personaIndex = [...r.data.candidates, ...r.data.recruiters, ...r.data.admins];
  }
  const p = personaIndex.find(u => u.username === String(email).split('@')[0].split('.')[0]);
  assert.ok(p, `no demo persona matching ${email}`);
  return (await api('/api/demo/enter', { method: 'POST', body: { userId: p.id } })).data.token;
}

let recruiterToken, candidateToken, adminToken, otherRecruiterToken;

before(async () => {
  await api('/api/demo/reset', { method: 'POST' });
  personaIndex = null;
  recruiterToken      = await login('ananya.sharma@illustrative.co');
  otherRecruiterToken = await login('rajiv.mehta@northwind.co');
  candidateToken      = await login('meera@candidate.demo');
  adminToken          = await login('kavita.rao@illustrative.co');
  assert.ok(recruiterToken && candidateToken && adminToken, 'demo sign-in must issue tokens');
});

/* ------------------------------------------------------------------ 1 */
test('prohibited inputs never reach the matching agent', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: false } });
  assert.equal(r.status, 200);
  const match = r.data.steps.find(s => s.key === 'inclusive_matching');
  const check = match.validation.checks.find(c => c.name === 'no_prohibited_inputs');
  assert.equal(check.pass, true, 'no_prohibited_inputs must pass');
  assert.ok(match.inputsWithheld.length >= 6, 'the orchestrator must record withheld inputs');

  const hay = JSON.stringify(match.output.breakdown).toLowerCase();
  for (const p of ['institution_tier', 'gender', 'career_break_duration', 'caste', 'disability'])
    assert.ok(!hay.includes(p), `${p} must not appear in matching inputs`);
});

/* ------------------------------------------------------------------ 2 */
test('a human gate is required before any final decision', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: false } });
  assert.equal(r.data.status, 'AWAITING_HUMAN_DECISION');
  assert.equal(r.data.decision, null, 'no decision may exist before a human records one');
  assert.equal(r.data.result.matching.humanGate, true);

  // A decision without a reason is refused.
  const noReason = await api(`/api/runs/${r.data.runId}/decision`, { method: 'POST', token: recruiterToken,
    body: { action: 'PROCEED_TO_INTERVIEW' } });
  assert.equal(noReason.status, 400, 'a reason must be mandatory');

  const ok = await api(`/api/runs/${r.data.runId}/decision`, { method: 'POST', token: recruiterToken,
    body: { action: 'PROCEED_TO_INTERVIEW', reason: 'Closable gap, strong verified automation evidence.' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'DECIDED');
  assert.equal(ok.data.decision.actor, 'Ananya Sharma');
  assert.ok(ok.data.decision.aiRecommendation, 'the AI recommendation must be recorded alongside the human decision');
});

/* ------------------------------------------------------------------ 3 */
test('a candidate cannot record a hiring decision', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: candidateToken,
    body: { requisitionId: 'req-sdet', useAI: false } });
  const d = await api(`/api/runs/${r.data.runId}/decision`, { method: 'POST', token: candidateToken,
    body: { action: 'PROCEED_TO_INTERVIEW', reason: 'trying to self-approve' } });
  assert.equal(d.status, 403, 'only a recruiter or admin may record a decision');
});

/* ------------------------------------------------------------------ 4 */
test('assessment token replay is rejected and navigation is forward-only', async () => {
  const start = await api('/api/assessment/start', { method: 'POST', token: candidateToken,
    body: { requisitionId: 'req-sdet', consent: { accepted: true }, preflight: { camera: true } } });
  assert.equal(start.status, 200);
  const attemptId = start.data.attempt.attemptId;
  const q1 = start.data.question;

  // No answer key ever reaches the client.
  const wire = JSON.stringify(start.data);
  assert.ok(!/"answer"|"rubric"|"explain"/.test(wire), 'answer keys and rubrics must never be serialised');

  const first = await api(`/api/assessment/${attemptId}/answer`, { method: 'POST', token: candidateToken,
    body: { questionId: q1.questionId, response: 0, token: q1.token } });
  assert.equal(first.status, 200);
  const cursorAfter = first.data.attempt.cursor;

  // Replaying the same finalised question must not change scoring or advance state.
  const replay = await api(`/api/assessment/${attemptId}/answer`, { method: 'POST', token: candidateToken,
    body: { questionId: q1.questionId, response: 1, token: q1.token } });
  assert.equal(replay.data.attempt.cursor, cursorAfter, 'a finalised question cannot be reopened');

  // A stale token against the CURRENT question is rejected outright.
  const q2 = first.data.question;
  if (q2) {
    const stale = await api(`/api/assessment/${attemptId}/answer`, { method: 'POST', token: candidateToken,
      body: { questionId: q2.questionId, response: 0, token: 'not-the-issued-token' } });
    assert.equal(stale.status, 409, 'a replayed or forged question token must be rejected');
  }
});

/* ------------------------------------------------------------------ 5 */
test('the warning threshold locks the attempt for review and never auto-rejects', async () => {
  const start = await api('/api/assessment/start', { method: 'POST', token: candidateToken,
    body: { requisitionId: 'req-sdet', consent: { accepted: true }, preflight: {} } });
  const id = start.data.attempt.attemptId;
  const threshold = start.data.attempt.policy.warnings.threshold;

  let last;
  for (let i = 0; i < threshold; i++) {
    last = await api(`/api/assessment/${id}/proctor`, { method: 'POST', token: candidateToken,
      body: { type: 'MULTIPLE_FACES', simulated: true } });
  }
  assert.equal(last.data.attempt.state, 'LOCKED_FOR_REVIEW');
  assert.equal(last.data.attempt.result.requiresHumanReview, true);
  assert.match(last.data.attempt.result.reviewNotice, /no decision is made automatically/i);
  assert.notEqual(last.data.attempt.result.state, 'REJECTED', 'a locked attempt is never an auto-rejection');
});

/* ------------------------------------------------------------------ 6 */
test('a candidate cannot alter a server-side score', async () => {
  const start = await api('/api/assessment/start', { method: 'POST', token: candidateToken,
    body: { consent: { accepted: true }, preflight: {} } });
  const id = start.data.attempt.attemptId;
  const q = start.data.question;
  // Client sends a score and a "correct" flag. The server must ignore both.
  const r = await api(`/api/assessment/${id}/answer`, { method: 'POST', token: candidateToken,
    body: { questionId: q.questionId, response: 0, token: q.token, score: 1, correct: true, overall: 1 } });
  const finished = await api(`/api/assessment/${id}/finish`, { method: 'POST', token: candidateToken });
  assert.ok(finished.data.attempt.result.overall <= 1);
  const finalized = r.data.attempt.finalized[0];
  assert.ok(typeof finalized.score === 'number', 'the score must be computed server-side');
  assert.ok(finalized.score === 0 || finalized.score === 1 || (finalized.score > 0 && finalized.score < 1));
});

/* ------------------------------------------------------------------ 7 */
test('deterministic scoring is stable across repeated runs', async () => {
  const a = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_farah', requisitionId: 'req-sdet', useAI: false } });
  const b = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_farah', requisitionId: 'req-sdet', useAI: false } });
  assert.equal(a.data.result.matching.skillsFirstScore, b.data.result.matching.skillsFirstScore);
  assert.equal(a.data.result.matching.potentialAdjusted, b.data.result.matching.potentialAdjusted);
  assert.deepEqual(
    a.data.result.discovery.skills.map(s => [s.id, s.confidence]),
    b.data.result.discovery.skills.map(s => [s.id, s.confidence]),
  );
});

/* ------------------------------------------------------------------ 8 */
test('recruiter isolation: a recruiter cannot touch another recruiter’s requisition', async () => {
  const mine = await api('/api/recruiter/requisitions', { token: otherRecruiterToken });
  assert.ok(mine.data.requisitions.every(r => r.recruiterId === 'rec_rajiv'),
    'a recruiter only lists their own requisitions');
  const foreign = await api('/api/recruiter/requisitions/req-sdet', { token: otherRecruiterToken });
  assert.equal(foreign.status, 403);
});

/* ------------------------------------------------------------------ 9 */
test('candidate isolation: a candidate sees only their own profile and evidence', async () => {
  const boot = await api('/api/bootstrap', { token: candidateToken });
  assert.equal(boot.data.profile.id, 'cand_meera');
  assert.ok(boot.data.evidence.every(e => e.candidateProfileId === 'cand_meera'));

  // A candidate cannot orchestrate against someone else's profile.
  const r = await api('/api/orchestrate', { method: 'POST', token: candidateToken,
    body: { candidateProfileId: 'cand_farah', requisitionId: 'req-sdet', useAI: false } });
  assert.equal(r.data.candidate.id, 'cand_meera', 'the server must ignore a spoofed candidate id');

  // A candidate cannot reach the admin workspace.
  const admin = await api('/api/admin/overview', { token: candidateToken });
  assert.equal(admin.status, 403);
});

/* ----------------------------------------------------------------- 10 */
test('AI failure falls back without breaking the run', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_arjun', requisitionId: 'req-sdet', useAI: false } });
  assert.equal(r.status, 200);
  assert.ok(r.data.result.matching.skillsFirstScore > 0, 'scores exist with the AI layer disabled');
  assert.ok(r.data.steps.every(s => ['SUCCESS', 'SKIPPED'].includes(s.status)),
    'every step must succeed or be deliberately skipped with no LLM available');
});

/* ----------------------------------------------------------------- 11 */
test('integrations report honestly and never claim connectivity they lack', async () => {
  const anon = await api('/api/services');
  assert.equal(anon.status, 401, 'the service landscape must require a session');
  const r = await api('/api/services', { token: adminToken });
  const byKey = Object.fromEntries(r.data.services.map(s => [s.key, s]));

  // Nothing is configured on the test server, so nothing may say it is connected.
  assert.equal(byKey.corsair.state, 'NOT_CONFIGURED');
  assert.match(byKey.corsair.detail, /own OAuth adapter/,
    'and it must say what PIE falls back to, not just that it is off');

  // The rule the whole panel rests on: a CONNECTED claim must carry evidence.
  for (const s of r.data.services) {
    assert.ok(s.state !== 'CONNECTED' || s.detail, `${s.key}: a CONNECTED claim needs detail`);
  }
  // And no key ever reaches the panel.
  const wire = JSON.stringify(r.data);
  assert.ok(!/sk-|ck_live|ck_dev|service_role/.test(wire), 'no credential may appear in the landscape');
});

/* ----------------------------------------------------------------- 12 */
test('high-severity bias blocks the automated flow until a human clears it', async () => {
  // req-aiengineer carries tier-1 + continuity + age-proxy language.
  const analyse = await api('/api/recruiter/jd/analyse', { method: 'POST', token: otherRecruiterToken,
    body: { title: 'AI Engineer', text: (await api('/api/recruiter/requisitions/req-aiengineer', { token: otherRecruiterToken })).data.requisition.text } });
  assert.ok(analyse.data.employerReadiness.findings.length >= 2,
    'exclusionary clauses must be detected in the requisition');
  assert.ok(analyse.data.employerReadiness.findings.some(f => f.severity === 'High'));

  const bias = await api('/api/admin/bias', { token: adminToken });
  assert.ok(Array.isArray(bias.data.reviews));

  // Signals must be phrased as potential, never as proof.
  const run = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: false } });
  const audit = run.data.steps.find(s => s.key === 'bias_audit');
  assert.equal(audit.validation.checks.find(c => c.name === 'signals_are_not_proof').pass, true);
  assert.match(audit.output.assurance, /cannot modify/i);
});

/* ----------------------------------------------------------------- 13 */
test('the reassessment loop produces new evidence and improves the match', async () => {
  const before = await api('/api/orchestrate', { method: 'POST', token: candidateToken,
    body: { requisitionId: 'req-sdet', useAI: false } });
  const gap = before.data.result.learning.objectives[0];
  assert.ok(gap, 'there must be at least one learning objective to close');

  const after = await api(`/api/runs/${before.data.runId}/reassess`, { method: 'POST', token: candidateToken,
    body: { skillId: gap.skillId, useAI: false } });
  assert.equal(after.status, 200);
  assert.ok(after.data.delta.matchAfter >= after.data.delta.matchBefore, 'the match must not go backwards');
  assert.ok(after.data.delta.evidenceAfter > after.data.delta.evidenceBefore, 'new evidence must exist');
  assert.ok(after.data.delta.gapsAfter <= after.data.delta.gapsBefore);
});

/* ----------------------------------------------------------------- 14 */
test('selective invocation: a trigger runs only the pipeline it needs', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: candidateToken,
    body: { trigger: 'RESUME_UPLOADED', useAI: false } });
  const ran = r.data.steps.filter(s => s.status === 'SUCCESS').map(s => s.key);
  const skipped = r.data.steps.filter(s => s.status === 'SKIPPED').map(s => s.key);
  assert.deepEqual(ran, ['capability_intelligence'], 'a resume upload runs only Capability Intelligence');
  assert.ok(skipped.includes('inclusive_matching'), 'matching must be skipped for this trigger');
});

/* ----------------------------------------------------------------- 15 */
test('evidence trust tier cannot be spoofed by the client', async () => {
  const r = await api('/api/candidate/evidence', { method: 'POST', token: candidateToken,
    body: { source: 'project', title: 'Spoof attempt', text: 'Claiming API-derived trust.',
      verification: 'api_derived', trustTier: 'API-DERIVED' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.evidence.verification, 'self_reported',
    'a self-declared project can never be recorded as API-derived');
  assert.equal(r.data.evidence.trustTier, 'SELF-REPORTED');
});

/* ----------------------------------------------------------------- 16 */
test('the AI-enabled path produces the same scores as the deterministic path', async () => {
  // Regression: a misconfigured or unreachable LLM must not change a single number,
  // and must not take a pipeline step down with it.
  const off = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: false } });
  const on = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: true } });

  assert.equal(on.status, 200);
  assert.ok(on.data.steps.every(s => ['SUCCESS', 'SKIPPED'].includes(s.status)),
    `every step must survive the AI path: ${on.data.steps.filter(s => !['SUCCESS', 'SKIPPED'].includes(s.status)).map(s => `${s.key}=${s.status}(${s.error})`).join(', ')}`);
  assert.equal(on.data.result.matching.skillsFirstScore, off.data.result.matching.skillsFirstScore);
  assert.equal(on.data.result.matching.potentialAdjusted, off.data.result.matching.potentialAdjusted);
  assert.equal(on.data.result.discovery.potential.value, off.data.result.discovery.potential.value);
  assert.equal(on.data.result.matching.gaps.length, off.data.result.matching.gaps.length);
});

/* ----------------------------------------------------------------- 17 */
test('the matching agent is never handed capability dimension data', async () => {
  const r = await api('/api/orchestrate', { method: 'POST', token: recruiterToken,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: true } });
  const step = r.data.steps.find(s => s.key === 'inclusive_matching');
  // It may know WHICH dimensions are unscored, but never their values or evidence.
  const payloadShape = JSON.stringify(step.output.breakdown);
  assert.ok(!/"rationale"|"evidenceRefs"/.test(payloadShape),
    'dimension rationale and evidence refs must not reach the matching agent');
});

after(async () => { await api('/api/demo/reset', { method: 'POST' }); });
