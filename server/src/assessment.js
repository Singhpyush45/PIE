// PIE — AI Mini Assessment: one evidence source of seven.
// Server-authoritative timing, JIT question delivery, forward-only state machine,
// answer keys never leaving the server, and a warning policy engine.
//
// Timing + warning matrices follow "PIE SRS — Advanced Assessment Security v1.0"
// (Tables: Assessment Timing Matrix, Proctoring Warning Matrix).

import crypto from 'node:crypto';
import { ONTOLOGY, SKILL_BY_ID } from './data.js';
import { execute } from './execution/runner.js';
import { generateQuestions, shuffle, shuffleOptions, familyId, assessmentAIStatus,
  LANGUAGES, isSupportedLanguage,
  ASSESSMENT_MODES, isAssessmentMode, DEFAULT_MODE } from './assessmentAI.js';

/* ------------------------------------------------------- ASSESSMENT POLICY */
// Immutable once attached to a live attempt (SRS §14).
export const ASSESSMENT_POLICY = {
  policyId: 'AP-2026-09-A',
  version: 2,
  source: 'PIE SRS — Advanced Assessment Security v1.0, Assessment Timing Matrix',
  timing: {
    // MCQ duration varies by difficulty; every other type has a single duration.
    mcq:            { byDifficulty: { Easy: 45, Medium: 60, Hard: 90 },
                      label: 'MCQ',              authority: 'Server', expiry: 'Finalize / skip',      back: false },
    multi_select:   { byDifficulty: { Easy: 60, Medium: 90, Hard: 120 },
                      label: 'Multiple-select',  authority: 'Server', expiry: 'Finalize / skip',      back: false },
    short_answer:   { seconds: 180,  label: 'Short answer',     authority: 'Server', expiry: 'Finalize',             back: false },
    coding_easy:    { seconds: 300,  label: 'Coding — easy',    authority: 'Server', expiry: 'Submit current state', back: false },
    coding_medium:  { seconds: 900,  label: 'Coding — medium',  authority: 'Server', expiry: 'Submit current state', back: false },
    coding_hard:    { seconds: 1500, label: 'Coding — hard',    authority: 'Server', expiry: 'Submit current state', back: false },
    debugging:      { seconds: 600,  label: 'Debugging',        authority: 'Server', expiry: 'Submit current state', back: false },
  },
  // Lowered from 5 to 3. Five gave a candidate a lot of room before anything
  // happened, which made the signals feel decorative. Three is strict enough to
  // mean something and still forgiving of one genuine mishap — a delivery at the
  // door, a laptop lid closing — because reaching it does NOT reject anyone. It
  // stops the attempt and hands it to a person.
  warnings: { threshold: 3, configurableMax: 6, terminateOnThreshold: true },
  gracePeriods: { noFaceMs: 6000, networkMs: 15000 },
  note: 'Timing and warning values are frozen at attempt start and cannot be altered for a live attempt.',
  // The claim PIE makes about its own integrity monitoring, stated once, here,
  // so every surface quotes the same thing. Browser-based signals cannot see a
  // second device, a person off camera, notes on paper, OS-level automation, a
  // remote-control tool or a VM — and a product that says otherwise is lying to
  // both the candidate and the recruiter.
  integrityPosture: 'DEFENCE_IN_DEPTH',
  integrityClaim: 'Defence-in-depth assessment integrity: several independent layers that raise the effort required to cheat and record what happened for a human to review. Not cheat-proof, and not represented as such.',
  // Said once, here, because it is the sentence people get wrong about
  // proctoring: a breach is an event worth a human looking at, not a verdict.
  breachMeaning: 'An integrity breach means something happened that a person should look at. It is never treated as proof of cheating, and reaching the threshold stops the attempt for review rather than rejecting the candidate.',
  integrityLimits: [
    'A second device, or a person off camera, is not detectable from the browser.',
    'Operating-system automation, remote-control software and virtual machines are not detectable from the browser.',
    'Notes on paper are not detectable.',
    'Blocking paste raises effort; it does not prevent a determined candidate from retyping an answer.',
  ],
};

// Proctoring Warning Matrix (SRS §52) — drives the candidate-facing warning UX.
export const WARNING_MATRIX = {
  // `breach: true` marks a signal that goes to the integrity count. The others
  // are recorded as context. What a breach is NOT: proof of cheating. It is an
  // event a human is asked to look at.
  MULTIPLE_FACES:  { signal: 'More than one face in frame', detection: 'Face count above one, sustained across several checks', action: 'Please make sure only you are visible in the camera frame.', severity: 'warning', breach: true, escalation: '3 cumulative → attempt is submitted and locked for human review' },
  NO_FACE:         { signal: 'No face in frame',        detection: 'No face found after the grace period', action: 'Please re-centre yourself in the camera frame.', severity: 'warning', breach: true, escalation: '3 cumulative → attempt is submitted and locked for human review' },
  FACE_CHANGED:    { signal: 'The person in frame appears to have changed', detection: 'Face geometry shifted abruptly between checks while a face stayed present', action: 'Please stay in front of your own camera for the whole assessment.', severity: 'warning', breach: true, escalation: '3 cumulative → attempt is submitted and locked for human review' },
  CAMERA_LOST:     { signal: 'Camera unavailable',      detection: 'Video track ended or unusable', action: 'Please reconnect your camera to continue.', severity: 'warning', breach: true, escalation: 'Per policy' },
  MIC_LOST:        { signal: 'Microphone unavailable',  detection: 'Audio track ended', action: 'Please reconnect your microphone.', severity: 'warning', breach: true, escalation: 'Per policy' },
  SCREEN_ENDED:    { signal: 'Screen sharing stopped',  detection: 'Display track ended', action: 'Please share your screen again to continue.', severity: 'warning', breach: true, escalation: 'Repeated → attempt is submitted and locked for human review' },
  FOCUS_LOST:      { signal: 'You left the assessment window', detection: 'Browser visibility / focus event', action: 'Please return to the assessment tab and stay on it.', severity: 'warning', breach: true, escalation: 'Per policy' },
  FULLSCREEN_EXIT: { signal: 'Fullscreen exited',       detection: 'Fullscreen state change', action: 'Please re-enter fullscreen to continue.', severity: 'warning', breach: true, escalation: 'Per policy' },
  NETWORK_LOST:    { signal: 'Connection interrupted',  detection: 'Heartbeat missed', action: 'Reconnecting — your timer is unaffected.', severity: 'info', escalation: 'Grace period; no timer extension' },
  // Recorded, never counted. A blocked paste is CONTEXT for the recruiter — it
  // may be a prepared answer, or it may be the candidate moving their own draft
  // between windows. Counting it toward the lock threshold would punish the
  // second case, and PIE cannot tell the two apart from a paste event alone.
  PASTE_BLOCKED:   { signal: 'Paste into the answer box was blocked', detection: 'Paste or drop event on the answer field', action: 'Pasting is disabled — please type your answer.', severity: 'info', escalation: 'Recorded for the recruiter; never counted toward the warning threshold' },
};

