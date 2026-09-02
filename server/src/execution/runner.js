// PIE — candidate code execution.
//
// THE RULE
//   Candidate code NEVER runs in the PIE server process, and never as a plain
//   child process of it. It runs in a container with no network, a read-only
//   filesystem, no privileges and hard resource limits — or it does not run at
//   all and the question is marked for human review.
//
//   There is no "just for the demo" middle option here on purpose. A process
//   spawned by the server inherits its environment, and its environment holds
//   the Supabase service-role key, the Gemini key and the session secret. One
//   `os.environ` in a candidate's Python is the whole platform.
//
// WHAT REPLACED WHAT
//   Coding answers used to be scored by looking for rubric keywords in the
//   text. That was not merely weak, it was backwards: a candidate who pasted
//   the rubric's words as a comment scored 100%, and a correct solution that
//   happened to use different words scored 0. Keyword scoring is gone. A coding
//   answer is now scored by running it, or it is not scored at all.

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d = '') => (process.env[k] || d).trim();

export const LANGUAGES = {
  python: {
    id: 'python', label: 'Python 3', file: 'solution.py',
    harness: 'harness.py',
    image: () => env('PIE_EXEC_PYTHON_IMAGE', 'python:3.11-alpine'),
    cmd: ['python', '/work/harness.py', '/work/spec.json'],
  },
  javascript: {
    id: 'javascript', label: 'JavaScript (Node)', file: 'solution.js',
    harness: 'harness.cjs',
    image: () => env('PIE_EXEC_NODE_IMAGE', 'node:20-alpine'),
    cmd: ['node', '/work/harness.cjs', '/work/spec.json'],
  },
};
export const isLanguage = l => Object.hasOwn(LANGUAGES, String(l || ''));

/* ------------------------------------------------------------------ limits */
export const LIMITS = {
  wallMs:   Number(env('PIE_EXEC_TIMEOUT_MS', '10000')),
  memory:   env('PIE_EXEC_MEMORY', '256m'),
  cpus:     env('PIE_EXEC_CPUS', '0.5'),
  pids:     env('PIE_EXEC_PIDS', '64'),
  outputKb: 64,
};

/**
 * The docker arguments, built in one place so they can be asserted in a test.
 *
 * Every flag here is load-bearing, and a test checks that each one is still
 * present — removing any of them silently turns a sandbox into a shell on the
 * host, and that is not the kind of regression that shows up as a failing
 * feature.
 */
export function dockerArgs({ image, cmd, workDir }) {
  return [
    'run', '--rm',
    '--network=none',              // no internet, no reaching PIE's own services
    '--read-only',                 // the image filesystem cannot be written to
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    `--memory=${LIMITS.memory}`,
    '--memory-swap=' + LIMITS.memory,   // no swapping around the memory cap
    `--cpus=${LIMITS.cpus}`,
    `--pids-limit=${LIMITS.pids}`,
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=65534:65534',          // nobody
    '--workdir=/work',
    // The code goes in read-only. Nothing from PIE's environment is passed:
    // docker run does not inherit the parent env unless asked, and it is not
    // asked here or anywhere else.
    '-v', `${workDir}:/work:ro`,
    image,
    ...cmd,
  ];
}

/**
 * How to invoke the container engine.
 *
 * Normally just `docker`. Tests replace it with a Node script so the pipeline
 * can be exercised without a daemon — through env vars rather than a PATH shim,
 * because a shell-script shim named `docker` is not executable on Windows and
 * the whole execution suite failed there for that reason alone.
 */
function engine() {
  const bin = env('PIE_DOCKER_BIN') || 'docker';
  let prefix = [];
  try { prefix = JSON.parse(env('PIE_DOCKER_PREFIX_ARGS') || '[]'); } catch { prefix = []; }
  return { bin, prefix: Array.isArray(prefix) ? prefix : [] };
}

const run = (args, { timeout, maxBuffer }) => new Promise(resolve => {
  const { bin, prefix } = engine();
  execFile(bin, [...prefix, ...args], { timeout, maxBuffer, killSignal: 'SIGKILL' },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

/* ------------------------------------------------------------ availability */
let cached = null;
export async function capabilities({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const r = await run(['info', '--format', '{{.ServerVersion}}'], { timeout: 4000, maxBuffer: 1 << 16 });
  const ok = !r.err && r.stdout.trim().length > 0;
  cached = ok
    ? {
        available: true, engine: 'docker', version: r.stdout.trim(),
        languages: Object.values(LANGUAGES).map(l => ({ id: l.id, label: l.label })),
        isolation: ['no network', 'read-only filesystem', 'non-root (uid 65534)',
          'all capabilities dropped', `memory ${LIMITS.memory}`, `${LIMITS.pids} process limit`,
          `${LIMITS.wallMs / 1000}s wall clock`],
        note: 'Candidate code runs in a throwaway container with no network and no access to the PIE host, its filesystem or its environment.',
      }
    : {
        available: false, engine: null, version: null, languages: [],
        isolation: [],
        // Stated plainly so nobody has to guess why coding scores are missing.
        note: 'Docker is not reachable, so candidate code is not executed. Coding answers are recorded and marked for recruiter review rather than scored — PIE will not guess a score it cannot compute.',
        reason: r.err ? String(r.err.message || r.err).split('\n')[0].slice(0, 160) : 'docker info returned nothing',
      };
  return cached;
}

/**
 * Runs one submission against its tests.
 *
 * Returns { executed, ok, error, results:[{id, passed, got, stdout, error}] }.
 * `results` covers EVERY test including hidden ones — masking for the candidate
 * happens at the route boundary, not here, so the grader always sees the truth.
 */
export async function execute({ language, code, entryPoint, tests }) {
  const lang = LANGUAGES[language];
  if (!lang) return { executed: false, ok: false, error: `Unsupported language "${language}".`, results: [] };

  const caps = await capabilities();
  if (!caps.available) {
    return { executed: false, ok: false, error: 'NO_SANDBOX', reason: caps.reason, results: [] };
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'pie-exec-'));
  try {
    await writeFile(path.join(dir, 'spec.json'), JSON.stringify({
      code: String(code || '').slice(0, 40_000),
      entryPoint: String(entryPoint || 'solve'),
      tests: tests.map(t => ({ id: t.id, input: t.input ?? [], expected: t.expected ?? null })),
    }));
    await cp(path.join(HERE, lang.harness), path.join(dir, lang.harness));

    const r = await run(dockerArgs({ image: lang.image(), cmd: lang.cmd, workDir: dir }),
      { timeout: LIMITS.wallMs, maxBuffer: LIMITS.outputKb * 1024 });

    if (r.err?.killed || r.err?.signal === 'SIGKILL') {
      return { executed: true, ok: false, error: `Timed out after ${LIMITS.wallMs / 1000}s.`, results: [] };
    }
    // The harness prints one JSON line last. Anything the candidate printed at
    // import time is captured inside the harness, but take the LAST line
    // regardless so stray container output cannot be mistaken for a verdict.
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    if (!line) {
      return { executed: true, ok: false,
        error: r.stderr.trim().split('\n').pop()?.slice(0, 300) || 'The sandbox produced no output.', results: [] };
    }
    try {
      const parsed = JSON.parse(line);
      return { executed: true, ok: Boolean(parsed.ok), error: parsed.error || null, results: parsed.results || [] };
    } catch {
      return { executed: true, ok: false, error: 'The sandbox returned output PIE could not read.', results: [] };
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
