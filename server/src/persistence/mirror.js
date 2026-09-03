// PIE — write-behind mirror into Supabase.
//
// WHAT THIS IS
//   The JSON store stays the system of record WHILE THE PROCESS RUNS. Every
//   write to it is also queued and pushed to Supabase in the background.
//
//   Reading back is a separate module — persistence/hydrate.js — which runs once
//   at boot. That split is deliberate: the request path never waits on the
//   network, and the restore path never competes with live writes.
//
// WHAT IT WILL NOT DO
//   • It never throws into a request. A database that is asleep, rate-limited or
//     misconfigured slows nothing down and breaks nothing.
//   • It never pushes a secret. Password hashes, session tokens, reset tokens and
//     encrypted GitHub credentials are dropped before the row leaves this file.
//   • It is off unless SUPABASE_MIRROR=1 and Supabase is configured.
//
// IDS
//   PIE uses readable string ids ("cand_1a2b"); Postgres uses uuid primary keys.
//   Migration 002 adds a `legacy_id` column to every mirrored table. Rows are
//   upserted on legacy_id, and foreign keys are resolved by looking the parent's
//   legacy_id up and writing the real uuid alongside it.

import * as db from '../store.js';
import * as sb from './supabase.js';

/* ------------------------------------------------------------------ config */
/**
 * ON whenever Supabase is configured. Set SUPABASE_MIRROR=0 to turn it off.
 *
 * This used to be opt-in, which was right while nothing read the data back: an
 * unproven column mapping should not run unasked. It is wrong now. hydrate.js
 * restores accounts from exactly these rows, so a mirror that is off means a
 * database that stays empty, a restore that finds nothing, and a candidate who
 * cannot sign in — with no error anywhere to explain it. Configuring Supabase
 * and then silently not using it is not a state worth defaulting to.
 */
export const isEnabled = () => process.env.SUPABASE_MIRROR !== '0' && sb.isConfigured();

const FLUSH_MS = Number(process.env.SUPABASE_MIRROR_FLUSH_MS || 1500);
const MAX_BATCH = Number(process.env.SUPABASE_MIRROR_BATCH || 200);

// Never leaves the server, whatever the column mapping says.
//
// `passwordHash` is deliberately NOT on this list, and that distinction matters.
// A bcrypt hash is not a credential — it is the verifier a users table exists to
// hold, it cannot be replayed against PIE, and every password system on earth
// stores one. A session token is the opposite: it IS the credential, and anyone
// holding it is logged in. So the hash is mirrored (behind RLS, reachable only
// with the service-role key) and the token never is.
//
// Without the hash, hydrating an account back after a restart would restore a
// user who can never sign in again — which is the exact production bug this
// whole path exists to fix.
// A face template is NOT on this list either, and for the same reason: if it
// never reaches the database it does not survive a restart, and every candidate
// has to re-register their identity every time Render recycles the instance.
// Biometric data is protected by where it lives and who can read it — its own
// table, RLS on with no policies so only the service-role key reaches it, absent
// from every public serialiser, never logged — not by refusing to persist it.
const SECRET_KEYS = new Set([
  'password', 'tokenHash', 'token',
  'accessToken', 'accessTokenEncrypted', 'refreshToken',
]);

// Collections that must not be mirrored at all.
const NEVER = new Set(['sessions', 'passwordResets']);

/**
 * Parent order matters: a child's foreign key can only resolve once its parent
 * exists. This is the order a full sync walks.
 */
const ORDER = [
  'organizations', 'users', 'recruiters', 'candidateProfiles', 'faceIdentities', 'requisitions',
  'applications', 'evidence', 'githubConnections', 'githubRepositories',
  'projects', 'certificates', 'hackathons', 'agentRuns', 'matchResults',
  'assessmentAttempts', 'proctoringEvents', 'biasAudits', 'humanDecisions',
  'learningProgress', 'auditEvents',
];