/* ------------------------------------------------------------ QUESTION BANK */
// `answer` and `rubric` are stored here and are NEVER serialised to a client.
const BANK = [
  { id: 'q-dq-1', skill: 'dataquality', type: 'mcq', difficulty: 'Easy',
    prompt: 'A nightly load reports 100% row-count parity with the source, yet downstream revenue totals are wrong. Which data-quality dimension has most likely failed?',
    options: ['Completeness', 'Accuracy', 'Timeliness', 'Uniqueness'], answer: 1,
    explain: 'Row counts match, so completeness holds. Values themselves are wrong — that is accuracy.' },
  { id: 'q-dq-2', skill: 'dataquality', type: 'mcq', difficulty: 'Medium',
    prompt: 'You must detect duplicate customer records where the same person appears with different formatting. Which check belongs in the validation suite?',
    options: ['NOT NULL constraint on email', 'Normalised-key uniqueness check', 'Row-count reconciliation', 'Schema drift detection'], answer: 1,
    explain: 'Normalising the key before a uniqueness test is what catches formatting-variant duplicates.' },
  { id: 'q-dq-3', skill: 'dataquality', type: 'multi_select', difficulty: 'Medium',
    prompt: 'Which of these belong in a reconciliation report between a source system and a warehouse table? (Select all that apply.)',
    options: ['Row-count delta', 'Sum-of-measure delta', 'Query execution plan', 'Late-arriving record count'], answer: [0, 1, 3],
    explain: 'Execution plans are a performance artefact, not a reconciliation output.' },
  { id: 'q-dq-4', skill: 'dataquality', type: 'coding_easy', difficulty: 'Easy',
    // Rules are DATA, not callables. Test inputs travel to the sandbox as JSON,
    // so a question whose arguments are functions cannot be auto-tested — and a
    // test case that can never run is worse than none at all.
    prompt: 'Write `find_violations(rows, rules)` returning every rule violation as `[row_index, rule_index]`. Each rule is a dict like `{"field": "amount", "op": "not_null"}` or `{"field": "amount", "op": "min", "value": 0}`. A row violates a rule when the rule does not hold.',
    starter: 'def find_violations(rows, rules):\n    # rules: [{"field": ..., "op": "not_null"|"min", "value": ...}]\n    # return a list of [row_index, rule_index] for each failure\n    pass\n',
    language: 'python', entryPoint: 'find_violations',
    // Two visible so the candidate can see the shape, three hidden so tuning to
    // the examples does not pass. Hidden tests never reach the browser.
    tests: [
      { id: 'dq4-v1', hidden: false, label: 'one null violates not_null',
        input: [[{ amount: 5 }, { amount: null }], [{ field: 'amount', op: 'not_null' }]], expected: [[1, 0]] },
      { id: 'dq4-v2', hidden: false, label: 'nothing fails',
        input: [[{ amount: 2 }], [{ field: 'amount', op: 'min', value: 0 }]], expected: [] },
      { id: 'dq4-h1', hidden: true, input: [[], [{ field: 'amount', op: 'not_null' }]], expected: [] },
      { id: 'dq4-h2', hidden: true,
        input: [[{ amount: null }, { amount: null }], [{ field: 'amount', op: 'not_null' }]], expected: [[0, 0], [1, 0]] },
      { id: 'dq4-h3', hidden: true, label: 'second rule is the one that fails',
        input: [[{ amount: -1 }], [{ field: 'amount', op: 'not_null' }, { field: 'amount', op: 'min', value: 0 }]],
        expected: [[0, 1]] },
    ],
    rubric: ['iterates rows and rules', 'collects failures rather than raising', 'returns index pairs'],
    explain: 'A validation harness reports every violation, it does not stop at the first one.' },
  { id: 'q-dq-5', skill: 'dataquality', type: 'coding_medium', difficulty: 'Medium',
    prompt: 'Write `reconcile(source_rows, target_rows, key, measure)` returning a reconciliation summary: row-count delta, sum-of-measure delta, keys missing from target, and keys only in target.',
    starter: 'def reconcile(source_rows, target_rows, key, measure):\n    # return {"row_delta":…, "measure_delta":…, "missing_in_target":[…], "extra_in_target":[…]}\n    pass\n',
    language: 'python', entryPoint: 'reconcile',
    tests: [
      { id: 'dq5-v1', hidden: false, label: 'one key missing downstream',
        input: [[{ k: 'a', m: 10 }, { k: 'b', m: 5 }], [{ k: 'a', m: 10 }], 'k', 'm'],
        expected: { row_delta: 1, measure_delta: 5, missing_in_target: ['b'], extra_in_target: [] } },
      { id: 'dq5-h1', hidden: true,
        input: [[], [], 'k', 'm'],
        expected: { row_delta: 0, measure_delta: 0, missing_in_target: [], extra_in_target: [] } },
      { id: 'dq5-h2', hidden: true,
        input: [[{ k: 'a', m: 1 }], [{ k: 'a', m: 1 }, { k: 'z', m: 3 }], 'k', 'm'],
        expected: { row_delta: -1, measure_delta: -3, missing_in_target: [], extra_in_target: ['z'] } },
    ],
    rubric: ['builds keyed lookups from both sides', 'computes row-count delta', 'computes sum-of-measure delta', 'reports missing and extra keys separately', 'returns a summary object'],
    explain: 'A reconciliation must report both the magnitude of the difference and which keys caused it.' },
  { id: 'q-sql-3', skill: 'sql', type: 'coding_hard', difficulty: 'Hard',
    prompt: 'Write a SQL query that, for every account, returns the first month in which its cumulative transaction amount crossed 100000 — and NULL for accounts that never cross it.',
    starter: '-- tables: txn(account_id, txn_date, amount)\n-- return: account_id, first_crossing_month\n',
    // No test cases: the answer is a SQL query, not a function the Python or
    // JavaScript harness can call. PIE does not run a database in the sandbox,
    // so this question is honestly marked for recruiter review rather than
    // given a score that would be guesswork.
    reviewOnly: true,
    reviewReason: 'This answer is a SQL query. PIE executes Python and JavaScript, so a recruiter reads this one.',
    rubric: ['uses a window function for the running total', 'partitions by account', 'orders by date within the partition', 'filters to the first crossing row', 'preserves accounts that never cross via an outer join or conditional aggregate'],
    explain: 'The running total is a window function; keeping non-crossing accounts requires an outer join or a conditional aggregate rather than a WHERE filter.' },
  { id: 'q-sql-1', skill: 'sql', type: 'mcq', difficulty: 'Medium',
    prompt: 'Which clause returns the running total of `amount` ordered by `txn_date` within each `account_id`?',
    options: ['SUM(amount) OVER (PARTITION BY account_id ORDER BY txn_date)', 'SUM(amount) GROUP BY account_id, txn_date', 'SUM(amount) OVER (ORDER BY account_id)', 'SUM(amount) FILTER (WHERE account_id IS NOT NULL)'], answer: 0,
    explain: 'PARTITION BY scopes the window per account; ORDER BY makes it cumulative.' },
  { id: 'q-sql-2', skill: 'sql', type: 'mcq', difficulty: 'Easy',
    prompt: 'A LEFT JOIN followed by `WHERE right_table.col = 5` behaves like which join?',
    options: ['LEFT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN'], answer: 1,
    explain: 'Filtering the right table in WHERE discards the NULL-extended rows, collapsing it to an inner join.' },
  { id: 'q-py-1', skill: 'python', type: 'mcq', difficulty: 'Easy',
    prompt: 'In pandas, which operation is most appropriate to flag rows where a required column is missing?',
    options: ['df.dropna()', 'df[df["col"].isna()]', 'df.fillna(0)', 'df.reset_index()'], answer: 1,
    explain: 'Flagging requires selecting the offending rows; dropping or filling hides the problem.' },
  { id: 'q-py-2', skill: 'python', type: 'coding_easy', difficulty: 'Easy',
    prompt: 'Write `normalise_key(s)` returning a lowercase, whitespace-collapsed, punctuation-stripped version of `s`, suitable for duplicate detection.',
    starter: 'def normalise_key(s):\n    pass\n',
    language: 'python', entryPoint: 'normalise_key',
    tests: [
      { id: 'py2-v1', hidden: false, label: 'case and spacing', input: ['  Hello   World '], expected: 'hello world' },
      { id: 'py2-v2', hidden: false, label: 'punctuation', input: ['A.C.M.E, Ltd.'], expected: 'acme ltd' },
      { id: 'py2-h1', hidden: true, input: [''], expected: '' },
      { id: 'py2-h2', hidden: true, input: ['MIXED\tTabs\nAnd  Newlines'], expected: 'mixed tabs and newlines' },
      { id: 'py2-h3', hidden: true, input: ["it's a test!"], expected: 'its a test' },
    ],
    rubric: ['lowercases', 'collapses whitespace', 'strips punctuation', 'returns a string'],
    explain: 'Normalisation must be deterministic and total so equal entities produce equal keys.' },
  { id: 'q-ta-1', skill: 'testautomation', type: 'mcq', difficulty: 'Medium',
    prompt: 'A regression suite passes locally and fails intermittently in CI. Which is the most likely root cause to investigate first?',
    options: ['Assertion messages are unclear', 'Tests share mutable state or depend on ordering', 'The suite has too few tests', 'The CI machine is slower'], answer: 1,
    explain: 'Order- or state-dependence is the classic source of intermittent CI-only failures.' },
  { id: 'q-ta-2', skill: 'testautomation', type: 'mcq', difficulty: 'Easy',
    prompt: 'What is the primary purpose of a parameterised test?',
    options: ['To run faster', 'To cover many input cases with one test body', 'To replace integration tests', 'To reduce code coverage'], answer: 1,
    explain: 'Parameterisation separates the case data from the test logic.' },
  { id: 'q-api-1', skill: 'apitesting', type: 'mcq', difficulty: 'Medium',
    prompt: 'Which assertion best belongs in a contract test rather than a functional test?',
    options: ['The total equals 42', 'The response body matches the published schema', 'The page renders in under 2s', 'The database row was created'], answer: 1,
    explain: 'A contract test asserts the shape of the interface, not the business value.' },
  { id: 'q-api-2', skill: 'apitesting', type: 'coding_easy', difficulty: 'Easy',
    // Written as a pure function rather than a pytest test. The skill is the
    // same — knowing what a creation contract actually promises — but a test
    // needing a `client` fixture cannot run in the sandbox, and a coding
    // question PIE cannot execute is a coding question PIE cannot score.
    prompt: 'Write `creation_violations(response, collection)` returning a sorted list of the ways a create response breaks its contract. `response` is a dict with "status" and "headers". Report "status" unless the status is 201, "location" if there is no Location header, and "identity" if the Location does not start with `collection + "/"` followed by a non-empty id.',
    starter: 'def creation_violations(response, collection):\n    # return a sorted list of "status", "location", "identity"\n    pass\n',
    language: 'python', entryPoint: 'creation_violations',
    tests: [
      { id: 'api2-v1', hidden: false, label: 'a correct creation response',
        input: [{ status: 201, headers: { Location: '/orders/42' } }, '/orders'], expected: [] },
      { id: 'api2-v2', hidden: false, label: '200 instead of 201',
        input: [{ status: 200, headers: { Location: '/orders/42' } }, '/orders'], expected: ['status'] },
      { id: 'api2-h1', hidden: true, label: 'no Location at all',
        input: [{ status: 201, headers: {} }, '/orders'], expected: ['identity', 'location'] },
      { id: 'api2-h2', hidden: true, label: 'Location points at the collection, not the row',
        input: [{ status: 201, headers: { Location: '/orders/' } }, '/orders'], expected: ['identity'] },
      { id: 'api2-h3', hidden: true, label: 'everything wrong at once',
        input: [{ status: 500, headers: {} }, '/orders'], expected: ['identity', 'location', 'status'] },
    ],
    rubric: ['checks the status code', 'checks the Location header exists', 'checks Location identifies the new row'],
    explain: 'A creation contract is status plus the identity of what was created — a 201 with no usable Location tells the caller nothing about what it made.' },
  { id: 'q-ci-1', skill: 'cicd', type: 'mcq', difficulty: 'Easy',
    prompt: 'Why should a CI pipeline fail the build when the test suite fails, rather than only reporting it?',
    options: ['To slow releases down', 'To make the failure blocking and prevent regression from shipping', 'To reduce log volume', 'To satisfy linting'], answer: 1,
    explain: 'A non-blocking signal is eventually ignored; blocking is what preserves the invariant.' },
  { id: 'q-docker-1', skill: 'docker', type: 'mcq', difficulty: 'Easy',
    prompt: 'Why is a container image usually preferred over "works on my machine" for running a test suite in CI?',
    options: ['Images are smaller than source', 'The image pins the runtime and dependencies, making runs reproducible', 'Containers run faster than processes', 'It removes the need for tests'], answer: 1,
    explain: 'Reproducibility comes from pinning the environment, which is exactly what an image does.' },
  { id: 'q-js-1', skill: 'javascript', type: 'mcq', difficulty: 'Easy',
    prompt: 'What does `Array.prototype.map` return?',
    options: ['The original array, mutated', 'A new array of the same length', 'A single accumulated value', 'undefined'], answer: 1,
    explain: 'map is non-mutating and length-preserving; reduce accumulates.' },
  { id: 'q-react-1', skill: 'react', type: 'mcq', difficulty: 'Medium',
    prompt: 'A list re-renders incorrectly when items are reordered. Which is the most likely cause?',
    options: ['Missing or index-based `key` props', 'Too many components', 'Using CSS modules', 'Not using useMemo'], answer: 0,
    explain: 'Index keys break React’s reconciliation identity when order changes.' },
  { id: 'q-express-1', skill: 'express', type: 'mcq', difficulty: 'Medium',
    prompt: 'Where must authorisation for a specific object (e.g. `/candidates/:id`) be enforced?',
    options: ['In the frontend route guard', 'On the server, per request, against the requesting identity', 'In the CSS', 'In the client-side store'], answer: 1,
    explain: 'Client-side hiding is not authorisation; object-level checks belong on the server.' },
];

