// Corsair adapter — what must stay true.
//
// These tests exist because the previous version of this integration was wrong
// in a way no test could have caught: it was written against a REST API that
// does not exist, and every test that could have been written about it would
// have passed. So these deliberately do NOT mock the SDK into agreeing with
// PIE. They assert the things that hold whatever Corsair does — the refusal to
// read without a tenant, the honesty of the status states, and the fact that a
// broken Corsair cannot break evidence import.
//
// Nothing here needs a Corsair account, a network, or a database.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as corsair from '../src/integrations/corsair.js';
import * as sdk from '../src/integrations/corsairClient.js';
import * as evidence from '../src/integrations/githubEvidenceAdapter.js';

const VARS = ['CORSAIR_API_KEY', 'CORSAIR_SIGNING_SECRET', 'CORSAIR_KEK', 'CORSAIR_DATABASE_URL', 'DATABASE_URL'];

/** Runs `fn` with exactly this Corsair environment, then puts it all back. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  Object.assign(process.env, vars);
  sdk.reset();
  try { return await fn(); } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    sdk.reset();
  }
}

/**
 * A complete, fake Corsair environment with a key nothing has ever seen.
 *
 * The key is unique per call on purpose. A proved integration is recorded to
 * disk in server/data/service-checks.json and deliberately outlives the process
 * — that is what stops PIE re-proving itself on every boot. It also means a
 * fixed test key would let one test read back the proof another test recorded
 * minutes ago in a different run, and assert something that is not true of a
 * fresh install. Every test here starts from "nothing has been proved".
 */
let n = 0;
const env = () => ({
  CORSAIR_API_KEY: `ck_test_${process.pid}_${(n += 1)}`,
  CORSAIR_SIGNING_SECRET: 'csec_test_not_a_real_secret',
  CORSAIR_KEK: 'dGVzdC1rZWstdGhpcnR5LXR3by1ieXRlcy1sb25nLi4=',
  // Refuses instantly rather than timing out, so a test never waits on a socket.
  CORSAIR_DATABASE_URL: 'postgres://pie:nope@127.0.0.1:1/pie',
});
const FULL = env();

/* ------------------------------------------------------------------------ */

test('1 — three variables out of four is not a configured integration', async () => {
  for (const omit of Object.keys(FULL)) {
    const partial = { ...FULL };
    delete partial[omit];
    await withEnv(partial, () => {
      assert.equal(corsair.isConfigured(), false, `${omit} missing should mean not configured`);
      assert.deepEqual(sdk.missing(), [omit], `only ${omit} should be reported missing`);
    });
  }
  await withEnv(FULL, () => {
    assert.equal(corsair.isConfigured(), true);
    assert.deepEqual(sdk.missing(), []);
  });
});

test('2 — an unconfigured Corsair names the variables, never a value', async () => {
  await withEnv({}, () => {
    const s = corsair.status();
    assert.equal(s.state, 'NOT_CONFIGURED');
    assert.equal(s.plugins.length, 0);
    // The point of the panel: it says what to set, without becoming a place
    // secrets are displayed.
    for (const name of Object.values(sdk.envNames)) {
      assert.ok(s.requires.includes(name), `${name} should be named in requires`);
    }
  });
});

test('3 — status never contains a configured secret value', async () => {
  const secrets = env();
  await withEnv(secrets, () => {
    const rendered = JSON.stringify(corsair.status());
    for (const [k, v] of Object.entries(secrets)) {
      assert.ok(!rendered.includes(v), `status() leaked the value of ${k}`);
    }
    // A prefix short enough to identify a rotation is fine and is not the key.
    assert.ok(!rendered.includes(secrets.CORSAIR_KEK.slice(0, 16)), 'status() leaked part of the KEK');
  });
});

test('4 — a configured-but-unproven Corsair does not claim to be connected', async () => {
  await withEnv(env(), () => {
    const s = corsair.status();
    assert.notEqual(s.state, 'CONNECTED');
    assert.match(s.classification, /^PROPOSED/);
    // The rule the whole Integrations screen rests on: having the environment
    // set is never evidence that anything works.
    assert.match(s.detail, /no call has been made|failed/i);
  });
});

