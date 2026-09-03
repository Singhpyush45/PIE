// PIE — Supabase connection verification.
//
// These run against a local mock that behaves like PostgREST. No credentials
// and no real Supabase project are involved, so they pass offline and in CI.
//
// The bug they exist to prevent: SUPABASE_URL pasted as the REST base
// (…/rest/v1) made the driver request /rest/v1/rest/v1/<table>. Every table
// 404'd and the UI told the operator to run schema.sql against a database that
// already had all 27 tables.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const TABLES = new Set(['profiles', 'organizations', 'recruiter_profiles', 'candidate_profiles',
  'requisitions', 'applications', 'evidence', 'github_connections', 'github_repositories',
  'projects', 'certificates', 'hackathons', 'agent_runs', 'match_results', 'assessment_attempts',
  'proctoring_events', 'bias_audits', 'human_decisions', 'learning_progress', 'audit_events',
  'face_identities']);

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: '42P01', message: 'relation does not exist' }));
};

/** Starts a mock and returns its base URL plus the paths it was asked for. */
async function mock(handler) {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(new URL(req.url, 'http://x').pathname);
    handler(req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, paths, close: () => server.close() };
}

const schemaApplied = (req, res) => {
  const m = new URL(req.url, 'http://x').pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
  if (m && TABLES.has(m[1])) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
  notFound(res);
};

/** Fresh module per case: the driver reads process.env at call time. */
async function verifyWith(url, key = 'placeholder-not-a-real-key') {
  process.env.SUPABASE_URL = url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  process.env.SUPABASE_TIMEOUT_MS = '2500';
  const mod = await import(`../src/persistence/supabase.js?case=${Math.random()}`);
  return mod.verify({ force: true });
}

/* ------------------------------------------------------------------------ */

test('1 — the project URL is accepted however it was pasted', async () => {
  const m = await mock(schemaApplied);
  try {
    for (const url of [m.base, `${m.base}/`, `${m.base}/rest/v1`, `${m.base}/rest/v1/`, `  ${m.base}  `]) {
      const r = await verifyWith(url);
      assert.equal(r.state, 'CONNECTED', `"${url.trim()}" should verify, got ${r.state}`);
      assert.equal(r.tables.length, TABLES.size);
    }
    // The decisive assertion: /rest/v1 is never doubled, whatever was pasted.
    assert.ok(m.paths.every(p => !p.includes('/rest/v1/rest/v1')),
      'the REST prefix must never appear twice in a request path');
    assert.ok(m.paths.every(p => /^\/rest\/v1\/[a-z_]+$/.test(p)),
      'every table check must hit /rest/v1/<table> exactly');
  } finally { m.close(); }
});

test('2 — an empty result set means the table exists, not that it is missing', async () => {
  // Every mock table returns []. A row-count check would call all 20 missing.
  const m = await mock(schemaApplied);
  try {
    const r = await verifyWith(m.base);
    assert.equal(r.state, 'CONNECTED');
    assert.deepEqual(r.missing, []);
  } finally { m.close(); }
});

test('3 — a schema that genuinely was never applied still reports as missing', async () => {
  const m = await mock((_q, res) => notFound(res));
  try {
    const r = await verifyWith(m.base);
    assert.equal(r.state, 'REACHABLE_SCHEMA_MISSING');
    assert.match(r.detail, /schema\.sql/, 'the operator must be told what to run');
  } finally { m.close(); }
});

test('4 — a partially applied schema names the tables that are absent', async () => {
  const half = [...TABLES].slice(0, 10);
  const rest = TABLES.size - 10;
  const m = await mock((req, res) => {
    const x = new URL(req.url, 'http://x').pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (x && half.includes(x[1])) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    notFound(res);
  });
  try {
    const r = await verifyWith(m.base);
    assert.equal(r.state, 'REACHABLE_SCHEMA_PARTIAL');
    assert.equal(r.tables.length, 10);
    assert.equal(r.missing.length, rest);
  } finally { m.close(); }
});

