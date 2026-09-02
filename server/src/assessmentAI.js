// PIE — AI question generation for the assessment engine.
//
// WHAT THIS REPLACES
//   A fixed bank of 19 questions that every candidate saw. That is the bug: an
//   assessment that does not depend on the job or the candidate is not evidence
//   of anything.
//
// PROVIDER
//   Gemini is preferred for assessment work specifically (`prefer: 'gemini'`).
//   If Gemini is not configured the normal PIE provider order applies, and if no
//   provider answers at all the verified bank is used. A generated assessment is
//   better; a working assessment is non-negotiable.
//
// THE RULE THAT DOES NOT BEND
//   A generated question is a CANDIDATE for inclusion, never a question. Nothing
//   reaches a candidate until it has passed schema, content, answer, relevance,
//   difficulty and duplicate checks. An LLM that writes a broken question costs
//   one regeneration, not one unfair assessment.

import crypto from 'node:crypto';
import { completeJson, untrusted, providerStatus } from './ai/provider.js';
import { ONTOLOGY, SKILL_BY_ID } from './data.js';
import { LANGUAGES as EXEC_LANGUAGES, isLanguage } from './execution/runner.js';

export const ASSESSMENT_PROVIDER = 'gemini';

/* ═══════════════════════════════════════════════════════════ RANDOMNESS
   Server-side and unpredictable. Frontend shuffling would let a candidate read
   the intended order out of the payload, so ordering is decided here. */
const rnd = () => crypto.randomInt(0, 2 ** 31) / 2 ** 31;

export function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Shuffles MCQ options and moves the answer index with them. */
export function shuffleOptions(q) {
  if (!Array.isArray(q.options) || q.options.length < 2) return q;
  const idx = q.options.map((_, i) => i);
  const order = shuffle(idx);
  const options = order.map(i => q.options[i]);
  const remap = i => order.indexOf(i);
  const answer = Array.isArray(q.answer) ? q.answer.map(remap).sort((a, b) => a - b) : remap(q.answer);
  return { ...q, options, answer };
}

/* ═══════════════════════════════════════════════ ANTI-REPETITION FINGERPRINT
   A "family" is the shape of a question, not its wording. Two questions that
   test hash maps at medium difficulty with different numbers are the same
   family — reusing one a week later is repetition even though the text differs. */
// Unicode-aware. The ASCII-only version silently emptied any non-Latin prompt,
// which would have given every Hindi question with the same skill and difficulty
// an identical fingerprint — banning a whole category after one question — and
// made duplicate detection always return 0. Language support has to start here,
// not at the prompt.
const norm = s => String(s || '').toLowerCase()
  // \p{M} keeps combining marks: without it Devanagari matras are stripped and
  // कौन becomes two tokens, so words stop matching themselves.
  .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function familyId(q) {
  const core = [q.skill, q.subSkill || '', q.type, q.difficulty,
    norm(q.prompt || q.title).split(' ').slice(0, 12).join(' ')].join('|');
  return crypto.createHash('sha256').update(core).digest('hex').slice(0, 16);
}

const overlap = (a, b) => {
  // The >3 filter drops stopwords in Latin scripts but would drop almost every
  // word in Chinese or Japanese, where a meaningful token is one or two
  // characters. Keep short tokens when the text is not mostly Latin.
  const minLen = t => (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t) ? 1 : 3);
  const words = t => new Set(norm(t).split(' ').filter(w => w.length > minLen(t)));
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
};

/** The part of a prompt that carries its subject, before the boilerplate ask.
 *  Sentence enders differ by script: Devanagari and Bengali end a sentence with
 *  a danda (।), CJK with 。 — splitting only on ASCII punctuation would return
 *  the whole prompt for those and make every question look like a duplicate. */
const subjectOf = p => String(p || '').split(/[.?!।॥。！？]/)[0];

