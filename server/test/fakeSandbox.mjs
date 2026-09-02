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

/** Points the runner at the stub for the rest of this process. */
export function installFakeSandbox() {
  process.env.PIE_DOCKER_BIN = process.execPath;
  process.env.PIE_DOCKER_PREFIX_ARGS = JSON.stringify([STUB]);
  return STUB;
}

export function removeFakeSandbox() {
  delete process.env.PIE_DOCKER_BIN;
  delete process.env.PIE_DOCKER_PREFIX_ARGS;
}

/* Splits a `-v` mount spec into its host path.

   Not `split(':')[0]`: a Windows host path starts `C:\…`, so that returned the
   drive letter alone and every harness path became a relative `C\harness.py`.
   The container side always starts with `/`, which is what tells the two apart. */
function hostPathOf(mount) {
  const m = String(mount).match(/^(.*?):(\/[^:]*)(?::[^:]*)?$/);
  return m ? m[1] : String(mount);
}

/* ------------------------------------------------------------ the stub itself
   Run as `node fakeDockerBin.mjs <docker args...>`. Only the two shapes PIE
   actually uses are understood: `info`, and a `run` whose last arguments are the
   image and the command. */
export function main(argv) {
  if (argv[0] === 'info') { process.stdout.write('0.0.0-test-double\n'); return 0; }

  let workDir = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v') { workDir = hostPathOf(argv[++i]); continue; }
    if (a === '--tmpfs') { i++; continue; }
    if (a.startsWith('-')) continue;          // every other flag is isolation we cannot emulate
    if (a === 'run') continue;
    rest.push(a);
  }
  // rest is now [image, program, harnessPath, specPath]
  const [, program, harnessInContainer, specInContainer] = rest;
  if (!program || !workDir) { process.stderr.write('fake docker: unrecognised invocation\n'); return 1; }

  const toHost = p => path.join(workDir, path.basename(String(p)));
  const r = spawnSync(program === 'python' ? 'python3' : process.execPath,
    [toHost(harnessInContainer), toHost(specInContainer)], { encoding: 'utf8' });

  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return r.status ?? 1;
}
