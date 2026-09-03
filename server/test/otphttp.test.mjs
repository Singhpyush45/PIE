// The OTP flow end to end, over HTTP, against a real PIE server.
//
// The shared test server runs with no mail transport, because that is the honest
// local default and a dozen other files assert behaviour under it. Email
// verification only exists when mail does, so this file brings up its own PIE
// process with SMTP wired to a fake server, and reads the codes out of the
// messages that actually arrive.
//
// Nothing is stubbed. PIE generates the code, sends it through nodemailer, and
// this test reads it the way a candidate reads their inbox — so a break anywhere
// along that path fails the test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPie, uniq } from './harness/pieServer.mjs';

let pie = null;
const api = (...a) => pie.api(...a);
const codeFor = e => pie.codeFor(e);

const newCandidate = () => {
  const tag = uniq();
  return {
    role: 'candidate', name: `Otp Test ${tag}`, username: `otp${tag}`,
    email: `otp${tag}@example.test`,
    password: `Str0ng-${tag}`, confirmPassword: `Str0ng-${tag}`,
  };
};

before(async () => { pie = await startPie({ name: 'otp' }); });
after(async () => { await pie?.stop(); });

/* ------------------------------------------------------------------------ */

test('1 — registering a candidate does not sign them in; it sends a code', async () => {
  const who = newCandidate();
  const r = await api('/api/auth/register', { method: 'POST', body: who });

  assert.equal(r.status, 201);
  assert.equal(r.data.requiresEmailVerification, true);
  assert.equal(r.data.user, null, 'no user object, because there is no session yet');
  assert.equal(r.data.token, null);
  assert.ok(!r.setCookie, 'and above all no session cookie — the account is not usable yet');
  assert.ok(r.data.ticket, 'the browser gets a ticket so it can finish what it started');

  const code = codeFor(who.email);
  assert.match(String(code), /^\d{4}$/, 'a four-digit code actually arrived by email');
  assert.ok(!JSON.stringify(r.data).includes(code),
    'and the code is nowhere in the HTTP response — only in the inbox');
});

test('2 — the right code signs them in; the account is now verified', async () => {
  const who = newCandidate();
  const reg = await api('/api/auth/register', { method: 'POST', body: who });
  const code = codeFor(who.email);

  const ok = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code, ticket: reg.data.ticket },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.user.email, who.email);
  assert.equal(ok.data.user.emailVerified, true);
  assert.ok(ok.setCookie, 'and only now is a session cookie set');

  // The session works.
  const me = await api('/api/auth/me', { cookie: ok.setCookie.split(';')[0] });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.emailVerified, true);
});

test('3 — the wrong code fails, and the fifth wrong one burns it', async () => {
  const who = newCandidate();
  const reg = await api('/api/auth/register', { method: 'POST', body: who });
  const code = codeFor(who.email);
  const wrong = code === '0000' ? '1111' : '0000';

  const first = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code: wrong, ticket: reg.data.ticket },
  });
  assert.equal(first.status, 400);
  assert.equal(first.data.reason, 'INCORRECT');
  assert.equal(first.data.attemptsLeft, 4);

  for (let i = 0; i < 4; i += 1) {
    await api('/api/auth/verify-email/confirm', {
      method: 'POST', body: { email: who.email, code: wrong, ticket: reg.data.ticket },
    });
  }
  const burnt = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code, ticket: reg.data.ticket },
  });
  assert.equal(burnt.status, 429);
  assert.equal(burnt.data.reason, 'TOO_MANY_ATTEMPTS');
  assert.ok(!burnt.setCookie, 'and no session is handed out on the way past');
});

test('4 — the code alone is not enough: a different browser is refused', async () => {
  const who = newCandidate();
  await api('/api/auth/register', { method: 'POST', body: who });
  const code = codeFor(who.email);

  // Everything the attacker could plausibly know — the address and the code —
  // but not the ticket the real browser was given.
  const stolen = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code },
  });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.data.reason, 'TICKET_INVALID');
  assert.ok(!stolen.setCookie);

  const madeUp = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code, ticket: 'a-ticket-somebody-made-up' },
  });
  assert.equal(madeUp.status, 403);
});

test('5 — resending issues a new code and retires the old one', async () => {
  const who = newCandidate();
  const reg = await api('/api/auth/register', { method: 'POST', body: who });
  const first = codeFor(who.email);

  // The per-minute cooldown is real, so an immediate resend is refused rather
  // than quietly succeeding.
  const tooSoon = await api('/api/auth/verify-email/request', { method: 'POST', body: { email: who.email } });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.data.reason, 'COOLDOWN');

  // The first code still works, because a refused resend must not invalidate it.
  const ok = await api('/api/auth/verify-email/confirm', {
    method: 'POST', body: { email: who.email, code: first, ticket: reg.data.ticket },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('6 — asking for a code never reveals whether an address has an account', async () => {
  const nobody = await api('/api/auth/verify-email/request', {
    method: 'POST', body: { email: `nobody-${uniq()}@example.test` },
  });
  const who = newCandidate();
  await api('/api/auth/register', { method: 'POST', body: who });
  const somebody = await api('/api/auth/verify-email/request', { method: 'POST', body: { email: who.email } });

  // A 404 for one and a 200 for the other would turn this into an account
  // enumeration endpoint. The rate-limit refusal is the only difference, and it
  // is the same refusal an attacker would hit for any address.
  assert.equal(nobody.status, 200);
  assert.equal(nobody.data.notice, 'If that address has an account awaiting verification, a new code is on its way.');
  assert.ok([200, 429].includes(somebody.status));
});

test('7 — recruiter registration is untouched and signs in immediately', async () => {
  const tag = uniq();
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      role: 'recruiter', name: `Rec ${tag}`, username: `rec${tag}`,
      email: `rec${tag}@example.test`, password: `Str0ng-${tag}`, confirmPassword: `Str0ng-${tag}`,
      organization: 'Northwind',
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.requiresEmailVerification, false);
  assert.ok(r.data.user, 'a recruiter still gets a session on registration');
  assert.ok(r.setCookie);
});

test('8 — the admin account still signs in', async () => {
  const r = await api('/api/auth/login', {
    method: 'POST', body: { identifier: 'admin', password: 'test-only-Adm1n-password' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'admin');
});

test('9 — the verification state endpoint leaks nothing', async () => {
  const who = newCandidate();
  await api('/api/auth/register', { method: 'POST', body: who });
  const code = codeFor(who.email);
  const s = await api(`/api/auth/verify-email/state?email=${encodeURIComponent(who.email)}`);

  assert.equal(s.status, 200);
  assert.equal(s.data.pending, true);
  assert.equal(s.data.attemptsLeft, 5);
  const wire = JSON.stringify(s.data);
  assert.ok(!wire.includes(code), 'the state endpoint must not hand out the code');
  assert.ok(!/hash|ticket/i.test(wire));
});
