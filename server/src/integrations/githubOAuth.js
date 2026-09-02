// PIE — GitHub authorization (OAuth App / GitHub App web flow).
//
// The candidate clicks [Connect GitHub], authorizes PIE on github.com, and GitHub
// redirects back to PIE's callback. PIE exchanges the code for an access token
// SERVER-SIDE and stores it encrypted. The token is never sent to the browser,
// never logged, never placed in a URL.
//
// Scopes requested: `read:user` only. That is enough to identify the account and
// list its repositories. PIE never requests write access — it cannot modify code.
//
// If no client credentials are configured, `isConfigured()` is false and the
// caller falls back to the clearly-labelled demo repository fixtures.

import crypto from 'node:crypto';

const cfg = () => ({
  clientId: (process.env.GITHUB_CLIENT_ID || '').trim(),
  clientSecret: (process.env.GITHUB_CLIENT_SECRET || '').trim(),
  callbackUrl: (process.env.GITHUB_CALLBACK_URL || '').trim()
    || `http://localhost:${process.env.PORT || 5174}/api/github/callback`,
  api: process.env.GITHUB_API_URL || 'https://api.github.com',
  appSlug: (process.env.GITHUB_APP_SLUG || '').trim(),
});

/** Read-only. PIE never asks for permission to change anything. */
export const SCOPES = ['read:user'];

export function isConfigured() {
  const c = cfg();
  return Boolean(c.clientId && c.clientSecret);
}

export function status() {
  const c = cfg();
  return {
    key: 'github_oauth',
    name: 'GitHub authorization',
    state: isConfigured() ? 'OAUTH_READY' : 'NOT_CONFIGURED',
    mode: isConfigured() ? 'REAL' : 'DEMO_FIXTURES',
    detail: isConfigured()
      ? 'Candidates authorize PIE on github.com. Access tokens are exchanged server-side and stored encrypted.'
      : 'No GitHub OAuth client is configured, so [Connect GitHub] imports clearly-labelled demo repository data instead of a real account.',
    scopes: SCOPES,
    permissionStatement: 'PIE can read the repositories you choose. PIE cannot modify your code.',
    callbackUrl: c.callbackUrl,
    requires: 'GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_CALLBACK_URL',
  };
}

/* ------------------------------------------------------------- state (CSRF) */
// Short-lived, single-use, bound to the signed-in user. Prevents an attacker from
// completing an authorization into someone else's account.
const STATES = new Map();       // state -> { userId, createdAt }
const STATE_TTL_MS = 10 * 60 * 1000;

export function issueState(userId) {
  const state = crypto.randomBytes(24).toString('base64url');
  STATES.set(state, { userId, createdAt: Date.now() });
  for (const [k, v] of STATES) if (Date.now() - v.createdAt > STATE_TTL_MS) STATES.delete(k);
  return state;
}

export function consumeState(state) {
  const row = STATES.get(state);
  if (!row) return null;
  STATES.delete(state);
  if (Date.now() - row.createdAt > STATE_TTL_MS) return null;
  return row;
}

/* ------------------------------------------------------------ authorize URL */
export function authorizeUrl(state) {
  const c = cfg();
  const params = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.callbackUrl,
    scope: SCOPES.join(' '),
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

/** GitHub App installation page — lets the user pick exactly which repos to grant. */
export const installUrl = () => (cfg().appSlug ? `https://github.com/apps/${cfg().appSlug}/installations/new` : null);

/* --------------------------------------------------------- token + identity */
export async function exchangeCode(code) {
  const c = cfg();
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.clientId, client_secret: c.clientSecret,
      code, redirect_uri: c.callbackUrl,
    }),
  });
  if (!res.ok) throw new Error(`GitHub token exchange failed (${res.status})`);
  const j = await res.json();
  if (j.error) throw new Error(j.error_description || j.error);
  if (!j.access_token) throw new Error('GitHub did not return an access token.');
  return { accessToken: j.access_token, scope: j.scope || '', tokenType: j.token_type || 'bearer' };
}

async function gh(token, path) {
  const res = await fetch(`${cfg().api}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 401) throw new Error('GitHub rejected the stored authorization. Please reconnect.');
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

export async function fetchIdentity(token) {
  const u = await gh(token, '/user');
  return {
    login: u.login, id: u.id, name: u.name || null,
    avatarUrl: u.avatar_url || null, htmlUrl: u.html_url || null,
    publicRepos: u.public_repos ?? null,
  };
}

export async function fetchRepositories(token, { limit = 60 } = {}) {
  const raw = await gh(token, `/user/repos?per_page=${Math.min(limit, 100)}&sort=pushed&affiliation=owner,collaborator`);
  return raw.filter(r => !r.fork).map(r => ({
    name: r.name, fullName: r.full_name,
    description: r.description || '',
    language: r.language || null,
    languages: [r.language].filter(Boolean),
    visibility: r.private ? 'private' : 'public',
    stars: r.stargazers_count, forks: r.forks_count,
    pushedAt: (r.pushed_at || '').slice(0, 10),
    updatedAt: (r.updated_at || '').slice(0, 10),
    monthsActive: monthsBetween(r.created_at, r.pushed_at),
    commits: null, hasTests: null, hasReadme: null, readmeQuality: null,
    topics: r.topics || [], structure: null,
  }));
}

/** Deeper signals for the repositories the candidate actually selected. */
export async function enrichRepository(token, fullName) {
  const out = { languages: null, hasReadme: null, readmeQuality: null, hasTests: null, structure: null, commits: null };
  try {
    const langs = await gh(token, `/repos/${fullName}/languages`);
    out.languages = Object.keys(langs).slice(0, 6);
  } catch { /* language endpoint is optional */ }
  try {
    const tree = await gh(token, `/repos/${fullName}/contents`);
    const names = Array.isArray(tree) ? tree.map(f => f.name) : [];
    out.structure = names.slice(0, 12);
    out.hasReadme = names.some(n => /^readme/i.test(n));
    out.hasTests = names.some(n => /^(tests?|spec|__tests__)$/i.test(n));
  } catch { /* contents may be unavailable on some repositories */ }
  try {
    const readme = await gh(token, `/repos/${fullName}/readme`);
    const size = readme?.size || 0;
    out.readmeQuality = size > 3000 ? 'high' : size > 700 ? 'medium' : 'low';
  } catch { /* no README is a signal in itself, not an error */ }
  return out;
}

/** Best-effort revocation. GitHub OAuth Apps support token deletion. */
export async function revokeToken(token) {
  const c = cfg();
  if (!isConfigured()) return { revoked: false, reason: 'not configured' };
  try {
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
    const res = await fetch(`${c.api}/applications/${c.clientId}/token`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    return { revoked: res.status === 204, status: res.status };
  } catch (e) {
    return { revoked: false, reason: e.message };
  }
}

function monthsBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30)));
}
