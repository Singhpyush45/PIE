// PIE — durable verification records.
//
// The behaviour these protect was a real complaint: `node tools/mail-test.mjs`
// reported ACCEPTED, and the running server still said "no message has been sent
// yet", because the tool proved it in its own process and exited. Supabase had
// the same shape — its verification died on every restart, so someone had to
// press "Verify connection" again each time.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A file URL, not a filesystem path. These tests build source code as a string
// and import from it; on Windows a raw path is `F:\PIE_V3\...`, whose
// backslashes are escape sequences inside a JS string literal. The generated
// code was a SyntaxError, the child printed nothing, and every assertion saw an
// empty string. A file:// URL has forward slashes on every platform.
const SRC = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')).href;

/** Runs one line of module code in a FRESH process, so nothing is shared. */
const inProcess = (code, env) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).stdout.trim();

const SMTP = {
  SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587',
  SMTP_USER: 'someone@example.test', SMTP_PASS: 'x'.repeat(16),
  SMTP_FROM: 'PIE <someone@example.test>',
};

test('a check proven in one process is visible in the next', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-checks-'));
  const env = { ...process.env, PIE_DATA_DIR: dir, ...SMTP };
  try {
    assert.equal(
      inProcess(`const m = await import('${SRC}/mailer.js'); console.log(m.status().state);`, env),
      'CONFIGURED_UNVERIFIED',
      'a fresh deployment must not claim to be verified');

    // Stand in for mail-test.mjs: a separate process proving the credentials.
    inProcess(`
      const c = await import('${SRC}/persistence/checks.js');
      c.record('smtp', { ok: true, detail: 'credentials accepted',
        config: c.fingerprint(['${SMTP.SMTP_HOST}', '${SMTP.SMTP_PORT}', '${SMTP.SMTP_USER}', '${SMTP.SMTP_FROM}']) });`, env);

    const after = inProcess(`
      const m = await import('${SRC}/mailer.js'); const s = m.status();
      console.log(JSON.stringify({ state: s.state, detail: s.detail }));`, env);
    const s = JSON.parse(after);
    assert.equal(s.state, 'VERIFIED', 'the server did not pick up a successful check made by another process');
    assert.match(s.detail, /checked /, 'a remembered verification must say when it was taken');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a verification does not carry over to different settings', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-checks-'));
  const env = { ...process.env, PIE_DATA_DIR: dir, ...SMTP };
  try {
    inProcess(`
      const c = await import('${SRC}/persistence/checks.js');
      c.record('smtp', { ok: true, detail: 'accepted',
        config: c.fingerprint(['${SMTP.SMTP_HOST}', '${SMTP.SMTP_PORT}', '${SMTP.SMTP_USER}', '${SMTP.SMTP_FROM}']) });`, env);

    // Point at a different mail server. The old pass was about another machine.
    const moved = inProcess(`const m = await import('${SRC}/mailer.js'); console.log(m.status().state);`,
      { ...env, SMTP_HOST: 'smtp.somewhere-else.test' });
    assert.equal(moved, 'CONFIGURED_UNVERIFIED',
      'a verification taken against one host was reported for a different host');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed check is remembered as a failure, never as a pass', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pie-checks-'));
  const env = { ...process.env, PIE_DATA_DIR: dir, ...SMTP };
  try {
    inProcess(`
      const c = await import('${SRC}/persistence/checks.js');
      c.record('smtp', { ok: false, detail: 'authentication rejected',
        config: c.fingerprint(['${SMTP.SMTP_HOST}', '${SMTP.SMTP_PORT}', '${SMTP.SMTP_USER}', '${SMTP.SMTP_FROM}']) });`, env);
    assert.equal(
      inProcess(`const m = await import('${SRC}/mailer.js'); console.log(m.status().state);`, env),
      'CONFIGURED_UNVERIFIED',
      'a recorded FAILURE was treated as proof that email works');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
