// SAP HANA Cloud repository adapter.
//
// WHAT THIS IS FOR
//   PIE's system of record stays where it is. HANA Cloud is the ENTERPRISE
//   record: the orchestrator's audit trail and its match results, written to the
//   database an SAP customer would actually keep them in.
//
//   That split is deliberate. The Hackfest HANA instance is a practice system
//   with an expiry date; betting PIE's accounts and evidence on it would mean
//   losing them when it goes. Append-only enterprise records are exactly the
//   right thing to put there — they carry the SAP integration story without the
//   application depending on the sandbox staying alive.
//
// WHAT REPLACED WHAT
//   This adapter used to report CONNECTED because three environment variables
//   were present. It had no driver and never opened a connection. That is the
//   same overclaim PIE refuses to make about email: "configured" is not
//   "working", and only a real query proves the difference.
//
// FAILURE POSTURE
//   A HANA write never blocks a request and never fails one. The driver is
//   imported lazily so a native module that will not build cannot stop the
//   server from booting, and every write path returns a result object rather
//   than throwing.

import * as checks from '../persistence/checks.js';
import { fingerprint } from '../persistence/checks.js';

const env = (k, d = '') => (process.env[k] || d).trim();

const cfg = () => ({
  host: env('SAP_HANA_HOST'),                    // <uuid>.hana.<region>.hanacloud.ondemand.com
  port: Number(env('SAP_HANA_PORT', '443')),
  user: env('SAP_HANA_USER'),
  password: process.env.SAP_HANA_PASSWORD || '',
  // No default. A schema-plan service key generates its own schema name, and
  // guessing "PIE" would send the tables somewhere the user cannot write.
  // Empty means "use whatever this user's default schema is", which is right.
  schema: env('SAP_HANA_SCHEMA'),
  timeoutMs: Number(env('SAP_HANA_TIMEOUT_MS', '15000')),
});

export function isConfigured() {
  const c = cfg();
  return Boolean(c.host && c.user && c.password);
}

/** Bound a verification to the instance and user it was taken against. */
const hanaFingerprint = () => {
  const c = cfg();
  return fingerprint([c.host, String(c.port), c.user, c.schema]);
};

/* ------------------------------------------------------------------ driver */
let driverPromise = null;
let lastError = null;

async function driver() {
  if (driverPromise) return driverPromise;
  driverPromise = (async () => {
    try {
      const mod = await import('@sap/hana-client');
      return mod.default || mod;
    } catch (e) {
      // A missing native module is a deployment fact, not a crash.
      lastError = '@sap/hana-client is not installed. Run: npm install @sap/hana-client';
      return null;
    }
  })();
  return driverPromise;
}

/**
 * Opens one connection. The caller always disconnects.
 *
 * HANA Cloud only accepts TLS, and it enforces an IP allowlist — a refusal here
 * is far more often "this address is not allowed" than "these credentials are
 * wrong", so the message says so.
 */
async function connect() {
  const hana = await driver();
  if (!hana) return { ok: false, reason: 'DRIVER_MISSING', detail: lastError };

  const c = cfg();
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };

    const conn = hana.createConnection();
    const timer = setTimeout(() => {
      try { conn.disconnect(); } catch { /* already gone */ }
      done({ ok: false, reason: 'TIMEOUT',
        detail: `No response from ${c.host} within ${c.timeoutMs / 1000}s. HANA Cloud allows connections only from addresses on its allowlist — check "Allowed connections" on the instance.` });
    }, c.timeoutMs);

    conn.connect({
      serverNode: `${c.host}:${c.port}`,
      uid: c.user,
      pwd: c.password,
      encrypt: 'true',
      sslValidateCertificate: 'true',
      connectTimeout: String(c.timeoutMs),
      // A schema-plan service key hands out a user whose default schema is the
      // one it was granted. Setting it explicitly means PIE's tables land where
      // they are supposed to even when the user can reach several schemas.
      ...(c.schema ? { currentSchema: c.schema } : {}),
    }, err => {
      clearTimeout(timer);
      if (err) {
        lastError = String(err.message || err).slice(0, 240);
        return done({ ok: false, reason: 'REFUSED', detail: lastError, conn: null });
      }
      done({ ok: true, conn });
    });
  });
}

