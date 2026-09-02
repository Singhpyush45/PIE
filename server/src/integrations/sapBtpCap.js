// SAP BTP / CAP service-layer adapter.
// PROPOSED for the enterprise tier. The interface is real; the transport is not
// wired, because no BTP subaccount or CAP service endpoint has been provisioned.

const cfg = () => ({
  baseUrl: process.env.SAP_BTP_CAP_URL || '',
  token: process.env.SAP_BTP_TOKEN || '',
});

export function isConfigured() { const c = cfg(); return Boolean(c.baseUrl && c.token); }

export function status() {
  return {
    key: 'sap_btp_cap',
    name: 'SAP BTP / CAP',
    state: isConfigured() ? 'CONNECTED' : 'ADAPTER_READY',
    detail: isConfigured()
      ? 'Configured against a CAP service on SAP BTP.'
      : 'Adapter interface implemented; no BTP subaccount or CAP endpoint provisioned. PIE Core runs standalone.',
    classification: 'PROPOSED — enterprise service layer for Candidate / Job / Skill / Evidence entities',
    requires: 'SAP_BTP_CAP_URL, SAP_BTP_TOKEN, provisioned CAP service',
  };
}

export async function fetchRequisitions() {
  if (!isConfigured()) return { ok: false, reason: status().detail, data: [] };
  const c = cfg();
  const res = await fetch(`${c.baseUrl.replace(/\/$/, '')}/Requisitions`, {
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`CAP ${res.status}`);
  return { ok: true, data: (await res.json()).value || [] };
}

export async function saveRun(run) {
  if (!isConfigured()) return { ok: false, persistedLocally: true, reason: 'CAP not configured' };
  const c = cfg();
  const res = await fetch(`${c.baseUrl.replace(/\/$/, '')}/OrchestratorRuns`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: run.runId, status: run.status, startedAt: run.startedAt }),
  });
  return { ok: res.ok };
}
