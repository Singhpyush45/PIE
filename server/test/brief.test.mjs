// PIE — decision briefs.
//
// The risk in letting a model narrate a hiring decision is not that the prose is
// bad. It is that the model is handed something it should never see — a name, a
// university, an employment gap — and quietly reintroduces exactly the pedigree
// bias the rest of the system removes. These tests capture what actually leaves
// the process, and assert on that.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* A provider stand-in that records every prompt it is sent. */
const seen = [];
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    seen.push(JSON.parse(b));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      headline: 'Developing match, strongest on SQL.',
      strengths: 'The evidence supports SQL and data quality work.',
      gaps: 'CI/CD is not covered by any evidence.',
      decisionHinges: 'Whether the team can support ramp-up on CI/CD.',
      whatWasStrong: 'Your evidence supports SQL and data quality engineering.',
      whatWasMissing: 'This role needed CI/CD, which your evidence did not cover.',
      nextStep: 'Start with the CI/CD pathway.',
      whatIsNext: 'A recruiter will be in touch.',
    }) } }] }));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
process.env.OPENAI_API_KEY = 'test-key-not-a-real-secret';
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${srv.address().port}`;

const { decisionBriefAgent, candidateOutcomeAgent } = await import('../src/ai/agents.js');

const MATCHING = {
  matchTier: 'Developing Match', skillsFirstScore: 0.62, potentialAdjusted: 0.68, growthUplift: 0.06,
  breakdown: [
    { id: 'sql', name: 'SQL', coverage: 0.9, mandatory: true },
    { id: 'dataquality', name: 'Data Quality Engineering', coverage: 0.5, mandatory: true },
  ],
  gaps: [{ id: 'cicd', name: 'CI/CD', required: 0.7, held: 0.1 }],
};
const DISCOVERY = { skills: [{ id: 'sql', name: 'SQL', confidence: 0.88, sourceCount: 3 }] };
// The shape the Learning Pathway agent actually emits. An earlier version of
// this fixture used `pathway: [...]`, which is metadata about where the steps
// came from — so the test passed while the real pathway came back empty on
// every rejection. A fixture that does not match production proves nothing.
const LEARNING = {
  pathway: { source: 'PIE ontology + open learning resources' },
  objectives: [
    { objectiveId: 'obj-cicd', skillId: 'cicd', skill: 'CI/CD', from: 0.1, to: 0.7 },
    { objectiveId: 'obj-docker', skillId: 'docker', skill: 'Docker / Containers', from: 0.2, to: 0.6 },
  ],
};
const ASSESSMENT = { overall: 0.71, answered: 6, skillBreakdown: [{ skill: 'SQL', score: 0.9 }] };

// Things a fair process must never hand to a narrator.
const FORBIDDEN = [
  'Meera', 'Kulkarni', 'Galgotias', 'university', 'college', 'graduated',
  'career gap', 'years of experience', 'female', 'male', 'age ', 'Pune', 'Bengaluru',
];

test('the recruiter brief never sends identity or pedigree to the model', async () => {
  seen.length = 0;
  const out = await decisionBriefAgent({
    matching: MATCHING, discovery: DISCOVERY, learning: LEARNING, assessment: ASSESSMENT,
    roleTitle: 'Data Quality / SDET Engineer',
    // Deliberately passed alongside — the agent must not forward them.
    candidateName: 'Meera Kulkarni', institution: 'Galgotias University', yearsExperience: 2,
  });
  assert.ok(out.narrative, 'the brief did not come back');

  // Only the USER message carries candidate data. The system message names the
  // things to avoid, so scanning it would flag PIE's own instruction not to
  // mention a university as a leak of one.
  const payload = JSON.stringify(seen.flatMap(c => c.messages.filter(m => m.role === 'user')));
  for (const word of FORBIDDEN) {
    assert.ok(!new RegExp(word, 'i').test(payload), `"${word}" was sent to the language model`);
  }
  // And prove the scan would actually catch something.
  assert.match(payload, /Data Quality/, 'the payload check is looking at the wrong message');
});

test('the brief is built from the computed numbers, not invented ones', async () => {
  seen.length = 0;
  await decisionBriefAgent({ matching: MATCHING, discovery: DISCOVERY, learning: LEARNING, roleTitle: 'X' });
  const payload = JSON.stringify(seen.flatMap(c => c.messages.filter(m => m.role === 'user')));
  assert.match(payload, /0\.62/, 'the skills-first score was not given to the model');
  assert.match(payload, /CI\/CD/, 'the computed gap was not given to the model');
});

test('with no model the brief still says something true', async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  const savedBase = process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  try {
    const out = await decisionBriefAgent({ matching: MATCHING, discovery: DISCOVERY, roleTitle: 'Data Engineer' });
    assert.equal(out.narrative, null);
    assert.ok(out.fallback.includes('Developing Match'), 'the fallback lost the computed tier');
    assert.ok(out.fallback.includes('CI/CD'), 'the fallback lost the computed gap');
    assert.match(out.note, /deterministic/i);
  } finally {
    process.env.OPENAI_API_KEY = savedKey;
    process.env.OPENAI_BASE_URL = savedBase;
  }
});

test('a rejected candidate is told what was missing and what closes it', async () => {
  const out = await candidateOutcomeAgent({
    action: 'REJECT', matching: MATCHING, discovery: DISCOVERY, learning: LEARNING,
    roleTitle: 'Data Quality / SDET Engineer',
  });
  assert.equal(out.rejected, true);
  assert.ok(out.narrative.whatWasStrong, 'a rejection with no acknowledgement of what was strong');
  assert.ok(out.narrative.whatWasMissing, 'a rejection that does not say what was missing');
  assert.ok(out.narrative.nextStep, 'a rejection with no way forward');
  assert.ok(out.gaps.length, 'the concrete gaps were not returned for the dashboard');
  assert.ok(out.learningSteps.length, 'no learning pathway came back with the rejection');
});

test("the recruiter's private reason is never relayed to the candidate", async () => {
  seen.length = 0;
  const REASON = 'Honestly the writing in their notes felt sloppy and I did not warm to them.';
  await candidateOutcomeAgent({
    action: 'REJECT', matching: MATCHING, discovery: DISCOVERY, learning: LEARNING,
    roleTitle: 'X', reason: REASON, recruiterNote: REASON,
  });
  const payload = JSON.stringify(seen.flatMap(c => c.messages.filter(m => m.role === 'user')));
  assert.ok(!/sloppy|warm to them/i.test(payload),
    'an internal recruiter note was forwarded into candidate-facing feedback');
});

test('the pathway survives either shape the learning agent might return', async () => {
  // Objectives is what it emits today. An array under `pathway` is the older
  // shape; neither should produce a rejection with no way forward.
  for (const learning of [
    LEARNING,
    { steps: [{ title: 'CI/CD foundations' }] },
    { pathway: [{ title: 'CI/CD foundations' }] },
  ]) {
    const out = await candidateOutcomeAgent({
      action: 'REJECT', matching: MATCHING, discovery: DISCOVERY, learning, roleTitle: 'X',
    });
    assert.ok(out.learningSteps.length > 0,
      `no pathway came back for ${JSON.stringify(Object.keys(learning))}`);
  }
});

test.after(() => srv.close());
