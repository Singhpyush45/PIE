// PIE — push the local store into Supabase.
//
//   cd F:\PIE_V3\server
//   node tools/supabase-sync.mjs              → dry run: show what WOULD be pushed
//   node tools/supabase-sync.mjs --push       → actually push real accounts
//   node tools/supabase-sync.mjs --push --demo → include the demo world too
//   node tools/supabase-sync.mjs --verify     → count rows on both sides and compare
//
// The JSON store stays the system of record. This only copies rows out; nothing
// in server/data/pie.json is read back from Supabase or changed by this tool.

import '../src/env.js';
import * as db from '../src/store.js';
import * as sb from '../src/persistence/supabase.js';
import * as mirror from '../src/persistence/mirror.js';

const args = process.argv.slice(2);
const PUSH = args.includes('--push');
const DEMO = args.includes('--demo');
const VERIFY = args.includes('--verify');

const line = (l, v) => console.log(`  ${String(l).padEnd(24)} ${v}`);

console.log('\nPIE — SUPABASE SYNC');
console.log('='.repeat(66));

db.load();

/* -------------------------------------------------------------- readiness */
if (!sb.isConfigured()) {
  line('Supabase', 'NOT CONFIGURED');
  console.log('\n  Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in server/.env first.');
  console.log('  PIE keeps working without them — the JSON store is the system of record.\n');
  process.exit(1);
}

const v = await sb.verify({ force: true });
line('Supabase', `${v.state}${v.host ? ` (${v.host})` : ''}`);
if (v.state !== 'CONNECTED') {
  console.log(`\n  ${v.detail}\n`);
  process.exit(1);
}

/* ------------------------------------------------------- migration check */
// Seventeen identical "no unique or exclusion constraint" errors mean one thing,
// and it is better said once, before pushing anything.
const mig = await sb.migrationCheck();
line('migration 002', mig.ok ? 'applied' : `NOT READY (${mig.reason})`);
if (!mig.ok) {
  console.log(`\n  ${mig.detail}\n`);
  console.log('  HOW TO FIX');
  console.log('    1. supabase.com -> your project -> SQL Editor -> New query');
  console.log('    2. Paste all of server/supabase/002_mirror.sql');
  console.log('    3. Run. Expect "Success. No rows returned".');
  console.log('    4. node tools/supabase-sync.mjs --push');
  console.log('\n  Nothing was written. The JSON store is untouched and still authoritative.\n');
  process.exit(1);
}

/* ------------------------------------------------------ what is on each side */
const COLLECTIONS = Object.keys(sb.TABLE_MAP);
const local = {};
for (const c of COLLECTIONS) {
  local[c] = db.all(c).filter(r => DEMO || !r.isDemo).length;
}

async function remoteCount(table) {
  try {
    const rows = await sb.rest(table, { query: { select: 'legacy_id', limit: '10000' } });
    return Array.isArray(rows) ? rows.filter(r => r.legacy_id).length : 0;
  } catch { return null; }
}

console.log(`\n${VERIFY ? 'ROW COUNTS' : PUSH ? 'PUSHING' : 'DRY RUN — nothing will be written'}`);
console.log('-'.repeat(66));
console.log(`  ${'COLLECTION'.padEnd(22)} ${'LOCAL'.padStart(7)} ${'SUPABASE'.padStart(9)}`);

let totalLocal = 0;
const before = {};
for (const c of COLLECTIONS) {
  const r = await remoteCount(sb.TABLE_MAP[c]);
  before[c] = r;
  totalLocal += local[c];
  if (local[c] || r) {
    console.log(`  ${c.padEnd(22)} ${String(local[c]).padStart(7)} ${String(r ?? '?').padStart(9)}`);
  }
}
console.log('-'.repeat(66));
line('rows to consider', `${totalLocal}${DEMO ? ' (including the demo world)' : ' (real accounts only)'}`);

if (VERIFY) {
  const drift = COLLECTIONS.filter(c => before[c] !== null && before[c] < local[c]);
  console.log('');
  if (!drift.length) console.log('  Supabase has at least as many rows as the local store in every collection.\n');
  else {
    console.log('  Behind in: ' + drift.map(c => `${c} (${before[c]}/${local[c]})`).join(', '));
    console.log('  Run with --push to catch up.\n');
  }
  process.exit(0);
}

if (!PUSH) {
  console.log('\n  This was a dry run. Add --push to write these rows to Supabase.');
  console.log('  Nothing in server/data/pie.json is changed either way.\n');
  process.exit(0);
}

/* -------------------------------------------------------------------- push */
console.log('\n  Pushing in dependency order, twice, so foreign keys resolve…');
const t0 = Date.now();
const r = await mirror.syncAll({ includeDemo: DEMO });
const ms = Date.now() - t0;

if (!r.ok) {
  line('result', `REFUSED (${r.reason})`);
  process.exit(1);
}

const failed = Object.entries(r.report).filter(([, val]) => typeof val === 'string');
const pushed = Object.entries(r.report).filter(([, val]) => typeof val === 'number' && val > 0);

console.log('');
for (const [c, n] of pushed) line(c, `${n} rows`);
if (failed.length) {
  console.log('\n  FAILURES');
  for (const [c, msg] of failed) console.log(`    ${c}: ${msg}`);
}

console.log('');
line('took', `${(ms / 1000).toFixed(1)}s`);
line('result', failed.length ? `${failed.length} collection(s) failed` : 'every collection pushed');

console.log(failed.length
  ? '\n  The local store is untouched and still authoritative. Fix the errors above and re-run.\n'
  : '\n  Done. The JSON store remains the system of record — nothing reads from Supabase yet.\n');
process.exit(failed.length ? 1 : 0);