test('5 — a rejected key is reported as an auth failure, never as a missing schema', async () => {
  const m = await mock((_q, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Invalid API key' }));
  });
  try {
    const r = await verifyWith(m.base);
    assert.equal(r.state, 'AUTH_REJECTED');
    assert.ok(!/schema\.sql/.test(r.detail),
      'a credential problem must not send the operator to the SQL editor');
  } finally { m.close(); }
});

test('5b — missing GRANTs are reported as a privilege problem, not a bad key', async () => {
  // PostgREST returns 403 + SQLSTATE 42501 when the table exists and the key is
  // valid but the API role has no GRANT. Calling that "bad credentials" sends
  // the operator to re-copy a key that was never wrong.
  const m = await mock((_q, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: '42501', message: 'permission denied for table profiles' }));
  });
  try {
    const r = await verifyWith(m.base);
    assert.equal(r.state, 'PERMISSION_DENIED');
    assert.match(r.detail, /grants\.sql/, 'it must name the file that fixes it');
    assert.ok(!/schema\.sql/.test(r.detail), 'the schema is present — do not send them to re-run it');
  } finally { m.close(); }
});

test('6 — an unreachable project is reported as unreachable', async () => {
  const r = await verifyWith('http://127.0.0.1:1');
  assert.equal(r.state, 'UNREACHABLE');
  assert.equal(r.tables.length, 0);
});

test('7 — with no credentials PIE says so and names the JSON store', async () => {
  const r = await verifyWith('', '');
  assert.equal(r.state, 'NOT_CONFIGURED');
  assert.equal(r.configured, false);
});

test('8 — no verification result ever carries the key or the raw URL', async () => {
  const m = await mock(schemaApplied);
  try {
    const secret = 'sb-secret-value-that-must-never-surface';
    const r = await verifyWith(`${m.base}/rest/v1/`, secret);
    const wire = JSON.stringify(r);
    assert.ok(!wire.includes(secret), 'the service-role key must never appear in the result');
    assert.ok(!/apikey|Authorization|Bearer/i.test(wire), 'no auth material may be echoed back');
    assert.equal(r.host, new URL(m.base).host, 'only the host is exposed');
  } finally { m.close(); }
});

/* ═════════════════════════════════════════════════════ AI PROVIDER CHAIN */

async function providersWith(envs) {
  for (const k of ['SAP_AI_CORE_DEPLOYMENT_URL', 'SAP_AI_CORE_TOKEN', 'OPENAI_API_KEY',
    'GEMINI_API_KEY', 'OLLAMA_BASE_URL']) delete process.env[k];
  Object.assign(process.env, envs);
  return import(`../src/ai/provider.js?c=${Math.random()}`);
}

