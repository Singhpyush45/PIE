// PIE — Supabase persistence driver.
//
// WHY THIS SHAPE
//   The JSON store is the default and always works offline, which is what keeps
//   the Grand Finale demo safe. This driver is the enterprise path: it activates
//   only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both present, and
//   until then every function here reports NOT_CONFIGURED rather than pretending.
//
// SECURITY
//   • The service-role key bypasses Row Level Security. It lives on the server
//     and is never sent to the browser, never logged, never returned by an API.
//   • The browser, if you wire it up later, uses the ANON key and is governed by
//     the RLS policies in server/supabase/schema.sql.
//   • Nothing here invents Supabase behaviour: it speaks plain PostgREST over
//     fetch, so there is no client library to drift out of date.

import * as json from '../store.js';
import * as checks from './checks.js';
import { fingerprint } from './checks.js';

const URL_ENV = 'SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

// Supabase shows the bare project URL on Settings → API, but the REST base
// (…/rest/v1) is just as easy to copy from the docs or the API preview. Accept
// either: `rest()` appends /rest/v1 itself, so a pasted one would be sent twice
// and every table would 404 — which reads exactly like a schema that was never
// applied. Normalise here, once, rather than trusting how the URL was pasted.
const cfg = () => ({
  url: (process.env[URL_ENV] || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, ''),
  key: (process.env[KEY_ENV] || '').trim(),
});

export function isConfigured() {
  const { url, key } = cfg();
  return Boolean(url && key);
}

/** JSON collection name → Supabase table name. */
export const TABLE_MAP = {
  users: 'profiles',
  organizations: 'organizations',
  recruiters: 'recruiter_profiles',
  candidateProfiles: 'candidate_profiles',
  requisitions: 'requisitions',
  applications: 'applications',
  evidence: 'evidence',
  githubConnections: 'github_connections',
  githubRepositories: 'github_repositories',
  projects: 'projects',
  certificates: 'certificates',
  hackathons: 'hackathons',
  agentRuns: 'agent_runs',
  matchResults: 'match_results',
  assessmentAttempts: 'assessment_attempts',
  proctoringEvents: 'proctoring_events',
  biasAudits: 'bias_audits',
  humanDecisions: 'human_decisions',
  learningProgress: 'learning_progress',
  auditEvents: 'audit_events',
  // `sessions` is deliberately absent: session tokens stay in server memory and
  // the local store. Shipping them to a hosted database buys nothing and widens
  // the blast radius if the service key ever leaks.
};

