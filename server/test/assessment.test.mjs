// PIE — assessment engine tests.
//
// These cover the properties that decide whether the assessment is fair, not
// just whether it runs:
//
//   • two candidates for one role are examined on the SAME competencies
//     (different questions are fine; different subjects are not)
//   • a candidate never sees a question family they were already asked
//   • an option shuffle never loses the correct answer
//   • a malformed or off-role generated question never reaches a candidate
//
// They use a stub provider on localhost, so no key and no network are needed
// and the result does not depend on what a real model happens to return today.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* A stand-in for Gemini that returns well-formed, varied questions. */
let served = 0;
const TOPICS = [
  'a connection pool exhausted during burst traffic',
  'a window function returning unexpected partitions',
  'a generator that silently swallows an exception',
  'an index that stopped being used after a column type change',
  'a retry loop that duplicates writes on timeout',
  'a transaction left open by an early return',
];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    served += 1;
    const mk = i => ({
      type: 'mcq', difficulty: 'Medium', skill: i % 2 ? 'sql' : 'python',
      prompt: `Investigate ${TOPICS[(served * 4 + i) % TOPICS.length]}. What is the most defensible first step?`,
      options: [`Check ${served}${i} pool limits`, `Rebuild ${served}${i} the index`,
                `Add ${served}${i} a retry`, `Raise ${served}${i} the timeout`],
      answer: i % 4,
      explain: 'The failure begins at the layer that changed, so that is where the evidence is.',
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ questions: [mk(1), mk(2), mk(3), mk(4)] }) } }] }));
  });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
process.env.GEMINI_API_KEY = 'test-only-not-a-real-key';
process.env.GEMINI_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.PIE_DATA_DIR = process.env.PIE_DATA_DIR || '/tmp/pie-assessment-test';

// The coding path must really run, or the tests that check hidden results are
// masked would pass against a payload that was empty for a different reason.
const { installFakeSandbox } = await import('./fakeSandbox.mjs');
installFakeSandbox();

const ai = await import('../src/assessmentAI.js');
const engine = await import('../src/assessment.js');

const candidate = id => ({ id, name: 'Test', evidence: [{ title: 'Pipeline', source: 'project', text: 'Python and SQL work.' }] });
const JOB = { targetSkills: ['python', 'sql'], role: 'Data Engineer', jobText: 'Python and SQL required.' };

test('two candidates for one role get different questions on the same competencies', async () => {
  const a = await engine.buildAssessment({ candidate: candidate('cand_test_a'), ...JOB });
  const b = await engine.buildAssessment({ candidate: candidate('cand_test_b'), ...JOB });

  const same = a.questions.filter(q => b.questions.some(x => x.prompt === q.prompt));
  assert.ok(same.length < a.questions.length,
    'every question was identical — the assessment is not candidate-specific');

  assert.deepEqual(
    [...new Set(a.questions.map(q => q.skill))].sort(),
    [...new Set(b.questions.map(q => q.skill))].sort(),
    'the two candidates were examined on different subjects, so their scores are not comparable');
  assert.equal(a.blueprint.questionCount, b.blueprint.questionCount);
  assert.equal(a.blueprint.competencyEquivalent, true);
  assert.equal(a.blueprint.offTargetSkills.length, 0, 'a question outside the role reached the paper');
});

test('a retake repeats nothing unless it says it had to', async () => {
  const first = await engine.buildAssessment({ candidate: candidate('cand_test_r'), ...JOB });
  const banned = new Set(first.questions.map(q => q.familyId));
  const second = await engine.buildAssessment({ candidate: candidate('cand_test_r'), ...JOB, bannedFamilies: banned });
  const repeats = second.questions.filter(q => banned.has(q.familyId));

  if (!second.blueprint.repetitionRelaxed) {
    assert.equal(repeats.length, 0, `retake repeated ${repeats.length} families without declaring it`);
  } else {
    // Reuse is allowed only as the alternative to a short paper, and it must be
    // visible to the recruiter comparing the two attempts.
    assert.ok(repeats.length > 0, 'relaxation was declared but nothing was actually reused');
    assert.equal(second.blueprint.questionCount, first.blueprint.questionCount);
  }
});

