// Diagnoses server/.env without reading it out loud.
//
//   node tools\env-doctor.mjs          just look
//   node tools\env-doctor.mjs --fix    look, and repair what can be repaired
//
// WHY A SEPARATE TOOL
//   "It says not set, but I pasted it" is the most expensive kind of bug at one
//   in the morning: the fix is usually trivial and finding it is not. Guessing
//   costs a round trip each time. This checks every plausible cause at once —
//   the value landed in the wrong file, the key name has a typo, the value is
//   there but malformed, a second .env is shadowing this one — and says which.
//
//   It reports lengths, shapes and yes/no. It never prints a value, a prefix or
//   a suffix. The one thing it does print about a URL is its port and whether
//   the host looks like a pooler, because those are the two things that decide
//   whether a Supabase connection can work at all and neither is a secret.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(SERVER, '.env');
const ROOT_ENV = path.resolve(SERVER, '..', '.env');
const TEMPLATE = path.join(SERVER, 'ADD_TO_ENV.txt');
const FIX = process.argv.includes('--fix');

const ok = s => `  [ok]   ${s}`;
const bad = s => `  [FIX]  ${s}`;
const info = s => `         ${s}`;

/** Keys set on more than one line, with those line numbers. Filled by parse(). */
const duplicates = new Map();

function parse(file, track = false) {
  if (!fs.existsSync(file)) return null;
  const map = new Map();
  const seen = new Map();

  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) return;
    const key = m[1];

    // Node's loadEnvFile lets the LAST occurrence win — measured, not assumed.
    // So a duplicate is not cosmetic: edit the first one and nothing changes,
    // while the file reads as if it did.
    if (track) {
      if (seen.has(key)) duplicates.set(key, [...(duplicates.get(key) || [seen.get(key)]), i + 1]);
      seen.set(key, i + 1);
    }
    map.set(key, m[2].trim().replace(/^["']|["']$/g, ''));
  });
  return map;
}

const env = parse(ENV, true);
if (!env) {
  console.log(`\n  No .env at ${ENV}\n  Run: node tools\\env-fix.mjs\n`);
  process.exit(1);
}

console.log('\n  Checking server/.env\n');
const problems = [];

/* ------------------------------------------------------------ duplicate keys */
// Expensive and completely silent. A GEMINI_MODEL added near the top of the
// file while an older one sat further down meant the server kept using the old
// model, the file looked right, and every check agreed with the file rather
// than with the server. This runs over EVERY key, not just Corsair's four,
// because the trap has nothing to do with which key it happens to be.
if (duplicates.size) {
  problems.push('duplicates');
  console.log(bad('These keys are set on more than one line. The LAST one wins:'));
  for (const [key, lines] of duplicates) {
    const winner = lines[lines.length - 1];
    console.log(info(`  ${key} — lines ${lines.join(', ')}   (line ${winner} is the one in effect: ${env.get(key) ? 'set' : 'empty'})`));
  }
  console.log(info('Delete the lines you do not want. Editing the earlier one changes nothing.\n'));
}

/* ---------------------------------------------------------- pasted elsewhere */
// The commonest cause of "I definitely pasted it": it went into the template
// rather than the real file. Both are open in Notepad and both look the same.
const template = parse(TEMPLATE);
if (template) {
  const filled = [...template.entries()].filter(([, v]) => v).map(([k]) => k);
  if (filled.length) {
    problems.push('template');
    console.log(bad('ADD_TO_ENV.txt has values filled in.'));
    console.log(info('That file is only a template — nothing reads it. Move these into .env:'));
    for (const k of filled) console.log(info(`  ${k}`));
    console.log('');
  }
}

/* ------------------------------------------------------------- shadowing .env */
const rootEnv = parse(ROOT_ENV);
if (rootEnv) {
  const clash = ['CORSAIR_API_KEY', 'CORSAIR_SIGNING_SECRET', 'CORSAIR_KEK', 'CORSAIR_DATABASE_URL']
    .filter(k => rootEnv.has(k));
  if (clash.length) {
    console.log(info(`A second .env exists at the project root and also sets: ${clash.join(', ')}`));
    console.log(info('server/.env is loaded first and wins, so this is usually harmless — but it'));
    console.log(info('is worth deleting those lines so there is one place to look.\n'));
  }
}