/* ------------------------------------------------------------------ PostgREST */
export async function rest(pathname, { method = 'GET', body, prefer, query } = {}) {
  const { url, key } = cfg();
  if (!url || !key) throw new Error(`Supabase is not configured (${URL_ENV} / ${KEY_ENV} missing).`);

  const qs = query ? `?${new URLSearchParams(query)}` : '';
  const res = await fetch(`${url}/rest/v1/${pathname}${qs}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.SUPABASE_TIMEOUT_MS || 8000)),
  });

  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

  if (!res.ok) {
    // The message may quote a column name; it never quotes the key.
    const detail = payload?.message || payload?.hint || res.statusText;
    const err = new Error(`Supabase ${method} ${pathname} → ${res.status}: ${detail}`);
    err.status = res.status;
    err.code = payload?.code || null;
    throw err;
  }
  return payload;
}

export const select = (table, query) => rest(table, { query: { select: '*', ...query } });
export const insert = (table, rows) =>
  rest(table, { method: 'POST', body: rows, prefer: 'return=representation' });
export const upsert = (table, rows) =>
  rest(table, { method: 'POST', body: rows, prefer: 'resolution=merge-duplicates,return=minimal' });
export const patch = (table, match, values) =>
  rest(table, { method: 'PATCH', body: values, query: match, prefer: 'return=representation' });
export const del = (table, match) => rest(table, { method: 'DELETE', query: match });

/* ----------------------------------------------------------------- readiness */
let cache = { at: 0, value: null };

/**
 * Live reachability + schema check. Cached briefly so a dashboard poll does not
 * hammer the project. Returns a plain object safe to render in the UI — it
 * contains the project host, never the key.
 */
export async function verify({ force = false } = {}) {
  if (!isConfigured()) {
    return {
      configured: false,
      state: 'NOT_CONFIGURED',
      detail: `Set ${URL_ENV} and ${KEY_ENV} in server/.env to activate. PIE is running on the local JSON store.`,
      tables: [],
    };
  }
  if (!force && cache.value && Date.now() - cache.at < 30_000) return cache.value;

  const host = (() => { try { return new URL(cfg().url).host; } catch { return 'invalid URL'; } })();
  const result = { configured: true, host, tables: [], missing: [] };

  try {
    // A HEAD-style count on each mapped table tells us whether schema.sql ran.
    const names = [...new Set(Object.values(TABLE_MAP))];
    const checks = await Promise.all(names.map(async name => {
      try {
        await rest(name, { query: { select: 'id', limit: '1' } });
        return { name, ok: true };
      } catch (e) {
        // No status at all means the request never reached PostgREST. The
        // SQLSTATE, where there is one, says far more than the HTTP code.
        return { name, ok: false, status: e.status || null, code: e.code || null };
      }
    }));
    result.tables = checks.filter(c => c.ok).map(c => c.name);
    result.missing = checks.filter(c => !c.ok).map(c => c.name);

    if (result.missing.length === names.length) {
      // Every table failing is NOT automatically a missing schema. The per-table
      // catch above swallows transport and auth failures too, so classify by what
      // actually came back — telling someone to re-run schema.sql when the real
      // problem is a rejected key or a wrong URL sends them down the wrong path.
      const failed = checks.filter(c => !c.ok);
      if (failed.every(c => c.status === null)) {
        result.state = 'UNREACHABLE';
        result.detail = `Could not reach ${host}. The project may be paused — resume it at supabase.com — or the host in ${URL_ENV} may be wrong.`;
      } else if (failed.every(c => c.code === '42501')) {
        // 42501 is insufficient_privilege. You cannot be denied permission on a
        // table that does not exist, so this proves the schema IS applied and
        // the key IS valid — Postgres simply has no GRANT for the API role.
        result.state = 'PERMISSION_DENIED';
        result.detail = `${host} has the PIE tables and your key is valid, but the API role has no table privileges. `
          + `Run server/supabase/grants.sql in the SQL editor — it only adds GRANTs and changes no data.`;
      } else if (failed.every(c => c.status === 401 || c.status === 403)) {
        result.state = 'AUTH_REJECTED';
        result.detail = `${host} answered but rejected the credentials. Check ${KEY_ENV} against Settings → API → service_role. The schema is not the problem.`;
      } else {
        result.state = 'REACHABLE_SCHEMA_MISSING';
        result.detail = `Reached ${host} but none of the ${names.length} PIE tables answered. `
          + `Either server/supabase/schema.sql has not been run in the SQL editor, or ${URL_ENV} `
          + `is not the project URL (it should be https://<ref>.supabase.co — PIE appends /rest/v1 itself).`;
      }
    } else if (result.missing.length) {
      result.state = 'REACHABLE_SCHEMA_PARTIAL';
      result.detail = `Connected to ${host}. ${result.tables.length}/${names.length} tables present; missing: ${result.missing.join(', ')}.`;
    } else {
      result.state = 'CONNECTED';
      result.detail = `Connected to ${host}. All ${names.length} PIE tables present.`;
    }
  } catch (e) {
    result.state = 'UNREACHABLE';
    result.detail = /paused/i.test(e.message)
      ? `Project ${host} appears to be paused. Resume it at supabase.com, then reload.`
      : `Could not reach ${host}: ${e.message}`;
  }

  cache = { at: Date.now(), value: result };
  // Kept on disk so the next server start already knows the schema was reachable.
  checks.record('supabase', {
    ok: result.state === 'CONNECTED',
    detail: result.detail, config: sbFingerprint(), meta: result,
  });
  return result;
}

/**
 * Is migration 002 actually applied, and does an upsert on legacy_id work?
 *
 * Both questions need answering before pushing hundreds of rows, and neither can
 * be read from PostgREST directly — it exposes tables, not indexes. So this
 * writes one clearly-marked probe row and deletes it again. That is the only way
 * to find out whether ON CONFLICT can infer the index, which is exactly the
 * failure that produces seventeen identical errors otherwise.
 */