/* ------------------------------------------------------------ ATTEMPT STORE */
const ATTEMPTS = new Map();
const nowMs = () => Date.now();
const QUICK_SLOTS = 4;

/**
 * Server-authoritative duration for one question.
 * MCQ and multiple-select vary by difficulty; every other type is fixed.
 * This is the ONLY place a duration is derived, so the policy stays the single source of truth.
 */
export function secondsFor(q, policy = ASSESSMENT_POLICY) {
  const t = policy.timing[q.type];
  if (!t) return 60;
  if (t.byDifficulty) return t.byDifficulty[q.difficulty] ?? t.byDifficulty.Medium;
  return t.seconds;
}

function publicQuestion(q, policy, index, total, deadlineAt) {
  // Strip answer, rubric and explanation. The client never receives them.
  const t = policy.timing[q.type];
  const secs = secondsFor(q, policy);
  return {
    questionId: q.id, index: index + 1, total,
    type: q.type, typeLabel: t.label, difficulty: q.difficulty,
    skillId: q.skill, skillName: SKILL_BY_ID[q.skill]?.name || q.skill,
    prompt: q.prompt,
    options: q.options || null,
    starter: q.starterCode || q.starter || null,
    // Coding questions carry their VISIBLE examples and nothing else. `tests`
    // on the stored question holds the hidden ones too; this is the line that
    // keeps them off the wire.
    language: q.language || null,
    entryPoint: q.entryPoint || null,
    examples: Array.isArray(q.tests)
      ? q.tests.filter(t => !t.hidden).map(t => ({ id: t.id, input: t.input, expected: t.expected, label: t.label || null }))
      : null,
    hiddenTestCount: Array.isArray(q.tests) ? q.tests.filter(t => t.hidden).length : 0,
    // Some coding answers cannot be executed — a SQL query, a design write-up.
    // The candidate is told, so silence is not mistaken for a broken Run button.
    reviewOnly: Boolean(q.reviewOnly),
    reviewReason: q.reviewOnly ? (q.reviewReason || null) : null,
    multi: q.type === 'multi_select',
    seconds: secs, deadlineAt,
    timingVariesByDifficulty: Boolean(t.byDifficulty),
    timingAuthority: t.authority, expiryBehaviour: t.expiry, backNavigation: t.back,
  };
}