/** Which PIE field points at which parent collection, and the columns to fill. */
const LINKS = {
  faceIdentities:      [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  evidence:            [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  githubConnections:   [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  githubRepositories:  [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  projects:            [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  certificates:        [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  hackathons:          [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  assessmentAttempts:  [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  proctoringEvents: [
    { field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' },
    { field: 'attemptId',          parent: 'assessmentAttempts', legacy: 'legacy_attempt_id',  uuid: 'attempt_id' },
  ],
  humanDecisions:      [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  learningProgress:    [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  biasAudits:          [{ field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id', uuid: 'candidate_profile_id' }],
  applications: [
    { field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id',   uuid: 'candidate_profile_id' },
    { field: 'requisitionId',      parent: 'requisitions',      legacy: 'legacy_requisition_id', uuid: 'requisition_id' },
  ],
  agentRuns: [
    { field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id',   uuid: 'candidate_profile_id' },
    { field: 'requisitionId',      parent: 'requisitions',      legacy: 'legacy_requisition_id', uuid: 'requisition_id' },
  ],
  matchResults: [
    { field: 'candidateProfileId', parent: 'candidateProfiles', legacy: 'legacy_candidate_id',   uuid: 'candidate_profile_id' },
    { field: 'requisitionId',      parent: 'requisitions',      legacy: 'legacy_requisition_id', uuid: 'requisition_id' },
  ],
  requisitions:        [{ field: 'recruiterId',    parent: 'recruiters',    legacy: 'legacy_recruiter_id',    uuid: null }],
  recruiters:          [{ field: 'organizationId', parent: 'organizations', legacy: 'legacy_organization_id', uuid: 'organization_id' }],
};

/**
 * Columns declared NOT NULL in schema.sql. Sending an explicit null for these
 * overrides their DEFAULT and the insert is rejected, so the mirror supplies
 * the same value the schema would have.
 */
const NOT_NULL_DEFAULTS = {
  is_demo: false,
  onboarding_complete: false,
  status: 'INGESTED',
  state: 'STARTED',
  verification: 'self_reported',
  completion_verification: 'CANDIDATE_DECLARED',
  warning_count: 0,
  signal_count: 0,
  requires_human_review: false,
  mode: 'REAL',
  context: {},
  protected_context: [],
};

/** NOT NULL timestamp columns. An explicit null overrides `default now()`. */
const NOT_NULL_TIMESTAMPS = new Set(['created_at', 'started_at', 'decided_at', 'occurred_at']);

/**
 * Where PIE's field name differs from the schema's column name. Declared in one
 * place because a silent mismatch on a NOT NULL column fails the whole batch,
 * and "null value in column event_type" does not tell you PIE calls it `type`.
 */
const FIELD_ALIASES = {
  // A user row carries the ids of the profiles it owns. Those are PIE ids, not
  // uuids, so they are stored under explicit `_legacy_id` names — a column called
  // `candidate_profile_id` would read as a uuid foreign key and be wrong.
  users: {
    name: 'full_name',
    candidateProfileId: 'candidate_profile_legacy_id',
    recruiterId: 'recruiter_legacy_id',
    organizationId: 'organization_legacy_id',
  },
  evidence:         { text: 'body', date: 'evidence_date' },
  requisitions:     { text: 'body' },
  hackathons:       { organizer: 'organiser' },
  proctoringEvents: { type: 'event_type' },
};

/**
 * Columns the schema declares NOT NULL with no DEFAULT. If one of these is null
 * the insert is rejected, so the mirror checks first and names the column —
 * rather than letting Postgres return a message about a column PIE does not
 * even use that name for. Test 27 asserts this matches schema.sql.
 */
const REQUIRED = {
  profiles: ['role', 'full_name', 'username', 'email'],
  organizations: ['name'],
  recruiter_profiles: ['name'],
  candidate_profiles: ['name'],
  requisitions: ['title', 'body'],
  evidence: ['source', 'title', 'verification'],
  github_connections: ['login'],
  github_repositories: ['name'],
  projects: ['name'],
  certificates: ['title'],
  hackathons: ['name'],
  agent_runs: ['trigger', 'status'],
  proctoring_events: ['event_type'],
  bias_audits: ['subject_type', 'subject_id', 'severity'],
  human_decisions: ['reviewer', 'action', 'reason'],
  learning_progress: ['skill_id'],
  audit_events: ['actor', 'action'],
  face_identities: ['algorithm', 'template'],
};

export const requiredColumns = () => REQUIRED;

/* The shape metadata, exported so persistence/hydrate.js can run it backwards.
   One declaration, two directions — a mapping that drifts between push and pull
   would restore rows that look right and link to nothing. */
export const shapeMeta = () => ({ ORDER, LINKS, FIELD_ALIASES, COLUMNS, NEVER });

/** Columns each table actually has, so the mirror never invents one. */
const COLUMNS = {
  profiles: ['legacy_id', 'role', 'full_name', 'username', 'email', 'title', 'is_demo', 'created_at',
    // Migration 003. Without these an account restored after a restart could
    // neither sign in nor prove it had verified its email.
    'password_hash', 'email_verified', 'email_verified_at', 'candidate_profile_legacy_id',
    'recruiter_legacy_id', 'organization_legacy_id'],
  organizations: ['legacy_id', 'name', 'industry', 'size', 'hq', 'is_demo', 'created_at'],
  recruiter_profiles: ['legacy_id', 'legacy_organization_id', 'organization_id', 'name', 'title', 'is_demo', 'created_at'],
  candidate_profiles: ['legacy_id', 'persona_id', 'name', 'headline', 'context', 'protected_context',
    'github_login', 'onboarding_complete', 'is_demo', 'created_at'],
  requisitions: ['legacy_id', 'legacy_recruiter_id', 'title', 'company', 'location', 'employment_type',
    'experience', 'body', 'required_skills', 'preferred_skills', 'status', 'is_demo', 'created_at'],
  applications: ['legacy_id', 'legacy_candidate_id', 'legacy_requisition_id', 'candidate_profile_id',
    'requisition_id', 'status', 'applied_at', 'is_demo', 'created_at'],
  evidence: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'source', 'type', 'verification',
    'title', 'body', 'evidence_date', 'verify_ref', 'metrics', 'status', 'import_mode', 'is_demo', 'created_at'],
  github_connections: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'login', 'name',
    'avatar_url', 'html_url', 'scopes', 'token_fingerprint', 'mode', 'is_demo', 'created_at'],
  github_repositories: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'login', 'name',
    'full_name', 'description', 'languages', 'visibility', 'commits', 'months_active', 'has_tests',
    'readme_quality', 'topics', 'stars', 'structure', 'pushed_at', 'import_mode', 'is_demo', 'created_at'],
  projects: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'name', 'description', 'role',
    'technologies', 'repository', 'problem', 'solution', 'outcome', 'team_size', 'duration', 'is_demo', 'created_at'],
  certificates: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'title', 'issuer', 'issued_on',
    'credential_id', 'verification_url', 'is_demo', 'created_at'],
  hackathons: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'name', 'organiser', 'year',
    'role', 'project', 'achievement', 'is_demo', 'created_at'],
  agent_runs: ['legacy_id', 'legacy_candidate_id', 'legacy_requisition_id', 'candidate_profile_id',
    'requisition_id', 'trigger', 'status', 'total_ms', 'ai_provider', 'ai_mode', 'step_summary', 'is_demo', 'started_at'],
  match_results: ['legacy_id', 'legacy_candidate_id', 'legacy_requisition_id', 'candidate_profile_id',
    'requisition_id', 'skills_first_score', 'potential_adjusted', 'match_tier', 'gap_count', 'confidence', 'is_demo', 'created_at'],
  assessment_attempts: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'policy_id', 'state',
    'question_count', 'overall', 'warning_count', 'requires_human_review', 'integrity_status', 'is_demo', 'started_at'],
  proctoring_events: ['legacy_id', 'legacy_candidate_id', 'legacy_attempt_id', 'candidate_profile_id',
    'attempt_id', 'event_type', 'severity', 'source', 'metadata', 'occurred_at'],
  bias_audits: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'subject_type', 'subject_id',
    'severity', 'signal_count', 'signals', 'status', 'is_demo', 'created_at'],
  human_decisions: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'reviewer', 'reviewer_role',
    'action', 'reason', 'ai_recommendation', 'is_demo', 'decided_at'],
  learning_progress: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'skill_id', 'resource_id',
    'state', 'completion_verification', 'is_demo', 'created_at'],
  audit_events: ['legacy_id', 'actor', 'actor_role', 'action', 'subject_type', 'subject_id', 'note', 'meta', 'is_demo'],
  // Migration 003. The template is the whole point of the row, so it is listed
  // like any other column; what protects it is the table's RLS and the fact
  // that no serialiser anywhere returns it.
  face_identities: ['legacy_id', 'legacy_candidate_id', 'candidate_profile_id', 'legacy_user_id',
    'algorithm', 'template_version', 'dimensions', 'template', 'quality', 'locked',
    'registered_at', 'is_demo', 'created_at'],
};

/* ------------------------------------------------------------------- state */
const queue = new Map();          // collection -> Set of row ids awaiting push
let timer = null;
let flushing = false;
let warnedMigration = false;
// One recurring fault should produce one line, not one line per flush forever.
const warnedColumns = new Set();
const warnedDuplicates = new Set();
const warnedOther = new Set();
const droppedColumns = new Map();   // say the migration message once, not per table
const stats = {
  enabled: false, pushed: 0, failed: 0, batches: 0,
  lastFlushAt: null, lastError: null, lastErrorAt: null, queued: 0,
};

const snake = k => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/**
 * PIE row -> a row shaped for its table, with anything unknown dropped.
 *
 * Every column the table declares is present on every row, even when the value
 * is null. PostgREST rejects a bulk insert whose objects do not all share the
 * same keys ("All object keys must match"), and PIE rows legitimately differ —
 * one agent run has a requisition, the next does not.
 */
export function shapeRow(collection, row) {
  const table = sb.TABLE_MAP[collection];
  const allowed = COLUMNS[table];
  if (!allowed) return null;

  // Columns filled only by parent resolution. PIE's `candidateProfileId` is a
  // string like "cand_1a2b"; the uuid column must never receive it.
  const uuidCols = new Set((LINKS[collection] || []).map(l => l.uuid).filter(Boolean));

  // Start with the full column set so the shape is identical for every row —
  // PostgREST rejects a batch whose objects do not share the same keys.
  const nowIso = new Date().toISOString();
  const out = {};
  for (const c of allowed) {
    if (c in NOT_NULL_DEFAULTS) out[c] = NOT_NULL_DEFAULTS[c];
    else if (NOT_NULL_TIMESTAMPS.has(c)) out[c] = row.createdAt || row.startedAt || row.ts || nowIso;
    else out[c] = null;
  }
  out.legacy_id = row.id;

  for (const [k, v] of Object.entries(row)) {
    if (SECRET_KEYS.has(k)) continue;
    const col = snake(k);
    if (col === 'id' || !allowed.includes(col) || uuidCols.has(col)) continue;
    if (v === undefined || v === null) continue;      // keep the schema default
    out[col] = v;
  }
  // PIE names a few fields differently from the schema.
  for (const [pieField, column] of Object.entries(FIELD_ALIASES[collection] || {})) {
    if (allowed.includes(column) && row[pieField] !== undefined && row[pieField] !== null) {
      out[column] = row[pieField];
    }
  }

  for (const link of LINKS[collection] || []) {
    if (link.legacy && !(link.legacy in out)) out[link.legacy] = null;
    if (link.uuid && !(link.uuid in out)) out[link.uuid] = null;
    if (row[link.field]) out[link.legacy] = row[link.field];
  }
  out.mirrored_at = new Date().toISOString();
  return out;
}

/* ------------------------------------------------------------------ queue */
export function enqueue(collection, id) {
  if (!isEnabled() || NEVER.has(collection) || !sb.TABLE_MAP[collection]) return;
  if (!queue.has(collection)) queue.set(collection, new Set());
  queue.get(collection).add(id);
  stats.queued = [...queue.values()].reduce((n, s) => n + s.size, 0);
  if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_MS);
}

/** legacy_id -> uuid for a set of parent rows. */
async function parentMap(parentCollection, legacyIds) {
  const table = sb.TABLE_MAP[parentCollection];
  const ids = [...new Set(legacyIds.filter(Boolean))];
  if (!table || !ids.length) return {};
  try {
    const rows = await sb.select(table, {
      select: 'id,legacy_id',
      legacy_id: `in.(${ids.map(v => `"${String(v).replace(/"/g, '')}"`).join(',')})`,
    });
    return Object.fromEntries((rows || []).map(r => [r.legacy_id, r.id]));
  } catch {
    return {};        // unresolved parents leave the uuid null; legacy_id still lands
  }
}

async function pushCollection(collection, rows) {
  const table = sb.TABLE_MAP[collection];
  const shaped = rows.map(r => shapeRow(collection, r)).filter(Boolean);
  if (!shaped.length) return 0;

  // Resolve foreign keys to real uuids where the parent is already mirrored.
  for (const link of LINKS[collection] || []) {
    if (!link.uuid) continue;
    const map = await parentMap(link.parent, shaped.map(r => r[link.legacy]));
    for (const r of shaped) {
      const uuid = map[r[link.legacy]];
      if (uuid) r[link.uuid] = uuid;
    }
  }

  // A NOT NULL column left empty fails the whole batch. Catch it here so the
  // message names the column and the row, not just the constraint.
  const required = REQUIRED[table] || [];
  for (const r of shaped) {
    for (const col of required) {
      if (r[col] === null || r[col] === undefined || r[col] === '') {
        throw new Error(`row ${r.legacy_id} has no value for ${table}.${col}, which the schema requires. `
          + 'Either PIE names that field differently (see FIELD_ALIASES) or the row is incomplete.');
      }
    }
  }

  // Columns this database has already told us it does not have. Stripped up
  // front so a known-missing column costs one request, not a failure and a
  // retry on every flush for the rest of the process's life.
  const known = droppedColumns.get(table);
  if (known?.size) {
    for (const r of shaped) for (const col of known) delete r[col];
  }

  for (let i = 0; i < shaped.length; i += MAX_BATCH) {
    let chunk = shaped.slice(i, i + MAX_BATCH);

    // A column PIE writes that the database does not have yet — almost always a
    // migration that has not been run. Rather than failing the whole mirror on
    // every flush until someone notices, drop that one column and push the rest.
    // The row still arrives; it is missing one link, and the warning says which.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await sb.rest(`${table}?on_conflict=legacy_id`, {
          method: 'POST', body: chunk,
          prefer: 'resolution=merge-duplicates,return=minimal',
        });
        stats.batches += 1;
        break;
      } catch (e) {
        const missing = /Could not find the '([^']+)' column/i.exec(e.message || '');
        if (!missing || attempt === 3) throw e;
        const col = missing[1];
        if (!warnedColumns.has(`${table}.${col}`)) {
          warnedColumns.add(`${table}.${col}`);
          console.warn(`[mirror] ${table}.${col} does not exist in Supabase, so it is being left out. `
            + 'Run server/supabase/002_mirror.sql to add it. Everything else is still mirrored, '
            + 'and the JSON store remains the system of record.');
        }
        if (!droppedColumns.has(table)) droppedColumns.set(table, new Set());
        droppedColumns.get(table).add(col);
        chunk = chunk.map(r => { const { [col]: _drop, ...rest } = r; return rest; });
      }
    }
  }
  return shaped.length;
}

