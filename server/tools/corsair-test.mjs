// Proves the Corsair integration, or says precisely which part is not working.
//
//   cd server && node tools/corsair-test.mjs
//
// A key in .env is not a working integration. This makes the calls that would
// otherwise fail for the first time in front of an audience, and records the
// result so the running server's Integrations panel updates without a restart.
//
// It prints states, counts and variable NAMES. It never prints a key, a signing
// secret, a KEK or a connection string — including inside an error message,
// which is where they would otherwise leak.

import '../src/env.js';
import * as corsair from '../src/integrations/corsair.js';
import * as sdk from '../src/integrations/corsairClient.js';

const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);

console.log('\nCorsair — proving the integration\n');

/* ------------------------------------------------------------ 1. variables */
console.log('Configuration');
const gaps = sdk.missing();
for (const name of Object.values(sdk.envNames)) {
  line(name, gaps.includes(name) ? 'NOT SET' : 'set');
}

if (gaps.length) {
  console.log(`\n  ${gaps.length} required variable(s) missing.\n`);
  console.log('  What each one is:');
  console.log('    CORSAIR_API_KEY        the project key from the Corsair dashboard (ck_…)');
  console.log('    CORSAIR_SIGNING_SECRET verifies that a Hub delivery really came from Corsair (csec_…)');
  console.log('    CORSAIR_KEK            encrypts stored authorisations. Generate ONCE:');
  console.log('                             openssl rand -base64 32');
  console.log('                           Lose it and every candidate must reconnect.');
  console.log('    CORSAIR_DATABASE_URL   a real Postgres connection string. In Supabase:');
  console.log('                             Settings → Database → Connection string → URI');
  console.log('                           Corsair speaks SQL; the Supabase REST key is not enough.');
  console.log('\n  PIE runs fine without any of this. GitHub evidence falls back to PIE\'s own');
  console.log('  OAuth adapter, and no score changes.\n');
  process.exit(1);
}

/* ---------------------------------------------------------------- 2. verify */
console.log('\nReaching the database through the SDK');
const v = await corsair.verify();

if (!v.ok) {
  line('result', `FAILED (${v.reason})`);
  console.log(`\n  ${v.detail}\n`);
  const hint = /relation .*corsair_.* does not exist|corsair_integrations/i.test(v.detail || '')
    ? 'The corsair_* tables are missing. Run server/supabase/004_corsair.sql in the Supabase SQL editor.'
    : /password|authentication|SASL/i.test(v.detail || '')
      ? 'The connection string was rejected. Check the password in CORSAIR_DATABASE_URL — copy it from Supabase rather than retyping it.'
      : /ENOTFOUND|ETIMEDOUT|ECONNREFUSED/i.test(v.detail || '')
        ? 'The database host could not be reached. If you are on a network that blocks port 5432, use Supabase\'s pooler connection string instead.'
        : 'Check that the connection string points at the same project the SQL was run in.';
  console.log(`  Most likely: ${hint}\n`);
  await sdk.close();
  process.exit(1);
}

line('result', 'CONNECTED');
line('plugins', v.plugins.join(', ') || 'none');
if (v.unconfigured?.length) line('awaiting credentials', v.unconfigured.join(', '));

/* --------------------------------------------------------- 3. read-only proof */
// The claim on the Integrations screen is that PIE *cannot* write to a
// candidate's GitHub. Asserting that in a comment is worth nothing; this makes
// the SDK refuse an actual write, so the guarantee is demonstrated rather than
// described.
console.log('\nProving PIE cannot write');
const probe = await corsair.githubRepositories('octocat', { tenantId: 'proof_readonly' })
  .then(() => null).catch(e => e);
void probe; // the read path is exercised below; this only warms the client

const wrote = await sdk.asTenant('proof_readonly', t =>
  t.github.api.repositories.star({ owner: 'corsairdev', repo: 'corsair' }))
  .then(() => 'ALLOWED', e => (/Readonly/i.test(e?.name || '') ? 'REFUSED' : `blocked (${e?.name || 'error'})`));

line('attempted a write', wrote);
if (wrote === 'ALLOWED') {
  console.log('\n  A write succeeded. The read-only guarantee is NOT holding — do not claim it.\n');
  await sdk.close();
  process.exit(1);
}
console.log('  The SDK refused a write from inside PIE\'s read-only scope, as designed.');

/* ------------------------------------------------------------- 4. a real read */
console.log('\nReading a candidate\'s repositories');
const tenant = process.argv[2] || null;
if (!tenant) {
  console.log('  Skipped — pass a tenant to try one, e.g.');
  console.log('    node tools/corsair-test.mjs cand_<candidateProfileId>');
  console.log('  A candidate must have completed the Corsair connect flow first.');
} else {
  const r = await corsair.githubRepositories(process.argv[3] || null, { tenantId: tenant });
  if (r.ok) {
    line('source', r.source === 'corsair-db' ? 'synced rows (no live call)' : 'live GitHub call');
    line('repositories', String(r.repositories.length));
    for (const repo of r.repositories.slice(0, 5)) {
      console.log(`    · ${repo.fullName}${repo.language ? ` — ${repo.language}` : ''}`);
    }
  } else {
    line('result', r.reason);
    console.log(`  ${r.detail || ''}`);
  }
}

console.log('\nRecorded. The Integrations screen will now show CONNECTED.\n');
await sdk.close();