test('an attempt with no requisition still builds', async () => {
  // The start route passes null targetSkills for a self-assessment. A default
  // parameter does not cover null, and this used to throw before a candidate
  // ever saw a question.
  for (const skills of [null, undefined, []]) {
    const a = await engine.buildAssessment({ candidate: candidate('cand_test_n'), targetSkills: skills });
    assert.ok(a.questions.length > 0, `targetSkills=${String(skills)} produced no questions`);
  }
});

test('a candidate who has seen the whole bank still gets a full paper', async () => {
  // Held as a hard rule, anti-repetition eventually empties the paper: every
  // remaining family is banned and the attempt cannot start. It must degrade to
  // a declared repeat instead of to nothing.
  const banned = new Set();
  let relaxedAt = null;
  for (let n = 1; n <= 6; n++) {
    const a = await engine.buildAssessment({ candidate: candidate('cand_test_x'), targetSkills: [], bannedFamilies: banned });
    assert.ok(a.questions.length >= 4, `attempt ${n} produced only ${a.questions.length} questions`);
    if (a.blueprint.repetitionRelaxed && relaxedAt === null) relaxedAt = n;
    a.questions.forEach(q => banned.add(q.familyId));
  }
  assert.ok(relaxedAt !== null, 'the pool was exhausted but no repetition was declared');
});

test('the paper keeps the blueprint\'s question-type mix', async () => {
  // The stub only writes MCQs. Taking whatever the model returns would produce
  // an all-MCQ paper: easier than the blueprint promised, and the candidate's
  // coding never examined at all.
  const a = await engine.buildAssessment({ candidate: candidate('cand_test_t'), ...JOB });
  const types = a.questions.map(q => q.type);
  assert.ok(types.some(t => t !== 'mcq'),
    'every question was an MCQ — the generator overrode the blueprint instead of filling it');
  assert.equal(a.questions.length, a.blueprint.questionCount);
  // Whatever could not be supplied must be declared, not silently dropped.
  assert.ok(Array.isArray(a.blueprint.unfilledTypes));
});

test('shuffling options never loses the correct answer', () => {
  for (let i = 0; i < 300; i++) {
    const q = { type: 'mcq', options: ['alpha', 'beta', 'gamma', 'delta'], answer: i % 4 };
    const s = ai.shuffleOptions(q);
    assert.equal(s.options[s.answer], q.options[q.answer]);
  }
  for (let i = 0; i < 300; i++) {
    const q = { type: 'multi_select', options: ['a', 'b', 'c', 'd', 'e'], answer: [0, 2] };
    const s = ai.shuffleOptions(q);
    assert.deepEqual(s.answer.map(x => s.options[x]).sort(), ['a', 'c']);
  }
});

test('validation rejects questions that would be unfair to score', () => {
  const base = {
    type: 'mcq', difficulty: 'Medium', skill: 'python',
    prompt: 'A service returns stale rows after a deployment. What is the most likely cause?',
    options: ['Cache key', 'Index', 'Timeout', 'Retry'], answer: 0,
    explain: 'The cache key no longer matches after the migration.',
  };
  const ctx = { targetSkills: ['python', 'sql'] };
  assert.equal(ai.validateQuestion(base, ctx).ok, true);

  const rejects = {
    ANSWER: { ...base, answer: 9 },
    CONTENT: { ...base, prompt: 'Explain.' },
    RELEVANCE: { ...base, skill: 'cobol' },
    SCHEMA: { ...base, difficulty: 'Impossible' },
  };
  for (const [code, q] of Object.entries(rejects)) {
    const r = ai.validateQuestion(q, ctx);
    assert.equal(r.ok, false, `${code} case was accepted`);
    assert.equal(r.code, code);
  }

  const dup = ai.validateQuestion(base, { ...ctx, existing: [base] });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'DUPLICATE');
});

