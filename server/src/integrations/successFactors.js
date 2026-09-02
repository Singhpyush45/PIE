// SAP SuccessFactors / Talent Intelligence Hub adapter.
// FUTURE INTEGRATION. Interface only — requesting a requisition feed or publishing a
// capability signal both require an SF tenant, OAuth client and validated API scopes
// that this team does not have. Nothing here fabricates a response.

const cfg = () => ({
  apiUrl: process.env.SF_API_URL || '',
  companyId: process.env.SF_COMPANY_ID || '',
  token: process.env.SF_TOKEN || '',
});

export function isConfigured() { const c = cfg(); return Boolean(c.apiUrl && c.companyId && c.token); }

export function status() {
  return {
    key: 'sap_successfactors',
    name: 'SAP SuccessFactors / Talent Intelligence Hub',
    state: isConfigured() ? 'CONNECTED' : 'FUTURE_INTEGRATION',
    detail: 'Inbound: requisitions from SuccessFactors into PIE matching. Outbound: PIE capability signal and growth readiness back to the talent workflow. Not implemented — requires an SF tenant and validated API scopes.',
    classification: 'FUTURE — requires SAP documentation and tenant validation',
    requires: 'SF_API_URL, SF_COMPANY_ID, SF_TOKEN',
  };
}

export async function fetchRequisitions() {
  return { ok: false, data: [], reason: status().detail };
}
export async function publishCapabilitySignal() {
  return { ok: false, reason: status().detail };
}