/**
 * Near-duplicate detection.
 *
 * Comparing whole prompts does not work: a model reuses framing ("The team
 * reports this began after last week's release. What is your first step?")
 * across genuinely different questions, and a naive word overlap then throws
 * most of a good batch away — which lands you right back at everyone seeing the
 * same handful of bank questions.
 *
 * So compare what actually distinguishes two questions: the subject of the stem,
 * and the answer options. Shared boilerplate is not a duplicate; a shared
 * subject WITH shared options is.
 */
export function similarity(a, b, optsA, optsB) {
  const subject = overlap(subjectOf(a), subjectOf(b));
  if (!Array.isArray(optsA) || !Array.isArray(optsB) || !optsA.length || !optsB.length) {
    return subject;
  }
  const options = overlap(optsA.join(' '), optsB.join(' '));
  return 0.65 * subject + 0.35 * options;
}

/* ═══════════════════════════════════════════════════════ ASSESSMENT MODES
   Who writes the questions is a RECRUITER's decision, not a default. A team
   that already has a trusted question set should not be forced to accept
   generated ones, and a team with no set should not be blocked from assessing.

   The three modes are not three quality levels — they are three answers to
   "whose judgement decides what this candidate is asked?". PIE records which
   one was used on every attempt, because a score means something different
   depending on the answer. */
export const ASSESSMENT_MODES = {
  FULL_AI: {
    id: 'FULL_AI',
    label: 'AI-generated from the job description',
    summary: 'Every question is written for this role and validated before a candidate sees it.',
    tradeoff: 'Strongest job-specificity and anti-repetition. Depends on a working AI provider; falls back to the verified bank when none answers.',
  },
  HYBRID: {
    id: 'HYBRID',
    label: 'Your questions, topped up by AI',
    summary: 'Your own questions are asked first, and AI fills the remaining slots for this role.',
    tradeoff: 'Keeps what you trust and still covers skills you have not written questions for. The recommended default once you have a few of your own.',
  },
  RECRUITER_ONLY: {
    id: 'RECRUITER_ONLY',
    label: 'Only my questions',
    summary: 'No generated questions. The paper is exactly what you wrote, in a randomised order.',
    tradeoff: 'Full control and full responsibility: the paper is only as long and as broad as your question set, and repeat candidates will see the same questions.',
  },
};
export const MODE_IDS = Object.keys(ASSESSMENT_MODES);
export const isAssessmentMode = m => MODE_IDS.includes(String(m || ''));
export const DEFAULT_MODE = 'FULL_AI';

/* ═══════════════════════════════════════════════════════════════ LANGUAGE
   Skills-first hiring means not filtering on English fluency. A candidate who
   can do the job but reads more comfortably in Hindi should be assessed on the
   job, not on the language the question happens to be written in.

   What this genuinely does: generated questions are written in the chosen
   language. What it does NOT do, and must not be claimed to do:
     • the verified bank is English-only, so a paper that falls back to it is
       mixed-language — the blueprint says so rather than hiding it;
     • the ambiguity checks below ("all of the above", true/false stems) are
       English patterns and will not fire on a translated equivalent, so a
       non-English paper gets WEAKER automated validation, not equal validation.
   Both are reported, because a candidate choosing a language is entitled to
   know what changes. */
export const LANGUAGES = [
  { code: 'en', name: 'English',   native: 'English' },
  { code: 'hi', name: 'Hindi',     native: 'हिन्दी' },
  { code: 'bn', name: 'Bengali',   native: 'বাংলা' },
  { code: 'ta', name: 'Tamil',     native: 'தமிழ்' },
  { code: 'te', name: 'Telugu',    native: 'తెలుగు' },
  { code: 'mr', name: 'Marathi',   native: 'मराठी' },
  { code: 'kn', name: 'Kannada',   native: 'ಕನ್ನಡ' },
  { code: 'gu', name: 'Gujarati',  native: 'ગુજરાતી' },
];
export const LANGUAGE_BY_CODE = Object.fromEntries(LANGUAGES.map(l => [l.code, l]));
export const isSupportedLanguage = c => Object.hasOwn(LANGUAGE_BY_CODE, String(c || ''));

