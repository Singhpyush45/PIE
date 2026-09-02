// PIE — authentication, authorization, isolation and GitHub authorization tests.
//
// Every test here is a promise PIE makes about *real accounts*, not the demo.
// Run with: npm test   (expects the API on PORT/5174)

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.PIE_TEST_BASE || 'http://localhost:5174';
const uniq = () => Math.random().toString(36).slice(2, 8);

async function api(path, { method = 'GET', body, token, cookie, redirect = 'follow' } = {}) {
  const res = await fetch(BASE + path, {
    method, redirect,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

const register = (role, extra = {}) => {
  const tag = uniq();
  const password = `Str0ng-${tag}`;
  return api('/api/auth/register', {
    method: 'POST',
    body: {
      role, name: `Test ${role} ${tag}`,
      username: `t${role.slice(0, 4)}${tag}`,
      email: `t${role.slice(0, 4)}${tag}@example.test`,
      password, confirmPassword: password,
      ...extra,
    },
  }).then(r => ({ ...r, password }));
};

let cand, rec;

before(async () => {
  cand = await register('candidate', { targetRole: 'Backend Engineer', location: 'Pune' });
  rec = await register('recruiter', { organization: `Testworks ${uniq()}` });
  assert.equal(cand.status, 201, 'candidate registration must succeed');
  assert.equal(rec.status, 201, 'recruiter registration must succeed');
});

/* ══════════════════════════════════════════════════════════ REGISTRATION */

test('1 — registration creates a real, non-demo account with a session', async () => {
  assert.equal(cand.data.user.role, 'candidate');
  assert.equal(cand.data.user.isDemo, false, 'a registered account is never part of the demo world');
  assert.ok(cand.data.token, 'registration must issue a session');
  const me = await api('/api/auth/me', { token: cand.data.token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, cand.data.user.username);
});

test('2 — the password is never returned, echoed or stored in plaintext', async () => {
  const wire = JSON.stringify(cand.data);
  assert.ok(!wire.includes(cand.password), 'the plaintext password must never appear in a response');
  assert.ok(!/passwordHash|password/i.test(JSON.stringify(cand.data.user)),
    'no password field of any kind may reach the client');

  // And nothing password-shaped is readable through any authenticated surface.
  const boot = await api('/api/bootstrap', { token: cand.data.token });
  assert.ok(!JSON.stringify(boot.data).includes(cand.password));
});

test('3 — weak passwords, bad usernames and duplicates are refused', async () => {
  const weak = await api('/api/auth/register', { method: 'POST', body: {
    role: 'candidate', name: 'Weak Password', username: `weak${uniq()}`,
    email: `weak${uniq()}@example.test`, password: 'abc', confirmPassword: 'abc' } });
  assert.equal(weak.status, 400);

  const badUser = await api('/api/auth/register', { method: 'POST', body: {
    role: 'candidate', name: 'Bad Username', username: 'a b!',
    email: `bad${uniq()}@example.test`, password: 'Str0ngEnough1', confirmPassword: 'Str0ngEnough1' } });
  assert.equal(badUser.status, 400);

  const dupe = await api('/api/auth/register', { method: 'POST', body: {
    role: 'candidate', name: 'Duplicate', username: cand.data.user.username,
    email: `dupe${uniq()}@example.test`, password: 'Str0ngEnough1', confirmPassword: 'Str0ngEnough1' } });
  assert.equal(dupe.status, 409, 'a taken username must be refused, not silently reassigned');
});

test('4 — the administrator account cannot be created from the public form', async () => {
  const r = await api('/api/auth/register', { method: 'POST', body: {
    role: 'admin', name: 'Sneaky Admin', username: `adm${uniq()}`,
    email: `adm${uniq()}@example.test`, password: 'Str0ngEnough1', confirmPassword: 'Str0ngEnough1' } });
  assert.equal(r.status, 400, 'admin is provisioned server-side only');
});

/* ══════════════════════════════════════════════════════════════════ LOGIN */

test('5 — login works with the username', async () => {
  const r = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: cand.password } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.id, cand.data.user.id);
});

test('6 — login works with the email address', async () => {
  const r = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.email.toUpperCase(), password: cand.password } });
  assert.equal(r.status, 200, 'email match must be case-insensitive');
  assert.equal(r.data.user.id, cand.data.user.id);
});

test('7 — a wrong password is refused, and the error reveals nothing', async () => {
  const wrong = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: 'NotTheP4ssword' } });
  const missing = await api('/api/auth/login', { method: 'POST',
    body: { identifier: `ghost${uniq()}`, password: 'NotTheP4ssword' } });
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(wrong.data.error, missing.data.error,
    'an existing account and a missing one must produce the identical message');
  assert.ok(!wrong.data.token);
});

