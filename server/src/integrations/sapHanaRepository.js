// SAP HANA Cloud repository adapter.
// PROPOSED as the enterprise system of record. Until a HANA Cloud instance exists,
// PIE's JSON store is the system of record and this adapter reports that plainly.

const cfg = () => ({
  host: process.env.SAP_HANA_HOST || '',
  user: process.env.SAP_HANA_USER || '',
  password: process.env.SAP_HANA_PASSWORD || '',
});

export function isConfigured() { const c = cfg(); return Boolean(c.host && c.user && c.password); }

export function status() {
  return {
    key: 'sap_hana_cloud',
    name: 'SAP HANA Cloud',
    state: isConfigured() ? 'CONNECTED' : 'ADAPTER_READY',
    detail: isConfigured()
      ? 'Configured as the enterprise system of record.'
      : 'Adapter interface implemented; no HANA Cloud instance provisioned. PIE’s server-side JSON store is the system of record for this demo.',
    classification: 'PROPOSED — enterprise persistence for evidence, matches and audit data',
    requires: 'SAP_HANA_HOST, SAP_HANA_USER, SAP_HANA_PASSWORD',
  };
}

export async function saveAuditEvent(event) {
  if (!isConfigured()) return { ok: false, persistedLocally: true, reason: 'HANA Cloud not configured' };
  return { ok: false, persistedLocally: true, reason: 'Write path requires a provisioned HANA Cloud schema' };
}
