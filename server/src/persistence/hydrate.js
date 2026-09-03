// PIE — restore the store from Supabase at boot.
//
// THE PROBLEM THIS SOLVES
//   Render's filesystem is ephemeral. server/data/pie.json is written happily,
//   and then thrown away the next time the instance is recycled — which on the
//   free plan happens after about fifteen minutes of inactivity. The symptom is
//   not an error. It is a candidate who registered yesterday being told "those
//   credentials do not match an account", while the same credentials work fine
//   on localhost. Nothing in the logs says anything is wrong, because from the
//   server's point of view nothing is: it genuinely has never seen that user.
//
//   The mirror has been pushing every write to Supabase all along. Nothing was
//   ever reading it back. This module is that missing half.
//
// WHAT IT DOES
//   Once, at boot, before seeding and before the mirror subscribes:
//     • pulls every mirrored collection back, parents first
//     • converts each row from its Postgres column names to PIE's field names,
//       running the mirror's own mapping tables backwards so the two can never
//       disagree
//     • MERGES. A row already in the local store is left exactly as it is.
//       Supabase fills gaps; it never overwrites something already loaded.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   • It does not restore sessions. Everyone signs in again after a restart —
//     that is correct, and shipping session tokens to a hosted database to
//     avoid it would be a poor trade.
//   • It does not restore the demo world. seed.js regenerates that for free.
//   • It never throws. A database that is asleep or misconfigured must not stop
//     the server from starting; it degrades to exactly today's behaviour, and
//     says so on the console.

import * as db from '../store.js';
import * as sb from './supabase.js';
import * as mirror from './mirror.js';
import * as checks from './checks.js';

/** Off only if you ask. Restoring your own data is the expected behaviour. */
export const isEnabled = () => process.env.SUPABASE_HYDRATE !== '0' && sb.isConfigured();

// Read at call time, not at import. Every other tunable in this codebase does
// the same, and a value frozen at module load is a setting that silently
// ignores the environment it was given.
const page = () => Number(process.env.SUPABASE_HYDRATE_PAGE || 1000);

const camel = c => c.replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());

/* --------------------------------------------------------------- reverse map */
/**
 * Column name -> PIE field name, for one collection.
 *
 * Built by inverting the mirror's own FIELD_ALIASES and LINKS rather than
 * restating them. If someone adds an alias for the push direction and forgets
 * the pull direction, that is a class of bug that cannot happen here.
 */
function reverseMap(collection) {
  const { LINKS, FIELD_ALIASES } = mirror.shapeMeta();
  const out = new Map();
  for (const [field, column] of Object.entries(FIELD_ALIASES[collection] || {})) {
    out.set(column, field);
  }
  for (const link of LINKS[collection] || []) {
    // The legacy column holds PIE's own id for the parent; the uuid column holds
    // Postgres's, which means nothing to PIE and is dropped.
    if (link.legacy) out.set(link.legacy, link.field);
  }
  return out;
}

/** Columns that describe the mirror rather than the row. */
const MIRROR_ONLY = new Set(['id', 'mirrored_at', 'legacy_id', 'updated_at', 'owner_id']);

/** One Supabase row -> one PIE row. Returns null if the row has no PIE id. */
export function toPieRow(collection, row) {
  const { LINKS } = mirror.shapeMeta();
  if (!row || !row.legacy_id) return null;         // written directly in Supabase, not by PIE

  const rev = reverseMap(collection);
  const uuidCols = new Set((LINKS[collection] || []).map(l => l.uuid).filter(Boolean));

  const out = { id: row.legacy_id };
  for (const [col, value] of Object.entries(row)) {
    if (MIRROR_ONLY.has(col) || uuidCols.has(col)) continue;
    if (value === null || value === undefined) continue;
    out[rev.get(col) || camel(col)] = value;
  }
  return out;
}

/* ------------------------------------------------------------------- paging */
async function readAll(table) {
  const rows = [];
  const PAGE = page();
  for (let offset = 0; ; offset += PAGE) {
    // PostgREST caps a response at its own max-rows setting, so asking for
    // everything in one request silently truncates on a busy project. Page.
    const batch = await sb.rest(table, {
      query: { select: '*', limit: String(PAGE), offset: String(offset), order: 'legacy_id' },
    });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

/* --------------------------------------------------------------------- run */
/**
 * Pulls Supabase into the local store. Safe to call on a store that already has
 * data: existing rows win, and nothing is deleted.
 *
 * @returns {Promise<{ok:boolean, reason?:string, restored:object, skipped:number, detail:string}>}
 */
export async function run({ includeDemo = false } = {}) {
  if (!sb.isConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', restored: {}, skipped: 0,
      detail: 'Supabase is not configured, so there is nothing to restore. The JSON store is all there is — '
        + 'on a host with an ephemeral filesystem that means accounts do not survive a restart.' };
  }
  if (!isEnabled()) {
    return { ok: false, reason: 'DISABLED', restored: {}, skipped: 0,
      detail: 'SUPABASE_HYDRATE=0 — the store was not restored from Supabase.' };
  }

  const { ORDER, NEVER } = mirror.shapeMeta();
  const restored = {};
  const failed = {};
  let skipped = 0;

  for (const collection of ORDER) {
    if (NEVER.has(collection)) continue;
    const table = sb.TABLE_MAP[collection];
    if (!table) continue;

    let rows;
    try {
      rows = await readAll(table);
    } catch (e) {
      // A missing table is a schema that has not been migrated, not a crash.
      failed[table] = String(e.message || e).slice(0, 160);
      continue;
    }

    let added = 0;
    for (const raw of rows) {
      if (!includeDemo && raw.is_demo === true) { skipped += 1; continue; }
      const row = toPieRow(collection, raw);
      if (!row) { skipped += 1; continue; }
      // The running store wins. Hydrate fills gaps; it never overwrites.
      if (db.findById(collection, row.id)) { skipped += 1; continue; }
      try {
        db.insert(collection, row);
        added += 1;
      } catch {
        skipped += 1;                              // unknown collection, or a bad row
      }
    }
    if (added) restored[collection] = added;
  }

  const total = Object.values(restored).reduce((a, b) => a + b, 0);
  const host = (() => { try { return new URL(sb.envUrl()).host; } catch { return 'Supabase'; } })();
  const ok = Object.keys(failed).length === 0;

  const detail = total
    ? `Restored ${total} row(s) from ${host}: `
      + Object.entries(restored).map(([c, n]) => `${n} ${c}`).join(', ') + '.'
    : ok
      ? `Nothing to restore — ${host} holds no PIE rows this store does not already have.`
      : `Could not read ${Object.keys(failed).length} table(s) from ${host}. `
        + 'Run server/supabase/schema.sql, grants.sql, 002_mirror.sql and 003_auth.sql, then restart.';

  checks.record('supabase_hydrate', {
    ok, detail, config: checks.fingerprint([sb.envUrl()]),
    meta: { restored, skipped, failed },
  });

  return { ok, restored, skipped, failed, total, detail };
}

/** Console line for boot. Says what happened in one sentence, or nothing. */
export function bootLine(result) {
  if (!result || result.reason === 'NOT_CONFIGURED') return null;
  if (result.reason === 'DISABLED') return '  Supabase restore: OFF (SUPABASE_HYDRATE=0)';
  if (!result.ok) return `  Supabase restore: INCOMPLETE — ${result.detail}`;
  if (!result.total) return '  Supabase restore: nothing new (the local store is already current)';
  return `  Supabase restore: ${result.total} row(s) recovered — ${Object.entries(result.restored)
    .map(([c, n]) => `${n} ${c}`).join(', ')}`;
}