test('8 — a demo persona cannot be signed into through the real login form', async () => {
  const personas = await api('/api/demo/personas');
  const meera = personas.data.candidates.find(c => c.username === 'meera');
  assert.ok(meera, 'the demo pool must be reachable through its own door');
  for (const pw of ['password', 'demo', 'meera', 'Str0ngEnough1']) {
    const r = await api('/api/auth/login', { method: 'POST',
      body: { identifier: 'meera', password: pw } });
    assert.equal(r.status, 401, 'demo personas have no password and no way in through this form');
  }
});

test('9 — logout ends the session and the token stops working', async () => {
  const fresh = await register('candidate');
  const t = fresh.data.token;
  assert.equal((await api('/api/auth/me', { token: t })).status, 200);
  await api('/api/auth/logout', { method: 'POST', token: t });
  assert.equal((await api('/api/auth/me', { token: t })).status, 401,
    'a destroyed session must not be usable afterwards');
});

test('10 — protected endpoints reject anonymous and forged tokens', async () => {
  for (const path of ['/api/bootstrap', '/api/services', '/api/audit']) {
    assert.equal((await api(path)).status, 401, `${path} must require a session`);
    assert.equal((await api(path, { token: 'forged.token.value' })).status, 401,
      `${path} must reject a token it never issued`);
  }
});

/* ═══════════════════════════════════════════════════════ THE SIGN-IN DOOR */

test('10b — a correct password at the wrong door is refused', async () => {
  // The landing page has one card per role. An administrator signing in at the
  // candidate card used to land in the Trust & Integrity console.
  const wrong = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: cand.password, role: 'recruiter' } });
  assert.equal(wrong.status, 401, 'a candidate must not sign in at the recruiter door');
  assert.ok(!wrong.data.token, 'no session may be issued');

  const asAdmin = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: cand.password, role: 'admin' } });
  assert.equal(asAdmin.status, 401, 'and certainly not at the administrator door');

  // Same message as a plain wrong password: the refusal must not reveal that the
  // account exists, nor what role it holds.
  const badPw = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: 'NotTheP4ssword', role: 'candidate' } });
  assert.equal(wrong.data.error, badPw.data.error,
    'a wrong-door refusal must be indistinguishable from a wrong password');

  // The right door still works.
  const right = await api('/api/auth/login', { method: 'POST',
    body: { identifier: cand.data.user.username, password: cand.password, role: 'candidate' } });
  assert.equal(right.status, 200);
  assert.equal(right.data.user.role, 'candidate');
});

/* ═══════════════════════════════════════════════════════ PASSWORD RESET */

test('10c — forgot-password never reveals whether an account exists', async () => {
  const real = await api('/api/auth/forgot', { method: 'POST', body: { email: cand.data.user.email } });
  const fake = await api('/api/auth/forgot', { method: 'POST', body: { email: `nobody${uniq()}@example.test` } });
  const junk = await api('/api/auth/forgot', { method: 'POST', body: { email: 'not-an-email' } });

  assert.equal(real.status, 200);
  assert.equal(fake.status, 200);
  assert.equal(junk.status, 200);
  assert.equal(real.data.message, fake.data.message, 'the answer must not depend on the address');
  assert.equal(real.data.message, junk.data.message);
  assert.ok(!JSON.stringify(real.data).includes('token'), 'no token may be returned to the caller');
});

test('10d — a bad or stale reset token is refused', async () => {
  const bogus = await api('/api/auth/reset', { method: 'POST',
    body: { token: 'a'.repeat(43), password: 'BrandNewP4ss', confirmPassword: 'BrandNewP4ss' } });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.data.code, 'INVALID');

  const check = await api('/api/auth/reset/check?token=' + 'b'.repeat(43));
  assert.equal(check.status, 200);
  assert.equal(check.data.valid, false, 'the screen must detect a stale link before asking for a password');
});

/* ═════════════════════════════════════════════════════ ROLE AUTHORIZATION */

test('11 — a candidate cannot use recruiter or administrator endpoints', async () => {
  const t = cand.data.token;
  const post = await api('/api/recruiter/requisitions', { method: 'POST', token: t,
    body: { title: 'Should never exist', text: 'x'.repeat(80) } });
  assert.ok([401, 403].includes(post.status), 'candidates may not create requisitions');

  const sb = await api('/api/system/supabase', { token: t });
  assert.equal(sb.status, 403, 'system readiness is Trust & Integrity only');
});