/** Pushes everything currently queued. Safe to call at any time. */
export async function flush() {
  if (!isEnabled() || flushing || !queue.size) return { pushed: 0 };
  flushing = true;
  const work = [...queue.entries()];
  queue.clear();
  stats.queued = 0;

  let pushed = 0;
  try {
    // Walk in dependency order so a parent exists before its children.
    const ordered = work.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    for (const [collection, ids] of ordered) {
      // The demo world is regenerated from seed.js on every empty boot, so
      // pushing it would accumulate a fresh set of orphans in Supabase every
      // time the process restarts. Only real data is mirrored automatically;
      // the admin sync endpoint can still send demo rows on request.
      const includeDemo = process.env.SUPABASE_MIRROR_DEMO === '1';
      const rows = [...ids].map(id => db.findById(collection, id))
        .filter(r => r && (includeDemo || !r.isDemo));
      if (!rows.length) continue;
      try {
        pushed += await pushCollection(collection, rows);
      } catch (e) {
        stats.failed += rows.length;
        stats.lastError = `${collection}: ${e.message?.slice(0, 200)}`;
        stats.lastErrorAt = new Date().toISOString();
        // One cause produces the same error on every table. Saying it once, with
        // the fix, beats twenty identical lines scrolling past.
        if (/no unique or exclusion constraint/i.test(e.message)) {
          if (!warnedMigration) {
            warnedMigration = true;
            console.warn('[mirror] Supabase cannot upsert on legacy_id — migration 002 is missing '
              + 'or its index is partial. Run server/supabase/002_mirror.sql, then restart. '
              + 'Nothing is lost meanwhile: the JSON store is the system of record.');
          }
          break;                       // no point trying the rest of this flush
        }
        // A unique violation on some OTHER constraint means Supabase already
        // holds a row for that natural key — typically after a demo reset
        // regenerated PIE's ids. The mirror cannot merge those two identities,
        // and the JSON store is authoritative either way, so say it once and
        // move on rather than repeating it on every flush.
        const dup = /duplicate key value violates unique constraint "([^"]+)"/i.exec(e.message || '');
        if (dup && !/legacy_id/.test(dup[1])) {
          if (!warnedDuplicates.has(collection)) {
            warnedDuplicates.add(collection);
            console.warn(`[mirror] ${collection}: Supabase already has a row matching ${dup[1]} `
              + 'under a different PIE id — usually a demo reset regenerated ids. Those rows are '
              + 'skipped; the JSON store is the system of record. To start the mirror clean, '
              + `delete the existing rows from that table in Supabase and run tools/supabase-sync.mjs --push.`);
          }
          continue;
        }
        // Everything else, once per distinct message, so one recurring fault
        // cannot fill the terminal.
        const key = `${collection}:${(e.message || '').slice(0, 80)}`;
        if (!warnedOther.has(key)) {
          warnedOther.add(key);
          console.warn(`[mirror] ${stats.lastError}`);
        }
      }
    }
    stats.pushed += pushed;
    stats.lastFlushAt = new Date().toISOString();
  } finally {
    flushing = false;
  }
  return { pushed };
}