/* ═══════════════════════════════════════════════════════════ VALIDATION
   Every check states what it rejects and why, because a rejected question is
   regenerated and the reason has to be actionable. */
const TYPES = new Set(['mcq', 'multi_select', 'short_answer', 'coding_easy', 'coding_medium', 'coding_hard', 'debugging']);
const DIFFS = new Set(['Easy', 'Medium', 'Hard']);

export function validateQuestion(q, { targetSkills = [], existing = [], bannedFamilies = new Set() } = {}) {
  const fail = (code, detail) => ({ ok: false, code, detail });

  /* --- schema --- */
  if (!q || typeof q !== 'object') return fail('SCHEMA', 'not an object');
  if (!TYPES.has(q.type)) return fail('SCHEMA', `unknown question type "${q.type}"`);
  if (!DIFFS.has(q.difficulty)) return fail('SCHEMA', `difficulty must be Easy, Medium or Hard, got "${q.difficulty}"`);
  if (typeof q.skill !== 'string' || !q.skill.trim()) return fail('SCHEMA', 'missing skill');
  if (typeof q.prompt !== 'string' || q.prompt.trim().length < 30)
    return fail('CONTENT', 'prompt is missing or too short to be a real question');
  if (q.prompt.length > 2000) return fail('CONTENT', 'prompt is implausibly long');

  /* --- answers --- */
  if (q.type === 'mcq') {
    if (!Array.isArray(q.options) || q.options.length < 3 || q.options.length > 6)
      return fail('ANSWER', 'an MCQ needs between 3 and 6 options');
    if (new Set(q.options.map(norm)).size !== q.options.length)
      return fail('ANSWER', 'two options are the same, so the question has more than one correct answer or a dead distractor');
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length)
      return fail('ANSWER', 'the answer index does not point at an option');
    if (q.options.some(o => typeof o !== 'string' || !o.trim()))
      return fail('ANSWER', 'an option is empty');
  }
  if (q.type === 'multi_select') {
    if (!Array.isArray(q.options) || q.options.length < 4) return fail('ANSWER', 'a multi-select needs at least 4 options');
    if (!Array.isArray(q.answer) || q.answer.length < 2)
      return fail('ANSWER', 'a multi-select must have at least two correct options, otherwise it is an MCQ');
    if (q.answer.length >= q.options.length) return fail('ANSWER', 'every option cannot be correct');
    if (q.answer.some(i => !Number.isInteger(i) || i < 0 || i >= q.options.length))
      return fail('ANSWER', 'an answer index does not point at an option');
  }
  if (q.type === 'short_answer' && (!Array.isArray(q.keywords) || q.keywords.length < 2))
    return fail('ANSWER', 'a short answer needs at least two scoring keywords');
  if (q.type.startsWith('coding') || q.type === 'debugging') {
    if (typeof q.starterCode !== 'string') return fail('SCHEMA', 'a coding question needs starter code');

    // A coding answer is scored by RUNNING it, so the question needs something
    // to run against. `reviewOnly` is the honest escape hatch for answers PIE
    // cannot execute — a SQL query, say — and it costs the question its
    // automatic score rather than pretending to one.
    if (!q.reviewOnly) {
      if (!isLanguage(q.language))
        return fail('SCHEMA', `language must be one of ${Object.keys(EXEC_LANGUAGES).join(', ')} — or mark the question review-only`);
      if (typeof q.entryPoint !== 'string' || !/^[A-Za-z_]\w*$/.test(q.entryPoint))
        return fail('SCHEMA', 'entryPoint must be the name of the function the tests will call');
      if (!Array.isArray(q.tests) || q.tests.length < 2)
        return fail('ANSWER', 'a coding question needs at least two test cases, or it cannot be scored');
      if (!q.tests.some(t => t.hidden))
        return fail('ANSWER', 'at least one test case must be hidden — scoring only on visible examples rewards tuning to them');
      if (!q.tests.some(t => !t.hidden))
        return fail('ANSWER', 'at least one test case must be visible, so the candidate can see the expected shape');
      const ids = q.tests.map(t => t.id);
      if (new Set(ids).size !== ids.length) return fail('ANSWER', 'two test cases share an id');
      for (const t of q.tests) {
        if (!t.id) return fail('ANSWER', 'every test case needs an id');
        if (!Array.isArray(t.input)) return fail('ANSWER', `test "${t.id}" needs its input as a list of arguments`);
        if (!('expected' in t)) return fail('ANSWER', `test "${t.id}" has no expected value`);
      }
    }
    if (!Array.isArray(q.rubric) || q.rubric.length < 2)
      return fail('ANSWER', 'a coding question needs a rubric of at least two criteria, so a human reviewer has something to read');
  }

  /* --- ambiguity --- */
  if (/all of the above|none of the above/i.test(JSON.stringify(q.options || [])))
    return fail('CONTENT', '"all/none of the above" makes an option order-dependent, and PIE shuffles options');
  if (/which of the following is (?:not )?true/i.test(q.prompt) && q.type === 'mcq' && !q.explain)
    return fail('CONTENT', 'a true/false-style stem needs an explanation to be defensible');
  if (typeof q.explain !== 'string' || q.explain.trim().length < 20)
    return fail('CONTENT', 'every question must explain why the answer is right — a candidate is owed that');

  /* --- relevance --- */
  if (targetSkills.length && !targetSkills.includes(q.skill))
    return fail('RELEVANCE', `skill "${q.skill}" is not among the skills this role requires`);

  /* --- duplication --- */
  const fam = familyId(q);
  if (bannedFamilies.has(fam))
    return fail('REPEAT', 'this candidate has already been asked a question of this family');
  for (const e of existing) {
    if (similarity(q.prompt, e.prompt, q.options, e.options) > 0.78)
      return fail('DUPLICATE', 'near-identical to another question in this assessment');
  }

  return { ok: true, familyId: fam };
}

