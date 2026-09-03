// Does an account survive losing the filesystem?
//
// That is the entire production bug: on Render's free plan the instance is
// recycled, server/data/pie.json goes with it, and a candidate who registered
// yesterday is told their credentials do not match an account. Locally it never
// happens, because locally the file is still there.
//
// So these tests do not check that hydrate "works". They stage the actual
// failure — an empty store, a database that has the rows — and then ask the
// question the user asks: can this person sign in?

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A throwaway data directory, so a test run never touches the real store.
process.env.PIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-hydrate-'));
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-not-a-real-key';
process.env.SUPABASE_TIMEOUT_MS = '2500';

const db = await import('../src/store.js');
const hydrate = await import('../src/persistence/hydrate.js');
const auth = await import('../src/auth.js');

/**
 * A fake PostgREST holding whatever rows the case needs.
 *
 * A table not named in `tables` answers with an empty array, because that is
 * what a correctly migrated but empty project does. Pass `{ unmigrated: true }`
 * to make every table 404 instead — the case where the SQL was never run.
 */
async function fakeSupabase(tables, { unmigrated = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const table = u.pathname.replace('/rest/v1/', '');
    seen.push({ table, offset: Number(u.searchParams.get('offset') || 0) });
    if (unmigrated) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: '42P01', message: 'relation does not exist' }));
    }
    const rows = tables[table] || [];
    const limit = Number(u.searchParams.get('limit') || 1000);
    const offset = Number(u.searchParams.get('offset') || 0);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows.slice(offset, offset + limit)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  return { seen, close: () => server.close() };
}

const reset = () => db.resetAll();

/* ------------------------------------------------------------------------ */

test('1 — an account restored from Supabase can actually sign in', async () => {
  reset();
  // The hash of a password a real candidate would have chosen. Generated here
  // rather than pasted, so the test proves bcrypt round-trips rather than
  // proving a literal string was copied.
  const hash = await auth.hashPassword('correct-horse-9');

  const m = await fakeSupabase({
    profiles: [{
      legacy_id: 'usr_real', role: 'candidate', full_name: 'Aarti Nair',
      username: 'aarti', email: 'aarti@example.test',
      password_hash: hash, email_verified: true,
      candidate_profile_legacy_id: 'cand_real', is_demo: false,
      id: '00000000-0000-0000-0000-000000000001', mirrored_at: '2026-09-01T00:00:00Z',
    }],
    candidate_profiles: [{
      legacy_id: 'cand_real', name: 'Aarti Nair', headline: 'Self-taught backend developer',
      is_demo: false, id: '00000000-0000-0000-0000-000000000002',
    }],
  });

  try {
    assert.equal(db.count('users'), 0, 'the store starts empty, as it does on a cold Render boot');

    const r = await hydrate.run();
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.restored.users, 1);
    assert.equal(r.restored.candidateProfiles, 1);

    // The question a candidate actually asks.
    const user = auth.findByIdentifier('aarti@example.test');
    assert.ok(user, 'the restored account must be findable by the email they sign in with');
    assert.equal(await auth.verifyPassword('correct-horse-9', user.passwordHash), true,
      'the restored account must accept the password it was created with');
    assert.equal(await auth.verifyPassword('wrong-password-1', user.passwordHash), false,
      'and must still reject the wrong one');

    // The links have to survive too, or the candidate signs in to an empty app.
    assert.equal(user.candidateProfileId, 'cand_real');
    assert.ok(db.findById('candidateProfiles', 'cand_real'), 'their profile came back with them');
    assert.equal(user.emailVerified, true, 'a verified email stays verified across a restart');
  } finally { m.close(); }
});

test('2 — without the hash the restore is worthless, so prove the hash is what carries it', async () => {
  // The mutation of test 1. If password_hash were ever dropped from the mirror
  // again — the exact bug this migration fixed — the row still restores, the
  // user still exists, and sign-in still fails. That failure is silent, so it
  // gets its own assertion rather than being implied.
  reset();
  const m = await fakeSupabase({
    profiles: [{
      legacy_id: 'usr_nohash', role: 'candidate', full_name: 'Ravi K',
      username: 'ravik', email: 'ravi@example.test', is_demo: false,
      // password_hash deliberately absent
    }],
  });
  try {
    await hydrate.run();
    const user = auth.findByIdentifier('ravi@example.test');
    assert.ok(user, 'the row restores');
    assert.equal(user.passwordHash, undefined);
    assert.equal(await auth.verifyPassword('anything-at-all', user.passwordHash), false,
      'and the account is permanently unusable — which is why the hash must be mirrored');
  } finally { m.close(); }
});