test('5 — a Corsair that cannot reach its database fails as a state, not a crash', async () => {
  await withEnv(env(), async () => {
    const r = await corsair.verify();
    assert.equal(r.ok, false);
    assert.ok(r.detail, 'a failure must explain itself');
    assert.ok(!String(r.detail).includes(FULL.CORSAIR_KEK), 'the failure detail leaked the KEK');
    // And the panel must now show the refusal rather than staying optimistic.
    assert.equal(corsair.status().state, 'REFUSED');
    await sdk.close();
  });
});

test('6 — Corsair is never read without a tenant', async () => {
  await withEnv(FULL, async () => {
    const r = await corsair.githubRepositories('octocat', {});
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_TENANT');
    // This is the multi-tenancy guarantee in one assertion: there is no ambient
    // "default" account whose credential a caller could read by forgetting an
    // argument.
  });
});

test('7 — one candidate can never be handed another candidate\'s tenant', () => {
  const a = corsair.tenantFor({ id: 'u_1', candidateProfileId: 'cp_aaa' });
  const b = corsair.tenantFor({ id: 'u_2', candidateProfileId: 'cp_bbb' });
  assert.notEqual(a, b);
  assert.equal(a, 'cand_cp_aaa');

  // A recruiter has no candidate profile, and must not fall into the candidate
  // namespace — otherwise a user id that happened to match a profile id would
  // read that candidate's connected account.
  const recruiter = corsair.tenantFor({ id: 'cp_aaa' });
  assert.equal(recruiter, 'user_cp_aaa');
  assert.notEqual(recruiter, a);

  assert.equal(corsair.tenantFor(null), null);
  assert.equal(corsair.tenantFor({}), null);
});

test('8 — a broken Corsair cannot break evidence import', async () => {
  await withEnv(FULL, async () => {
    // Corsair is configured and its database is unreachable — the worst case.
    // A candidate importing repositories must still get evidence.
    const r = await evidence.fetchRepositories('meerak', { limit: 8, tenantId: 'cand_cp_zzz' });
    assert.ok(r.repositories.length > 0, 'evidence import returned nothing');
    assert.notEqual(r.mode, 'CORSAIR');
    assert.ok(r.notice, 'the fallback must say where the data came from');
    await sdk.close();
  });
});

test('9 — with no tenant, Corsair is not consulted at all', async () => {
  await withEnv(FULL, async () => {
    const started = Date.now();
    const r = await evidence.fetchRepositories('meerak', { limit: 8 });
    // No tenant means the Corsair branch is skipped entirely rather than tried
    // and failed — which is observable as it not having waited on a socket.
    assert.ok(Date.now() - started < 500, 'a tenant-less import should not touch Corsair');
    assert.equal(r.mode, 'DEMO_DATA');
  });
});

test('10 — the demo path is labelled as demo, always', async () => {
  await withEnv({}, async () => {
    const r = await evidence.fetchRepositories('meerak', { limit: 8 });
    assert.equal(r.mode, 'DEMO_DATA');
    assert.match(r.notice, /demo/i);
    assert.match(r.notice, /nothing was fetched/i);
    // PIE never presents fixtures as API-derived. The trust tier is what a
    // recruiter reads, so it is what must not lie.
    const [ev] = evidence.toEvidence(r.repositories, 'meerak', r.mode);
    assert.equal(ev.trustTier, 'SELF-REPORTED');
    assert.equal(ev.verification, 'self_reported');
  });
});

test('11 — rotating the key retires the proof that the old one earned', async () => {
  // A recorded success is bound to the configuration that produced it. Without
  // that, replacing a revoked key with a new one would leave the panel showing
  // CONNECTED on the strength of a call the current credentials never made —
  // the panel would be reporting history, not state.
  const first = env();
  await withEnv(first, async () => {
    await corsair.verify();                      // fails against 127.0.0.1:1
    assert.equal(corsair.status().state, 'REFUSED');
    await sdk.close();
  });

  await withEnv({ ...first, CORSAIR_API_KEY: `${first.CORSAIR_API_KEY}_rotated` }, () => {
    assert.equal(corsair.status().state, 'CONFIGURED_UNVERIFIED',
      'a rotated key must be unproven again, not inherit the old verdict');
  });
});