test('reused framing is not mistaken for a duplicate question', () => {
  // A model reuses phrasing across genuinely different questions. Treating that
  // as duplication throws the batch away and everyone falls back to the bank.
  const tail = ' The team reports it began after the last release. What is your first step?';
  const a = { ...{}, prompt: 'Investigate a pool exhausted under load.' + tail, options: ['pool', 'index', 'retry', 'cache'] };
  const b = { prompt: 'Investigate a CTE that blows memory.' + tail, options: ['rewrite', 'index', 'memory', 'shard'] };
  assert.ok(ai.similarity(a.prompt, b.prompt, a.options, b.options) < 0.78,
    'two different questions with shared framing were treated as duplicates');
});

test('non-Latin questions get real fingerprints, not empty ones', () => {
  // The fingerprint and the duplicate check both normalise text. An ASCII-only
  // normaliser emptied every Devanagari prompt, which gave all of them the same
  // family id — one Hindi question would have banned the whole category — and
  // made duplicate detection compare two empty sets.
  const hi = d => ({
    type: 'mcq', difficulty: 'Medium', skill: 'sql',
    prompt: d === 1
      ? 'कौन सा इंडेक्स टाइमस्टैम्प कॉलम पर रेंज स्कैन का समर्थन करता है?'
      : 'एक क्वेरी डिप्लॉय के बाद धीमी क्यों हो सकती है?',
    options: ['btree', 'hash', 'gin', 'brin'], answer: 0,
  });
  assert.notEqual(ai.familyId(hi(1)), ai.familyId(hi(2)),
    'two different Hindi questions share a family id — the normaliser dropped the text');

  const same = ai.similarity(hi(1).prompt, hi(1).prompt, hi(1).options, hi(1).options);
  const diff = ai.similarity(hi(1).prompt, hi(2).prompt, hi(1).options, ['a', 'b', 'c', 'd']);
  assert.ok(same > 0.9, 'a Hindi question is not similar to itself — the text was normalised away');
  assert.ok(diff < 0.78, 'two unrelated Hindi questions were called duplicates');
});

test('choosing a language declares what it does and does not change', async () => {
  const hiPaper = await engine.buildAssessment({ candidate: candidate('cand_test_l'), ...JOB, language: 'hi' });
  assert.equal(hiPaper.blueprint.language, 'hi');
  // The bank is English-only, so any bank top-up makes the paper mixed and that
  // must be visible rather than discovered on question three.
  if ((hiPaper.blueprint.sourceMix.verified_bank || 0) > 0) {
    assert.equal(hiPaper.blueprint.mixedLanguage, true, 'a mixed-language paper did not say so');
  }
  // Ambiguity checks are English patterns; a non-English paper is validated less.
  assert.equal(hiPaper.blueprint.validationReducedForLanguage, true);

  const en = await engine.buildAssessment({ candidate: candidate('cand_test_l2'), ...JOB, language: 'en' });
  assert.equal(en.blueprint.mixedLanguage, false);
  assert.equal(en.blueprint.validationReducedForLanguage, false);

  // An unsupported code must fall back, never reach the model as free text.
  const junk = await engine.buildAssessment({ candidate: candidate('cand_test_l3'), ...JOB, language: 'xx-INVALID' });
  assert.equal(junk.blueprint.language, 'en');
});

/* ─────────────────────────────────────────── recruiter-authored questions */

const MINE = [1, 2, 3].map(i => ({
  id: `rq-test-${i}`,
  type: i === 3 ? 'coding_easy' : 'mcq',
  difficulty: 'Medium',
  skill: i % 2 ? 'sql' : 'python',
  prompt: `RECRUITER QUESTION ${i}: how would you validate a nightly load against the source system?`,
  ...(i === 3
    ? { starterCode: 'def check():\n    pass', rubric: ['handles nulls', 'reconciles counts'] }
    : { options: [`Own ${i}A`, `Own ${i}B`, `Own ${i}C`, `Own ${i}D`], answer: 1 }),
  explain: 'The recruiter\'s own rationale for why this answer is the right one.',
}));
const by = (a, src) => a.questions.filter(q => q.source === src).length;