/* -------------------------------------------------------------- misspelt keys */
const EXPECTED = ['CORSAIR_API_KEY', 'CORSAIR_SIGNING_SECRET', 'CORSAIR_KEK', 'CORSAIR_DATABASE_URL'];

/**
 * Real variables PIE reads that are not among the required four.
 *
 * Without this list the typo check flagged `CORSAIR_TUNNEL` — a correct,
 * documented line — and told the reader to fix it. A diagnostic that calls a
 * working setting a typo is worse than one that says nothing: the obvious
 * response is to delete the line, which silently switches the tunnel off again,
 * and the next failure looks like Corsair's fault.
 *
 * Kept in step with the source by `npm test`, which greps for env() calls.
 */
const ALSO_REAL = ['CORSAIR_TUNNEL', 'CORSAIR_DB_POOL_MAX',
  'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URL'];

/**
 * Edit distance, capped — enough to tell a typo from a different word.
 *
 * The first version of this check listed misspellings by hand: CORSAIER,
 * CROSSAIR, COSAIR. A test fixture containing `CORSIAR_API_KEY` — a plain
 * transposition, and the likeliest typo of the six — walked straight past it,
 * because nobody had thought of that one. A hand-written list of mistakes only
 * catches the mistakes its author happened to imagine.
 */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

const REAL = [...EXPECTED, ...ALSO_REAL];
const nearMiss = [...env.keys()].filter(k => {
  if (REAL.includes(k)) return false;
  const up = k.toUpperCase();
  // Close to a name PIE reads, or shaped like one of the database variables.
  return REAL.some(name => distance(up, name) <= 2) || /^(CORSAIR|DATABASE_URL|DB_URL)/i.test(up);
});
if (nearMiss.length) {
  problems.push('typo');
  console.log(bad('These key names look like typos of the ones PIE reads:'));
  for (const k of nearMiss) console.log(info(`  ${k}`));
  console.log(info(`PIE requires exactly: ${EXPECTED.join(', ')}`));
  console.log(info(`It also reads, optionally: ${ALSO_REAL.join(', ')}\n`));
}

/* ------------------------------------------------------------------- the four */

function report(key, checks) {
  const v = env.get(key);
  if (v === undefined) { problems.push(key); console.log(bad(`${key} — the line does not exist in .env`)); return null; }
  if (!v) { problems.push(key); console.log(bad(`${key} — the line exists but is empty`)); return null; }
  const fails = checks.filter(c => !c.pass(v));
  if (!fails.length) { console.log(ok(`${key} — present, ${v.length} characters, shape looks right`)); return v; }
  problems.push(key);
  console.log(bad(`${key} — present (${v.length} characters) but:`));
  for (const f of fails) console.log(info(`  ${f.why}`));
  return v;
}

report('CORSAIR_API_KEY', [
  { pass: v => /^ck_/.test(v), why: 'does not start with "ck_". Corsair project keys do. Did another value land here?' },
  { pass: v => v.length > 20, why: 'looks too short to be a full key — check it copied completely.' },
]);

report('CORSAIR_SIGNING_SECRET', [
  { pass: v => /^csec_/.test(v), why: 'does not start with "csec_". Signing secrets do. The API key may have been pasted twice.' },
]);

/* --------------------------------------------------------------------- KEK */
const kek = env.get('CORSAIR_KEK');
const kekBytes = kek ? Buffer.from(kek, 'base64').length : 0;
const kekValid = kekBytes === 32;

if (!kek) {
  problems.push('CORSAIR_KEK');
  console.log(bad('CORSAIR_KEK — empty. This one is NOT issued by Corsair; it is generated here.'));
} else if (!kekValid) {
  problems.push('CORSAIR_KEK');
  console.log(bad(`CORSAIR_KEK — present but decodes to ${kekBytes} bytes, not 32.`));
  console.log(info('This is not a key Corsair gave you — it is one you generate. Something else'));
  console.log(info('was probably pasted here. Nothing has been encrypted with it yet (Corsair has'));
  console.log(info('never connected), so replacing it is safe right now.'));
} else {
  console.log(ok('CORSAIR_KEK — present, decodes to 32 bytes, correct'));
}

