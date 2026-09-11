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
import * as corsair from '../integrations/corsair.js';
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

  /* --------------------------------------------------------------- corsair */
  // A second, optional way for a candidate to authorise GitHub: Corsair Hub
  // runs the OAuth handshake and the resulting credential is stored in PIE's
  // own database, encrypted. PIE's first-party OAuth route above is unchanged
  // and still takes precedence — this is an addition, not a replacement.
  //
  // Every response here is a state, never a credential.

  app.get('/api/github/corsair', ...asCandidate, async (req, res) => {
    const tenantId = corsair.tenantFor(req.user);
    if (!corsair.isConfigured()) {
      return res.json({ available: false, connected: false,
        notice: 'Corsair is not configured on this server. Use "Connect GitHub" above, or add projects manually.' });
    }
    const r = await corsair.connectionStatus({ tenantId });
    const state = r.ok ? (r.data?.github || 'not_connected') : 'not_connected';
    res.json({
      available: true,
      connected: state === 'connected',
      state,
      // Said plainly, because it is the thing a candidate is being asked to
      // trust, and it is enforced rather than promised.
      guarantee: 'PIE reads your repository metadata. It cannot write to your GitHub — no commits, '
        + 'issues, stars or forks — and you can disconnect at any time.',
      // Not buried. The connect screen above asks for consent, and consent to
      // something broader than it looks is not consent.
      scopeNotice: 'Corsair\'s GitHub app asks for the repo, user and read:org scopes, which is more '
        + 'access than PIE uses. PIE\'s own "Connect GitHub" asks for read:user only — prefer it if '
        + 'you would rather grant less.',
      // Sent whether or not Gmail is configured, because the candidate needs it
      // BEFORE they press Connect Gmail, not after the consent screen has
      // already listed four scopes they were not expecting.
      gmailScopeNotice: corsair.GMAIL_SCOPE_NOTICE,
      ...(r.ok ? {} : { detail: r.detail || null }),
    });
  });

  // Which plugins a candidate may connect. An allowlist rather than a
  // pass-through: `plugin` arrives from the browser, and Corsair would happily
  // issue a link for anything the server has configured.
  const CONNECTABLE = ['github', 'gmail'];

  app.post('/api/github/corsair/connect', ...asCandidate, rateLimit(10, 60_000), async (req, res) => {
    const plugin = CONNECTABLE.includes(req.body?.plugin) ? req.body.plugin : 'github';
    const r = await corsair.connectLink({ tenantId: corsair.tenantFor(req.user), plugin });
    if (!r.ok) {
      return res.status(r.reason === 'NOT_CONFIGURED' ? 409 : 502).json({
        error: r.detail || 'A Corsair connect link could not be created.', code: r.reason,
        recovery: 'Use "Connect GitHub" instead, or add projects manually — self-reported evidence still counts.',
      });
    }
    db.audit({ actorId: req.user.id, action: 'github.corsair.connect_link',
      subjectType: 'candidateProfile', subjectId: req.user.candidateProfileId,
      meta: { plugin },
      note: `A Corsair Hub connect link was issued for ${plugin}. No credential exists until the candidate completes it.` });
    res.json({ connectUrl: r.connectUrl, expiresAt: r.expiresAt });
  });

  app.post('/api/github/corsair/disconnect', ...asCandidate, async (req, res) => {
    const plugin = CONNECTABLE.includes(req.body?.plugin) ? req.body.plugin : 'github';
    const r = await corsair.disconnect({ tenantId: corsair.tenantFor(req.user), plugin });
    db.audit({ actorId: req.user.id, action: 'github.corsair.disconnect',
      subjectType: 'candidateProfile', subjectId: req.user.candidateProfileId,
      note: r.ok ? 'The stored Corsair GitHub authorisation was removed.' : `Disconnect refused: ${r.reason}` });
    res.json({ ok: Boolean(r.ok), ...(r.ok ? {} : { detail: r.detail || null }) });
  });

  /* ------------------------------------------------------------------ scout */
  /**
   * Runs the Evidence Scout across whatever this candidate has connected.
   *
   * Candidate-initiated on purpose. A recruiter-triggered sweep of somebody's
   * repositories and inbox is a different product with a different consent
   * story; here the person whose accounts these are asks for the look, and the
   * whole call log comes back to them.
   *
   * Slow by nature — up to eight live calls — so it is rate limited hard and
   * returns the log rather than streaming.
   */
  app.post('/api/github/corsair/scout', ...asCandidate, rateLimit(6, 60_000), async (req, res) => {
    const tenantId = corsair.tenantFor(req.user);

    if (!corsair.isConfigured()) {
      return res.status(409).json({
        error: 'Corsair is not configured on this server, so there is nothing for the Scout to read.',
        code: 'NOT_CONFIGURED',
        recovery: 'Import repositories manually — self-reported evidence still counts.',
      });
    }

    // Only look at what this candidate has actually authorised. Asking Corsair
    // first also means the run reports "you have not connected anything" instead
    // of eight identical failures.
    const status = await corsair.connectionStatus({ tenantId });
    const connected = status.ok
      ? Object.entries(status.data || {}).filter(([, v]) => v === 'connected').map(([k]) => k)
      : [];

    const login = str(req.body?.login, 60)
      || connectionFor(req.user.candidateProfileId)?.login
      || null;

    const targetSkills = Array.isArray(req.body?.targetSkills)
      ? req.body.targetSkills.slice(0, 12).map(s => str(s, 40)).filter(Boolean)
      : [];

    const result = await corsair.scout({ tenantId, login, targetSkills, connected });

    db.audit({
      actorId: req.user.id, action: 'evidence.scout',
      subjectType: 'candidateProfile', subjectId: req.user.candidateProfileId,
      meta: { mode: result.mode, calls: result.callLog.length, connected },
      note: `Evidence Scout ran in ${result.mode} mode: ${result.callLog.filter(c => c.ok).length} `
        + `successful call(s) across ${connected.join(', ') || 'nothing'}. Every call is in the log.`,
    });

    res.json({ ...result, connected });
  });

  /* --------------------------------------------------- sync + knowledge base */

  /** Copies this candidate's repositories into Corsair's database. */
  app.post('/api/github/corsair/sync', ...asCandidate, rateLimit(6, 60_000), async (req, res) => {
    const tenantId = corsair.tenantFor(req.user);
    const login = str(req.body?.login, 60)
      || connectionFor(req.user.candidateProfileId)?.login || null;

    const r = await corsair.syncGithub({ tenantId, login });
    if (!r.ok) {
      return res.status(r.reason === 'NOT_CONFIGURED' ? 409 : 502).json({
        error: r.detail || 'The sync could not run.', code: r.reason,
        recovery: 'Connect GitHub first, or import repositories manually.',
      });
    }
    db.audit({ actorId: req.user.id, action: 'evidence.corsair_sync',
      subjectType: 'candidateProfile', subjectId: req.user.candidateProfileId,
      meta: { synced: r.synced, source: r.source },
      note: `${r.synced} repositories copied into Corsair's entity store from ${r.source}.` });
    res.json(r);
  });

  /** How many rows this candidate has synced. Cheap; called on page load. */
  app.get('/api/github/corsair/sync', ...asCandidate, async (req, res) => {
    res.json(await corsair.syncStatus({ tenantId: corsair.tenantFor(req.user) }));
  });

  /**
   * Asks a question of the synced rows.
   *
   * Candidate-scoped, like the Scout. The question is answered ONLY from what
   * has been synced — no live call, and nothing outside those rows. The response
   * carries its own provenance line rather than leaving the reader to assume.
   */
  app.post('/api/github/corsair/ask', ...asCandidate, rateLimit(20, 60_000), async (req, res) => {
    const question = str(req.body?.question, 300);
    if (!question) return bad(res, 'Ask a question about the synced repositories.');

    const { ask } = await import('../ai/knowledgeBase.js');
    const r = await ask({ tenantId: corsair.tenantFor(req.user), question });

    db.audit({ actorId: req.user.id, action: 'evidence.knowledge_query',
      subjectType: 'candidateProfile', subjectId: req.user.candidateProfileId,
      meta: { mode: r.mode, rows: r.rows ?? 0, matches: r.matches?.length ?? 0 },
      note: `Knowledge base query over ${r.rows ?? 0} synced row(s): ${r.matches?.length ?? 0} match(es). `
        + `Answered from Corsair's database only.` });

    res.json(r);
  });

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

      // Hand the same token to Corsair, so one authorisation serves both paths.
      //
      // The candidate consented once, to PIE, for read:user. Corsair then gives
      // PIE the tenant-scoped read layer, the synced-data side and the Evidence
      // Scout's tools over exactly that grant — no second consent screen, no
      // second token, and no Hub round trip that would need a tunnel to come
      // back to a laptop.
      //
      // Best-effort on purpose. If Corsair is unconfigured or unreachable, the
      // candidate's GitHub connection has still succeeded and everything that
      // worked before still works; only the Corsair-powered extras are absent.
      // A failure here must never turn a successful authorisation into an error
      // page the candidate cannot act on.
      let corsairLinked = false;
      if (corsair.isConfigured()) {
        const linked = await corsair.linkGithubToken({
          tenantId: corsair.tenantFor({ ...user, candidateProfileId: user.candidateProfileId }),
          token: accessToken,
          login: identity.login,
          scopes: scope || oauth.SCOPES.join(','),
        });
        corsairLinked = Boolean(linked.ok);
        if (!linked.ok) {
          console.warn(`[corsair] could not link @${identity.login}'s token: ${linked.reason}`);
        }
      }

      db.audit({ actor: user.email, actorRole: 'candidate', action: 'GITHUB_CONNECTED',
        meta: { candidateProfileId: user.candidateProfileId, login: identity.login, corsairLinked },
        note: `GitHub account @${identity.login} authorized with read-only scopes. The access token is `
          + `encrypted at rest and never sent to the browser.`
          + (corsairLinked
            ? ' The same grant was linked to this candidate\'s Corsair tenant, so evidence can be read '
              + 'through Corsair without a second authorisation.'
            : '') });
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

    // No PIE OAuth connection. Corsair next, if this candidate has authorised
    // through it; labelled demo fixtures otherwise, so the flow is demonstrable
    // on a bad conference network.
    const username = str(req.query?.username, 60) || 'demo';
    const fetched = await fixtures.fetchRepositories(username, {
      limit: 8, tenantId: corsair.tenantFor(req.user),
    });
    const viaCorsair = fetched.mode === 'CORSAIR';
    res.json({
      mode: viaCorsair ? 'CORSAIR' : 'DEMO_FIXTURES', login: viaCorsair ? username : null,
      repositories: fetched.repositories.map(r => ({
        ...r, fullName: r.fullName || `${username}/${r.name}`, visibility: r.visibility || 'public',
      })),
      notice: fetched.notice,
      demo: !viaCorsair,
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
        const fetched = await fixtures.fetchRepositories(str(req.body?.username, 60) || 'demo', {
          limit: 8, tenantId: corsair.tenantFor(req.user),
        });
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
