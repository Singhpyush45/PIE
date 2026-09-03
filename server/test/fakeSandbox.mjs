// A stand-in for the Docker daemon, for tests only.
//
// It strips the container flags and runs the harness on the host, which makes it
// emphatically NOT a sandbox. It exists so PIE's own pipeline — writing the
// spec, copying the harness, parsing the verdict, masking hidden results — can
// be exercised on machines without a daemon. Nothing outside test/ imports it.
//
// Written in Node and wired in through env vars rather than a shell script on
// PATH: a file named `docker` with a shebang is not executable on Windows, so
// the PATH-shim version of this made every execution test fail there while
// passing on Linux.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STUB = path.join(HERE, 'fakeDockerBin.mjs');

/* ----------------------------------------------------------------- python
   Windows ships an "App Execution Alias" for python and python3 that is not an
   interpreter: it prints "Python was not found; run without arguments to
   install from the Microsoft Store" and exits. `which python3` finds it, and a
   naive check that the command exists is satisfied by it — which is how a
   machine with no Python ends up reporting that a correct solution failed and
   that a syntax error was not a syntax error.

   So the probe does not ask whether the command exists. It asks the interpreter
   to print something only a real interpreter could print. */
const MARKER = 'pie-python-probe-ok';
let pythonBin;

export function findPython() {
  if (pythonBin !== undefined) return pythonBin;
  for (const bin of ['python3', 'python', 'py']) {
    try {
      const r = spawnSync(bin, ['-c', `print("${MARKER}")`], { encoding: 'utf8', timeout: 8000 });
      if (r.status === 0 && String(r.stdout).includes(MARKER)) { pythonBin = bin; return bin; }
    } catch { /* not on PATH at all */ }
  }
  pythonBin = null;
  return null;
}

/** One sentence a person can act on, for a skip message. */
export const NO_PYTHON =
  'needs a real Python on PATH — on Windows, `python3` is usually the Microsoft Store '
  + 'alias, which is not an interpreter. Install Python and re-run.';

/** Points the runner at the stub for the rest of this process. */
export function installFakeSandbox() {
  process.env.PIE_DOCKER_BIN = process.execPath;
  process.env.PIE_DOCKER_PREFIX_ARGS = JSON.stringify([STUB]);
  // Resolved once here so the stub, which runs as a child process per execution,
  // does not re-probe every time.
  const py = findPython();
  if (py) process.env.PIE_TEST_PYTHON = py;
  else delete process.env.PIE_TEST_PYTHON;
  return STUB;
}

export function removeFakeSandbox() {
  delete process.env.PIE_DOCKER_BIN;
  delete process.env.PIE_DOCKER_PREFIX_ARGS;
}

/* ------------------------------------------------------------ the stub itself
   Run as `node fakeDockerBin.mjs <docker args...>`. Only the two shapes PIE
   actually uses are understood: `info`, and a `run` whose last arguments are the
   image and the command. */
/**
 * The host side of a `-v host:container[:mode]` mount.
 *
 * Splitting on the first colon is the obvious reading and it is wrong on
 * Windows, where the host path starts with a drive letter: `C:\\Users\\…` becomes
 * `C`, and the harness is then looked for at `<cwd>\\C\\harness.py`. The error
 * that produces — "can't open file" — looks nothing like a path-parsing bug, and
 * it is invisible on Linux, where the host path has no colon at all.
 *
 * So the container side is matched instead. PIE always mounts at /work, and the
 * container path is the one that cannot contain a drive letter.
 */
export function parseMount(value) {
  const m = /^(.+?):(\/[^:]*)(?::([a-z]+))?$/.exec(String(value || ''));
  return m ? m[1] : null;
}

export function main(argv) {
  if (argv[0] === 'info') { process.stdout.write('0.0.0-test-double\n'); return 0; }

  let workDir = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v') { workDir = parseMount(argv[++i]); continue; }
    if (a === '--tmpfs') { i++; continue; }
    if (a.startsWith('-')) continue;          // every other flag is isolation we cannot emulate
    if (a === 'run') continue;
    rest.push(a);
  }
  // rest is now [image, program, harnessPath, specPath]
  const [, program, harnessInContainer, specInContainer] = rest;
  if (!program || !workDir) { process.stderr.write('fake docker: unrecognised invocation\n'); return 1; }

  const toHost = p => path.join(workDir, path.basename(String(p)));
  // `python` is what the container command says; which interpreter actually
  // exists on this host is a separate question, answered by findPython().
  const r = spawnSync(program === 'python' ? (process.env.PIE_TEST_PYTHON || 'python3') : process.execPath,
    [toHost(harnessInContainer), toHost(specInContainer)], { encoding: 'utf8' });

  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return r.status ?? 1;
}