/* --------------------------------------------------------------------- URL */
const url = env.get('CORSAIR_DATABASE_URL');
if (!url) {
  problems.push('CORSAIR_DATABASE_URL');
  console.log(bad(url === undefined
    ? 'CORSAIR_DATABASE_URL — the line does not exist in .env'
    : 'CORSAIR_DATABASE_URL — the line exists but is empty'));
} else {
  const issues = [];
  if (!/^postgres(ql)?:\/\//.test(url)) issues.push('does not start with postgres:// or postgresql://');
  if (/\[YOUR-PASSWORD\]|\[YOUR_PASSWORD\]/i.test(url)) issues.push('still contains the literal [YOUR-PASSWORD] placeholder — replace it with the real database password');
  if (/[[\]]/.test(url)) issues.push('contains square brackets — remove them');
  const ats = (url.match(/@/g) || []).length;
  if (ats !== 1) issues.push(`contains ${ats} "@" characters; a valid URL has exactly 1. A raw "@" in the password must be written as %40`);

  let host = '', port = '', pw = '';
  try { const u = new URL(url); host = u.hostname; port = u.port; pw = u.password; }
  catch {
    // Almost always a password character the URL syntax gives its own meaning:
    // "#" starts a fragment, "?" starts a query, "/" ends the authority. The
    // string looks fine to a human and is a different URL to a parser.
    issues.push('cannot be parsed as a URL. A password containing # ? / @ : or a space breaks it — '
      + 'percent-encode those (# %23, ? %3F, / %2F, @ %40, : %3A, space %20), or reset the database '
      + 'password to letters and digits only');
  }

  if (host && !/pooler\./.test(host)) {
    issues.push('is not a pooler host. Supabase\'s "Direct connection" is IPv6-only and usually '
      + 'fails from home networks — use the Session pooler string instead');
  }
  if (host && !pw) issues.push('has no password in it');
  if (pw && /[@#$/?:\s]/.test(pw)) {
    issues.push('has a password containing a character that must be percent-encoded '
      + '(@ %40, # %23, $ %24, / %2F, : %3A, ? %3F) — or reset it to letters and digits only');
  }

  if (!issues.length) {
    console.log(ok(`CORSAIR_DATABASE_URL — present, pooler host, port ${port || '(default)'}, password set`));
  } else {
    problems.push('CORSAIR_DATABASE_URL');
    console.log(bad(`CORSAIR_DATABASE_URL — present (${url.length} characters) but:`));
    for (const i of issues) console.log(info(`  ${i}`));
    if (port) console.log(info(`  (host looks like: ${/pooler\./.test(host) ? 'a pooler' : 'a direct connection'}, port ${port})`));
  }
}

/* --------------------------------------------------------------------- fix */

if (FIX && (!kek || !kekValid)) {
  const backup = path.join(SERVER, `.env.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.copyFileSync(ENV, backup);
  const fresh = crypto.randomBytes(32).toString('base64');
  const text = fs.readFileSync(ENV, 'utf8');
  const replaced = /^CORSAIR_KEK=.*$/m.test(text)
    ? text.replace(/^CORSAIR_KEK=.*$/m, `CORSAIR_KEK=${fresh}`)
    : `${text.replace(/\s*$/, '')}\nCORSAIR_KEK=${fresh}\n`;
  fs.writeFileSync(ENV, replaced);
  console.log(`\n  Generated a new CORSAIR_KEK. Backup: ${path.basename(backup)}`);
}

/* ------------------------------------------------------------------ verdict */

console.log('');
if (!problems.length) {
  console.log('  Everything Corsair needs is present and well-formed.');
  console.log('  Next:  node tools\\corsair-test.mjs\n');
  process.exit(0);
}

console.log('  ─────────────────────────────────────────────────────────────');
console.log('  Not ready yet. Fix the [FIX] lines above.');
if (!kekValid) console.log('  For the KEK specifically, this repairs it:  node tools\\env-doctor.mjs --fix');
console.log('  ─────────────────────────────────────────────────────────────\n');
process.exit(1);
