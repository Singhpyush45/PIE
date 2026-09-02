// GitHub connection routes — authorize, callback, repository picker, import, disconnect.
//
// The access token lives only in the store, encrypted. No endpoint here returns it,
// and no response contains it. If OAuth is not configured, every route degrades to
// clearly-labelled demo fixtures rather than failing.

import * as db from '../store.js';
import { requireAuth, requireRole, rateLimit, str, bad, sanitize } from '../lib.js';
import { encryptSecret, decryptSecret, fingerprint } from '../secrets.js';
import * as oauth from '../integrations/githubOAuth.js';
import * as fixtures from '../integrations/githubEvidenceAdapter.js';
import { addEvidence } from './candidate.js';

/** The stored connection for a candidate, or null. Never includes the token. */
function connectionFor(profileId) {
  return db.find('githubConnections', c => c.candidateProfileId === profileId) || null;
}

const publicConnection = c => c && ({
  id: c.id, login: c.login, name: c.name, avatarUrl: c.avatarUrl, htmlUrl: c.htmlUrl,
  scopes: c.scopes, connectedAt: c.createdAt, mode: c.mode,
  tokenFingerprint: c.tokenFingerprint,   // proves a token exists; is not the token
});

function tokenFor(profileId) {
  const c = connectionFor(profileId);
  if (!c?.accessTokenEncrypted) return null;
  return decryptSecret(c.accessTokenEncrypted);
}

