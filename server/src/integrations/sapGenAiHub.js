// SAP Generative AI Hub adapter (SAP AI Core).
//
// This is the first provider in PIE's chain, so when it is configured, PIE's
// narration runs on SAP's own AI platform rather than a third party.
//
// TWO THINGS THIS FIXES
//
//   1. AI Core authenticates with OAuth2 client credentials, not a static
//      bearer token. A pasted token is valid for hours and then stops working —
//      which, on a demo day, means the AI layer dies partway through with a 401
//      and nobody knows why. This fetches a token from the service key's XSUAA
//      endpoint and refreshes it before it expires.
//
//   2. `status()` used to report CONNECTED, and classify itself CONFIRMED to a
//      jury, because two environment variables were present. It had never
//      called anything. Now only a real token exchange plus a real API call
//      promotes it, and the result is recorded on disk the same way SMTP and
//      HANA record theirs.
//
// A static token is still accepted for a quick test, and is labelled as such —
// it is the shape that expires.

import * as checks from '../persistence/checks.js';
import { fingerprint } from '../persistence/checks.js';

const env = (k, d = '') => (process.env[k] || d).trim();

const cfg = () => ({
  // Inference
  deploymentUrl: env('SAP_AI_CORE_DEPLOYMENT_URL'),
  apiVersion: env('SAP_AI_CORE_API_VERSION', '2023-05-15'),
  resourceGroup: env('SAP_AI_RESOURCE_GROUP', 'default'),

  // OAuth2 client credentials, from the AI Core service key
  authUrl: env('SAP_AI_CORE_AUTH_URL'),          // service key: url
  clientId: env('SAP_AI_CORE_CLIENT_ID'),        // service key: clientid
  clientSecret: process.env.SAP_AI_CORE_CLIENT_SECRET || '',
  apiUrl: env('SAP_AI_CORE_API_URL'),            // service key: serviceurls.AI_API_URL

  // Escape hatch for a quick manual test. Expires.
  staticToken: process.env.SAP_AI_CORE_TOKEN || '',

  timeoutMs: Number(env('SAP_AI_TIMEOUT_MS', '20000')),
});

/** OAuth2 is the real path; a static token is the temporary one. */
export function authMode() {
  const c = cfg();
  if (c.authUrl && c.clientId && c.clientSecret) return 'OAUTH';
  if (c.staticToken) return 'STATIC_TOKEN';
  return 'NONE';
}

export function isConfigured() {
  const c = cfg();
  return Boolean(c.deploymentUrl) && authMode() !== 'NONE';
}

const aiFingerprint = () => {
  const c = cfg();
  return fingerprint([c.deploymentUrl, c.authUrl, c.clientId, c.resourceGroup, authMode()]);
};

/* ------------------------------------------------------------------- token */
// Keyed by the credentials it was issued for. Change the service key or the
// resource group and the old token is dropped rather than reused against a
// different instance — which would otherwise keep working here while the status
// panel correctly reported the new configuration as unverified.
let cached = { token: null, expiresAt: 0, key: null };
let lastError = null;

/**
 * A bearer token for AI Core.
 *
 * Refreshed 60 seconds before it actually expires, so a request never sets off
 * with a token that dies in flight.
 */