/* ═══════════════════════════════════════════════════════════════ PROMPT */
const SYSTEM = `You write assessment questions for PIE, a skills-first hiring platform.

RULES
- Write questions that test whether someone can DO the job, not whether they memorised terminology.
- Ground every question in the role and the candidate's actual evidence.
- Never write "all of the above" or "none of the above": options are shuffled.
- A coding question is scored by RUNNING the candidate's function against your test cases, so:
  * every argument in "input" and every "expected" value must be plain JSON — no lambdas, no
    objects the candidate would have to construct, no floating-point equality;
  * "input" is the argument LIST, so a function taking two arguments has two entries;
  * write visible examples that show the shape, and hidden tests that catch the edge cases a
    candidate would miss if they only read the examples — empty input, duplicates, boundaries;
  * a reference solution you could write yourself must pass every test you give.
- Every question needs a short explanation of why the answer is correct.
- You never emit a score, a ranking, or any judgement about the candidate.
- Reply with a single JSON object and nothing else.

SHAPE
{"questions":[{
  "type":"mcq|multi_select|short_answer|coding_easy|coding_medium|coding_hard|debugging",
  "difficulty":"Easy|Medium|Hard",
  "skill":"<one of the allowed skill ids>",
  "subSkill":"<narrower topic>",
  "competency":"<what this actually measures>",
  "prompt":"<the question>",
  "options":["..."],            // mcq / multi_select only
  "answer":0,                    // mcq: index. multi_select: array of indices
  "keywords":["..."],           // short_answer only
  "starterCode":"",             // coding only
  "language":"python",          // coding only: "python" or "javascript"
  "entryPoint":"solve",         // coding only: the function the tests will call
  "tests":[                     // coding only: >= 2, at least one hidden AND one visible
    {"id":"v1","hidden":false,"label":"<what this example shows>","input":[<args>],"expected":<value>},
    {"id":"h1","hidden":true,"input":[<args>],"expected":<value>}
  ],
  "rubric":["..."],             // coding only, >= 2 criteria
  "expectedConcept":"<the idea being tested>",
  "explain":"<why the answer is right>"
}]}`;

