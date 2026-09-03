// Can somebody start an assessment they should not be able to start?
//
// Everything else about identity is unit-tested. This file only asks the
// question an attacker asks, and it asks it over HTTP against a running PIE —
// because a gate that exists in a module and not on the wire is not a gate.
//
// The tests deliberately skip the interface entirely. Every request here is one
// anybody could send with curl. That is the point of Phase 4: the screen is not
// what is being trusted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPie, uniq, personDescriptor, sameFace } from './harness/pieServer.mjs';

let pie = null;
const api = (...a) => pie.api(...a);

before(async () => { pie = await startPie({ name: 'gate' }); });
after(async () => { await pie?.stop(); });

/** A candidate who has done everything asked of them, ready to be attacked. */
async function makeCandidate({ verifyEmail = true, registerFace = true } = {}) {
  const tag = uniq();
  const who = {
    role: 'candidate', name: `Gate ${tag}`, username: `gate${tag}`,
    email: `gate${tag}@example.test`,
    password: `Str0ng-${tag}`, confirmPassword: `Str0ng-${tag}`,
  };
  const reg = await api('/api/auth/register', { method: 'POST', body: who });
  const out = { ...who, ticket: reg.data.ticket, cookie: null, token: null, face: personDescriptor(Math.random()) };

  if (!verifyEmail) return out;

  const code = pie.codeFor(who.email);
  const ok = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code, ticket: reg.data.ticket },
  });
  assert.equal(ok.status, 200, `email verification failed: ${JSON.stringify(ok.data)}`);
  out.cookie = ok.setCookie.split(';')[0];
  out.token = ok.data.token;
  out.userId = ok.data.user.id;
  out.candidateProfileId = ok.data.user.candidateProfileId;

  if (registerFace) {
    const r = await api('/api/candidate/identity/register', {
      method: 'POST', token: out.token, body: { descriptor: out.face },
    });
    assert.equal(r.status, 201, `identity registration failed: ${JSON.stringify(r.data)}`);
  }
  return out;
}

const startBody = extra => ({
  requisitionId: 'req-sdet', consent: { accepted: true }, preflight: { camera: true }, ...extra,
});

/* ------------------------------------------------------------------------ */

test('1 — the honest path works end to end', async () => {
  const c = await makeCandidate();

  const check = await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: sameFace(c.face, 0.02) },
  });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.ok, true);
  assert.ok(check.data.checkId);

  const start = await api('/api/assessment/start', {
    method: 'POST', token: c.token, body: startBody({ identityCheckId: check.data.checkId }),
  });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.ok(start.data.attempt.attemptId, 'and only now does an attempt exist');
});

test('2 — a direct API call with no identity check is rejected', async () => {
  const c = await makeCandidate();
  // Exactly what a modified client, or curl, would send: everything the honest
  // request has except the one thing that was earned.
  const start = await api('/api/assessment/start', { method: 'POST', token: c.token, body: startBody() });
  assert.equal(start.status, 403);
  assert.equal(start.data.reason, 'NO_CHECK');
  assert.equal(start.data.attempt, undefined, 'and no session comes back with the refusal');
});

test('3 — a failed face check cannot be spent', async () => {
  const c = await makeCandidate();
  const somebodyElse = personDescriptor(Math.random());

  const check = await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: somebodyElse },
  });
  assert.equal(check.status, 403);
  assert.equal(check.data.reason, 'NO_MATCH');
  assert.match(check.data.error, /does not match the registered candidate/);

  // The refusal still records a check row. Presenting its id must not work.
  const start = await api('/api/assessment/start', {
    method: 'POST', token: c.token, body: startBody({ identityCheckId: check.data.checkId || 'chk_x' }),
  });
  assert.equal(start.status, 403);
});

test('4 — candidate A cannot start an assessment with candidate B\'s verification', async () => {
  const [a, b] = await Promise.all([makeCandidate(), makeCandidate()]);

  // B verifies honestly and gets a real, valid, unspent ticket.
  const bCheck = await api('/api/assessment/identity/verify', {
    method: 'POST', token: b.token, body: { descriptor: sameFace(b.face, 0.02) },
  });
  assert.equal(bCheck.status, 200);

  // A presents it, signed in as A.
  const stolen = await api('/api/assessment/start', {
    method: 'POST', token: a.token, body: startBody({ identityCheckId: bCheck.data.checkId }),
  });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.data.reason, 'NOT_YOURS');

  // And B's ticket is still good afterwards, so the refusal did not simply
  // invalidate everything it touched.
  const bStart = await api('/api/assessment/start', {
    method: 'POST', token: b.token, body: startBody({ identityCheckId: bCheck.data.checkId }),
  });
  assert.equal(bStart.status, 200, JSON.stringify(bStart.data));
});

test('5 — a candidate cannot register somebody else\'s face over their own', async () => {
  const c = await makeCandidate();
  const swap = await api('/api/candidate/identity/register', {
    method: 'POST', token: c.token, body: { descriptor: personDescriptor(Math.random()) },
  });
  assert.equal(swap.status, 409);
  assert.equal(swap.data.reason, 'ALREADY_REGISTERED');

  // The original face still verifies — the attempt changed nothing.
  const check = await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: sameFace(c.face, 0.02) },
  });
  assert.equal(check.status, 200);
});