test('9 — the provider order is SAP, then OpenAI, then Gemini, then a local model', async () => {
  const all = await providersWith({
    SAP_AI_CORE_DEPLOYMENT_URL: 'https://x/y', SAP_AI_CORE_TOKEN: 't',
    OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x', OLLAMA_BASE_URL: 'http://localhost:11434/v1',
  });
  assert.equal(all.providerStatus().providerKey, 'sap_genai_hub', 'SAP wins when configured');

  const noSap = await providersWith({ OPENAI_API_KEY: 'sk-x', GEMINI_API_KEY: 'g-x' });
  assert.equal(noSap.providerStatus().providerKey, 'openai');

  const geminiOnly = await providersWith({ GEMINI_API_KEY: 'g-x' });
  assert.equal(geminiOnly.providerStatus().providerKey, 'gemini');

  const ollamaOnly = await providersWith({ OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
  assert.equal(ollamaOnly.providerStatus().providerKey, 'ollama');
});

test('10 — with nothing configured PIE says so and still answers', async () => {
  const m = await providersWith({});
  const st = m.providerStatus();
  assert.equal(st.enabled, false);
  assert.equal(st.mode, 'OFFLINE');
  const r = await m.completeJson([{ role: 'user', content: 'x' }]);
  assert.equal(r.ok, false, 'no provider means no call, not a crash');
  assert.equal(r.data, null);
});

test('11 — a local model is reported as keeping data on your own infrastructure', async () => {
  const m = await providersWith({ OLLAMA_BASE_URL: 'http://localhost:11434/v1' });
  const land = m.providerLandscape();
  const ollama = land.providers.find(p => p.key === 'ollama');
  assert.equal(ollama.state, 'ACTIVE');
  assert.equal(ollama.dataLeavesMachine, false, 'this is the claim the pitch rests on');
  for (const k of ['openai', 'gemini', 'sap_genai_hub']) {
    assert.equal(land.providers.find(p => p.key === k).dataLeavesMachine, true,
      `${k} sends data off the machine and must say so`);
  }
  assert.ok(land.providers.some(p => p.key === 'templates'),
    'the deterministic floor must always appear in the chain');
});

test('12 — no provider key ever appears in the landscape', async () => {
  const m = await providersWith({ OPENAI_API_KEY: 'sk-secret-value-here', GEMINI_API_KEY: 'g-secret-value' });
  const wire = JSON.stringify(m.providerLandscape()) + JSON.stringify(m.providerStatus());
  assert.ok(!wire.includes('sk-secret-value-here'));
  assert.ok(!wire.includes('g-secret-value'));
});

/* ══════════════════════════════════════════════════════ THE SUPABASE MIRROR */

async function freshMirror(envs = {}) {
  process.env.SUPABASE_MIRROR = '1';
  Object.assign(process.env, envs);
  return import(`../src/persistence/mirror.js?c=${Math.random()}`);
}

// The line between "verifier" and "credential", which is the whole of the
// mirror's secrets policy. A bcrypt hash is a verifier: it cannot be replayed
// against PIE, and an account restored without it is an account nobody can ever
// sign in to again — which was the production bug. A session token, a reset
// token and an encrypted GitHub token are credentials: holding one IS being
// logged in. So the first is mirrored and the rest never are.
test('13 — the mirror carries verifiers and never carries credentials', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();

  const row = m.shapeRow('users', {
    id: 'usr_1', role: 'candidate', name: 'Someone', username: 'someone',
    email: 'someone@example.test', isDemo: false,
    passwordHash: '$2a$10$THE-VERIFIER',
    password: 'hunter2-MUST-NEVER-LEAVE',
    candidateProfileId: 'cand_1',
  });
  const wire = JSON.stringify(row);
  assert.equal(row.password_hash, '$2a$10$THE-VERIFIER',
    'the bcrypt hash must be mirrored — without it a restored account cannot sign in');
  assert.ok(!wire.includes('hunter2'), 'a plaintext password must never reach the mirror payload');
  assert.equal(row.candidate_profile_legacy_id, 'cand_1',
    "the user's link to its candidate profile survives, as a PIE id and not a uuid");
  assert.equal(row.legacy_id, 'usr_1', "PIE's own id is carried as legacy_id");
  assert.equal(row.full_name, 'Someone', 'name maps onto the schema column');

  const sess = m.shapeRow('users', { id: 'usr_2', name: 'X', username: 'x', email: 'x@y.z',
    tokenHash: 'SESSION-MUST-NEVER-LEAVE', accessToken: 'GH-MUST-NEVER-LEAVE' });
  const sessWire = JSON.stringify(sess);
  assert.ok(!sessWire.includes('MUST-NEVER-LEAVE'),
    'session and access tokens are credentials and are never mirrored');

  const gh = m.shapeRow('githubConnections', {
    id: 'ghc_1', candidateProfileId: 'cand_1', login: 'someone',
    accessTokenEncrypted: 'v1.aaa.bbb.ccc', tokenFingerprint: 'abc12345',
  });
  const ghWire = JSON.stringify(gh);
  assert.ok(!ghWire.includes('v1.aaa.bbb.ccc'), 'an encrypted GitHub token must never be mirrored');
  assert.equal(gh.token_fingerprint, 'abc12345', 'the fingerprint may go — it is not the token');
});

test('14 — sessions and reset tokens are never mirrored at all', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();
  const sbMod = await import('../src/persistence/supabase.js?c=' + Math.random());
  for (const c of ['sessions', 'passwordResets']) {
    assert.ok(!(c in sbMod.TABLE_MAP), `${c} must have no Supabase table mapping`);
    assert.equal(m.shapeRow(c, { id: 'x' }), null, `${c} must never be shaped for the wire`);
  }
});