test('12 — a recruiter cannot act as a candidate', async () => {
  const r = await api('/api/candidate/evidence', { method: 'POST', token: rec.data.token,
    body: { source: 'resume', title: 'Not mine', body: 'x'.repeat(40) } });
  assert.ok([401, 403, 404].includes(r.status), 'a recruiter has no candidate profile to write to');
});

/* ════════════════════════════════════════════════════════ WORLD ISOLATION */

test('13 — a real account cannot see or touch demo data', async () => {
  const boot = await api('/api/bootstrap', { token: cand.data.token });
  assert.equal(boot.status, 200);
  assert.equal(boot.data.evidence.length, 0, 'a new real candidate starts with no evidence');
  assert.equal(boot.data.openRequisitions.length, 0, 'demo requisitions are invisible to a real account');

  // And a demo profile id cannot be reached by guessing it.
  const peek = await api('/api/orchestrate', { method: 'POST', token: rec.data.token,
    body: { candidateProfileId: 'cand_meera', requisitionId: 'req-sdet', useAI: false } });
  assert.ok([403, 404].includes(peek.status),
    'a real recruiter must not be able to orchestrate against a demo candidate');
});

test('14 — a demo session cannot see or modify a real account', async () => {
  const personas = await api('/api/demo/personas');
  const ananya = personas.data.recruiters[0];
  const demo = await api('/api/demo/enter', { method: 'POST', body: { userId: ananya.id } });
  const boot = await api('/api/bootstrap', { token: demo.data.token });
  const ids = (boot.data.candidates || []).map(c => c.id);
  assert.ok(!ids.includes(cand.data.user.candidateProfileId),
    'the real candidate registered in this run must not appear in the demo recruiter’s pool');
  assert.ok(boot.data.candidates.every(c => c.isDemo !== false),
    'every candidate visible to a demo session belongs to the demo world');
});

test('15 — resetting the demo leaves real accounts signed in and intact', async () => {
  const before = await api('/api/auth/me', { token: cand.data.token });
  await api('/api/demo/reset', { method: 'POST' });
  const after = await api('/api/auth/me', { token: cand.data.token });
  assert.equal(after.status, 200, 'a real session must survive a demo reset');
  assert.equal(after.data.user.id, before.data.user.id);
});

/* ══════════════════════════════════════════════ CANDIDATE DATA ISOLATION */

test('16 — one candidate cannot read another candidate’s evidence', async () => {
  const other = await register('candidate');
  await api('/api/candidate/evidence', { method: 'POST', token: other.data.token,
    body: { source: 'project', title: 'Private to the other candidate',
      body: 'A project record that belongs to somebody else entirely.' } });

  const mine = await api('/api/bootstrap', { token: cand.data.token });
  assert.ok(!JSON.stringify(mine.data.evidence).includes('Private to the other candidate'),
    'evidence must never cross between candidate accounts');

  const direct = await api(`/api/candidate/profile/${other.data.user.candidateProfileId}`,
    { token: cand.data.token });
  assert.ok([403, 404].includes(direct.status), 'a direct profile read must be refused');
});

/* ═════════════════════════════════════════════════ GITHUB AUTHORIZATION */

test('17 — GitHub status is reported honestly and never overclaims', async () => {
  const s = await api('/api/github/status', { token: cand.data.token });
  assert.equal(s.status, 200);
  assert.equal(s.data.connected, false, 'a new account has no GitHub connection');
  assert.equal(s.data.connection, null, 'and therefore no connection record');

  assert.ok(['OAUTH_CONFIGURED', 'NOT_CONFIGURED', 'DEMO_FIXTURES',
    'LIVE_API_READ_ONLY', 'MISCONFIGURED'].includes(s.data.fixtures.state),
    `unexpected evidence-source state: ${s.data.fixtures.state}`);

  assert.ok(['OAUTH_READY', 'NOT_CONFIGURED'].includes(s.data.oauth.state));
  assert.deepEqual(s.data.oauth.scopes, ['read:user'],
    'PIE must request read-only access and nothing more');
  assert.ok(/cannot modify your code/i.test(s.data.oauth.permissionStatement),
    'the permission statement shown to the candidate must be explicit about limits');
  if (s.data.oauth.state === 'NOT_CONFIGURED')
    assert.equal(s.data.oauth.mode, 'DEMO_FIXTURES', 'unconfigured must mean demo, never a silent live claim');
  assert.ok(!JSON.stringify(s.data).includes('client_secret'));
});

