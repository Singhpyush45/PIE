// PIE — the SAP HANA Cloud adapter.
//
// The failure this guards against is not a crash. It is the adapter saying
// CONNECTED because three environment variables are present, which is what it
// used to do — it had no driver and never opened a session. An integration that
// reports itself green without ever connecting is worse than one that is absent,
// because the readiness page is then lying to a jury.
//
// The live instance cannot be reached from CI, so these tests cover everything
// around the connection: what the adapter claims before one succeeds, what it
// claims after one fails, that a failure never propagates into a request, and
// that a verification does not survive a change of instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const SRC = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')).href;

const HANA = {
  SAP_HANA_HOST: 'pie-test.hana.eu-central-1.hanacloud.ondemand.com',
  SAP_HANA_PORT: '443',
  SAP_HANA_USER: 'PIE_APP',
  SAP_HANA_PASSWORD: 'not-a-real-password',
  SAP_HANA_SCHEMA: 'PIE_TEST',
  SAP_HANA_TIMEOUT_MS: '3000',
};

/** Runs module code in a fresh process so nothing is shared between cases. */
const run = (code, env) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).stdout.trim();

test('environment variables alone never mean connected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-hana-'));
  try {
    const out = run(`
      const h = await import('${SRC}/integrations/sapHanaRepository.js');
      const s = h.status();
      console.log(JSON.stringify({ state: s.state, cls: s.classification }));`,
    { ...process.env, PIE_DATA_DIR: dir, ...HANA });
    const s = JSON.parse(out);
    assert.equal(s.state, 'CONFIGURED_UNVERIFIED',
      'the adapter claimed a connection it has never made');
    assert.match(s.cls, /PROPOSED/,
      'an unverified adapter must not be classified CONFIRMED to a jury');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a real connection attempt that fails is recorded as a failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-hana-'));
  try {
    const out = run(`
      const h = await import('${SRC}/integrations/sapHanaRepository.js');
      const v = await h.verify();
      console.log(JSON.stringify({ ok: v.ok, reason: v.reason, state: h.status().state }));`,
    { ...process.env, PIE_DATA_DIR: dir, ...HANA });
    const r = JSON.parse(out);
    assert.equal(r.ok, false, 'a nonexistent host reported a successful connection');
    assert.ok(['REFUSED', 'TIMEOUT', 'DRIVER_MISSING'].includes(r.reason), `unexpected reason ${r.reason}`);
    assert.equal(r.state, 'REFUSED', 'a failed connection did not change the reported state');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a verification does not carry over to a different instance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-hana-'));
  const env = { ...process.env, PIE_DATA_DIR: dir, ...HANA };
  try {
    // Record a success against this instance, as a real verify would.
    run(`
      const c = await import('${SRC}/persistence/checks.js');
      c.record('sap_hana', { ok: true, detail: 'connected',
        config: c.fingerprint(['${HANA.SAP_HANA_HOST}', '443', '${HANA.SAP_HANA_USER}', '${HANA.SAP_HANA_SCHEMA}']) });`, env);

    const same = run(`
      const h = await import('${SRC}/integrations/sapHanaRepository.js');
      console.log(h.status().state);`, env);
    assert.equal(same, 'CONNECTED', 'a recorded connection was not picked up');

    const moved = run(`
      const h = await import('${SRC}/integrations/sapHanaRepository.js');
      console.log(h.status().state);`,
    { ...env, SAP_HANA_HOST: 'somewhere-else.hana.eu-central-1.hanacloud.ondemand.com' });
    assert.equal(moved, 'CONFIGURED_UNVERIFIED',
      'a verification taken against one instance was reported for a different one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a write failure is survived, never thrown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-hana-'));
  try {
    const out = run(`
      const h = await import('${SRC}/integrations/sapHanaRepository.js');
      const a = await h.saveAuditEvent({ id: 'ae-1', action: 'TEST', actor: 'someone' });
      const m = await h.saveMatchResult({ id: 'mr-1', candidateProfileId: 'c1', skillsFirstScore: 0.8 });
      console.log(JSON.stringify({ a, m }));`,
    { ...process.env, PIE_DATA_DIR: dir, ...HANA });
    const { a, m } = JSON.parse(out);
    for (const [name, r] of [['audit event', a], ['match result', m]]) {
      assert.equal(r.ok, false, `${name}: an unreachable database reported a successful write`);
      assert.equal(r.persistedLocally, true,
        `${name}: a HANA failure must still say the local store holds the record`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the enterprise-record mirror is off unless explicitly switched on', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-hana-'));
  try {
    const off = run(`
      const m = await import('${SRC}/persistence/hanaMirror.js');
      console.log(m.status().state);`, { ...process.env, PIE_DATA_DIR: dir, ...HANA });
    assert.equal(off, 'OFF', 'the HANA mirror ran without being asked to');

    const on = run(`
      const m = await import('${SRC}/persistence/hanaMirror.js');
      console.log(m.status().state);`,
    { ...process.env, PIE_DATA_DIR: dir, ...HANA, SAP_HANA_MIRROR: '1' });
    assert.ok(['ON', 'DEGRADED'].includes(on), `unexpected mirror state ${on}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