test('3 — hydrate merges; it never overwrites what the running store already has', async () => {
  reset();
  db.insert('candidateProfiles', { id: 'cand_local', name: 'Local Edit', headline: 'edited just now' });
  const m = await fakeSupabase({
    candidate_profiles: [
      { legacy_id: 'cand_local', name: 'Stale Copy', headline: 'from an older push', is_demo: false },
      { legacy_id: 'cand_new', name: 'Restored', is_demo: false },
    ],
  });
  try {
    const r = await hydrate.run();
    assert.equal(db.findById('candidateProfiles', 'cand_local').headline, 'edited just now',
      'a newer local row must win over the database copy');
    assert.ok(db.findById('candidateProfiles', 'cand_new'), 'a row only in the database is added');
    assert.equal(r.restored.candidateProfiles, 1, 'exactly one row was new');
    assert.equal(db.count('candidateProfiles'), 2, 'and nothing was duplicated');
  } finally { m.close(); }
});

test('4 — the demo world is regenerated, not restored', async () => {
  reset();
  const m = await fakeSupabase({
    candidate_profiles: [
      { legacy_id: 'cand_demo', name: 'Demo Persona', is_demo: true },
      { legacy_id: 'cand_real2', name: 'Real Person', is_demo: false },
    ],
  });
  try {
    await hydrate.run();
    assert.equal(db.findById('candidateProfiles', 'cand_demo'), undefined,
      'seed.js owns the demo world; restoring it would accumulate a new set every boot');
    assert.ok(db.findById('candidateProfiles', 'cand_real2'));
  } finally { m.close(); }
});

test('5 — more rows than one page still all arrive', async () => {
  reset();
  process.env.SUPABASE_HYDRATE_PAGE = '25';
  const many = Array.from({ length: 60 }, (_, i) => ({
    legacy_id: `cand_${i}`, name: `Candidate ${i}`, is_demo: false,
  }));
  const m = await fakeSupabase({ candidate_profiles: many });
  try {
    const r = await hydrate.run();
    assert.equal(r.restored.candidateProfiles, 60,
      'PostgREST caps a response server-side, so a single unpaged request loses rows silently');
    const offsets = m.seen.filter(s => s.table === 'candidate_profiles').map(s => s.offset);
    assert.deepEqual(offsets, [0, 25, 50], 'and it pages until a short page says stop');
  } finally {
    delete process.env.SUPABASE_HYDRATE_PAGE;
    m.close();
  }
});

test('6 — a database that is asleep or unmigrated does not stop the server booting', async () => {
  reset();
  // Nothing listening at all.
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  const r = await hydrate.run();
  assert.equal(r.ok, false);
  assert.equal(r.total, 0);
  assert.match(r.detail, /Could not read/);
  assert.ok(hydrate.bootLine(r).includes('INCOMPLETE'),
    'the console must say so rather than looking like a normal boot');

  // A schema that was never migrated: the tables 404.
  const m = await fakeSupabase({}, { unmigrated: true });
  try {
    const r2 = await hydrate.run();
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /003_auth\.sql/, 'and it names the migration to run');
  } finally { m.close(); }
});

test('7 — a row written directly in Supabase, with no PIE id, is left alone', async () => {
  reset();
  const m = await fakeSupabase({
    candidate_profiles: [
      { id: 'aaaaaaaa-0000-0000-0000-000000000000', name: 'Written via the Supabase console', is_demo: false },
      { legacy_id: 'cand_pie', name: 'Written by PIE', is_demo: false },
    ],
  });
  try {
    const r = await hydrate.run();
    assert.equal(r.restored.candidateProfiles, 1);
    assert.equal(db.count('candidateProfiles'), 1,
      'a row with no legacy_id has no PIE identity and must not be invented one');
  } finally { m.close(); }
});

test('8 — turning it off is possible, and says so', async () => {
  reset();
  process.env.SUPABASE_HYDRATE = '0';
  try {
    const r = await hydrate.run();
    assert.equal(r.reason, 'DISABLED');
    assert.equal(db.count('users'), 0);
  } finally { delete process.env.SUPABASE_HYDRATE; }
});

test('9 — sessions are never restored, so a restart signs everyone out', async () => {
  reset();
  const m = await fakeSupabase({
    // Even if something put them there, hydrate must not walk this table.
    sessions: [{ legacy_id: 'sess_1', token_hash: 'MUST-NEVER-COME-BACK' }],
    profiles: [{ legacy_id: 'usr_s', role: 'candidate', full_name: 'S', username: 's',
      email: 's@example.test', is_demo: false }],
  });
  try {
    await hydrate.run();
    assert.equal(db.count('sessions'), 0);
    assert.equal(m.seen.some(s => s.table === 'sessions'), false,
      'the sessions table is not even read — a session token is a credential, not a record');
  } finally { m.close(); }
});