/* ------------------------------------------------------ BLUEPRINT (§67) */
/* -------------------------------------------------------------- LIFECYCLE */

/**
 * What the AI is asked to write. Derived from the role's required skills
 * crossed with where this candidate's evidence is thinnest — the questions
 * worth asking are the ones the evidence cannot already answer.
 */
export function questionSpec({ candidate, targetSkills, gaps = [] }) {
  const skills = (targetSkills && targetSkills.length ? targetSkills : ['problemsolving']).slice(0, 6);

  // Weakest-first: a skill with a large gap earns the harder question.
  const gapOf = id => gaps.find(g => g.skillId === id || g.skill === id)?.severity ?? 0.5;
  const ranked = skills.slice().sort((a, b) => gapOf(b) - gapOf(a));

  const spec = [];
  const quickTypes = ['mcq', 'mcq', 'multi_select', 'short_answer'];
  for (let i = 0; i < QUICK_SLOTS; i++) {
    const skill = ranked[i % ranked.length];
    const g = gapOf(skill);
    spec.push({ type: quickTypes[i], skill, difficulty: g > 0.6 ? 'Medium' : g > 0.3 ? 'Medium' : 'Hard' });
  }
  // Coding spans the timing range so the 5 / 15 / 25-minute tiers are real.
  spec.push({ type: 'coding_easy', skill: ranked[0], difficulty: 'Easy' });
  spec.push({ type: 'coding_medium', skill: ranked[Math.min(1, ranked.length - 1)], difficulty: 'Medium' });
  return spec;
}

/**
 * Builds the paper for ONE candidate and ONE job.
 *
 * Generation is preferred; the verified bank is the floor. If the model is slow,
 * unreachable or writes questions that fail validation, the candidate still gets
 * a coherent assessment — they are simply told where the questions came from.
 */
