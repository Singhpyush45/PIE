// PIE — the SAP Generative AI Hub adapter.
//
// Two failures this guards against, both of which the adapter used to have.
//
//   The adapter reported CONNECTED, and classified itself CONFIRMED to a jury,
//   because two environment variables were set. It had never called anything.
//
//   It authenticated with a static bearer token. AI Core issues tokens that
//   expire after a few hours, so a demo that started fine would begin returning
//   401 partway through with no explanation. Tokens are now fetched from the
//   service key and refreshed before they expire.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* A stand-in for AI Core: an XSUAA token endpoint, the deployment list, and
   an OpenAI-shaped inference endpoint. */
const seen = { tokenCalls: 0, secretInBody: false, bearers: [] };
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    if (req.headers.authorization) seen.bearers.push(req.headers.authorization);
    if (req.url.startsWith('/oauth/token')) {
      seen.tokenCalls += 1;
      seen.secretInBody = /client_secret=/.test(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: `tok-${seen.tokenCalls}`, expires_in: 3600 }));
    }
    if (req.url.startsWith('/v2/lm/deployments')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ resources: [{ status: 'RUNNING' }, { status: 'STOPPED' }] }));
    }
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const dir = await mkdtemp(path.join(tmpdir(), 'pie-sapai-'));
process.env.PIE_DATA_DIR = dir;
process.env.SAP_AI_CORE_DEPLOYMENT_URL = `${BASE}/v2/inference/deployments/d1`;
process.env.SAP_AI_CORE_AUTH_URL = BASE;
process.env.SAP_AI_CORE_CLIENT_ID = 'sb-pie-test';
process.env.SAP_AI_CORE_CLIENT_SECRET = 'not-a-real-secret';
process.env.SAP_AI_CORE_API_URL = BASE;

const sap = await import('../src/integrations/sapGenAiHub.js');

test('credentials alone do not mean connected', () => {
  const s = sap.status();
  assert.equal(s.state, 'CONFIGURED_UNVERIFIED',
    'the adapter claimed a connection it had never made');
  assert.match(s.classification, /PROPOSED/,
    'an unverified adapter must not be classified CONFIRMED to a jury');
});

test('the service key is the auth path, not a pasted token', () => {
  assert.equal(sap.authMode(), 'OAUTH');
});

test('a real token exchange and API call promotes the adapter', async () => {
  const v = await sap.verify();
  assert.equal(v.ok, true, `verify failed: ${v.detail}`);
  assert.equal(v.running, 1, 'the running-deployment count was not read from the API');

  const s = sap.status();
  assert.equal(s.state, 'CONNECTED');
  assert.match(s.classification, /CONFIRMED/);
  assert.match(s.detail, /checked /, 'a verified adapter must say when it was checked');
});

test('the client secret never travels as a bearer token', async () => {
  await sap.chat([{ role: 'user', content: 'hi' }]);
  for (const b of seen.bearers) {
    assert.ok(!b.includes('not-a-real-secret'), 'the client secret was sent as a bearer token');
    assert.match(b, /^Bearer tok-/, `unexpected authorization header: ${b.slice(0, 20)}`);
  }
  assert.equal(seen.secretInBody, true, 'the secret should be form-encoded in the token request body');
});

test('the token is reused rather than refetched on every call', async () => {
  const before = seen.tokenCalls;
  await sap.chat([{ role: 'user', content: 'a' }]);
  await sap.chat([{ role: 'user', content: 'b' }]);
  assert.equal(seen.tokenCalls, before,
    `the token endpoint was called ${seen.tokenCalls - before} extra time(s) for two inference calls`);
});

test('a static token is accepted but labelled as the thing that expires', async () => {
  const saved = {
    url: process.env.SAP_AI_CORE_AUTH_URL,
    id: process.env.SAP_AI_CORE_CLIENT_ID,
    secret: process.env.SAP_AI_CORE_CLIENT_SECRET,
  };
  delete process.env.SAP_AI_CORE_AUTH_URL;
  delete process.env.SAP_AI_CORE_CLIENT_ID;
  delete process.env.SAP_AI_CORE_CLIENT_SECRET;
  process.env.SAP_AI_CORE_TOKEN = 'a-pasted-token';
  try {
    assert.equal(sap.authMode(), 'STATIC_TOKEN');
    const s = sap.status();
    assert.ok(s.limitation, 'a static token carries no warning that it expires');
    assert.match(s.limitation, /expire/i);
  } finally {
    delete process.env.SAP_AI_CORE_TOKEN;
    process.env.SAP_AI_CORE_AUTH_URL = saved.url;
    process.env.SAP_AI_CORE_CLIENT_ID = saved.id;
    process.env.SAP_AI_CORE_CLIENT_SECRET = saved.secret;
  }
});

test('an unreachable auth endpoint degrades honestly', async () => {
  const saved = process.env.SAP_AI_CORE_AUTH_URL;
  process.env.SAP_AI_CORE_AUTH_URL = 'http://127.0.0.1:1';   // nothing listens here
  process.env.SAP_AI_TIMEOUT_MS = '2000';
  try {
    const v = await sap.verify();
    assert.equal(v.ok, false);
    assert.ok(['AUTH_UNREACHABLE', 'AUTH_REJECTED'].includes(v.reason), `unexpected reason ${v.reason}`);
    assert.equal(sap.status().state, 'REFUSED');
    assert.match(sap.status().detail, /falls back/i,
      'a refusal must say PIE keeps working without it');
  } finally {
    process.env.SAP_AI_CORE_AUTH_URL = saved;
  }
});

test.after(async () => { srv.close(); await rm(dir, { recursive: true, force: true }); });
