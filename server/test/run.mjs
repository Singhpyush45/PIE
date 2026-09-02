// PIE — test runner.
//
//   npm test
//
// WHY THIS EXISTS
//   The suite drives a LIVE server, so two things used to make it unreliable:
//
//   1. Node runs test files in parallel by default. auth.test.mjs calls
//      /api/demo/reset (that is the behaviour it verifies), which deletes demo
//      sessions — including the ones flows.test.mjs was in the middle of using.
//      Result: a burst of 401s in a file that had done nothing wrong.
//
//   2. Both the JSON store and the in-memory rate-limit counters live in the
//      server process. Run the suite repeatedly against the same long-running
//      server and leftover rows change what the demo personas look like, while
//      the rate limiter starts answering 429.
//
//   So: this starts a server of its own, on its own port, with its own throwaway
//   data directory, runs the files one at a time, then shuts it down and deletes
//   the directory. Your real server and your real server/data/pie.json are never
//   touched, and the result is the same on every run.
//
//   To test against an already-running server instead:  npm run test:live

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PIE_TEST_PORT || 5175);
const DATA_DIR = path.join(SERVER_DIR, 'data', '.test-run');
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  PORT: String(PORT),
  PIE_DATA_DIR: DATA_DIR,
  NODE_ENV: 'test',
  // Deterministic and local to this throwaway run; never written to your .env.
  ADMIN_PASSWORD: 'test-only-Adm1n-password',
  // The suite asserts the deterministic engine, so keep the LLM out of it —
  // faster, free, and it removes a network dependency from your test results.
  OPENAI_API_KEY: '',
  SAP_AI_CORE_DEPLOYMENT_URL: '',
  SAP_AI_CORE_TOKEN: '',
  // Likewise: the GitHub tests assert the honest unconfigured behaviour.
  GITHUB_TOKEN: '',
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
};

const log = (m) => process.stdout.write(`${m}\n`);

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

let server = null;
const stopServer = () => { if (server && !server.killed) { try { server.kill(); } catch { /* already gone */ } } };
process.on('exit', stopServer);
process.on('SIGINT', () => { stopServer(); process.exit(130); });

async function main() {
  await rm(DATA_DIR, { recursive: true, force: true });

  log(`\n  Starting a throwaway PIE server on ${BASE}`);
  log(`  Data directory: server/data/.test-run  (deleted afterwards)\n`);

  server = spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverOutput = '';
  server.stdout.on('data', d => { serverOutput += d; });
  server.stderr.on('data', d => { serverOutput += d; });
  server.on('exit', code => {
    if (code !== null && code !== 0 && !server.killed) {
      log('  The test server exited unexpectedly. Its output:\n');
      log(serverOutput);
    }
  });

  if (!await waitForHealth()) {
    log('  Could not start the test server. Its output:\n');
    log(serverOutput || '  (no output)');
    log(`\n  Is port ${PORT} already in use? Set PIE_TEST_PORT to another port.\n`);
    stopServer();
    process.exit(1);
  }

  // One file at a time, each in its OWN node process.
  //
  // `--test-concurrency=1` was supposed to do this, and does on some platforms.
  // On the machine this was reported from it did not: the files interleaved, and
  // two of them died with "Promise resolution is still pending" — the signature
  // of a file being torn down while another was mid-flight. These tests share
  // one server and /api/demo/reset is a global side effect, so overlap is not a
  // cosmetic problem. Looping is slower and cannot be misinterpreted.
  const FILES = [
    'test/auth.test.mjs',
    'test/flows.test.mjs',
    'test/supabase.test.mjs',
    'test/assessment.test.mjs',
    'test/execution.test.mjs',
    'test/checks.test.mjs',
    'test/facewatch.test.mjs',
    'test/facedetect.test.mjs',
    'test/brief.test.mjs',
  ];

  let code = 0;
  const failed = [];
  for (const file of FILES) {
    const one = spawn(process.execPath, ['--test', file],
      { cwd: SERVER_DIR, env: { ...env, PIE_TEST_BASE: BASE }, stdio: 'inherit' });
    const status = await new Promise(resolve => one.on('exit', resolve));
    if (status !== 0) { code = 1; failed.push(file); }
  }
  log(`\n  ${FILES.length - failed.length}/${FILES.length} test files passed`);
  if (failed.length) log(`  Files with failures: ${failed.join(', ')}`);

  stopServer();
  await new Promise(r => setTimeout(r, 300));
  await rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});

  log(code === 0
    ? '\n  All good — your server and server/data/pie.json were not touched.\n'
    : '\n  Some tests failed. The throwaway server and its data have been cleaned up.\n');
  process.exit(code ?? 1);
}

main().catch(e => { log(`  Runner failed: ${e.message}`); stopServer(); process.exit(1); });
