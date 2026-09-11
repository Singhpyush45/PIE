// Cleans up server/.env — without anyone reading it.
//
//   cd F:\PIE_V3\server
//   node tools\env-fix.mjs
//
// WHY THIS EXISTS RATHER THAN SOMEONE JUST EDITING THE FILE
//   A .env is the one file in a project that should be read by as few things as
//   possible. Opening it in a chat window, pasting it into a tool, or handing it
//   to an assistant all put its contents somewhere they were not before — and
//   those places keep transcripts. This script does the same edits without the
//   values ever leaving the machine. It prints key NAMES and whether each one is
//   filled. It never prints a value, not even a truncated one.
//
// WHAT IT DOES
//   1. Backs the file up first, with a timestamp. Nothing is destructive.
//   2. Drops variables that no longer mean anything — the SAP-era leftovers, and
//      the two Corsair names from the version of the integration that was built
//      against a REST API that does not exist.
//   3. Adds the variables the current code needs, empty, each with a comment
//      saying exactly where its value comes from.
//   4. Generates CORSAIR_KEK and TOKEN_ENCRYPTION_KEY if they are missing, so
//      nobody has to remember to. These are the two secrets you should never
//      copy from anywhere: they are supposed to be random and local.
//   5. Regroups the file so it can be read.
//
//   Anything it does not recognise is KEPT, in its own section. A cleanup script
//   that silently deletes what it has not heard of is not a cleanup script.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(SERVER, '.env');

/* --------------------------------------------------------------- what is what */

/** Dead. Every one of these belongs to something that no longer exists. */
const DEAD_PREFIXES = ['HANA_', 'SAP_', 'BTP_', 'AICORE_', 'AI_CORE_', 'SUCCESSFACTORS_', 'XSUAA_', 'DESTINATION_', 'CF_'];
const DEAD_EXACT = new Set([
  // From the first Corsair adapter, which assumed a REST API with a bearer
  // token and a tenant header. The SDK has neither.
  'CORSAIR_TENANT_ID', 'CORSAIR_BASE_URL', 'CORSAIR_TIMEOUT_MS',
  'SAP_LEARNING_HUB_URL', 'HANA_CLIENT_CERT',
]);

const isDead = k => DEAD_EXACT.has(k) || DEAD_PREFIXES.some(p => k.startsWith(p));

/**
 * The file's shape after this runs. `note` is written above the key; `gen` means
 * "make one up if it is missing"; `dflt` is a safe value, not a secret.
 */
const GROUPS = [
  ['App', [
    ['NODE_ENV', { dflt: 'development' }],
    ['PORT', { dflt: '5174' }],
    ['APP_BASE_URL', { dflt: 'http://localhost:5174',
      note: 'Password-reset links are built from this. Left as localhost, every reset link a deployed user receives is dead.' }],
    ['ADMIN_PASSWORD', { note: 'The administrator account is provisioned from this. Choose one you will remember.' }],
    ['TOKEN_ENCRYPTION_KEY', { gen: true,
      note: 'Encrypts stored GitHub tokens and keys the OTP digests. Generated locally, once. Change it and every stored connection becomes undecryptable.' }],
  ]],
  ['Persistence — Supabase', [
    ['SUPABASE_URL', { note: 'Supabase → Settings → API. https://<ref>.supabase.co' }],
    ['SUPABASE_SERVICE_ROLE_KEY', { note: 'The service_role key (called "secret" in the newer UI). NOT anon/publishable — that one is for browsers and sits behind RLS.' }],
  ]],
  ['Corsair — all four, or none', [
    ['CORSAIR_API_KEY', { note: 'Corsair dashboard → PIE → the .env panel. Use its copy button.' }],
    ['CORSAIR_SIGNING_SECRET', { note: 'Same panel. Verifies that a delivery really came from Corsair.' }],
    ['CORSAIR_KEK', { gen: true,
      note: 'NOT issued by Corsair — generated here, once. Encrypts every candidate\'s stored authorisation. Change it and they all have to reconnect, with no error saying why.' }],
    ['CORSAIR_DATABASE_URL', {
      note: 'NOT from Corsair either — this is Postgres. Supabase → the "Connect" button → Session pooler (not Direct connection: that is IPv6-only). URL-encode special characters in the password: @ %40, # %23, $ %24, / %2F.' }],
  ]],
  ['Gmail — tomorrow, see GMAIL_SETUP.md', [
    ['GMAIL_CLIENT_ID', { optional: true,
      note: 'Your own Google Cloud OAuth client — the Gmail plugin has no managed auth type. Empty is fine: the plugin simply is not loaded, and nothing claims otherwise.' }],
    ['GMAIL_CLIENT_SECRET', { optional: true }],
    ['GMAIL_REDIRECT_URL', { optional: true, note: 'Must match the URI registered with Google character for character.' }],
  ]],
  ['GitHub OAuth — optional', [
    ['GITHUB_CLIENT_ID', { optional: true }],
    ['GITHUB_CLIENT_SECRET', { optional: true }],
    ['GITHUB_CALLBACK_URL', { optional: true }],
    ['GITHUB_TOKEN', { optional: true, note: 'Anonymous public lookups only. Not needed if OAuth or Corsair is configured.' }],
  ]],
  ['AI — optional; every score is identical without it', [
    ['OPENAI_API_KEY', { optional: true }],
    ['GEMINI_API_KEY', { optional: true }],
    ['OLLAMA_BASE_URL', { optional: true }],
  ]],
  ['Mail', [
    ['EMAIL_VERIFICATION', { dflt: 'off',
      note: 'off = candidates are signed in at registration and no code is sent. Reported as OFF on the integrity panel, because switching off a check is a reduction in what PIE claims.' }],
    ['MAIL_HTTP_PROVIDER', { optional: true }],
    ['RESEND_API_KEY', { optional: true }],
    ['BREVO_API_KEY', { optional: true }],
    ['MAIL_FROM', { optional: true }],
  ]],
];