test('FULL_AI asks none of the recruiter\'s questions', async () => {
  const a = await engine.buildAssessment({
    candidate: candidate('cand_mode_a'), ...JOB, mode: 'FULL_AI', recruiterQuestions: MINE });
  assert.equal(by(a, 'recruiter_authored'), 0);
  assert.equal(a.blueprint.mode, 'FULL_AI');
});

test('RECRUITER_ONLY asks nothing the recruiter did not write', async () => {
  const a = await engine.buildAssessment({
    candidate: candidate('cand_mode_r'), ...JOB, mode: 'RECRUITER_ONLY', recruiterQuestions: MINE });
  assert.equal(by(a, 'ai_generated'), 0, 'a generated question reached a recruiter-only paper');
  assert.equal(by(a, 'verified_bank'), 0, 'a bank question reached a recruiter-only paper');
  assert.equal(a.questions.length, MINE.length);

  // Each authored question appears at most once. Slot matching pushes copies, so
  // identity checks silently allow the same question into several slots.
  const ids = a.questions.map(q => q.id);
  assert.equal(new Set(ids).size, ids.length, `a question was asked twice: ${ids.join(', ')}`);

  // A short pool is the recruiter's trade-off, but it must be declared rather
  // than looking like PIE failed to build a full paper.
  assert.equal(a.blueprint.recruiterPoolShort, true);
  assert.ok(a.blueprint.plannedQuestionCount > a.questions.length);
});

test('HYBRID asks the recruiter\'s questions first, then fills the rest', async () => {
  const a = await engine.buildAssessment({
    candidate: candidate('cand_mode_h'), ...JOB, mode: 'HYBRID', recruiterQuestions: MINE });
  assert.equal(by(a, 'recruiter_authored'), MINE.length, 'the recruiter\'s questions were crowded out');
  assert.ok(by(a, 'ai_generated') + by(a, 'verified_bank') > 0, 'nothing filled the remaining slots');
  assert.equal(a.questions.length, a.blueprint.plannedQuestionCount);
  assert.equal(a.blueprint.recruiterAuthored, MINE.length);
});

test('an unknown mode falls back rather than building an empty paper', async () => {
  const a = await engine.buildAssessment({
    candidate: candidate('cand_mode_x'), ...JOB, mode: 'WHATEVER', recruiterQuestions: MINE });
  assert.equal(a.blueprint.mode, 'FULL_AI');
  assert.ok(a.questions.length > 0);
});

/* ───────────────────────────────────────── hidden test cases stay hidden */

test('a coding question sends its examples but never its hidden tests', async () => {
  // Checked on the ACTUAL payloads a candidate receives: the question envelope
  // (currentQuestion) and, after finalising, the per-answer execution detail.
  // An earlier version of this test inspected publicAttempt at start time,
  // where neither has been populated yet — it passed with the masking removed.
  const a = await engine.startAttempt({
    candidate: candidate('cand_hide'), targetSkills: ['dataquality', 'python'],
    consent: { accepted: true }, preflight: { camera: true },
  });
  const idx = a.questions.findIndex(q => Array.isArray(q.tests) && q.tests.some(t => t.hidden));
  assert.ok(idx >= 0, 'no coding question with hidden tests was built — the fixture is wrong');
  a.cursor = idx;

  const q = a.questions[idx];
  const hidden = q.tests.filter(t => t.hidden);
  const visible = q.tests.filter(t => !t.hidden);

  // 1. the question envelope
  const envelope = JSON.stringify(engine.currentQuestion(a));
  for (const t of hidden) {
    assert.ok(!envelope.includes(t.id), `hidden test id ${t.id} reached the candidate's question`);
    const exp = JSON.stringify(t.expected);
    if (exp.length > 6) assert.ok(!envelope.includes(exp), `hidden expected value ${exp} reached the candidate`);
  }
  assert.ok(envelope.includes(visible[0].id), 'the visible examples were withheld too');
  assert.match(envelope, new RegExp(`"hiddenTestCount":\\s*${hidden.length}`),
    'the candidate is not told how many hidden tests there are');

  // 2. the finalised answer, where execution results live
  const { attempt } = await engine.submitAnswer(a, {
    questionId: q.id, response: 'def ' + (q.entryPoint || 'solve') + '(*a):\n    return None\n',
    token: a.currentToken,
  });
  const wire = JSON.stringify(engine.publicAttempt(attempt));
  for (const t of hidden) {
    assert.ok(!wire.includes(t.id), `hidden test id ${t.id} was serialised in the finalised answer`);
  }
});