function candidateBrief(candidate) {
  const ev = (candidate.evidence || []).slice(0, 14).map(e =>
    `- [${e.trustTier || e.verification}] ${e.title} (${e.source}): ${String(e.text || '').slice(0, 220)}`).join('\n');
  return ev || '(no evidence on file yet)';
}

/* ═══════════════════════════════════════════════════════ GENERATION */

/**
 * Asks the model for `spec.length` questions and returns only those that pass
 * validation, with why each rejection happened. Never throws.
 */
export async function generateQuestions({ role, jobText, candidate, spec, targetSkills, bannedFamilies, language = 'en' }) {
  const lang = LANGUAGE_BY_CODE[language] || LANGUAGE_BY_CODE.en;
  const allowed = targetSkills.length ? targetSkills : ONTOLOGY.slice(0, 20).map(s => s.id);
  const skillNames = allowed.map(id => `${id} (${SKILL_BY_ID[id]?.name || id})`).join(', ');

  const ask = spec.map(s => `- one ${s.type} at ${s.difficulty} difficulty testing "${s.skill}"`).join('\n');

  const r = await completeJson([
    { role: 'system', content: SYSTEM },
    { role: 'user', content:
`ROLE: ${role || 'Software Engineer'}

${untrusted('job_description', String(jobText || '').slice(0, 3000))}

${untrusted('candidate_evidence', candidateBrief(candidate))}

ALLOWED SKILL IDS (use these exact ids in the "skill" field):
${skillNames}

Write exactly ${spec.length} questions:
${ask}

Make them specific to this role and to what this candidate's evidence shows they have actually done. Vary the wording and the scenario — do not write textbook questions.
${lang.code === 'en' ? '' : `
LANGUAGE: write every prompt, option and explanation in ${lang.name} (${lang.native}).
Keep code, identifiers, error messages and established technical terms in their original form — a candidate reading in ${lang.name} still writes SQL in SQL. Translate the question, not the technology.`}` },
  ], { prefer: ASSESSMENT_PROVIDER, maxTokens: 3000, temperature: 0.85 });

  if (!r.ok || !r.data) {
    return { ok: false, questions: [], rejected: [], error: r.error || 'no provider', provider: r.provider };
  }

  const raw = Array.isArray(r.data.questions) ? r.data.questions : [];
  const accepted = [];
  const rejected = [];

  for (const q of raw) {
    const v = validateQuestion(q, { targetSkills: allowed, existing: accepted, bannedFamilies });
    if (!v.ok) { rejected.push({ code: v.code, detail: v.detail, prompt: String(q?.prompt || '').slice(0, 80) }); continue; }
    accepted.push({
      ...q,
      id: `gen-${crypto.randomUUID().slice(0, 8)}`,
      familyId: v.familyId,
      source: 'ai_generated',
      language: lang.code,
      generationId: r.provider || 'unknown',
      generatedAt: new Date().toISOString(),
    });
  }

  return { ok: accepted.length > 0, questions: accepted, rejected, provider: r.provider, language: lang.code };
}

/** What the assessment layer reports about its own AI, honestly. */
export function assessmentAIStatus() {
  const st = providerStatus(ASSESSMENT_PROVIDER);
  return {
    preferred: 'Google Gemini',
    active: st.provider,
    usingPreferred: st.providerKey === ASSESSMENT_PROVIDER,
    mode: st.mode,
    note: st.enabled
      ? (st.providerKey === ASSESSMENT_PROVIDER
        ? 'Questions are generated by Gemini and validated before any candidate sees them.'
        : `Gemini is not configured, so questions are generated by ${st.provider} instead. Set GEMINI_API_KEY to use the preferred provider.`)
      : 'No AI provider configured. The assessment uses PIE\'s verified question bank — fewer questions, but every one is human-reviewed.',
  };
}