export async function buildAssessment(input = {}) {
  const { candidate, role = null, jobText = null } = input;
  const language = isSupportedLanguage(input.language) ? input.language : 'en';
  // Normalise at the boundary rather than trusting the caller. A default
  // parameter only fires on `undefined`, and the start route legitimately passes
  // `null` for targetSkills when there is no requisition — a self-assessment.
  // That is how a null reached `.length` and broke every no-requisition attempt.
  const targetSkills   = Array.isArray(input.targetSkills) ? input.targetSkills : [];
  const gaps           = Array.isArray(input.gaps) ? input.gaps : [];
  const bannedFamilies = input.bannedFamilies instanceof Set
    ? input.bannedFamilies
    : new Set(Array.isArray(input.bannedFamilies) ? input.bannedFamilies : []);

  const mode = isAssessmentMode(input.mode) ? input.mode : DEFAULT_MODE;
  const authored = Array.isArray(input.recruiterQuestions) ? input.recruiterQuestions : [];

  const spec = questionSpec({ candidate, targetSkills, gaps });
  let questions = [];
  let generation = { attempted: false, accepted: 0, rejected: [], provider: null, error: null };

  /* ---------------------------------------------- 1. the recruiter's own
     Asked FIRST in every mode that includes them. A recruiter who wrote a
     question wrote it because it matters for this role; it should not be
     crowded out by a generated one that merely arrived earlier. */
  if (mode !== 'FULL_AI') {
    const pool = shuffle(authored.filter(q => !bannedFamilies.has(familyId(q))));
    // Track ids, not object identity: each question is pushed as a COPY, so
    // `questions.includes(poolItem)` is never true and the same question would
    // be matched into every slot of its type — a three-question set producing a
    // paper that asks one of them twice.
    const used = new Set();
    const take = q => {
      used.add(q.id);
      questions.push({ ...q, familyId: familyId(q), source: 'recruiter_authored' });
    };
    // Match the blueprint's slots by type first, so a recruiter's coding
    // question lands in the coding slot rather than displacing an MCQ.
    for (const slot of spec) {
      if (questions.length >= spec.length) break;
      const q = pool.find(x => x.type === slot.type && !used.has(x.id));
      if (q) take(q);
    }
    // Their remaining questions fill whatever slots are left — but only when
    // nothing else is coming to fill them.
    if (mode === 'RECRUITER_ONLY') {
      for (const q of pool) {
        if (questions.length >= spec.length) break;
        if (!used.has(q.id)) take(q);
      }
    }
  }
  const authoredCount = questions.length;

  /* ------------------------------------------------------ 2. generation
     Skipped entirely when the recruiter asked for their questions only. That
     is the whole point of the mode: nothing the recruiter did not write. */
  let generated = [];
  if (mode !== 'RECRUITER_ONLY' && questions.length < spec.length) {
    try {
      generation.attempted = true;
      const remaining = spec.slice(questions.length);
      const r = await generateQuestions({
        role, jobText, candidate, spec: remaining, targetSkills, bannedFamilies, language,
      });
      generation.provider = r.provider;
      generation.rejected = r.rejected;
      generation.error = r.error || null;
      generated = r.questions;
    } catch (e) {
      generation.error = e.message;
    }
  }

  // Fill the blueprint SLOT BY SLOT, matching each slot's question type.
  //
  // Taking whatever the model returned, in the order it returned it, quietly
  // changes what the assessment measures: ask for four MCQs plus two coding
  // slots, get six MCQs back, and the paper is easier than the blueprint says
  // and the candidate's coding is never examined at all. The blueprint is a
  // promise about difficulty and breadth — the generator fills it, it does not
  // redefine it.
  for (const slot of spec) {
    const i = generated.findIndex(q => q.type === slot.type && !questions.includes(q));
    if (i >= 0) questions.push(generated[i]);
  }
  generation.accepted = questions.length - authoredCount;

  // Top up from the verified bank when generation came up short.
  //
  // Two passes, and the order matters for fairness: on-target skills first, so
  // two candidates for the same role are examined on the same competencies. A
  // random off-role question would make their scores incomparable, which is
  // exactly what §28 forbids — different questions are fine, different subjects
  // are not.
  const onTarget = q => !targetSkills.length || targetSkills.includes(q.skill);
  const notOnPaper = q => !questions.some(x => x.id === q.id);
  const fresh = q => notOnPaper(q) && !bannedFamilies.has(familyId(q));
  // How many of each type the paper is still owed.
  const shortfall = () => {
    const need = {};
    for (const slot of spec) need[slot.type] = (need[slot.type] || 0) + 1;
    for (const q of questions) if (need[q.type]) need[q.type] -= 1;
    return need;
  };
  const takeFrom = (pool, { allowRepeatSkill = false, anyType = false } = {}) => {
    const need = shortfall();
    for (const q of shuffle(pool)) {
      if (questions.length >= spec.length) break;
      // Prefer a question of a type the paper is still missing, so the promised
      // mix survives a partial generation.
      if (!anyType && !(need[q.type] > 0)) continue;
      if (!allowRepeatSkill && questions.some(x => x.skill === q.skill && x.type === q.type)) continue;
      questions.push({ ...q, familyId: familyId(q), source: 'verified_bank' });
      if (need[q.type]) need[q.type] -= 1;
    }
  };

  /* --------------------------------------------------- 3. the verified bank
     The floor under generation — and explicitly NOT available in
     RECRUITER_ONLY, where a bank question would be exactly the thing the
     recruiter said they did not want. In that mode a short pool means a short
     paper, and the blueprint says so. */
  const bankAllowed = mode !== 'RECRUITER_ONLY';
  const BANKPOOL = bankAllowed ? BANK : [];

  if (questions.length < spec.length) takeFrom(BANKPOOL.filter(q => fresh(q) && onTarget(q)));
  // Still short: allow a second question on the same target skill before ever
  // reaching outside the role.
  if (questions.length < spec.length) takeFrom(BANKPOOL.filter(q => fresh(q) && onTarget(q)), { allowRepeatSkill: true });

  // Anti-repetition is a preference, not a hard constraint.
  //
  // Held absolutely it eventually produces an EMPTY paper: a candidate who has
  // taken several assessments has seen most of the bank, every remaining family
  // is banned, and the attempt fails to start. A repeated question is a much
  // smaller problem than no assessment, so when the ban would leave the paper
  // short, it is relaxed — and the blueprint says so, because a recruiter
  // comparing a retake is owed the fact that it overlapped the first one.
  let repetitionRelaxed = false;
  if (questions.length < spec.length) {
    const before = questions.length;
    takeFrom(BANKPOOL.filter(q => notOnPaper(q) && onTarget(q)), { allowRepeatSkill: true });
    repetitionRelaxed = questions.length > before;
  }

  // Length before type. A paper that is one question short measures less than the
  // blueprint promised; a paper where one slot's type was substituted still
  // measures the right skills. So if slots remain, fill them with any type that
  // is still on-role.
  let typeSubstituted = false;
  if (questions.length < spec.length) {
    const before = questions.length;
    takeFrom(BANKPOOL.filter(q => notOnPaper(q) && onTarget(q)), { allowRepeatSkill: true, anyType: true });
    typeSubstituted = questions.length > before;
  }

  // Only now, and only to avoid shipping a two-question assessment, widen beyond
  // the role — and say so, rather than quietly changing what is being measured.
  let widened = false;
  if (questions.length < Math.min(4, spec.length)) {
    const before = questions.length;
    takeFrom(BANKPOOL.filter(notOnPaper), { allowRepeatSkill: true, anyType: true });
    widened = questions.length > before;
  }

  // Randomise: option order per question, then the order of the paper itself,
  // keeping coding last so the long timers do not open the assessment.
  questions = questions.map(shuffleOptions);
  const CODING = new Set(['coding_easy', 'coding_medium', 'coding_hard', 'debugging']);
  const quick = shuffle(questions.filter(q => !CODING.has(q.type)));
  const coding = shuffle(questions.filter(q => CODING.has(q.type)))
    .sort((a, b) => secondsFor(a) - secondsFor(b));
  questions = [...quick, ...coding];

  const blueprint = {
    blueprintId: `bp-${crypto.randomUUID().slice(0, 8)}`,
    role: role || null,
    skillCoverage: [...new Set(questions.map(q => SKILL_BY_ID[q.skill]?.name || q.skill))],
    difficultyMix: questions.reduce((a, q) => (a[q.difficulty] = (a[q.difficulty] || 0) + 1, a), {}),
    questionCount: questions.length,
    estimatedSeconds: questions.reduce((a, q) => a + secondsFor(q), 0),
    questionIds: questions.map(q => q.id),
    sourceMix: questions.reduce((a, q) => (a[q.source || 'verified_bank'] = (a[q.source || 'verified_bank'] || 0) + 1, a), {}),
    // Two candidates for one role must be examined on the same competencies,
    // even though the questions differ. This says whether that held.
    targetSkills,
    offTargetSkills: targetSkills.length
      ? [...new Set(questions.map(q => q.skill).filter(sk => !targetSkills.includes(sk)))] : [],
    competencyEquivalent: !widened,
    // Whose judgement decided what was asked. A score means something different
    // under each mode, so it is recorded rather than assumed.
    mode,
    modeLabel: ASSESSMENT_MODES[mode].label,
    recruiterAuthored: authoredCount,
    // RECRUITER_ONLY with a thin question set produces a short paper. That is
    // the recruiter's own trade-off, but it must be visible rather than looking
    // like a PIE failure.
    recruiterPoolShort: mode === 'RECRUITER_ONLY' && questions.length < spec.length,
    plannedQuestionCount: spec.length,
    // Language, and what is true about it. The verified bank is English-only,
    // so a paper that fell back to it is mixed — saying "assessment available in
    // Hindi" while half the questions are in English would be a lie the
    // candidate discovers on question three.
    language,
    mixedLanguage: language !== 'en' && questions.some(q => (q.language || 'en') !== language),
    // Ambiguity checks are English patterns. A non-English paper is validated
    // for schema, answer keys, relevance and duplicates, but NOT for the
    // English-phrasing traps. Weaker, and said so.
    validationReducedForLanguage: language !== 'en',
    // Promised question types the paper could not supply, after generation and
    // every bank pass. Empty is the normal case; non-empty answers "why does
    // this paper have no coding question?" without anyone guessing.
    unfilledTypes: (() => {
      const need = {};
      for (const slot of spec) need[slot.type] = (need[slot.type] || 0) + 1;
      for (const q of questions) if (need[q.type]) need[q.type] -= 1;
      return Object.entries(need).filter(([, n]) => n > 0).map(([t]) => t);
    })(),
    typeSubstituted,
    // True when this paper had to reuse a question family the candidate has
    // already seen, because the unseen pool was too small.
    repetitionRelaxed,
    generation,
    ai: assessmentAIStatus(),
  };
  return { blueprint, questions };
}