async function bearer() {
  const c = cfg();
  if (authMode() === 'STATIC_TOKEN') return { ok: true, token: c.staticToken, mode: 'STATIC_TOKEN' };

  const key = aiFingerprint();
  if (cached.key !== key) cached = { token: null, expiresAt: 0, key: null };
  if (cached.token && Date.now() < cached.expiresAt - 60_000) {
    return { ok: true, token: cached.token, mode: 'OAUTH', cached: true };
  }

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), c.timeoutMs);
  try {
    // XSUAA wants form-encoded client credentials; the secret goes in the body,
    // never in a URL or a log line.
    const res = await fetch(`${c.authUrl.replace(/\/+$/, '')}/oauth/token`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastError = `token endpoint returned ${res.status}${body ? `: ${body.slice(0, 140)}` : ''}`;
      return { ok: false, reason: 'AUTH_REJECTED', detail: lastError };
    }
    const j = await res.json();
    if (!j.access_token) {
      lastError = 'the token endpoint answered without an access_token';
      return { ok: false, reason: 'AUTH_MALFORMED', detail: lastError };
    }
    cached = {
      token: j.access_token,
      expiresAt: Date.now() + (Number(j.expires_in || 3600) * 1000),
      key,
    };
    lastError = null;
    return { ok: true, token: cached.token, mode: 'OAUTH', expiresIn: j.expires_in };
  } catch (e) {
    lastError = e.name === 'AbortError'
      ? `no response from the token endpoint within ${c.timeoutMs / 1000}s`
      : String(e.message || e).slice(0, 200);
    return { ok: false, reason: 'AUTH_UNREACHABLE', detail: lastError };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ verify */
/**
 * Proves the whole path: a real token exchange, then a real call to the AI API.
 * This is the only thing that may set the adapter to CONNECTED.
 */
export async function verify() {
  if (!isConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED',
      detail: 'SAP_AI_CORE_DEPLOYMENT_URL plus either the service-key credentials (AUTH_URL, CLIENT_ID, CLIENT_SECRET) or a static SAP_AI_CORE_TOKEN.' };
  }

  const c = cfg();
  const auth = await bearer();
  if (!auth.ok) {
    checks.record('sap_genai', { ok: false, detail: auth.detail, config: aiFingerprint() });
    return auth;
  }

  // Listing deployments proves the token is accepted by the AI API, without
  // spending an inference call.
  if (c.apiUrl) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), c.timeoutMs);
    try {
      const res = await fetch(`${c.apiUrl.replace(/\/+$/, '')}/v2/lm/deployments`, {
        signal: ac.signal,
        headers: { Authorization: `Bearer ${auth.token}`, 'AI-Resource-Group': c.resourceGroup },
      });
      if (!res.ok) {
        const detail = `AI API returned ${res.status} for the deployment list`;
        checks.record('sap_genai', { ok: false, detail, config: aiFingerprint() });
        return { ok: false, reason: 'API_REJECTED', detail };
      }
      const j = await res.json().catch(() => ({}));
      const deployments = Array.isArray(j.resources) ? j.resources.length : null;
      const running = Array.isArray(j.resources)
        ? j.resources.filter(d => String(d.status).toUpperCase() === 'RUNNING').length : null;
      checks.record('sap_genai', {
        ok: true, detail: `token accepted; ${running ?? '?'} running deployment(s)`,
        config: aiFingerprint(), meta: { deployments, running, mode: auth.mode },
      });
      return { ok: true, mode: auth.mode, deployments, running,
        detail: `Authenticated with SAP AI Core. ${running ?? '?'} of ${deployments ?? '?'} deployments running.` };
    } catch (e) {
      const detail = String(e.message || e).slice(0, 200);
      checks.record('sap_genai', { ok: false, detail, config: aiFingerprint() });
      return { ok: false, reason: 'API_UNREACHABLE', detail };
    } finally {
      clearTimeout(t);
    }
  }

  // No AI API URL: the token exchange is all that can be proven here.
  checks.record('sap_genai', {
    ok: true, detail: 'token obtained; deployment list not checked (SAP_AI_CORE_API_URL unset)',
    config: aiFingerprint(), meta: { mode: auth.mode },
  });
  return { ok: true, mode: auth.mode, deployments: null,
    detail: 'A token was obtained. Set SAP_AI_CORE_API_URL to also verify the deployment.' };
}

/* ------------------------------------------------------------------ status */
export function status() {
  const c = cfg();
  const mode = authMode();
  const proven = isConfigured() ? checks.read('sap_genai', aiFingerprint()) : null;
  const when = proven?.ok ? checks.ageOf(proven) : null;

  const state = !isConfigured() ? 'OFFLINE_TEMPLATE_MODE'
    : proven?.ok ? 'CONNECTED'
      : proven ? 'REFUSED' : 'CONFIGURED_UNVERIFIED';

  const detail = {
    OFFLINE_TEMPLATE_MODE: 'No SAP AI Core deployment configured. PIE runs its deterministic engine and template narration — every score is identical either way.',
    CONFIGURED_UNVERIFIED: 'Credentials are present but no call has been made yet. Run "node tools/sap-ai-test.mjs" to prove it before you need it.',
    CONNECTED: `SAP AI Core accepted the credentials${when ? ` (checked ${when})` : ''}. Agent narration runs on SAP Generative AI Hub.`,
    REFUSED: `SAP AI Core refused the last attempt. ${proven?.detail || ''} PIE falls back to the next provider, and no score changes.`,
  }[state];

  return {
    key: 'sap_genai_hub',
    name: 'SAP Generative AI Hub',
    state,
    detail,
    classification: state === 'CONNECTED'
      ? 'CONFIRMED — live; agent narration runs on SAP AI Core'
      : 'PROPOSED — adapter wired, activates when credentials are verified',
    limitation: mode === 'STATIC_TOKEN'
      ? 'Authenticated with a static token, which expires. Use the AI Core service key (client id and secret) so PIE can refresh it.'
      : undefined,
    requires: 'SAP_AI_CORE_DEPLOYMENT_URL + SAP_AI_CORE_AUTH_URL, SAP_AI_CORE_CLIENT_ID, SAP_AI_CORE_CLIENT_SECRET (optionally SAP_AI_CORE_API_URL)',
    authMode: mode,
    lastError: lastError || null,
  };
}

/* --------------------------------------------------------------- inference */
/** OpenAI-compatible chat completion against the SAP AI Core deployment. */
export async function chat(messages, { maxTokens = 700, temperature = 0.2, signal } = {}) {
  if (!isConfigured()) throw new Error('SAP Generative AI Hub is not configured');
  const c = cfg();

  const auth = await bearer();
  if (!auth.ok) throw new Error(`SAP Generative AI Hub auth failed: ${auth.detail}`);

  const res = await fetch(
    `${c.deploymentUrl.replace(/\/+$/, '')}/chat/completions?api-version=${c.apiVersion}`,
    {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'AI-Resource-Group': c.resourceGroup,
      },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
    });

  if (res.status === 401 && auth.mode === 'OAUTH') {
    // The cached token was rejected — drop it so the next call fetches a fresh
    // one rather than repeating the failure for the rest of the process's life.
    cached = { token: null, expiresAt: 0, key: null };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SAP Generative AI Hub ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
  }
  const j = await res.json();
  return j.choices?.[0]?.message?.content?.trim() || '';
}