const KNOWN = new Set(GROUPS.flatMap(([, keys]) => keys.map(([k]) => k)));

/* ------------------------------------------------------------------- parsing */

/** KEY=value lines only. Comments and blanks are not carried over — the file is regrouped. */
function parse(text) {
  const values = new Map();
  const duplicates = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (values.has(key)) duplicates.push(key);
    values.set(key, value.trim());   // last wins, as dotenv does
  }
  return { values, duplicates };
}

const secret = () => crypto.randomBytes(32).toString('base64');

/* ---------------------------------------------------------------------- main */

if (!fs.existsSync(ENV)) {
  console.log('\n  No server/.env found. Creating one from scratch.\n');
}

const original = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
const { values, duplicates } = parse(original);

// Back up before touching anything. Timestamped, so running this twice never
// overwrites the first backup.
let backup = null;
if (original) {
  backup = path.join(SERVER, `.env.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.writeFileSync(backup, original);
}

const removed = [];
const generated = [];
const added = [];
const empty = [];

for (const key of [...values.keys()]) {
  if (isDead(key)) { removed.push(key); values.delete(key); }
}

const out = [
  '# PIE — server environment.',
  '#',
  '# Never commit this file. It is in .gitignore; leave it there.',
  `# Tidied by tools/env-fix.mjs on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}.`,
  '#',
  '# Values are read by the SERVER ONLY. None of them is ever sent to a browser,',
  '# written to a log, or returned by an API — PIE reports key names and states.',
  '',
];

for (const [title, keys] of GROUPS) {
  out.push(`# ${'='.repeat(74)}`, `#  ${title.toUpperCase()}`, `# ${'='.repeat(74)}`, '');
  for (const [key, spec] of keys) {
    let value = values.get(key) ?? '';
    const existed = values.has(key);

    if (!value && spec.gen) { value = secret(); generated.push(key); }
    else if (!value && spec.dflt) { value = spec.dflt; if (!existed) added.push(key); }
    else if (!existed) added.push(key);

    if (!value && !spec.optional) empty.push(key);

    if (spec.note) {
      // Wrapped by hand rather than by a formatter, so the comment stays
      // readable in Notepad, which does not wrap.
      let line = '#';
      for (const word of spec.note.split(' ')) {
        if ((line + ' ' + word).length > 78) { out.push(line); line = '#'; }
        line += ' ' + word;
      }
      out.push(line);
    }
    out.push(`${key}=${value}`, '');
    values.delete(key);
  }
}

// Whatever is left is something this script has not heard of. Keeping it is the
// only safe choice: an unrecognised key is far more likely to be something the
// project needs than something worth deleting.
const leftovers = [...values.keys()];
if (leftovers.length) {
  out.push(`# ${'='.repeat(74)}`,
    '#  OTHER — kept exactly as they were',
    '#',
    '#  This script did not recognise these. They have been preserved rather than',
    '#  deleted. Remove any you know to be dead.',
    `# ${'='.repeat(74)}`, '');
  for (const key of leftovers) out.push(`${key}=${values.get(key)}`);
  out.push('');
}

fs.writeFileSync(ENV, out.join('\n'));

/* -------------------------------------------------------------------- report */
// Names and states only. No value appears below, and none should ever be added.

const say = (label, list) => {
  if (!list.length) return;
  console.log(`\n  ${label}`);
  for (const k of [...new Set(list)].sort()) console.log(`    ${k}`);
};

console.log('\n  server/.env has been tidied.');
if (backup) console.log(`  Backup: ${path.basename(backup)}`);

say('Removed — dead, nothing reads these any more:', removed);
say('Duplicated in the old file (the last one was kept):', duplicates);
say('Generated locally — do not copy these from anywhere:', generated);
say('Added, empty or with a safe default:', added);
say('Kept as-is, not recognised by this script:', leftovers);

if (empty.length) {
  console.log('\n  ─────────────────────────────────────────────────────────────');
  console.log('  STILL EMPTY — the file will not work until these are filled:');
  for (const k of [...new Set(empty)].sort()) console.log(`    ${k}`);
  console.log('\n  Open server/.env — each one has a comment above it saying');
  console.log('  exactly where its value comes from.');
  console.log('  ─────────────────────────────────────────────────────────────');
} else {
  console.log('\n  Every required variable has a value.');
  console.log('\n  Next:  npm run env:check');
  console.log('         node tools\\corsair-test.mjs');
}
console.log('');