/**
 * Pushes the entire store, in dependency order, twice — the second pass fills
 * foreign keys whose parents did not exist yet on the first. Used by the
 * sync tool and the admin endpoint, never automatically.
 */
export async function syncAll({ includeDemo = false } = {}) {
  if (!sb.isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const report = {};
  for (let pass = 1; pass <= 2; pass += 1) {
    for (const collection of ORDER) {
      if (NEVER.has(collection)) continue;
      const rows = db.all(collection).filter(r => includeDemo || !r.isDemo);
      if (!rows.length) { report[collection] = 0; continue; }
      try {
        const n = await pushCollection(collection, rows);
        report[collection] = n;
      } catch (e) {
        report[collection] = `FAILED: ${e.message?.slice(0, 160)}`;
        stats.lastError = `${collection}: ${e.message?.slice(0, 200)}`;
        stats.lastErrorAt = new Date().toISOString();
      }
    }
  }
  stats.lastFlushAt = new Date().toISOString();
  return { ok: true, report };
}

/** Never returns a key or a row — counts and the last error message only. */
export function status() {
  const on = isEnabled();
  return {
    key: 'supabase_mirror',
    name: 'Supabase mirror',
    state: !sb.isConfigured() ? 'NOT_CONFIGURED'
      : !on ? 'OFF'
        : stats.lastError ? 'DEGRADED' : stats.pushed ? 'MIRRORING' : 'IDLE',
    detail: !sb.isConfigured()
      ? 'Supabase is not configured, so nothing is mirrored. The JSON store is the system of record.'
      : !on
        ? 'Mirroring is off (SUPABASE_MIRROR=0). New writes stay in the local JSON store only, which on a host with an ephemeral filesystem means they are lost on the next restart.'
        : 'Writes are pushed to Supabase in the background, and read back at boot by the restore step. Supabase is what makes an account outlive a restart.',
    systemOfRecord: on ? 'Supabase across restarts; the JSON store within a run' : 'Local JSON store',
    ...stats, enabled: on,
  };
}

/** Wire this once at boot. Subscribing is what makes writes flow. */
export function attach() {
  stats.enabled = isEnabled();
  if (!isEnabled()) return false;
  db.onChange((collection, id) => enqueue(collection, id));
  // Anything still queued when the process ends should still make it out.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { flush().catch(() => {}); });
  }
  return true;
}