test('6 — one verification buys one assessment', async () => {
  const c = await makeCandidate();
  const check = await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: sameFace(c.face, 0.02) },
  });
  const first = await api('/api/assessment/start', {
    method: 'POST', token: c.token, body: startBody({ identityCheckId: check.data.checkId }),
  });
  assert.equal(first.status, 200);

  const second = await api('/api/assessment/start', {
    method: 'POST', token: c.token, body: startBody({ identityCheckId: check.data.checkId }),
  });
  assert.equal(second.status, 403);
  assert.equal(second.data.reason, 'ALREADY_USED');
});

test('7 — an unverified email stops everything, before any face is involved', async () => {
  const c = await makeCandidate({ verifyEmail: false });
  // No session was issued at all, so there is nothing to attack with. That is
  // itself the assertion: registration did not hand out a usable credential.
  assert.equal(c.token, null);
  assert.equal(c.cookie, null);

  // And an unauthenticated call gets nowhere near the gate.
  const start = await api('/api/assessment/start', { method: 'POST', body: startBody() });
  assert.equal(start.status, 401);
});

test('8 — a candidate with no registered identity cannot verify or start', async () => {
  const c = await makeCandidate({ registerFace: false });

  const check = await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: c.face },
  });
  assert.equal(check.status, 409);
  assert.equal(check.data.reason, 'NOT_REGISTERED');

  const start = await api('/api/assessment/start', {
    method: 'POST', token: c.token, body: startBody({ identityCheckId: 'chk_invented' }),
  });
  assert.equal(start.status, 403);
  assert.equal(start.data.reason, 'IDENTITY_NOT_REGISTERED');
});

test('9 — junk descriptors are refused rather than stored as a face', async () => {
  const c = await makeCandidate({ registerFace: false });
  const junk = [
    { descriptor: null },
    { descriptor: [] },
    { descriptor: 'not-a-vector' },
    { descriptor: new Array(128).fill(0) },
    { descriptor: new Array(64).fill(0.1) },
    { descriptor: { 0: 0.1, 1: 0.2 } },      // a Float32Array after JSON
    {},
  ];
  for (const body of junk) {
    const r = await api('/api/candidate/identity/register', { method: 'POST', token: c.token, body });
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(body).slice(0, 40)}`);
    assert.equal(r.data.reason, 'BAD_DESCRIPTOR');
  }
  const still = await api('/api/candidate/identity', { token: c.token });
  assert.equal(still.data.registered, false, 'and none of them became a registered identity');
});

test('10 — no response anywhere carries the stored template', async () => {
  const c = await makeCandidate();
  const seen = [];
  seen.push(await api('/api/candidate/identity', { token: c.token }));
  seen.push(await api('/api/bootstrap', { token: c.token }));
  seen.push(await api('/api/candidate/profile', { token: c.token }));
  seen.push(await api('/api/assessment/identity/verify', {
    method: 'POST', token: c.token, body: { descriptor: sameFace(c.face, 0.02) } }));

  for (const r of seen) {
    const wire = JSON.stringify(r.data);
    for (const v of c.face.slice(0, 10)) {
      assert.ok(!wire.includes(String(v)), 'a template element must never appear in a response');
    }
    assert.ok(!/"template"|"descriptor"|"embedding"/.test(wire));
  }
});

test('11 — PIE says out loud that it does not do liveness', async () => {
  const c = await makeCandidate();
  const r = await api('/api/candidate/identity', { token: c.token });
  assert.equal(r.data.liveness.implemented, false);
  assert.match(r.data.liveness.note, /photograph/i);
  // The overclaim this guards against: describing face matching as if it stopped
  // someone holding up a photo. If liveness is ever implemented, this test
  // should be changed deliberately, not deleted.
});

test('12 — a gate nobody can pass is an outage, so email is enforced only where mail exists', async () => {
  // This server HAS mail, so the gate is live and a candidate who skipped
  // verification never even got a session.
  const enforced = await api('/api/candidate/identity', { token: 'not-a-real-token' });
  assert.equal(enforced.status, 401);

  const c = await makeCandidate();
  const state = await api('/api/candidate/identity', { token: c.token });
  assert.equal(state.data.emailVerificationEnforced, true,
    'with SMTP configured, email verification is enforced');
  assert.equal(state.data.emailVerified, true);

  // The other half of this claim — that a deployment with no mail transport
  // does not lock every candidate out — is asserted by the rest of the suite:
  // the shared test server runs without SMTP, and its real candidates still
  // register, sign in and use the product throughout flows.test.mjs.
});

test('13 — the demo world still works, because it is exempt on purpose', async () => {
  const personas = await api('/api/demo/personas');
  assert.equal(personas.status, 200);
  const candidate = (personas.data.personas || personas.data.candidates || [])
    .find(p => p.role === 'candidate') || personas.data.personas?.[0];
  assert.ok(candidate, 'the demo entrance must still offer a candidate persona');

  const entered = await api('/api/demo/enter', { method: 'POST', body: { userId: candidate.id } });
  assert.equal(entered.status, 200, JSON.stringify(entered.data));

  const start = await api('/api/assessment/start', {
    method: 'POST', token: entered.data.token, body: startBody(),
  });
  assert.equal(start.status, 200,
    `a curated demo persona has no email and no face; gating it would break the walkthrough `
    + `and protect nothing. ${JSON.stringify(start.data)}`);
});