export async function migrationCheck() {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const PROBE = '__pie_migration_probe__';
  const table = 'audit_events';          // no foreign keys, safest place to poke

  // 1. Does the legacy_id column exist at all?
  try {
    await rest(table, { query: { select: 'legacy_id', limit: '1' } });
  } catch (e) {
    if (/legacy_id/i.test(e.message)) {
      return { ok: false, reason: 'MIGRATION_MISSING',
        detail: 'The legacy_id column does not exist. Run server/supabase/002_mirror.sql in the SQL editor.' };
    }
    return { ok: false, reason: 'UNREACHABLE', detail: e.message };
  }

  // 2. Can PostgREST actually upsert on it? A partial unique index passes step 1
  //    and fails here, which is the whole point of probing.
  try {
    await rest(`${table}?on_conflict=legacy_id`, {
      method: 'POST',
      body: [{ legacy_id: PROBE, actor: 'pie', action: 'MIGRATION_PROBE', is_demo: false }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  } catch (e) {
    if (/no unique or exclusion constraint/i.test(e.message)) {
      return {
        ok: false, reason: 'PARTIAL_INDEX',
        detail: 'legacy_id exists but its unique index is PARTIAL, so PostgREST cannot upsert on it. '
          + 'Re-run server/supabase/002_mirror.sql — the current version rebuilds the index without a WHERE clause.',
      };
    }
    return { ok: false, reason: 'UPSERT_REFUSED', detail: e.message };
  } finally {
    // Leave nothing behind, whether the probe succeeded or not.
    try { await del(table, { legacy_id: `eq.${PROBE}` }); } catch { /* best effort */ }
  }

  return { ok: true, detail: 'Migration 002 is applied and upserts on legacy_id work.' };
}

/** Synchronous snapshot for the service list — never blocks a request. */
/** What a check was taken against, so a changed URL invalidates an old pass. */
const sbFingerprint = () => {
  const c = cfg();
  return fingerprint([c.url, c.key.slice(0, 12)]);
};

export function status() {
  const configured = isConfigured();
  // In-process cache first; then the durable record, so a verification does not
  // have to be repeated after every restart.
  const proven = cache.value || (configured ? checks.read('supabase', sbFingerprint()) : null);
  const last = cache.value || (proven?.ok ? proven.meta : null);
  const when = cache.value ? null : proven?.ok ? checks.ageOf(proven) : null;
  return {
    key: 'supabase',
    name: 'Supabase (PostgreSQL + RLS)',
    state: configured ? (last?.state || 'CONFIGURED_UNVERIFIED') : 'NOT_CONFIGURED',
    detail: configured
      ? ((last?.detail ? `${last.detail}${when ? ` (checked ${when})` : ''}` : null)
        || 'Credentials present. Press "Verify connection" to check the schema — nothing is checked until you ask.')
      : `Not configured. PIE is persisting to the local JSON store at server/data/pie.json. Add ${URL_ENV} and ${KEY_ENV} to activate.`,
    classification: configured ? 'PROPOSED — credentials supplied, schema verified on demand' : 'OPTIONAL — not configured',
    systemOfRecord: configured ? 'Supabase when mirroring is enabled; JSON store otherwise' : 'Local JSON store',
  };
}

/* ------------------------------------------------------------------- mirror */
// Row shaping. The JSON store uses camelCase ids like `cand_1a2b`; Postgres uses
// uuid primary keys. Mirroring therefore writes to a `legacy_id` column where the
// schema has one and lets Postgres mint the uuid. Anything the target table does
// not declare is dropped rather than guessed — a mirror that invents columns is
// worse than no mirror.
const SKIP_KEYS = new Set(['passwordHash', 'accessToken', 'tokenHash', 'password']);

function shape(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP_KEYS.has(k)) continue;                 // secrets never leave the server
    out[k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)] = v;
  }
  return out;
}

/**
 * One-way push of the local store into Supabase. Off by default; enable with
 * SUPABASE_MIRROR=1 once the schema is applied and you have confirmed the
 * column mapping against your own project. Failures are reported, never fatal —
 * the demo must survive a database that is asleep.
 */
export async function mirror({ collections = Object.keys(TABLE_MAP), includeDemo = false } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED', pushed: {} };
  const pushed = {};
  const failed = {};
  for (const c of collections) {
    const table = TABLE_MAP[c];
    if (!table) continue;
    const rows = json.all(c).filter(r => includeDemo || !r.isDemo).map(shape);
    if (!rows.length) { pushed[table] = 0; continue; }
    try {
      await upsert(table, rows);
      pushed[table] = rows.length;
    } catch (e) {
      failed[table] = e.message;
    }
  }
  return { ok: Object.keys(failed).length === 0, pushed, failed };
}

export const MIRROR_ENABLED = () => process.env.SUPABASE_MIRROR === '1' && isConfigured();

export const envNames = { URL_ENV, KEY_ENV };