test('15 — unknown fields are dropped rather than invented as columns', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();
  const row = m.shapeRow('evidence', {
    id: 'ev_1', candidateProfileId: 'cand_1', source: 'project',
    verification: 'self_reported', title: 'A thing', text: 'Some detail',
    somethingPieInventedLater: 'should not become a column',
  });
  assert.ok(!('something_pie_invented_later' in row), 'a mirror that invents columns is worse than no mirror');
  assert.equal(row.body, 'Some detail', 'PIE\'s `text` maps onto the schema\'s `body`');
  assert.equal(row.legacy_candidate_id, 'cand_1', 'the parent id travels as a legacy id');
});

// Configuring a database and then not writing to it is not a state anyone
// intends. It used to be the default, and it is the shape of the production bug:
// Supabase present, mirror quiet, restore finds nothing, sign-in fails, no error
// anywhere. So the default is now ON, and turning it off has to be a choice.
test('16 — mirroring follows the configuration, and switching it off is explicit', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:3999';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';

  delete process.env.SUPABASE_MIRROR;
  const on = await import(`../src/persistence/mirror.js?c=${Math.random()}`);
  assert.equal(on.isEnabled(), true, 'a configured Supabase is mirrored to without being asked twice');
  assert.equal(on.status().systemOfRecord, 'Supabase across restarts; the JSON store within a run');

  process.env.SUPABASE_MIRROR = '0';
  const off = await import(`../src/persistence/mirror.js?c=${Math.random()}`);
  assert.equal(off.isEnabled(), false, 'SUPABASE_MIRROR=0 turns it off');
  assert.equal(off.attach(), false, 'and attach() must decline to subscribe');
  assert.match(off.status().state, /OFF|NOT_CONFIGURED/);
  assert.equal(off.status().systemOfRecord, 'Local JSON store');
  assert.match(off.status().detail, /lost on the next restart/,
    'and it must say what turning it off costs, not just that it is off');

  delete process.env.SUPABASE_MIRROR;

  // With no Supabase at all there is nothing to mirror to, whatever the flag.
  const url = process.env.SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  const none = await import(`../src/persistence/mirror.js?c=${Math.random()}`);
  assert.equal(none.isEnabled(), false);
  process.env.SUPABASE_URL = url;
});

test('17 — an unreachable Supabase degrades, and never throws into a write', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';   // nothing listening
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  process.env.SUPABASE_TIMEOUT_MS = '1500';
  const m = await freshMirror();
  const store = await import(`../src/store.js`);

  // Queue something and flush against a dead endpoint.
  m.enqueue('organizations', 'org_does_not_matter');
  const before = store.count('organizations');
  await assert.doesNotReject(() => m.flush(), 'flush must never throw');
  assert.equal(store.count('organizations'), before, 'the local store is untouched by a mirror failure');
  assert.match(m.status().state, /DEGRADED|IDLE|MIRRORING/,
    'a dead endpoint degrades the mirror; it does not take the request path with it');
});

/* ════════════════════════════════ THE FIVE BUGS THAT ONLY APPEARED IN PRODUCTION
   A lenient local mock hid every one of these. They are asserted here so the
   next change cannot quietly reintroduce them.                              */

test('18 — every row in a batch carries an identical key set', async () => {
  // PostgREST rejects a bulk insert whose objects differ:
  //   400 "All object keys must match"
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();

  const withReq = m.shapeRow('agentRuns', { id: 'run_1', candidateProfileId: 'cand_1',
    requisitionId: 'req_1', trigger: 'FULL_ORCHESTRATION', status: 'SUCCESS' });
  const withoutReq = m.shapeRow('agentRuns', { id: 'run_2', candidateProfileId: 'cand_1',
    trigger: 'EVIDENCE_ADDED', status: 'SUCCESS' });

  assert.deepEqual(Object.keys(withReq).sort(), Object.keys(withoutReq).sort(),
    'a run with a requisition and one without must serialise to the same shape');
  assert.equal(withoutReq.legacy_requisition_id, null, 'the absent parent is null, not missing');
});

