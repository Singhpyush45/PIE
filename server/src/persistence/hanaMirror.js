// PIE — the enterprise-record path into SAP HANA Cloud.
//
// Audit events and match results are written to HANA in the background, on the
// same principle as the Supabase mirror: the local store is authoritative, the
// enterprise database receives a copy, and a failure over there is reported and
// survived rather than propagated into a user request.
//
// Why only these two collections: they are append-only records of what the
// system decided and who did what. Those belong in an enterprise database. The
// accounts and the evidence do not go here, because the Hackfest HANA instance
// has an expiry date and PIE must not lose its users when it passes.

import * as db from '../store.js';
import * as hana from '../integrations/sapHanaRepository.js';

const enabled = () => process.env.SAP_HANA_MIRROR === '1' && hana.isConfigured();

const state = {
  attached: false,
  written: 0,
  failed: 0,
  lastError: null,
  lastErrorAt: null,
  lastWriteAt: null,
};

// One recurring fault produces one line, not one per event.
const warned = new Set();
function report(what, detail) {
  state.failed += 1;
  state.lastError = `${what}: ${String(detail || '').slice(0, 200)}`;
  state.lastErrorAt = new Date().toISOString();
  const key = `${what}:${String(detail || '').slice(0, 60)}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[hana] ${state.lastError}`);
  console.warn('[hana] The local store is unaffected and remains the system of record.');
}

async function push(collection, id) {
  if (!enabled()) return;
  const row = db.findById(collection, id);
  if (!row) return;
  try {
    const r = collection === 'auditEvents'
      ? await hana.saveAuditEvent({ ...row, at: row.ts })
      : await hana.saveMatchResult({ ...row, at: row.ts || row.createdAt, modelVersion: row.modelVersion || null });
    if (r.ok) { state.written += 1; state.lastWriteAt = new Date().toISOString(); }
    else report(collection, r.detail || r.reason);
  } catch (e) {
    report(collection, e.message);
  }
}

/** Subscribes to the store's change feed. Safe to call once at boot. */
export function attach() {
  if (state.attached) return;
  state.attached = true;
  db.onChange((collection, id) => {
    if (collection !== 'auditEvents' && collection !== 'matchResults') return;
    // Fire and forget: a slow enterprise database must never hold up a request.
    push(collection, id).catch(() => {});
  });
}

export function status() {
  const on = enabled();
  return {
    key: 'sap_hana_mirror',
    name: 'SAP HANA enterprise records',
    state: !hana.isConfigured() ? 'NOT_CONFIGURED'
      : !on ? 'OFF'
        : state.lastError ? 'DEGRADED' : 'ON',
    detail: !hana.isConfigured()
      ? 'HANA Cloud is not configured, so nothing is written there.'
      : !on
        ? 'Set SAP_HANA_MIRROR=1 to write the audit trail and match results to HANA Cloud. The local store stays the system of record either way.'
        : `Audit events and match results are written to HANA Cloud in the background. ${state.written} written, ${state.failed} failed.`,
    written: state.written,
    failed: state.failed,
    lastWriteAt: state.lastWriteAt,
    lastError: state.lastError,
  };
}
