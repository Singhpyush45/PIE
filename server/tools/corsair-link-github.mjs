// Links a GitHub token to a candidate's Corsair tenant, without the Hub.
//
//   node tools\corsair-link-github.mjs <tenantId> <token> [githubLogin]
//
//   node tools\corsair-link-github.mjs --list
//       shows the candidates on this instance and the tenant id for each
//
// WHY YOU WOULD USE THIS
//   The Hub connect flow needs Corsair to reach this server to deliver the
//   credential. On a laptop that means a tunnel, and a tunnel is one more thing
//   that a network or an antivirus can take away — frp is a legitimate tool that
//   Windows Defender routinely classifies as a hacking tool and refuses to run.
//
//   This is the same destination by a shorter road. The token you give it is
//   written into corsair_accounts, encrypted under CORSAIR_KEK, against the
//   tenant you name. Afterwards every Corsair path is identical: tenant-scoped
//   reads, the db and api surfaces, the read-only policy, and the Evidence
//   Scout's tools.
//
//   In the product this happens by itself: when a candidate connects GitHub
//   through PIE's own OAuth, the callback hands the same grant to Corsair. This
//   tool is for setting one up by hand — your own account, before a demo.
//
// ABOUT THE TOKEN
//   A fine-grained or classic personal access token with NO scopes ticked is
//   enough for public repository metadata, which is all PIE presents as
//   evidence. Give it nothing else. PIE could not use more if you did: the
//   plugin runs mode: readonly and every call is inside a runReadonly scope.
//
//   Create one at  https://github.com/settings/tokens
//
//   The token is written and never read back. It is not printed here, not
//   logged, and not returned by any endpoint. It DOES appear in your shell
//   history, though — clear it afterwards, or paste when prompted instead of
//   passing it as an argument.

import '../src/env.js';
import readline from 'node:readline/promises';
import * as db from '../src/store.js';
import * as corsair from '../src/integrations/corsair.js';
import * as sdk from '../src/integrations/corsairClient.js';

const args = process.argv.slice(2);

/* -------------------------------------------------------------------- list */

if (args.includes('--list')) {
  db.load();
  const profiles = db.all('candidateProfiles');
  if (!profiles.length) {
    console.log('\n  No candidate profiles on this instance yet.\n');
    process.exit(0);
  }
  console.log('\n  Candidates on this instance\n');
  for (const p of profiles.slice(0, 40)) {
    const user = db.find('users', u => u.candidateProfileId === p.id);
    const tenant = `cand_${p.id}`;
    console.log(`  ${tenant.padEnd(24)} ${(p.fullName || user?.name || '—').slice(0, 28).padEnd(30)}${p.githubLogin ? `@${p.githubLogin}` : ''}`);
  }
  console.log('\n  Use one of these tenant ids as the first argument.\n');
  process.exit(0);
}

/* -------------------------------------------------------------------- link */

const [tenantId, tokenArg, login] = args;

if (!tenantId) {
  console.log('\n  Usage:  node tools\\corsair-link-github.mjs <tenantId> [token] [githubLogin]');
  console.log('          node tools\\corsair-link-github.mjs --list\n');
  process.exit(1);
}

if (!corsair.isConfigured()) {
  console.log(`\n  Corsair is not configured (${sdk.missing().join(', ')} not set).`);
  console.log('  Run: node tools\\env-doctor.mjs\n');
  process.exit(1);
}

let token = tokenArg;
if (!token) {
  // Preferred: keeps the token out of the shell history entirely.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  token = (await rl.question('  GitHub token (not echoed to history): ')).trim();
  rl.close();
}

if (!token) { console.log('\n  No token given. Nothing was changed.\n'); process.exit(1); }

if (!/^gh[pousr]_[A-Za-z0-9]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
  console.log('\n  That does not look like a GitHub token.');
  console.log('  Classic tokens start ghp_ / gho_ / ghu_ / ghs_ / ghr_; fine-grained ones start github_pat_.');
  console.log('  Nothing was written.\n');
  process.exit(1);
}

console.log(`\n  Linking a GitHub token to tenant ${tenantId}\n`);

const linked = await corsair.linkGithubToken({ tenantId, token, login: login || null, scopes: 'read:public' });
if (!linked.ok) {
  console.log(`  Failed: ${linked.reason}`);
  if (linked.detail) console.log(`  ${linked.detail}`);
  console.log('');
  await sdk.close();
  process.exit(1);
}
console.log('  Stored, encrypted under CORSAIR_KEK in corsair_accounts.');

/* ------------------------------------------------------------------ prove it */
// Writing a key proves a write. It does not prove the token works, and PIE's
// rule everywhere else is that an integration is connected when a real call has
// come back. So: make one.

console.log('\n  Proving it with a real read\n');
const check = await corsair.verifyGithubLink({ tenantId, login: login || null });

if (!check.ok) {
  console.log(`  The token was stored, but reading with it failed: ${check.reason}`);
  if (check.detail) console.log(`  ${check.detail}`);
  console.log('\n  Most likely the token is expired, revoked, or was truncated when pasted.');
  console.log('  Re-run with a fresh one.\n');
  await sdk.close();
  process.exit(1);
}

console.log(`  Read ${check.repositories} repositor${check.repositories === 1 ? 'y' : 'ies'} through Corsair`);
console.log(`  Source: ${check.source === 'corsair-db' ? 'synced rows' : 'a live GitHub call'}`);
console.log('\n  This tenant is now connected. Sign in as that candidate and run the');
console.log('  Evidence Scout — Evidence → Import → Evidence Scout.\n');

await sdk.close();