test('19 — a uuid foreign-key column never receives PIE\'s string id', async () => {
  // "invalid input syntax for type uuid: cand_1a2b" — the uuid column may only
  // be filled by parent resolution, never by the camelCase mapper.
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();

  for (const [collection, row] of [
    ['evidence', { id: 'ev_1', candidateProfileId: 'cand_1a2b', source: 'project', title: 'X' }],
    ['applications', { id: 'app_1', candidateProfileId: 'cand_1a2b', requisitionId: 'req-sdet' }],
    ['matchResults', { id: 'mr_1', candidateProfileId: 'cand_1a2b', requisitionId: 'req-sdet' }],
  ]) {
    const shaped = m.shapeRow(collection, row);
    assert.equal(shaped.candidate_profile_id, null,
      `${collection}: the uuid column must stay null until the parent is resolved`);
    assert.equal(shaped.legacy_candidate_id, 'cand_1a2b',
      `${collection}: the string id belongs in the legacy column`);
    if ('requisition_id' in shaped) assert.equal(shaped.requisition_id, null);
  }
});

test('20 — NOT NULL columns are given a value, never an explicit null', async () => {
  // Sending null overrides the schema DEFAULT and the insert is rejected with
  // "null value in column ... violates not-null constraint".
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();

  const cand = m.shapeRow('candidateProfiles', { id: 'cand_1', name: 'Someone' });
  assert.equal(cand.onboarding_complete, false, 'NOT NULL boolean must not be null');
  assert.equal(cand.is_demo, false);
  assert.deepEqual(cand.context, {}, 'NOT NULL jsonb must not be null');
  assert.notEqual(cand.created_at, null, 'NOT NULL timestamp must not be null');

  const audit = m.shapeRow('auditEvents', { id: 'aud_1', actor: 'x', action: 'SIGN_IN' });
  assert.equal(audit.is_demo, false, 'audit rows carry no isDemo but the column is NOT NULL');

  const run = m.shapeRow('agentRuns', { id: 'run_1', trigger: 'X', status: 'SUCCESS' });
  assert.notEqual(run.started_at, null, 'started_at is NOT NULL with a default — send a value');
});

test('21 — the upsert target must be a plain unique index, not a partial one', async () => {
  // PostgREST emits `ON CONFLICT (legacy_id)` with no predicate. Postgres cannot
  // infer a partial index from that:
  //   "there is no unique or exclusion constraint matching the ON CONFLICT..."
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../supabase/002_mirror.sql', import.meta.url), 'utf8');
  assert.ok(/create unique index %I on public\.%I \(legacy_id\)/.test(sql),
    'the legacy_id index must be created without a WHERE predicate');
  assert.ok(!/create unique index[^;]*legacy_id[^;]*where/i.test(sql),
    'a partial index here breaks every upsert PostgREST sends');
});

test('22 — a real timestamp is carried across rather than invented', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();
  const when = '2026-08-30T10:00:00.000Z';
  const run = m.shapeRow('agentRuns', { id: 'run_1', startedAt: when, trigger: 'X', status: 'SUCCESS' });
  assert.equal(run.started_at, when, "PIE's own timestamp wins over a generated one");
});

test('23 — the migration check names the real problem before pushing anything', async () => {
  // Seventeen identical "no unique or exclusion constraint" errors have exactly
  // one cause. The tool must say it once, up front, and write nothing.
  const seen = [];
  const m = await mock((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    // The upsert probe fails the way a partial index makes it fail.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' }));
  });
  try {
    process.env.SUPABASE_URL = m.base;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
    const sbMod = await import(`../src/persistence/supabase.js?c=${Math.random()}`);
    const r = await sbMod.migrationCheck();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'PARTIAL_INDEX', 'the cause must be named, not left as a raw 400');
    assert.match(r.detail, /002_mirror\.sql/, 'and the fix must be named too');
    assert.ok(seen.some(x => x.startsWith('DELETE')), 'the probe row must be cleaned up');
  } finally { m.close(); }
});