/** Kept for callers that only want a preview of the shape of an assessment. */
export function buildBlueprint({ candidate, targetSkills }) {
  const spec = questionSpec({ candidate, targetSkills });
  return {
    blueprintId: `bp-preview-${crypto.randomUUID().slice(0, 6)}`,
    skillCoverage: [...new Set(spec.map(x => SKILL_BY_ID[x.skill]?.name || x.skill))],
    difficultyMix: spec.reduce((a, q) => (a[q.difficulty] = (a[q.difficulty] || 0) + 1, a), {}),
    questionCount: spec.length,
    estimatedSeconds: spec.reduce((a, q) => a + secondsFor(q), 0),
    questionIds: [],
    preview: true,
    ai: assessmentAIStatus(),
  };
}

export async function startAttempt({ candidate, targetSkills, consent, preflight, gaps, role, jobText, bannedFamilies, language, mode, recruiterQuestions }) {
  if (!consent?.accepted) throw new Error('Candidate consent is required before an attempt may start.');
  const { blueprint, questions } = await buildAssessment({
    candidate, targetSkills, gaps, role, jobText, bannedFamilies, language, mode, recruiterQuestions,
  });
  if (!questions.length) throw new Error('No assessment could be assembled for this role.');

  const attemptId = `att-${crypto.randomUUID().slice(0, 8)}`;
  const attempt = {
    attemptId, candidateId: candidate.id,
    policy: structuredClone(ASSESSMENT_POLICY),   // frozen for this attempt
    blueprint, questions, state: 'IN_PROGRESS',
    cursor: 0, finalized: [], warnings: [], warningCount: 0,
    consent: { ...consent, at: new Date().toISOString() },
    preflight: preflight || {},
    startedAt: new Date().toISOString(),
    deadlineAt: null, currentToken: null,
  };
  ATTEMPTS.set(attemptId, attempt);
  return attempt;
}

export function getAttempt(id) { return ATTEMPTS.get(id); }

/** Questions live on the attempt: each candidate gets their own paper. */
export const questionOf = (attempt, id) =>
  (attempt.questions || []).find(x => x.id === id) || BANK.find(x => x.id === id);