test('a coding answer is never given a score PIE cannot compute', async () => {
  // With no sandbox the answer is carried as pending. A zero would read as "the
  // candidate got it wrong", which is a different and false statement.
  const saved = process.env.PIE_DOCKER_BIN;
  process.env.PIE_DOCKER_BIN = 'definitely-not-a-real-docker-binary';
  // capabilities() caches, so the cache has to be re-read after hiding docker —
  // otherwise this test silently runs against the sandbox it means to remove.
  const runner = await import('../src/execution/runner.js');
  await runner.capabilities({ refresh: true });
  try {
    const a = await engine.startAttempt({
      candidate: candidate('cand_pending'), targetSkills: ['dataquality'],
      consent: { accepted: true }, preflight: { camera: true },
    });
    const idx = a.questions.findIndex(q => q.type.startsWith('coding'));
    if (idx < 0) return;
    a.cursor = idx;
    engine.currentQuestion(a);                     // mints the token and deadline
    const { attempt } = await engine.submitAnswer(a, {
      questionId: a.questions[idx].id,
      response: 'def solve(a, b):\n    return []\n',
      token: a.currentToken,
    });
    const f = attempt.finalized.at(-1);
    assert.equal(f.pending, true, 'a coding answer was scored with no sandbox available');
    assert.ok(f.pendingReason, 'pending with no reason given');
  } finally {
    process.env.PIE_DOCKER_BIN = saved;
    await runner.capabilities({ refresh: true });
  }
});

test('every coding question in the bank can be scored, or says why it cannot', async () => {
  // The gap this closes: q-api-2 asked for a pytest test taking a `client`
  // fixture. It could never be executed, was not marked review-only, and so
  // reached candidates as a coding question with no examples, no way to score
  // it, and no explanation. One unscoreable question is a bug; the class of bug
  // is what this catches.
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    const a = await engine.buildAssessment({
      candidate: candidate(`cand_bank_${i}`),
      targetSkills: [], role: null,
    });
    for (const q of a.questions) {
      if (!(q.type.startsWith('coding') || q.type === 'debugging')) continue;
      if (seen.has(q.id)) continue;
      seen.add(q.id);

      if (q.reviewOnly) {
        assert.ok(q.reviewReason, `${q.id} is review-only but does not say why`);
        continue;
      }
      assert.ok(Array.isArray(q.tests) && q.tests.length >= 2,
        `${q.id} has no test cases and is not marked review-only, so it can never be scored`);
      assert.ok(q.tests.some(t => t.hidden), `${q.id} has no hidden test, so it scores on the visible examples`);
      assert.ok(q.tests.some(t => !t.hidden), `${q.id} has no visible example for the candidate`);
      assert.ok(q.entryPoint, `${q.id} has test cases but no entry point to call`);
      assert.ok(q.language, `${q.id} has test cases but no language to run them in`);
    }
  }
  assert.ok(seen.size >= 3, `only ${seen.size} coding question(s) were ever built — the sweep is too narrow`);
});

test.after(() => stub.close());