const exec = (conn, sql, params = []) => new Promise((resolve, reject) => {
  conn.exec(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const close = conn => { try { conn?.disconnect(); } catch { /* nothing to do */ } };

/* ------------------------------------------------------------------ verify */
/**
 * Opens a real connection and runs a real query.
 * This is the only thing that may set the adapter to VERIFIED.
 */
export async function verify() {
  if (!isConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED',
      detail: 'SAP_HANA_HOST, SAP_HANA_USER and SAP_HANA_PASSWORD must all be set.' };
  }
  const c = await connect();
  if (!c.ok) {
    checks.record('sap_hana', { ok: false, detail: c.detail, config: hanaFingerprint() });
    return c;
  }
  try {
    const rows = await exec(c.conn, 'SELECT VERSION AS V, CURRENT_USER AS U FROM SYS.M_DATABASE');
    const version = rows?.[0]?.V || null;
    const user = rows?.[0]?.U || null;
    checks.record('sap_hana', {
      ok: true, detail: `connected to HANA ${version}`, config: hanaFingerprint(),
      meta: { version, user, host: cfg().host },
    });
    lastError = null;
    return { ok: true, version, user, detail: `Connected. HANA ${version}, signed in as ${user}.` };
  } catch (e) {
    lastError = String(e.message || e).slice(0, 240);
    checks.record('sap_hana', { ok: false, detail: lastError, config: hanaFingerprint() });
    return { ok: false, reason: 'QUERY_FAILED', detail: lastError };
  } finally {
    close(c.conn);
  }
}

/* ------------------------------------------------------------------ schema */
const DDL = [
  `CREATE TABLE PIE_AUDIT_EVENT (
     EVENT_ID      NVARCHAR(64)  PRIMARY KEY,
     OCCURRED_AT   TIMESTAMP     NOT NULL,
     ACTOR         NVARCHAR(200),
     ACTOR_ROLE    NVARCHAR(40),
     ACTION        NVARCHAR(80)  NOT NULL,
     SUBJECT_TYPE  NVARCHAR(60),
     SUBJECT_ID    NVARCHAR(64),
     NOTE          NVARCHAR(2000)
   )`,
  `CREATE TABLE PIE_MATCH_RESULT (
     MATCH_ID            NVARCHAR(64) PRIMARY KEY,
     COMPUTED_AT         TIMESTAMP    NOT NULL,
     CANDIDATE_ID        NVARCHAR(64) NOT NULL,
     REQUISITION_ID      NVARCHAR(64),
     MATCH_TIER          NVARCHAR(40),
     SKILLS_FIRST_SCORE  DECIMAL(5,4),
     POTENTIAL_ADJUSTED  DECIMAL(5,4),
     GROWTH_UPLIFT       DECIMAL(5,4),
     GAP_COUNT           INTEGER,
     MODEL_VERSION       NVARCHAR(60)
   )`,
];

/**
 * Creates the two tables if they are absent. Safe to call repeatedly: HANA has
 * no CREATE TABLE IF NOT EXISTS, so an "already exists" error is the success
 * case and is swallowed rather than reported as a fault.
 */
export async function ensureSchema() {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const c = await connect();
  if (!c.ok) return c;

  const created = [];
  const existing = [];
  try {
    for (const sql of DDL) {
      const name = /CREATE TABLE (\w+)/.exec(sql)[1];
      try { await exec(c.conn, sql); created.push(name); }
      catch (e) {
        if (/exists/i.test(String(e.message || ''))) existing.push(name);
        else throw e;
      }
    }
    return { ok: true, created, existing };
  } catch (e) {
    return { ok: false, reason: 'DDL_FAILED', detail: String(e.message || e).slice(0, 240) };
  } finally {
    close(c.conn);
  }
}

/* ------------------------------------------------------------------ writes */
/**
 * Writes one audit event. Never throws, never blocks the caller's request.
 * A failure is reported in the return value and the local store still holds the
 * authoritative copy.
 */
export async function saveAuditEvent(event) {
  if (!isConfigured()) return { ok: false, persistedLocally: true, reason: 'HANA Cloud not configured' };
  const c = await connect();
  if (!c.ok) return { ok: false, persistedLocally: true, reason: c.reason, detail: c.detail };
  try {
    await exec(c.conn,
      `UPSERT PIE_AUDIT_EVENT (EVENT_ID, OCCURRED_AT, ACTOR, ACTOR_ROLE, ACTION, SUBJECT_TYPE, SUBJECT_ID, NOTE)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
      [
        String(event.id || ''),
        new Date(event.at || Date.now()),
        String(event.actor || '').slice(0, 200),
        String(event.actorRole || '').slice(0, 40),
        String(event.action || '').slice(0, 80),
        String(event.subjectType || '').slice(0, 60),
        String(event.subjectId || '').slice(0, 64),
        String(event.note || '').slice(0, 2000),
      ]);
    return { ok: true, persistedLocally: true };
  } catch (e) {
    return { ok: false, persistedLocally: true, reason: 'WRITE_FAILED', detail: String(e.message || e).slice(0, 240) };
  } finally {
    close(c.conn);
  }
}

/** Writes one match result — the enterprise record of a scoring decision. */
export async function saveMatchResult(m) {
  if (!isConfigured()) return { ok: false, persistedLocally: true, reason: 'HANA Cloud not configured' };
  const c = await connect();
  if (!c.ok) return { ok: false, persistedLocally: true, reason: c.reason, detail: c.detail };
  try {
    await exec(c.conn,
      `UPSERT PIE_MATCH_RESULT (MATCH_ID, COMPUTED_AT, CANDIDATE_ID, REQUISITION_ID, MATCH_TIER,
                                SKILLS_FIRST_SCORE, POTENTIAL_ADJUSTED, GROWTH_UPLIFT, GAP_COUNT, MODEL_VERSION)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) WITH PRIMARY KEY`,
      [
        String(m.id || ''),
        new Date(m.at || Date.now()),
        String(m.candidateProfileId || ''),
        String(m.requisitionId || ''),
        String(m.matchTier || ''),
        Number(m.skillsFirstScore ?? 0),
        Number(m.potentialAdjusted ?? 0),
        Number(m.growthUplift ?? 0),
        Number(m.gapCount ?? 0),
        String(m.modelVersion || ''),
      ]);
    return { ok: true, persistedLocally: true };
  } catch (e) {
    return { ok: false, persistedLocally: true, reason: 'WRITE_FAILED', detail: String(e.message || e).slice(0, 240) };
  } finally {
    close(c.conn);
  }
}

/** Row counts, for showing that the enterprise records are really there. */
export async function counts() {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  const c = await connect();
  if (!c.ok) return c;
  try {
    const a = await exec(c.conn, 'SELECT COUNT(*) AS N FROM PIE_AUDIT_EVENT');
    const m = await exec(c.conn, 'SELECT COUNT(*) AS N FROM PIE_MATCH_RESULT');
    return { ok: true, auditEvents: Number(a?.[0]?.N ?? 0), matchResults: Number(m?.[0]?.N ?? 0) };
  } catch (e) {
    return { ok: false, reason: 'QUERY_FAILED', detail: String(e.message || e).slice(0, 240) };
  } finally {
    close(c.conn);
  }
}

/* ------------------------------------------------------------------ status */
export function status() {
  const c = cfg();
  // A durable record of a real connection is what promotes this adapter. Env
  // vars alone prove only that somebody filled in a form.
  const proven = isConfigured() ? checks.read('sap_hana', hanaFingerprint()) : null;
  const when = proven?.ok ? checks.ageOf(proven) : null;

  const state = !isConfigured() ? 'ADAPTER_READY'
    : proven?.ok ? 'CONNECTED'
      : proven ? 'REFUSED' : 'CONFIGURED_UNVERIFIED';

  const detail = {
    ADAPTER_READY: 'Adapter implemented; no HANA Cloud instance configured. PIE’s own store remains the system of record either way.',
    CONFIGURED_UNVERIFIED: `Credentials for ${c.host || 'HANA Cloud'} are present but no connection has been made yet. Run "node tools/hana-test.mjs" to prove it before you need it.`,
    CONNECTED: `${c.host} accepted the connection${when ? ` (checked ${when})` : ''}. PIE writes its audit trail and match results to ${c.schema ? `schema ${c.schema}` : 'this user\u2019s default schema'}.`,
    REFUSED: `${c.host} refused the last connection. ${proven?.detail || ''} PIE’s own store is unaffected.`,
  }[state];

  return {
    key: 'sap_hana_cloud',
    name: 'SAP HANA Cloud',
    state,
    detail,
    classification: state === 'CONNECTED'
      ? 'CONFIRMED — live enterprise record for audit and match data'
      : 'PROPOSED — enterprise persistence for audit and match data',
    limitation: state === 'CONNECTED'
      ? 'PIE’s own store remains the system of record for accounts and evidence. HANA Cloud holds the append-only enterprise records.'
      : undefined,
    requires: 'SAP_HANA_HOST, SAP_HANA_USER, SAP_HANA_PASSWORD (optionally SAP_HANA_PORT, SAP_HANA_SCHEMA)',
    lastError: lastError || null,
  };
}