export function currentQuestion(attempt) {
  if (attempt.state !== 'IN_PROGRESS') return null;
  const q = questionOf(attempt, attempt.blueprint.questionIds[attempt.cursor]);
  if (!q) return null;
  // JIT: issue a single-use, short-lived token and start the server clock now.
  if (!attempt.deadlineAt) {
    attempt.deadlineAt = nowMs() + secondsFor(q, attempt.policy) * 1000;
    attempt.currentToken = crypto.randomUUID();
  }
  return {
    ...publicQuestion(q, attempt.policy, attempt.cursor, attempt.blueprint.questionIds.length, attempt.deadlineAt),
    token: attempt.currentToken,
    serverNow: nowMs(),
  };
}

function grade(q, response) {
  if (q.type === 'mcq') return { correct: response === q.answer, partial: response === q.answer ? 1 : 0 };
  if (q.type === 'multi_select') {
    const sel = new Set(Array.isArray(response) ? response : []);
    const key = new Set(q.answer);
    const hit = [...key].filter(k => sel.has(k)).length;
    const wrong = [...sel].filter(s => !key.has(s)).length;
    const p = Math.max(0, (hit - wrong) / key.size);
    return { correct: p === 1, partial: Number(p.toFixed(2)) };
  }
  // Coding is not graded here. It is graded by running the code — see
  // gradeCoding below — because a coding answer cannot be judged by looking at
  // its text.
  //
  // What used to be here was keyword matching against the rubric, and it was
  // not merely approximate: pasting the rubric's own words as a comment scored
  // 100%, while a correct solution phrased differently scored 0. A wrong score
  // is worse than no score, because a recruiter cannot tell it is wrong.
  return { correct: false, partial: 0, pending: true };
}

/**
 * Grades a coding answer by executing it against the question's test cases.
 *
 * Scoring uses the HIDDEN tests. Visible tests exist so a candidate can debug;
 * scoring on them would reward tuning to the examples. If a question has no
 * hidden tests, the visible ones are used and the blueprint says so.
 *
 * When no sandbox is available the answer is stored unscored and flagged for a
 * recruiter, rather than being given a number PIE cannot stand behind.
 */
async function gradeCoding(q, response) {
  if (q.reviewOnly) {
    return { correct: false, partial: 0, pending: true,
      pendingReason: q.reviewReason || 'This question is marked for recruiter review.' };
  }
  const tests = Array.isArray(q.tests) ? q.tests : [];
  if (!tests.length) {
    return { correct: false, partial: 0, pending: true,
      pendingReason: 'This question has no test cases, so it cannot be scored automatically.' };
  }

  const r = await execute({
    language: q.language || 'python',
    code: String(response || ''),
    entryPoint: q.entryPoint || 'solve',
    tests,
  });

  if (!r.executed) {
    return { correct: false, partial: 0, pending: true, execution: r,
      pendingReason: 'No execution sandbox was available, so this answer was recorded for recruiter review instead of scored.' };
  }

  const scored = tests.filter(t => t.hidden);
  const pool = scored.length ? scored : tests;
  const hiddenIds = new Set(tests.filter(t => t.hidden).map(t => t.id));
  const results = (r.results || []).map(x => ({ ...x, hidden: hiddenIds.has(x.id) }));
  const byId = new Map(results.map(x => [x.id, x]));
  const passed = pool.filter(t => byId.get(t.id)?.passed).length;
  const p = pool.length ? passed / pool.length : 0;

  return {
    correct: p === 1,
    partial: Number(p.toFixed(2)),
    execution: {
      ok: r.ok, error: r.error,
      passed, total: pool.length,
      scoredOn: scored.length ? 'hidden' : 'visible',
      results,                     // full detail — masked at the route boundary
    },
  };
}

export async function submitAnswer(attempt, { questionId, response, token, expired }) {
  if (attempt.state !== 'IN_PROGRESS') throw new Error('Attempt is not in progress.');
  const q = questionOf(attempt, questionId);
  if (!q) throw new Error('Unknown question.');
  // Forward-only: a finalized question can never be reopened (§15).
  if (attempt.finalized.find(f => f.questionId === questionId))
    return { idempotent: true, attempt };
  if (token && attempt.currentToken && token !== attempt.currentToken)
    throw new Error('Replayed or expired question token rejected.');

  const late = nowMs() > (attempt.deadlineAt || 0) + 1500;
  const timedOut = Boolean(expired) || late;
  const blank = response === null || response === undefined || response === '';
  const isCoding = q.type.startsWith('coding') || q.type === 'debugging';
  const g = timedOut && blank ? { correct: false, partial: 0 }
    : isCoding ? await gradeCoding(q, response)
    : grade(q, response);

  attempt.finalized.push({
    questionId, skill: q.skill, type: q.type, difficulty: q.difficulty,
    correct: g.correct, score: g.partial, timedOut,
    // An answer PIE could not score is not a zero. It is carried as pending so
    // the result page can say so and a recruiter can look at it.
    pending: Boolean(g.pending),
    pendingReason: g.pendingReason || null,
    execution: g.execution || null,
    explain: q.explain,                     // released only after finalization
    finalizedAt: new Date().toISOString(),
  });
  attempt.cursor += 1;
  attempt.deadlineAt = null;
  attempt.currentToken = null;
  if (attempt.cursor >= attempt.blueprint.questionIds.length) finalizeAttempt(attempt, 'COMPLETED');
  return { idempotent: false, attempt };
}

export function recordProctorEvent(attempt, type) {
  const rule = WARNING_MATRIX[type];
  if (!rule || attempt.state !== 'IN_PROGRESS') return attempt;
  // `breach` decides what counts, not severity. An event can be worth recording
  // for a reviewer without being one of the three that stops the attempt.
  if (!rule.breach) {
    attempt.warnings.push({ type, ...rule, counted: false, at: new Date().toISOString(), count: attempt.warningCount });
    return attempt;
  }
  attempt.warningCount += 1;
  attempt.warnings.push({
    type, ...rule, counted: true, at: new Date().toISOString(),
    count: attempt.warningCount, threshold: attempt.policy.warnings.threshold,
    remaining: Math.max(0, attempt.policy.warnings.threshold - attempt.warningCount),
  });
  if (attempt.warningCount >= attempt.policy.warnings.threshold && attempt.policy.warnings.terminateOnThreshold)
    finalizeAttempt(attempt, 'LOCKED_FOR_REVIEW');
  return attempt;
}

