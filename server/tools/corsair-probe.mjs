// PIE — what does Corsair actually return?
//
//   node tools\corsair-probe.mjs cand_can_c61dd20c
//
// WHY THIS EXISTS
//   The sync enriches each repository with two things the list endpoint does
//   not carry: whether it runs GitHub Actions, and how long it was worked on.
//   Both were written against the SDK's documented surface and neither had ever
//   run against a live Corsair, so when the knowledge base kept reporting
//   "whether these repositories run CI has not been synced" there were three
//   possible reasons and no way to tell them apart:
//
//     1. the sync was never re-run, so the rows are the old ones
//     2. the call failed — wrong arguments, a scope the token does not carry
//     3. the call succeeded and returned a shape the sync did not recognise
//
//   Guessing between those costs a round trip each time. This prints the answer.
//   It makes the same calls the sync makes, through the same read-only path, and
//   shows what came back.
//
// WHAT IT PRINTS
//   Repository names, languages and dates — the candidate's own public metadata,
//   the same data the app already shows them. No keys, no tokens, no secrets.

// FIRST, and for its side effect: this is what reads server/.env. Without it
// the tool sees an empty environment and reports a correctly-configured Corsair
// as missing all four variables — which is the one answer a diagnostic must
// never give wrongly, because it sends you to fix something that is not broken.
import '../src/env.js';
import * as sdk from '../src/integrations/corsairClient.js';

const tenantId = process.argv[2];

const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);
const head = t => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

if (!tenantId) {
  console.log('\n  Usage: node tools\\corsair-probe.mjs <tenantId>');
  console.log('  Find the tenant with: node tools\\corsair-link-github.mjs --list\n');
  process.exit(1);
}

if (!sdk.isConfigured()) {
  console.log(`\n  Corsair is not configured. Missing: ${sdk.missing().join(', ')}\n`);
  process.exit(1);
}

/* ------------------------------------------------- 1. what is in the store */

head('1. Rows already synced into corsair_entities');

let rows = [];
let readFailed = null;
try {
  const entities = await sdk.asTenant(tenantId, t => t.github.db.repositories.list({ limit: 200 }));
  rows = (entities || []).map(e => e?.data ?? e).filter(Boolean);
} catch (e) {
  readFailed = String(e?.message || e).slice(0, 180);
}

// "The read failed" and "there is nothing there" are different answers, and a
// diagnostic that conflates them sends you to run a sync that will fail for the
// same reason. This is the same mistake the knowledge base was making about CI.
if (readFailed) {
  console.log(`  The read itself failed: ${readFailed}`);
  console.log('  So this says nothing about whether anything is synced. Fix the');
  console.log('  connection first — node tools\\corsair-test.mjs reports on it.');
} else if (!rows.length) {
  console.log('  The read worked and returned nothing. Run a sync — the knowledge');
  console.log('  base genuinely has nothing to search for this candidate.');
} else {
  console.log(`  ${rows.length} row(s). The three fields the knowledge base depends on:\n`);
  console.log(`  ${'repository'.padEnd(28)} ${'language'.padEnd(12)} ${'hasWorkflows'.padEnd(13)} monthsActive`);
  for (const r of rows) {
    const wf = r.hasWorkflows === undefined ? 'absent' : String(r.hasWorkflows);
    const ma = r.monthsActive == null ? 'null' : String(r.monthsActive);
    console.log(`  ${String(r.fullName || r.name).slice(0, 27).padEnd(28)} `
      + `${String(r.language || '-').slice(0, 11).padEnd(12)} ${wf.padEnd(13)} ${ma}`);
  }
  console.log('');
  const absent = rows.filter(r => r.hasWorkflows === undefined).length;
  if (absent === rows.length) {
    console.log('  hasWorkflows is absent on every row. Either the sync has not been re-run');
    console.log('  since the enrichment was added, or the calls below are failing.');
  } else if (absent) {
    console.log(`  ${absent} row(s) have no hasWorkflows — those calls failed individually.`);
  } else {
    console.log('  Every row carries hasWorkflows. The knowledge base can answer CI questions.');
  }
}

/* ------------------------------------------- 2. do the enrichment calls work */

const target = rows[0]?.fullName || rows[0]?.name;
if (target && String(target).includes('/')) {
  const [owner, repo] = String(target).split('/');

  head(`2. The two calls the sync makes, against ${owner}/${repo}`);

  for (const [label, call] of [
    ['github.api.workflows.list', t => t.github.api.workflows.list({ owner, repo })],
    ['github.api.repositories.get', t => t.github.api.repositories.get({ owner, repo })],
  ]) {
    try {
      const data = await sdk.asTenant(tenantId, call);
      line(label, 'OK');

      // The SHAPE is the thing. The sync reads a list three ways (a bare array,
      // `.workflows`, `.items`) and a creation date two ways (`createdAt`,
      // `created_at`); if Corsair uses a fourth spelling, this is where it shows.
      if (Array.isArray(data)) {
        line('  shape', `array of ${data.length}`);
        if (data[0]) line('  first item keys', Object.keys(data[0]).slice(0, 8).join(', '));
      } else if (data && typeof data === 'object') {
        line('  shape', 'object');
        line('  keys', Object.keys(data).slice(0, 14).join(', '));
        for (const k of ['workflows', 'items', 'total_count', 'totalCount']) {
          if (k in data) line(`  ${k}`, Array.isArray(data[k]) ? `array of ${data[k].length}` : String(data[k]));
        }
        for (const k of ['createdAt', 'created_at', 'pushedAt', 'pushed_at']) {
          if (k in data) line(`  ${k}`, String(data[k]));
        }
      } else {
        line('  shape', typeof data);
      }
    } catch (e) {
      line(label, 'FAILED');
      line('  reason', String(e?.message || e).slice(0, 180));
    }
    console.log('');
  }
} else if (rows.length) {
  head('2. Skipped');
  console.log('  The first row has no owner/name, so there is nothing to call against.');
}

await sdk.close().catch(() => {});
console.log('');