export function registerGithubRoutes(app) {
  const asCandidate = [requireAuth, requireRole('candidate')];

  /* ---------------------------------------------------------------- status */
  app.get('/api/github/status', requireAuth, (req, res) => {
    const profileId = req.user.candidateProfileId;
    const conn = profileId ? connectionFor(profileId) : null;
    res.json({
      oauth: oauth.status(),
      fixtures: fixtures.status(),
      connection: publicConnection(conn),
      connected: Boolean(conn),
      installUrl: oauth.installUrl(),
    });
  });

  /* ------------------------------------------------------------- authorize */
  app.post('/api/github/authorize', ...asCandidate, rateLimit(20, 60_000), (req, res) => {
    if (!oauth.isConfigured()) {
      return res.status(503).json({
        error: 'GitHub authorization is not configured on this server.',
        code: 'GITHUB_OAUTH_UNCONFIGURED',
        fallback: 'DEMO_FIXTURES',
        recovery: 'You can still import clearly-labelled demo repositories, or add projects manually.',
        requires: oauth.status().requires,
      });
    }
    const state = oauth.issueState(req.user.id);
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'GITHUB_AUTHORIZE_STARTED',
      meta: { candidateProfileId: req.user.candidateProfileId },
      note: `Authorization started. Scopes requested: ${oauth.SCOPES.join(', ')} — read-only.` });
    res.json({ url: oauth.authorizeUrl(state), scopes: oauth.SCOPES,
      permissionStatement: oauth.status().permissionStatement });
  });

  /* -------------------------------------------------------------- callback */
  // GitHub redirects the BROWSER here. We must not render a token, so we finish
  // server-side and redirect back into the app with a status flag only.
  app.get('/api/github/callback', async (req, res) => {
    const back = (ok, reason) =>
      res.redirect(`/?github=${ok ? 'connected' : 'error'}${reason ? `&reason=${encodeURIComponent(reason)}` : ''}`);

    const code = str(req.query?.code, 400);
    const state = str(req.query?.state, 200);
    if (req.query?.error) return back(false, str(req.query.error_description || req.query.error, 200));
    if (!code || !state) return back(false, 'Missing authorization code.');

    const claim = oauth.consumeState(state);
    if (!claim) return back(false, 'This authorization link has expired. Please try again.');

    const user = db.findById('users', claim.userId);
    if (!user?.candidateProfileId) return back(false, 'Account no longer available.');

    try {
      const { accessToken, scope } = await oauth.exchangeCode(code);
      const identity = await oauth.fetchIdentity(accessToken);

      const existing = connectionFor(user.candidateProfileId);
      const row = {
        candidateProfileId: user.candidateProfileId,
        isDemo: Boolean(user.isDemo),
        login: identity.login, githubUserId: identity.id, name: identity.name,
        avatarUrl: identity.avatarUrl, htmlUrl: identity.htmlUrl,
        scopes: scope || oauth.SCOPES.join(','),
        mode: 'REAL',
        accessTokenEncrypted: encryptSecret(accessToken),
        tokenFingerprint: fingerprint(accessToken),
      };
      if (existing) db.update('githubConnections', existing.id, row);
      else db.insert('githubConnections', row);

      db.update('candidateProfiles', user.candidateProfileId, { githubLogin: identity.login });
      db.audit({ actor: user.email, actorRole: 'candidate', action: 'GITHUB_CONNECTED',
        meta: { candidateProfileId: user.candidateProfileId, login: identity.login },
        note: `GitHub account @${identity.login} authorized with read-only scopes. The access token is encrypted at rest and never sent to the browser.` });
      return back(true);
    } catch (e) {
      return back(false, e.message);
    }
  });

  /* ---------------------------------------------------------------- repos */
  app.get('/api/github/repositories', ...asCandidate, rateLimit(40, 60_000), async (req, res) => {
    const profileId = req.user.candidateProfileId;
    const token = tokenFor(profileId);

    if (token) {
      try {
        const repositories = await oauth.fetchRepositories(token);
        const imported = new Set(db.filter('githubRepositories', r => r.candidateProfileId === profileId)
          .map(r => r.fullName || r.name));
        return res.json({
          mode: 'REAL', login: connectionFor(profileId)?.login,
          repositories: repositories.map(r => ({ ...r, imported: imported.has(r.fullName) })),
          notice: 'Read from your authorized GitHub account. PIE can read the repositories you choose and cannot modify your code.',
        });
      } catch (e) {
        return res.status(502).json({ error: e.message, code: 'GITHUB_API_ERROR',
          recovery: 'Reconnect GitHub, or add projects manually — self-reported evidence still counts.' });
      }
    }

    // No real connection: labelled demo fixtures so the flow is demonstrable.
    const username = str(req.query?.username, 60) || 'demo';
    const fetched = await fixtures.fetchRepositories(username, { limit: 8 });
    res.json({
      mode: 'DEMO_FIXTURES', login: null,
      repositories: fetched.repositories.map(r => ({ ...r, fullName: `${username}/${r.name}`, visibility: 'public' })),
      notice: fetched.notice,
      demo: true,
    });
  });

  /* --------------------------------------------------------------- import */
  app.post('/api/github/import', ...asCandidate, rateLimit(30, 60_000), async (req, res) => {
    const profileId = req.user.candidateProfileId;
    const wanted = Array.isArray(req.body?.repositories) ? req.body.repositories.slice(0, 25).map(String) : [];
    if (!wanted.length) return bad(res, 'Select at least one repository to import.');

    const token = tokenFor(profileId);
    const real = Boolean(token);
    let selected = [];
    let mode = real ? 'REAL' : 'DEMO_FIXTURES';

    try {
      if (real) {
        const all = await oauth.fetchRepositories(token);
        selected = all.filter(r => wanted.includes(r.fullName) || wanted.includes(r.name));
        // Deeper signals only for what the candidate explicitly chose.
        for (const r of selected) {
          Object.assign(r, await oauth.enrichRepository(token, r.fullName));
        }
      } else {
        const fetched = await fixtures.fetchRepositories(str(req.body?.username, 60) || 'demo', { limit: 8 });
        mode = fetched.mode;
        selected = fetched.repositories
          .filter(r => wanted.includes(r.name) || wanted.includes(`demo/${r.name}`))
          .map(r => ({ ...r, fullName: `demo/${r.name}`, visibility: 'public' }));
      }
    } catch (e) {
      return res.status(502).json({ error: e.message, code: 'GITHUB_API_ERROR' });
    }

    if (!selected.length) return bad(res, 'None of the selected repositories could be found.');

    const login = real ? connectionFor(profileId).login : (str(req.body?.username, 60) || 'demo');
    const evidenceRows = fixtures.toEvidence(selected, login, mode).map(e => addEvidence(profileId, {
      ...e,
      // Demo fixtures are never presented as real candidate evidence.
      title: mode === 'REAL' ? e.title : `${e.title} (demo repository data)`,
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) }));

    for (const r of selected) {
      const existing = db.find('githubRepositories',
        x => x.candidateProfileId === profileId && (x.fullName === r.fullName || x.name === r.name));
      const row = {
        candidateProfileId: profileId, isDemo: Boolean(req.user.isDemo),
        login, name: r.name, fullName: r.fullName || `${login}/${r.name}`,
        description: r.description, languages: r.languages, visibility: r.visibility || 'public',
        commits: r.commits, monthsActive: r.monthsActive, hasTests: r.hasTests,
        readmeQuality: r.readmeQuality, topics: r.topics, stars: r.stars,
        structure: r.structure, pushedAt: r.pushedAt, importMode: mode,
      };
      if (existing) db.update('githubRepositories', existing.id, row);
      else db.insert('githubRepositories', row);
    }

    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'GITHUB_REPOS_IMPORTED',
      meta: { candidateProfileId: profileId, count: selected.length, mode },
      note: `${selected.length} repository/repositories imported as ${mode === 'REAL' ? 'API-derived' : 'labelled demo'} evidence.` });

    res.status(201).json({
      mode, imported: selected.length, repositories: selected, evidence: evidenceRows,
      caveat: 'Repository activity is supporting evidence for capability. PIE does not treat it as proof of skill.',
    });
  });

  /* ----------------------------------------------------------- disconnect */
  app.post('/api/github/disconnect', ...asCandidate, async (req, res) => {
    const profileId = req.user.candidateProfileId;
    const conn = connectionFor(profileId);
    if (!conn) return res.json({ ok: true, alreadyDisconnected: true });

    const token = tokenFor(profileId);
    let revocation = { revoked: false, reason: 'no token stored' };
    if (token) revocation = await oauth.revokeToken(token);

    // The credential is destroyed regardless of whether GitHub confirmed revocation.
    db.remove('githubConnections', conn.id);
    db.update('candidateProfiles', profileId, { githubLogin: null });

    const keepEvidence = req.body?.deleteEvidence !== true;
    let removed = 0;
    if (!keepEvidence) {
      for (const r of db.filter('githubRepositories', r => r.candidateProfileId === profileId)) {
        db.remove('githubRepositories', r.id); removed += 1;
      }
      for (const e of db.filter('evidence', e => e.candidateProfileId === profileId && e.source === 'github')) {
        db.remove('evidence', e.id); removed += 1;
      }
    }

    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'GITHUB_DISCONNECTED',
      meta: { candidateProfileId: profileId, login: conn.login },
      note: `GitHub disconnected. Stored credential destroyed${revocation.revoked ? ' and revoked at GitHub' : ''}. ${keepEvidence ? 'Imported evidence was retained at the candidate’s choice.' : `${removed} imported record(s) deleted.`}` });

    res.json({
      ok: true, revokedAtGithub: revocation.revoked, evidenceRetained: keepEvidence, removed,
      notice: keepEvidence
        ? 'Your GitHub authorization has been removed and the stored credential destroyed. Previously imported evidence stays on your profile — you can delete individual items from the Evidence Center.'
        : 'Your GitHub authorization and all imported repository evidence have been removed.',
    });
  });
}
