// SAP Analytics Cloud / Business Data Cloud adapter.
// Defined as the analytics integration point for cohort placement-readiness
// reporting. Not wired; PIE renders its own analytics in the meantime.

export function isConfigured() { return Boolean(process.env.SAC_TENANT_URL && process.env.SAC_TOKEN); }

export function status() {
  return {
    key: 'sap_analytics_cloud',
    name: 'SAP Analytics Cloud / Business Data Cloud',
    state: isConfigured() ? 'CONNECTED' : 'ANALYTICS_INTEGRATION_POINT',
    detail: 'Intended destination for cohort-level placement-readiness and skill-gap analytics for colleges and enterprise HR. PIE currently renders these in-app.',
    classification: 'RECOMMENDED — analytics tier',
    requires: 'SAC_TENANT_URL, SAC_TOKEN',
  };
}