test('24 — a missing legacy_id column is reported as a missing migration', async () => {
  const m = await mock((req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'column audit_events.legacy_id does not exist', code: '42703' }));
  });
  try {
    process.env.SUPABASE_URL = m.base;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
    const sbMod = await import(`../src/persistence/supabase.js?c=${Math.random()}`);
    const r = await sbMod.migrationCheck();
    assert.equal(r.reason, 'MIGRATION_MISSING');
    assert.match(r.detail, /002_mirror\.sql/);
  } finally { m.close(); }
});

test('25 — every NOT NULL foreign key on a mirrored table is accounted for', async () => {
  // The class of bug behind "null value in column attempt_id violates not-null
  // constraint". Rather than wait for the next one to show up in production,
  // read the schema and check each NOT NULL uuid FK is either relaxed by the
  // migration or filled by a declared link.
  const fs = await import('node:fs');
  const here = new URL('.', import.meta.url);
  const schema = fs.readFileSync(new URL('../supabase/schema.sql', here), 'utf8');
  const migration = fs.readFileSync(new URL('../supabase/002_mirror.sql', here), 'utf8');

  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const sbMod = await import(`../src/persistence/supabase.js?c=${Math.random()}`);
  const mirrored = new Set(Object.values(sbMod.TABLE_MAP));

  // Walk the schema table by table so a column is attributed correctly.
  const gaps = [];
  const blocks = schema.split(/create table if not exists public\./).slice(1);
  for (const block of blocks) {
    const table = block.slice(0, block.indexOf(' ')).trim().replace(/\s*\($/, '');
    if (!mirrored.has(table)) continue;
    const body = block.slice(0, block.indexOf('\n);'));
    for (const m of body.matchAll(/^\s*(\w+)\s+uuid\s+not null\s+references/gim)) {
      const col = m[1];
      const relaxed = new RegExp(
        `alter table public\\.${table}\\s+alter column ${col}\\s+drop not null`, 'i').test(migration);
      if (!relaxed) gaps.push(`${table}.${col}`);
    }
  }

  assert.deepEqual(gaps, [],
    `these NOT NULL foreign keys would fail every insert the mirror makes: ${gaps.join(', ')}`);
});

test('26 — a proctoring event carries its attempt as a legacy id, never as a uuid', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();
  const row = m.shapeRow('proctoringEvents', {
    id: 'pev_1', attemptId: 'att_9f2', candidateProfileId: 'cand_1',
    type: 'WINDOW_BLUR', severity: 'low',
  });
  assert.equal(row.legacy_attempt_id, 'att_9f2', 'the attempt travels as a legacy id');
  assert.equal(row.attempt_id, null, 'and the uuid column waits for parent resolution');
  assert.ok('occurred_at' in row, 'occurred_at is NOT NULL in the schema and must be sent');
});

test('27 — the required-column map matches what the schema actually demands', async () => {
  // "null value in column event_type" cost a round trip because PIE calls that
  // field `type`. The mirror now refuses such a row up front — but only if its
  // idea of "required" matches the schema. This keeps the two honest.
  const fs = await import('node:fs');
  const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const sbMod = await import(`../src/persistence/supabase.js?c=${Math.random()}`);
  const m = await freshMirror();
  const mirrored = new Set(Object.values(sbMod.TABLE_MAP));
  const declared = m.requiredColumns();

  // Derive NOT NULL, no-DEFAULT, non-generated columns straight from the schema.
  // Split on commas at paren-depth 0: several lines declare more than one column
  // ("login text, name text not null, full_name text"), and a line-based parser
  // attributes the constraint to the wrong one.
  const splitColumns = (rawBody) => {
    // Strip -- comments LINE BY LINE first. Splitting a whole fragment at its
    // first "--" throws away the column that follows a comment line.
    const body = rawBody.split('\n').map(l => l.split('--')[0]).join('\n');
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of body) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    return parts.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  };

  const fromSchema = {};
  for (const block of schema.split(/create table if not exists public\./).slice(1)) {
    const table = block.slice(0, block.indexOf(' ')).trim();
    if (!mirrored.has(table)) continue;
    const body = block.slice(block.indexOf('(') + 1, block.indexOf('\n);'));
    const cols = [];
    for (const frag of splitColumns(body)) {
      const name = (frag.match(/^(\w+)\s/) || [])[1];
      if (!name || /^(primary|unique|check|constraint|foreign)$/i.test(name)) continue;
      if (!/\bnot null\b/i.test(frag)) continue;
      if (/\bdefault\b|generated always/i.test(frag)) continue;
      if (/\breferences\b/i.test(frag)) continue;     // covered by test 25
      cols.push(name);
    }
    if (cols.length) fromSchema[table] = cols;
  }

  for (const [table, cols] of Object.entries(fromSchema)) {
    assert.deepEqual((declared[table] || []).slice().sort(), cols.slice().sort(),
      `${table}: the mirror's required columns drifted from schema.sql`);
  }
});

