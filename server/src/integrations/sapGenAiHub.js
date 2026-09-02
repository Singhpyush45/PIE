// SAP Generative AI Hub adapter.
// Talks to an SAP AI Core deployment exposing an OpenAI-compatible chat-completions
// endpoint. NOTHING here is defaulted or invented: with no deployment URL and token
// configured, the adapter reports OFFLINE and the caller falls back to templates.

const cfg = () => ({
  deploymentUrl: process.env.SAP_AI_CORE_DEPLOYMENT_URL || '',
  token: process.env.SAP_AI_CORE_TOKEN || '',
  resourceGroup: process.env.SAP_AI_RESOURCE_GROUP || 'default',
  apiVersion: process.env.SAP_AI_CORE_API_VERSION || '2023-05-15',
});

export function isConfigured() {
  const c = cfg();
  return Boolean(c.deploymentUrl && c.token);
}

export function status() {
  return {
    key: 'sap_genai_hub',
    name: 'SAP Generative AI Hub',
    state: isConfigured() ? 'CONNECTED' : 'OFFLINE_TEMPLATE_MODE',
    detail: isConfigured()
      ? 'Configured against an SAP AI Core deployment. Used for agent narration and structured reasoning.'
      : 'No SAP AI Core deployment URL or token configured. PIE runs its deterministic engine and template narration.',
    classification: 'CONFIRMED — wired, activates when credentials are present',
    requires: 'SAP_AI_CORE_DEPLOYMENT_URL, SAP_AI_CORE_TOKEN',
  };
}

/** OpenAI-compatible chat completion against the SAP AI Core deployment. */
export async function chat(messages, { maxTokens = 700, temperature = 0.2, signal } = {}) {
  if (!isConfigured()) throw new Error('SAP Generative AI Hub is not configured');
  const c = cfg();
  const res = await fetch(
    `${c.deploymentUrl.replace(/\/$/, '')}/chat/completions?api-version=${c.apiVersion}`,
    {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.token}`,
        'AI-Resource-Group': c.resourceGroup,
      },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
    });
  if (!res.ok) throw new Error(`SAP Generative AI Hub ${res.status}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}
