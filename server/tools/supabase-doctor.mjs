// PIE — Supabase credential doctor.
//
//   cd F:\PIE_V3\server
//   node tools/supabase-doctor.mjs
//
// Answers one question: why is Supabase rejecting the key?
//
// SAFETY: this NEVER prints the key. It prints the key's shape (length, prefix,
// whether stray characters crept in) and, for a legacy JWT, only the two public
// claims that matter — `role` and `ref`. A JWT payload is base64, not encrypted,
// and the signature is never touched or shown. Nothing here is written anywhere.

import '../src/env.js';   // loads server/.env exactly the way the server does

const rawUrl = process.env.SUPABASE_URL || '';
const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
const YES = 'YES  <-- problem';

console.log('\nSUPABASE CREDENTIAL DOCTOR');
console.log('='.repeat(66));

/* ------------------------------------------------------------------- URL */
console.log('\n1. SUPABASE_URL');
if (!rawUrl) {
  line('present', 'NO  <-- not set in server/.env');
} else {
  const url = rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  let host = '(unparseable)';
  try { host = new URL(url).host; } catch { /* reported below */ }
  line('host', host);
  line('had /rest/v1 appended', /\/rest\/v1\/?$/i.test(rawUrl.trim()) ? 'yes (harmless — stripped)' : 'no');
  line('surrounding quotes', /^["']|["']$/.test(rawUrl.trim()) ? YES : 'no');
}

/* ------------------------------------------------------------------- key */
console.log('\n2. SUPABASE_SERVICE_ROLE_KEY  (value is never printed)');
if (!rawKey) {
  line('present', 'NO  <-- not set in server/.env');
} else {
  const key = rawKey.trim();
  line('length', `${rawKey.length} chars (${key.length} after trimming)`);
  line('leading/trailing space', rawKey !== key ? YES : 'no');
  line('surrounding quotes', /^["']|["']$/.test(key) ? YES : 'no');
  line('contains a line break', /[\r\n]/.test(rawKey) ? YES + ' (key is split across lines)' : 'no');
  line('contains a space inside', /\s/.test(key) ? YES + ' (paste was broken)' : 'no');

  let kind = 'unrecognised format';
  if (key.startsWith('sb_secret_')) kind = 'new-style SECRET key — correct type';
  else if (key.startsWith('sb_publishable_')) kind = 'new-style PUBLISHABLE key  <-- WRONG, this is the public one';
  else if (key.startsWith('eyJ')) kind = 'legacy JWT';
  line('key type', kind);

  // Legacy JWT: the payload is public metadata. Read the two claims that decide this.
  if (key.startsWith('eyJ')) {
    try {
      const p = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
      line('  claim: role', p.role === 'service_role'
        ? 'service_role — correct'
        : `${p.role}  <-- WRONG, you need the service_role key`);
      line('  claim: project ref', p.ref || '(none)');
      if (p.exp) {
        const exp = new Date(p.exp * 1000);
        line('  claim: expires', `${exp.toISOString().slice(0, 10)}${exp < new Date() ? '  <-- EXPIRED' : ''}`);
      }

      // A key from the WRONG project is the classic 401 when you have two projects.
      try {
        const host = new URL(rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '')).host;
        // Only meaningful for a real Supabase host, where the ref is the subdomain.
        const urlRef = /\.supabase\.(co|in)$/i.test(host) ? host.split('.')[0] : null;
        if (p.ref && urlRef) {
          line('  ref vs URL', p.ref === urlRef
            ? 'match'
            : `MISMATCH  <-- key belongs to project "${p.ref}", URL points at "${urlRef}"`);
        }
      } catch { /* URL already reported above */ }
    } catch {
      line('  JWT payload', 'could not be decoded  <-- the key looks truncated');
    }
  }
}

/* ---------------------------------------------------------------- request */
console.log('\n3. LIVE REQUEST  (GET /rest/v1/profiles?select=id&limit=1)');
if (!rawUrl || !rawKey) {
  console.log('   skipped — set both variables first.\n');
  process.exit(1);
}

const base = rawUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const key = rawKey.trim();

try {
  const res = await fetch(`${base}/rest/v1/profiles?select=id&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }

  line('HTTP status', `${res.status} ${res.statusText}`);
  line('server said', body?.message || body?.hint || body?.error || '(no message)');
  if (body?.code) line('postgrest code', body.code);

  console.log('');
  if (res.ok) {
    console.log('  RESULT: the credentials work. Restart the server and press Verify connection.');
  } else if (body?.code === '42501') {
    // You cannot be denied permission on a table that does not exist.
    console.log('  RESULT: good news — the table EXISTS and your key is VALID.');
    console.log('  Postgres just has no GRANT for the API role, so PostgREST is refused at the door.');
    console.log('');
    console.log('  FIX: Supabase → SQL Editor → New query → paste server/supabase/grants.sql → Run.');
    console.log('       It only adds GRANTs. No table is created, altered or dropped, no row changes,');
    console.log('       and Row Level Security stays on for every table.');
  } else if (res.status === 401 || res.status === 403) {
    console.log('  RESULT: Supabase rejected the key. Section 2 above says which reason applies.');
    console.log('  Fix it in Supabase → Settings → API:');
    console.log('    • Copy the key labelled "service_role" (or "secret"), not "anon"/"publishable".');
    console.log('    • Paste it into server/.env on ONE line, no quotes, nothing after it.');
    console.log('    • If your project only offers sb_publishable_/sb_secret_ keys, use the sb_secret_ one.');
    console.log('    • If the legacy JWT keys are shown as disabled, they will 401 — use the new secret key.');
  } else if (res.status === 404) {
    console.log('  RESULT: reached the project, but the table was not found — a schema problem, not a key problem.');
  } else {
    console.log('  RESULT: unexpected response; the message above is what Supabase returned.');
  }
} catch (e) {
  line('request failed', e.message);
  console.log('\n  RESULT: could not reach the project at all — paused, offline, or the host is wrong.');
}
console.log('');