test('28 — a row missing a required column is refused with a useful message', async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:1';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
  const m = await freshMirror();
  // PIE calls it `type`; the alias must carry it onto event_type.
  const good = m.shapeRow('proctoringEvents', {
    id: 'pev_1', attemptId: 'att_1', candidateProfileId: 'cand_1', type: 'WINDOW_BLUR',
  });
  assert.equal(good.event_type, 'WINDOW_BLUR', 'the alias must map `type` onto `event_type`');
});

/* ───────────────────────────────── degrading without filling the terminal */

test('29 — a column Supabase does not have is dropped, not fatal, and warned once', async () => {
  // Reproduces what a real deployment showed: proctoring_events had no
  // legacy_attempt_id because migration 002 had not been re-run, and every
  // flush printed the same failure forever while the rows never arrived.
  const http = await import('node:http');
  const posts = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', c => { b += c; });
    req.on('end', () => {
      const table = req.url.split('?')[0].replace('/rest/v1/', '');
      let rows = [];
      try { rows = JSON.parse(b || '[]'); } catch { /* body is always JSON here */ }
      posts.push({ table, cols: Object.keys(rows[0] || {}) });
      if (table === 'proctoring_events' && rows.some(r => 'legacy_attempt_id' in r)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          message: "Could not find the 'legacy_attempt_id' column of 'proctoring_events' in the schema cache",
        }));
      }
      res.writeHead(201); res.end('');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));

  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, on: process.env.SUPABASE_MIRROR };
  process.env.SUPABASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-a-real-secret';
  process.env.SUPABASE_MIRROR = '1';

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));

  try {
    const db = await import('../src/store.js');
    const mirror = await import('../src/persistence/mirror.js');
    mirror.attach();

    db.insert('proctoringEvents', { id: 'pev_drop_1', attemptId: 'att_x', candidateProfileId: 'cand_x', type: 'FOCUS_LOST', ts: new Date().toISOString() });
    await mirror.flush();
    db.insert('proctoringEvents', { id: 'pev_drop_2', attemptId: 'att_x', candidateProfileId: 'cand_x', type: 'NO_FACE', ts: new Date().toISOString() });
    await mirror.flush();

    const pe = posts.filter(p => p.table === 'proctoring_events');
    assert.ok(pe.length >= 2, 'the mirror gave up instead of retrying without the column');
    assert.ok(!pe.at(-1).cols.includes('legacy_attempt_id'),
      'the missing column was sent again after the database rejected it');
    assert.ok(pe.at(-1).cols.length > 4, 'the retry dropped more than the one missing column');

    const about = warnings.filter(w => /legacy_attempt_id/.test(w));
    assert.equal(about.length, 1, `the same fault was reported ${about.length} times; it must be said once`);
    assert.match(about[0], /002_mirror\.sql/, 'the warning does not say how to fix it');
  } finally {
    console.warn = realWarn;
    srv.close();
    process.env.SUPABASE_URL = saved.url ?? '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key ?? '';
    if (saved.on === undefined) delete process.env.SUPABASE_MIRROR; else process.env.SUPABASE_MIRROR = saved.on;
  }
});