export function finalizeAttempt(attempt, state = 'COMPLETED') {
  attempt.state = state;
  attempt.completedAt = new Date().toISOString();
  const answered = attempt.finalized;
  const bySkill = {};
  for (const f of answered) {
    (bySkill[f.skill] ||= { skill: SKILL_BY_ID[f.skill]?.name || f.skill, total: 0, score: 0 });
    bySkill[f.skill].total += 1;
    bySkill[f.skill].score += f.score;
  }
  const skillBreakdown = Object.entries(bySkill).map(([id, v]) => ({
    skillId: id, skill: v.skill, questions: v.total,
    score: Number((v.score / v.total).toFixed(2)),
  }));
  attempt.result = {
    state,
    answered: answered.length,
    total: attempt.blueprint.questionIds.length,
    overall: answered.length ? Number((answered.reduce((a, f) => a + f.score, 0) / answered.length).toFixed(2)) : 0,
    skillBreakdown,
    warningCount: attempt.warningCount,
    requiresHumanReview: state === 'LOCKED_FOR_REVIEW',
    reviewNotice: state === 'LOCKED_FOR_REVIEW'
      ? 'This attempt reached the integrity warning threshold and has been submitted and locked. A Trust & Integrity Administrator must review it before any result is treated as final. No decision is made automatically.'
      : null,
  };
  return attempt;
}

// Convert a finished attempt into evidence for the Unified Candidate Evidence Profile.
export function attemptToEvidence(attempt) {
  const r = attempt.result;
  if (!r || r.requiresHumanReview) return null;
  const strong = r.skillBreakdown.filter(s => s.score >= 0.5);
  if (!strong.length) return null;
  return {
    id: `ev-assess-${attempt.attemptId}`,
    source: 'assessment', verification: 'api_derived', date: '2026-08',
    title: `AI Mini Assessment — ${r.overall >= 0.75 ? 'strong' : r.overall >= 0.5 ? 'solid' : 'partial'} result (${Math.round(r.overall * 100)}%)`,
    text: `${strong.map(s => s.skill).join(', ')}. Scored server-side against a protected rubric across ${r.answered} questions. Skill breakdown: ${r.skillBreakdown.map(s => `${s.skill} ${Math.round(s.score * 100)}%`).join('; ')}.`,
  };
}

/**
 * One finalised answer as the CANDIDATE may see it.
 *
 * The rule for hidden tests is the same as for answer keys: they never reach the
 * browser in any form. A candidate who can see that hidden test `h3` failed with
 * `got: []` knows more about the hidden case than the question intends, and a
 * candidate who can enumerate the ids knows how many there are.
 */
function publicFinalized(f) {
  const e = f.execution;
  return {
    questionId: f.questionId, skill: f.skill, type: f.type, difficulty: f.difficulty,
    correct: f.correct, score: f.score, timedOut: f.timedOut,
    pending: Boolean(f.pending), pendingReason: f.pendingReason ?? null,
    explain: f.explain, finalizedAt: f.finalizedAt,
    execution: e ? {
      ok: e.ok, error: e.error,
      passed: e.passed, total: e.total,
      scoredOn: e.scoredOn,
      // Visible tests only — with their own results, which the candidate has
      // already seen while working.
      results: (e.results || []).filter(x => !x.hidden),
      hiddenCount: (e.results || []).filter(x => x.hidden).length,
    } : null,
  };
}

/**
 * The candidate-facing view of an attempt.
 *
 * This is an ALLOWLIST, deliberately. It used to spread the attempt and delete
 * the known-sensitive keys, which was safe only for as long as nobody added a
 * new one — and then generated questions started living on the attempt, so the
 * spread began serialising every answer key, rubric and explanation straight to
 * the browser. A denylist fails silently and in the wrong direction. This fails
 * by omitting a new field, which is visible and harmless.
 */
export function publicAttempt(a) {
  const b = a.blueprint || {};
  return {
    attemptId: a.attemptId,
    candidateId: a.candidateId,
    requisitionId: a.requisitionId ?? null,
    applicationId: a.applicationId ?? null,
    state: a.state,
    cursor: a.cursor,
    startedAt: a.startedAt,
    deadlineAt: a.deadlineAt,
    submittedAt: a.submittedAt ?? null,
    consent: a.consent ?? null,
    preflight: a.preflight ?? null,
    warnings: a.warnings ?? [],
    warningCount: a.warningCount ?? 0,   // the UI renders warning pips from this
    locked: a.locked ?? false,
    lockReason: a.lockReason ?? null,
    result: a.result ?? null,
    // Per-question feedback, and only for questions the candidate has already
    // locked in. The state machine is forward-only, so releasing `correct` and
    // the explanation here cannot help them on a question they have not seen.
    //
    // Execution detail is masked here, not at the grader: a hidden test's id,
    // its inputs and what the candidate's code returned for it together
    // reconstruct the test. The candidate gets the count and their visible
    // tests; the hidden ones stay a number.
    finalized: (a.finalized ?? []).map(publicFinalized),
    policy: {
      policyId: a.policy.policyId, timing: a.policy.timing,
      warnings: a.policy.warnings, note: a.policy.note,
      integrityPosture: a.policy.integrityPosture,
      integrityClaim: a.policy.integrityClaim,
      integrityLimits: a.policy.integrityLimits,
    },
    // What the paper is made of — never what is on it. `questionIds` and the
    // rejected prompts stay server-side: both describe the question pool, and a
    // candidate who can enumerate it can prepare against it.
    blueprint: {
      blueprintId: b.blueprintId,
      role: b.role ?? null,
      skillCoverage: b.skillCoverage,
      difficultyMix: b.difficultyMix,
      questionCount: b.questionCount,
      estimatedSeconds: b.estimatedSeconds,
      sourceMix: b.sourceMix,
      competencyEquivalent: b.competencyEquivalent,
      repetitionRelaxed: b.repetitionRelaxed ?? false,
      unfilledTypes: b.unfilledTypes ?? [],
      typeSubstituted: b.typeSubstituted ?? false,
      language: b.language ?? 'en',
      mixedLanguage: b.mixedLanguage ?? false,
      validationReducedForLanguage: b.validationReducedForLanguage ?? false,
      mode: b.mode ?? 'FULL_AI',
      modeLabel: b.modeLabel ?? null,
      recruiterAuthored: b.recruiterAuthored ?? 0,
      recruiterPoolShort: b.recruiterPoolShort ?? false,
      plannedQuestionCount: b.plannedQuestionCount ?? b.questionCount,
      // Provenance the candidate is entitled to (§32): who wrote the paper and
      // that it was checked — as counts, not content.
      generation: b.generation ? {
        attempted: b.generation.attempted,
        accepted: b.generation.accepted,
        rejectedCount: (b.generation.rejected || []).length,
        provider: b.generation.provider,
      } : null,
      ai: b.ai ?? null,
    },
  };
}
