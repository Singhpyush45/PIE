// PIE — candidate code execution tests.
//
// The daemon is not available in CI, so these cover everything around it:
//   • the docker flags, because a missing --network=none is a silent hole
//   • the harnesses, run directly — they are what decides pass or fail
//   • the boundary that keeps hidden tests off the wire
//   • what happens when there is no sandbox at all
//
// A stub `docker` on PATH stands in for the daemon so the full pipeline —
// writing the spec, copying the harness, parsing the verdict — is exercised.
// It is a test double, not a sandbox, and lives only for the duration of a run.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeSandbox, removeFakeSandbox } from './fakeSandbox.mjs';
installFakeSandbox();

const runner = await import('../src/execution/runner.js');

/* ------------------------------------------------------------------ flags */

test('every container isolation flag is present', () => {
  const args = runner.dockerArgs({ image: 'python:3.11-alpine', cmd: ['python', '/work/harness.py', '/work/spec.json'], workDir: '/tmp/x' });
  const joined = args.join(' ');

  // Each of these is the difference between a sandbox and a shell on the host.
  for (const flag of [
    '--network=none',                 // no internet, and no reach into PIE's own services
    '--read-only',                    // the image filesystem cannot be written
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=65534:65534',             // never root
    '--memory=', '--memory-swap=',    // a memory cap that swap cannot defeat
    '--pids-limit=',                  // no fork bombs
    '--cpus=',
    '--rm',
  ]) {
    assert.ok(joined.includes(flag), `docker args lost ${flag}`);
  }
  // The code is mounted read-only.
  assert.ok(joined.includes('/tmp/x:/work:ro'), 'the work directory is not mounted read-only');
  // Nothing from PIE's environment may be forwarded: one -e and a candidate can
  // read the Supabase service-role key.
  assert.ok(!args.includes('-e') && !args.some(a => a.startsWith('--env')),
    'the container is being given environment variables');
});

/* --------------------------------------------------------------- pipeline */

const TESTS = [
  { id: 'v1', hidden: false, input: [[3, 1, 2], [2]], expected: [1, 3] },
  { id: 'h1', hidden: true, input: [[], [9]], expected: [] },
  { id: 'h2', hidden: true, input: [[5, 5, 4], [5]], expected: [4] },
];

test('a correct solution passes and a wrong one does not', async () => {
  const good = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: 'def solve(a, b):\n    return sorted(set(a) - set(b))\n' });
  assert.equal(good.executed, true);
  assert.equal(good.ok, true);
  assert.equal(good.results.filter(r => r.passed).length, 3);

  const bad = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: 'def solve(a, b):\n    return list(a)\n' });
  assert.ok(bad.results.filter(r => r.passed).length < 3);
});

test('keyword bluffing scores nothing', async () => {
  // The behaviour this whole layer exists to fix: the old grader gave this 100%
  // because the rubric's words appear in it.
  const r = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: '# handles nulls, reconciles counts, reports mismatches clearly\ndef solve(a, b):\n    return None\n' });
  assert.equal(r.results.filter(x => x.passed).length, 0);
});

test('a candidate cannot forge the result line', async () => {
  // The harness prints the verdict on stdout, so a candidate printing a
  // convincing JSON object must not be able to substitute their own.
  const forged = JSON.stringify({ ok: true, results: TESTS.map(t => ({ id: t.id, passed: true })) });
  const r = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: `print(${JSON.stringify(forged)})\ndef solve(a, b):\n    return None\n` });
  assert.equal(r.results.filter(x => x.passed).length, 0, 'a printed result line was accepted as the verdict');
});

test('a syntax error is reported as one, not as every test failing silently', async () => {
  const r = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: 'def solve(a b):\n    return a\n' });
  assert.equal(r.ok, false);
  assert.match(r.error, /SyntaxError/);
});

test('a missing entry point says so', async () => {
  const r = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS,
    code: 'def something_else():\n    return 1\n' });
  assert.equal(r.ok, false);
  assert.match(r.error, /solve/);
});

test('javascript runs too', async () => {
  const r = await runner.execute({ language: 'javascript', entryPoint: 'solve', tests: TESTS,
    code: 'function solve(a, b) { return a.filter(x => !b.includes(x)).sort((p, q) => p - q); }' });
  assert.equal(r.ok, true);
  assert.equal(r.results.filter(x => x.passed).length, 3);
});

test('an unsupported language is refused rather than guessed at', async () => {
  const r = await runner.execute({ language: 'brainfuck', entryPoint: 'solve', tests: TESTS, code: '+' });
  assert.equal(r.executed, false);
  assert.match(r.error, /Unsupported/);
});

test('with no sandbox, nothing is executed and nothing is scored', async () => {
  // Remove the injected engine rather than breaking PATH: PATH tricks do not
  // work the same way on Windows, and this is what "no docker" really means now.
  removeFakeSandbox();
  process.env.PIE_DOCKER_BIN = 'definitely-not-a-real-docker-binary';
  try {
    const caps = await runner.capabilities({ refresh: true });
    assert.equal(caps.available, false);
    assert.ok(caps.note.includes('not executed'), 'the unavailable state does not say what it means');
    const r = await runner.execute({ language: 'python', entryPoint: 'solve', tests: TESTS, code: 'def solve(a,b): return []' });
    assert.equal(r.executed, false);
    assert.equal(r.error, 'NO_SANDBOX');
  } finally {
    installFakeSandbox();
    await runner.capabilities({ refresh: true });
  }
});