test('18 — authorization is a redirect to github.com, never a password prompt', async () => {
  const r = await api('/api/github/authorize', { method: 'POST', token: cand.data.token });
  if (r.status === 200) {
    assert.ok(r.data.url.startsWith('https://github.com/login/oauth/authorize'),
      'the candidate must be sent to GitHub’s own consent screen');
    assert.ok(/scope=read%3Auser|scope=read:user/.test(r.data.url), 'read:user scope only');
    assert.ok(/state=/.test(r.data.url), 'a CSRF state parameter is mandatory');
    assert.ok(!/client_secret/.test(r.data.url), 'the client secret must never appear in a browser URL');
  } else {
    assert.equal(r.status, 503, 'with no OAuth app configured, PIE says so rather than faking it');
    assert.equal(r.data.code, 'GITHUB_OAUTH_UNCONFIGURED');
    assert.ok(r.data.error && /GITHUB_CLIENT_ID/.test(JSON.stringify(r.data)),
      'the error must tell the operator exactly what to configure');
  }
});

test('19 — the OAuth callback rejects a forged or replayed state', async () => {
  const r = await api('/api/github/callback?code=fake&state=forged-state-value',
    { token: cand.data.token, redirect: 'manual' });
  const location = r.headers.get('location') || '';
  assert.ok(r.status >= 300 || r.status === 400, 'a bad state must not be processed');
  assert.ok(!/token/i.test(location), 'no token may ever appear in a redirect URL');
});

test('20 — imported repositories become SELF-REPORTED evidence when not API-derived', async () => {
  const repos = await api('/api/github/repositories', { token: cand.data.token });
  if (repos.status !== 200 || !repos.data.repositories?.length) return; // no connection: nothing to assert

  assert.ok(repos.data.mode, 'the repository list must declare where it came from');
  const first = repos.data.repositories[0];
  const imp = await api('/api/github/import', { method: 'POST', token: cand.data.token,
    body: { repositories: [first.fullName || first.name] } });
  if (imp.status !== 200) return;
  for (const e of imp.data.evidence || []) {
    if (repos.data.mode !== 'LIVE_API') {
      assert.equal(e.trustTier, 'SELF-REPORTED',
        'demo repository data must never be labelled API-DERIVED');
      assert.ok(/demo/i.test(e.title + e.body), 'demo-sourced evidence must say so on its face');
    }
  }
});

test('21 — no GitHub access token is ever exposed to the client', async () => {
  const surfaces = await Promise.all([
    api('/api/github/status', { token: cand.data.token }),
    api('/api/bootstrap', { token: cand.data.token }),
    api('/api/services', { token: cand.data.token }),
  ]);
  for (const s of surfaces) {
    const wire = JSON.stringify(s.data);
    assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(wire), 'a GitHub token pattern must never be serialised');
    assert.ok(!/"accessToken"|"access_token"|"clientSecret"|"client_secret"/.test(wire),
      'no token or secret field may reach the browser');
  }
});

/* ═══════════════════════════════════════════════════ SECRETS & READINESS */

test('22 — no server secret leaks through any authenticated surface', async () => {
  const s = await api('/api/services', { token: cand.data.token });
  const wire = JSON.stringify(s.data);
  assert.ok(!/sk-[A-Za-z0-9_-]{20,}/.test(wire), 'an OpenAI key pattern must never be serialised');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(wire), 'a JWT-shaped service key must never be serialised');
  // Naming an environment VARIABLE is how PIE tells the operator what to configure.
  // Leaking its VALUE is the failure. Assert on values, not on the word.
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'GITHUB_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY']) {
    const value = process.env[name];
    if (value) assert.ok(!wire.includes(value), `${name}'s value must never be serialised`);
  }
});

test('23 — Supabase reports its real state and never claims a connection it lacks', async () => {
  const s = await api('/api/services', { token: cand.data.token });
  const sb = s.data.services.find(x => x.key === 'supabase');
  assert.ok(sb, 'Supabase must appear in the service landscape');
  assert.ok(['NOT_CONFIGURED', 'CONFIGURED_UNVERIFIED', 'CONNECTED', 'UNREACHABLE',
    'AUTH_REJECTED', 'REACHABLE_SCHEMA_MISSING', 'REACHABLE_SCHEMA_PARTIAL'].includes(sb.state),
    `unexpected Supabase state: ${sb.state}`);
  if (sb.state === 'NOT_CONFIGURED') {
    assert.ok(/JSON store/i.test(sb.detail), 'it must name the actual system of record instead');
  }
});
