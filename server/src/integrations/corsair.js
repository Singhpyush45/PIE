// PIE — Corsair integration adapter.
//
// WHAT CORSAIR DOES FOR PIE
//   PIE's whole claim is "potential over pedigree", and that claim only holds up
//   if PIE can see what a candidate has actually built. The hard part has never
//   been the reasoning — it is the plumbing. OAuth per service, tokens to store
//   and refresh, rate limits, a different client for every API. PIE already
//   carries a hand-rolled version of all of that for GitHub alone.
//
//   Corsair replaces it with one shape, per candidate:
//       corsair.withTenant(t).github.db.<group>.<method>()    synced rows, local read
//       corsair.withTenant(t).github.api.<group>.<method>()   the live call
//
//   The db side matters for PIE specifically. Evidence gathering is read-heavy
//   and bursty — a recruiter opens a candidate and PIE wants repositories,
//   languages, commits and activity at once. Against the live API that is a
//   fan-out and a rate limit waiting to happen; against synced rows it is a
//   query against PIE's own Postgres.
//
// WHAT THIS ADAPTER PROMISES
//   Nothing it has not proven. `status()` returns CONNECTED only after a real
//   call has come back — having the environment variables set is never enough,
//   and `verify()` is what makes a real call. That is the same rule every other
//   adapter in PIE follows, and it is why the Integrations screen can be
//   believed at all.
//
//   The earlier version of this file failed that rule in the worst possible
//   way: it was written against a REST API that does not exist, so `verify()`
//   would have reported a network failure for an integration that was actually
//   fine, and no amount of correct configuration could have turned it green.
//   The lesson is not "read the docs" — it is that an adapter which cannot
//   succeed and an adapter which cannot fail are the same bug.
//
// WHAT IT DOES NOT DO
//   It does not replace PIE's existing GitHub path. When Corsair is configured
//   and the candidate has connected, PIE prefers it and says so; otherwise the
//   OAuth adapter and the labelled demo fixtures still work and the product is
//   unchanged. An integration that has to be present for the demo to run is a
//   single point of failure.
//
//   It also cannot write. See corsairClient.js — read-only is enforced twice,
//   by plugin policy and by an enclosing runReadonly scope.

import * as checks from '../persistence/checks.js';
import { fingerprint } from '../persistence/checks.js';
import * as store from '../store.js';
import * as sdk from './corsairClient.js';

export const envNames = sdk.envNames;
export const tenantFor = sdk.tenantFor;
export const isConfigured = sdk.isConfigured;

let lastError = null;

/**
 * Identifies the configuration a proof belongs to, so a recorded success cannot
 * outlive the credentials that earned it.
 *
 * The WHOLE of each value goes in, not a prefix. The first version took
 * `apiKey.slice(0, 12)` on the theory that less of a secret in a hash input is
 * safer — which is backwards twice over. `fingerprint()` is a truncated SHA-256
 * and is not reversible, so a prefix buys no safety; and Corsair keys share a
 * long fixed prefix (`ck_dev_`, `ck_live_`), so twelve characters is mostly
 * constant. A test rotated a key and the panel kept showing the old verdict,
 * because as far as this function could see nothing had changed.
 *
 * The KEK is included too: change it and every stored authorisation becomes
 * undecryptable, which is a different integration whatever the key says.
 */
const corsairFingerprint = () => {
  const c = sdk.config();
  return fingerprint(['corsair-sdk', c.apiKey, c.kek, c.databaseUrl]);
};

/* -------------------------------------------------------------------- calls */

/**
 * Runs an SDK call and turns every failure into a result object.
 *
 * An integration failure must never reach a candidate as a 500 while they are
 * importing their own repositories. PIE falls back, and says which source it
 * used.
 */
async function attempt(label, fn) {
  try {
    const data = await fn();
    lastError = null;
    return { ok: true, data };
  } catch (e) {
    const name = e?.name || '';
    const msg = String(e?.message || e).slice(0, 200);

    // "The candidate has not authorised GitHub yet" is an ordinary state, not a
    // fault, and must not be recorded as one — otherwise every unconnected
    // candidate would turn the Integrations panel red.
    if (/AuthMissing/i.test(name) || /no credential|not connected|missing credential/i.test(msg)) {
      return { ok: false, reason: 'NOT_CONNECTED', detail: 'This candidate has not connected GitHub through Corsair yet.' };
    }
    if (/ReconnectRequired/i.test(name)) {
      return { ok: false, reason: 'RECONNECT_REQUIRED', detail: 'The stored GitHub authorisation is no longer usable. The candidate needs to reconnect.' };
    }
    if (/ReadonlyForbidden/i.test(name)) {
      // This is PIE calling a write endpoint by mistake. It is a bug in PIE, and
      // it is supposed to be loud.
      lastError = `Corsair refused a write from ${label}: PIE runs read-only.`;
      return { ok: false, reason: 'READONLY_VIOLATION', detail: lastError };
    }
    lastError = `Corsair ${label}: ${msg}`;
    return { ok: false, reason: 'FAILED', detail: lastError };
  }
}

/* ------------------------------------------------------------------ verify */

/**
 * Proves the integration by doing something that cannot succeed unless it is
 * genuinely working, and records the result so the running server — and the
 * next one — knows without being asked again.
 *
 * The proof is `manage.tenants.list()`, and choosing it took one deliberate
 * correction. The obvious candidate was `manage.plugins.list()` — it names the
 * plugins, so it reads like a health check. It is not one: it answers out of
 * the in-process plugin configuration and returns a confident, fully-populated
 * result against a database that does not exist. A test pointed this adapter at
 * an unreachable Postgres and `verify()` said CONNECTED. That is precisely the
 * failure this file's header describes, reintroduced in the function whose only
 * job is to prevent it.
 *
 * `tenants.list()` reads corsair_accounts. It cannot answer without the
 * connection string reaching the database and the corsair_* tables existing, so
 * a green result establishes all three of: the SDK constructed under this KEK,
 * the database is reachable, and migration 004 has been run. Those are the
 * three realistic failures, and each one fails this call.
 *
 * The plugin list is still reported — it is genuinely useful — but as
 * information alongside the proof, never as the proof.
 *
 * It deliberately does NOT prove Corsair Hub is reachable, because nothing PIE
 * can do at boot proves that without creating a connect session. Hub is proven
 * the first time a candidate actually connects, and `connectLink()` records it.
 */
export async function verify() {
  if (!isConfigured()) {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      detail: `Not configured. Set ${sdk.missing().join(', ')} in server/.env. `
        + 'PIE gathers GitHub evidence through its own adapter until then.',
    };
  }
  const m = await sdk.manage();
  if (!m) {
    const detail = sdk.lastError() || 'The Corsair client could not be constructed.';
    checks.record('corsair', { ok: false, detail, config: corsairFingerprint() });
    return { ok: false, reason: 'CLIENT_FAILED', detail };
  }

  // The proof. Reads corsair_accounts — impossible to answer without a working
  // database and migration 004.
  const r = await attempt('manage.tenants.list', () => m.tenants.list());
  const config = corsairFingerprint();

  if (!r.ok) {
    checks.record('corsair', { ok: false, detail: r.detail, config });
    return r;
  }

  // Only now, having established the database is real, is it worth reporting
  // what is configured on top of it.
  const listed = await attempt('manage.plugins.list', () => m.plugins.list());
  const plugins = (listed.data || []).map(p => p?.id).filter(Boolean);
  const unconfigured = (listed.data || []).filter(p => p && p.configured === false).map(p => p.id);
  const tenants = Array.isArray(r.data) ? r.data.length : 0;

  const detail = `Corsair is live against PIE's database — corsair_accounts read, ${tenants} tenant(s). `
    + `${plugins.length} plugin(s): ${plugins.join(', ') || 'none'}.`
    + (unconfigured.length ? ` Awaiting credentials: ${unconfigured.join(', ')}.` : '');

  checks.record('corsair', { ok: true, detail, config, meta: { plugins, unconfigured, tenants } });
  return { ok: true, plugins, unconfigured, tenants, detail };
}

/* ------------------------------------------------------------------ status */

/** Never returns a key, a secret or a connection string. States and counts only. */
export function status() {
  const configured = isConfigured();
  const gaps = sdk.missing();
  const proven = configured ? checks.read('corsair', corsairFingerprint()) : null;
  const when = proven?.ok ? checks.ageOf(proven) : null;

  const state = !configured ? 'NOT_CONFIGURED'
    : proven?.ok ? 'CONNECTED'
      : proven ? 'REFUSED' : 'CONFIGURED_UNVERIFIED';

  return {
    key: 'corsair',
    name: 'Corsair',
    state,
    detail: {
      NOT_CONFIGURED: `Not configured (${gaps.join(', ')} not set). PIE gathers GitHub evidence through its own `
        + 'OAuth adapter, which is unchanged and fully working.',
      CONFIGURED_UNVERIFIED: 'Configured, but no call has been made yet. Run "node tools/corsair-test.mjs" '
        + 'to prove it before you need it — a key in .env is not a working integration.',
      CONNECTED: `${proven?.detail || 'Corsair is live.'}${when ? ` (checked ${when})` : ''}`,
      REFUSED: `The last attempt failed. ${proven?.detail || ''} PIE falls back to its own GitHub adapter, `
        + 'and no evidence or score changes.',
    }[state],
    classification: state === 'CONNECTED'
      ? 'CONFIRMED — live; candidate evidence is read through Corsair'
      : 'PROPOSED — SDK wired, activates once the configuration is proven',
    plugins: proven?.ok ? (proven.meta?.plugins || []) : [],
    // The claims worth stating explicitly, because they are the ones a
    // candidate would care about and the ones easiest to overclaim.
    guarantees: [
      'Read-only, enforced in software: the plugin is configured mode: readonly, and every call '
        + 'PIE makes runs inside the SDK\'s runReadonly scope, which throws on any write endpoint. '
        + 'PIE cannot commit, open issues, star or fork on a candidate\'s behalf.',
      'Credentials stay in PIE\'s own Postgres, encrypted under CORSAIR_KEK. Corsair Hub runs the '
        + 'OAuth handshake; it does not hold the resulting token.',
    ],
    // Stated because it is the honest limit of the sentence above, and because
    // a candidate reading "PIE cannot write" deserves to know the difference
    // between "the token cannot" and "the code will not".
    limitation: 'Corsair\'s managed GitHub app requests the repo, user and read:org scopes, so the '
      + 'token itself is broader than PIE\'s use of it. The read-only guarantee is enforced by PIE\'s '
      + 'code and the SDK\'s policy layer, not by the scope of the token. A candidate who wants the '
      + 'narrower guarantee should use PIE\'s own "Connect GitHub", which requests read:user only.',
    requires: Object.values(sdk.envNames).join(', '),
    missing: gaps,
    lastError: lastError || sdk.lastError() || null,
  };
}

/* --------------------------------------------------------------- connecting */

/**
 * A URL the candidate visits to authorise GitHub.
 *
 * This is the one call that genuinely reaches Corsair Hub, so a success here is
 * recorded as a Hub proof — it is the only honest one PIE can obtain.
 */
export async function connectLink({ tenantId, plugin = 'github' } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED', detail: 'Corsair is not configured.' };
  if (!tenantId) return { ok: false, reason: 'NO_TENANT', detail: 'A candidate is required.' };
  const m = await sdk.manage();
  if (!m) return { ok: false, reason: 'CLIENT_FAILED', detail: sdk.lastError() || 'The Corsair client is unavailable.' };

  // Gmail is bring-your-own: Corsair lends PIE its GitHub app but has no Google
  // one, so the client id and secret have to be in Corsair's key store before a
  // connect link can be issued at all.
  //
  // `ensureGmailKeys()` used to be called only from `scout()` — that is, only
  // once a candidate had already connected. Which they could not do, because
  // the link could not be issued, because the keys were not there. The error
  // said `BYO credentials not configured for 'gmail'` and pointed at Corsair,
  // where everything was in fact fine.
  //
  // It is idempotent and costs one round trip the first time per process.
  if (plugin === 'gmail') {
    const keys = await sdk.ensureGmailKeys();
    if (!keys.ok && keys.reason === 'NOT_CONFIGURED') {
      return {
        ok: false,
        reason: 'GMAIL_NOT_CONFIGURED',
        // The two REQUIRED names. GMAIL_REDIRECT_URL is also in gmailEnvNames
        // and is optional — naming it here would send someone to set a variable
        // that is better left unset.
        detail: `Gmail needs ${sdk.gmailEnvNames.CLIENT_ID} and ${sdk.gmailEnvNames.CLIENT_SECRET} in server/.env. `
          + 'See GMAIL_SETUP.md — it is a Google Cloud OAuth client, not a Corsair setting.',
      };
    }
    if (!keys.ok) {
      return { ok: false, reason: 'GMAIL_KEYS_FAILED',
        detail: keys.detail || 'The Google client could not be stored in Corsair.' };
    }
  }

  const r = await attempt('manage.connect.createLink', () => m.connect.createLink({ plugin, tenantId }));
  if (!r.ok) return r;

  checks.record('corsair-hub', {
    ok: true,
    detail: 'Corsair Hub issued a connect link.',
    config: corsairFingerprint(),
  });
  return { ok: true, connectUrl: r.data?.connectUrl, expiresAt: r.data?.expiresAt || null };
}

/**
 * What Google will actually ask for when a candidate connects Gmail.
 *
 * This is not what PIE uses, and the difference is the whole point of saying it.
 *
 * `@corsair-dev/gmail` hard-codes its OAuth scopes — gmail.modify, gmail.labels,
 * gmail.send, gmail.compose. `gmail.readonly` is not among them, and
 * `permissions: { mode: 'readonly' }` does not narrow them: that option governs
 * which SDK operations are allowed to run, not what the consent screen asks the
 * candidate to grant.
 *
 * So "PIE cannot send mail on your behalf" is true, and "nothing can" is not.
 * PIE's allowlist offers the model two Gmail operations, both reads, and the
 * readonly scope throws on the rest — but the token sitting in Corsair's
 * database was granted send and modify, and a candidate consenting to this
 * deserves to be told that in the sentence before they click, not after.
 */
export const GMAIL_SCOPE_NOTICE =
  'Google will ask you to grant send, compose, modify and label access. That is Corsair\'s Gmail '
  + 'plugin asking — its scopes are fixed and it does not offer a read-only one. PIE itself only '
  + 'ever lists messages and reads their From, Subject and Date, never the body, and it cannot '
  + 'send, delete or modify anything. But the authorisation you are granting is broader than what '
  + 'PIE uses, and you can revoke it at myaccount.google.com/permissions.';

/** Which plugins this candidate has actually connected. */
export async function connectionStatus({ tenantId } = {}) {
  if (!isConfigured() || !tenantId) return { ok: false, reason: 'NOT_CONFIGURED' };
  const m = await sdk.manage();
  if (!m) return { ok: false, reason: 'CLIENT_FAILED', detail: sdk.lastError() };
  return attempt('manage.connectionStatus.get', () => m.connectionStatus.get({ tenantId }));
}

/** Removes a candidate's stored authorisation. Candidates can withdraw consent. */
export async function disconnect({ tenantId, plugin = 'github' } = {}) {
  if (!isConfigured() || !tenantId) return { ok: false, reason: 'NOT_CONFIGURED' };
  const m = await sdk.manage();
  if (!m) return { ok: false, reason: 'CLIENT_FAILED', detail: sdk.lastError() };
  return attempt('manage.disconnect', () => m.disconnect({ tenantId, plugin }));
}

/* ------------------------------------------------------------------ github */

/**
 * Normalises one Corsair GitHub repository into the object PIE's evidence
 * pipeline already understands.
 *
 * Everything downstream — evidence, skills discovery, the trust tier — is
 * untouched by where the data came from. Only the provenance line differs, and
 * that is shown to the candidate.
 */
function shapeRepo(x, login) {
  if (!x) return null;
  const created = x.createdAt || x.created_at || null;
  const pushed = x.pushedAt || x.pushed_at || null;
  const language = x.language || null;
  return {
    // GitHub's own numeric id, carried through rather than dropped.
    //
    // PIE does not need it — repositories are identified here by full name —
    // but Corsair's repository schema does, and it is a number. The sync was
    // sending the full name as `id` and every upsert was rejected with
    // "expected number, received string". Nobody noticed, because Corsair syncs
    // the same repositories itself: `db.repositories.list()` answered happily
    // from Corsair's own rows, so the store looked populated and the writes
    // that were failing were the only ones carrying PIE's added fields.
    githubId: Number.isFinite(Number(x.id)) ? Number(x.id) : null,
    name: x.name || String(x.fullName || x.full_name || '').split('/').pop() || 'repository',
    fullName: x.fullName || x.full_name || (login ? `${login}/${x.name}` : x.name),
    description: x.description || '',
    language,
    languages: language ? [language] : [],
    visibility: (x.private ?? x.isPrivate) ? 'private' : 'public',
    stars: Number(x.stargazersCount ?? x.stargazers_count ?? x.stars ?? 0),
    forks: Number(x.forksCount ?? x.forks_count ?? 0),
    openIssues: Number(x.openIssuesCount ?? x.open_issues_count ?? 0),
    archived: Boolean(x.archived),
    fork: Boolean(x.fork),
    topics: x.topics || [],
    // Left null on purpose. PIE's evidence layer treats null as "not observed"
    // and says so, rather than letting an absent number read as a zero.
    commits: null,
    hasTests: null,
    hasReadme: null,
    readmeQuality: null,
    structure: null,
    monthsActive: monthsBetween(created, pushed),
    pushedAt: pushed ? String(pushed).slice(0, 10) : null,
  };
}

function monthsBetween(a, b) {
  if (!a || !b) return null;
  const ms = new Date(b) - new Date(a);
  if (!Number.isFinite(ms)) return null;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24 * 30)));
}

/**
 * A candidate's repositories, read through Corsair.
 *
 * Synced rows first, because that is a local query with no rate limit. If the
 * sync has not run for this candidate yet, one live call fills in — and the
 * result says which of the two it was, because "this was read from a cache" and
 * "this was fetched a second ago" are different claims.
 */
/**
 * One row per repository, whatever the source handed over.
 *
 * An earlier version of the sync wrote PIE's own copy of every repository into
 * Corsair's entity table under a different key, alongside the copy Corsair had
 * synced itself. Four repositories became eight rows. The knowledge base
 * answered "8 of 8 synced repositories match", and the sync reported "8
 * repositories are searchable" — which is not merely untidy: it doubles the
 * apparent size of a candidate's portfolio, and portfolio size is exactly what
 * a recruiter reads off that screen as evidence.
 *
 * The sync no longer writes there. This stays for two reasons: the duplicate
 * rows it already created are still in the database, and a mirror PIE does not
 * own can always hand it the same repository twice.
 *
 * It lives here, on the read path, so that EVERY consumer is covered. Putting
 * it only in the knowledge base fixed the answers and left the sync still
 * counting eight — the same number, wrong in a different place.
 */
export function uniqueRepositories(rows) {
  const fields = r => Object.values(r).filter(v => v !== null && v !== undefined && v !== '').length;
  const byName = new Map();

  for (const r of rows) {
    const key = String(r?.fullName || r?.name || '').toLowerCase();
    if (!key) continue;
    const seen = byName.get(key);
    // Keep whichever copy carries more: a sparse duplicate must not displace
    // the row holding the language and push date a question is matched on.
    if (!seen || fields(r) > fields(seen)) byName.set(key, r);
  }
  return [...byName.values()];
}

export async function githubRepositories(login, { tenantId, limit = 100 } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!tenantId) return { ok: false, reason: 'NO_TENANT', detail: 'A candidate is required — Corsair reads are tenant-scoped.' };

  if (!(await sdk.client())) {
    return { ok: false, reason: 'CLIENT_FAILED', detail: sdk.lastError() || 'The Corsair client is unavailable.' };
  }
  const scoped = fn => sdk.asTenant(tenantId, fn);

  // 1. Synced rows.
  const fromDb = await attempt('github.db.repositories.list', () =>
    scoped(t => t.github.db.repositories.list({ limit })));

  if (fromDb.ok && Array.isArray(fromDb.data) && fromDb.data.length) {
    const rows = uniqueRepositories(fromDb.data.map(e => shapeRepo(e?.data ?? e, login)).filter(Boolean));
    if (rows.length) {
      return { ok: true, source: 'corsair-db', repositories: rows };
    }
  }

  // 2. A live call, when nothing has been synced yet.
  const fromApi = await attempt('github.api.repositories.list', () =>
    scoped(t => t.github.api.repositories.list({
      ...(login ? { owner: login } : {}),
      sort: 'pushed',
      direction: 'desc',
      perPage: Math.min(limit, 100),
    })));

  if (!fromApi.ok) return fromApi;

  const list = Array.isArray(fromApi.data) ? fromApi.data : (fromApi.data?.data || []);
  const rows = uniqueRepositories(list.map(x => shapeRepo(x, login)).filter(Boolean));
  return { ok: true, source: 'corsair-api', repositories: rows };
}

/* ----------------------------------------------------------------- syncing */

/**
 * Copies a candidate's GitHub repositories into Corsair's synced-entity store.
 *
 * WHY SYNC AT ALL, WHEN THE API WORKS
 *   Evidence gathering is read-heavy and bursty. A recruiter opens a candidate
 *   and PIE wants repositories, languages, activity and CI at once; against the
 *   live API that is a fan-out of calls and a rate limit waiting to happen. Once
 *   synced it is a query against PIE's own Postgres, and it works when GitHub is
 *   slow, rate-limiting, or unreachable from a conference network.
 *
 *   It is also what makes a knowledge base possible. You cannot search data you
 *   have not got.
 *
 * WHAT IS STORED
 *   Public repository metadata — the same fields PIE already shows a candidate
 *   on the import screen. No file contents, no private repository data beyond
 *   what the candidate's own grant returns, and nothing that is not already
 *   evidence.
 *
 * WHAT "READ-ONLY" MEANS HERE
 *   Nothing about this writes to GitHub. It writes to `corsair_entities`, which
 *   is PIE's own table, holding a copy of data PIE was already permitted to
 *   read. That is why it runs through `asTenantForCache` rather than the
 *   read-only scope every other path uses — see the comment on that function.
 */
/**
 * Does each repository have GitHub Actions workflows?
 *
 * WHY THIS EXISTS
 *   The repository list endpoint does not say. So `hasWorkflows` was never
 *   written, the knowledge base's `ci` signal read every row as false, and
 *   "anything that runs CI?" answered "None of the 4 synced repositories
 *   match" — a claim about the candidate's engineering practice that PIE had
 *   no basis for. Either PIE looks, or it says it did not. This is PIE looking.
 *
 *   CI is also the strongest cheap signal there is for the thing PIE exists to
 *   measure. Someone who set up Actions on a personal project is demonstrating
 *   practice that no degree certificate reports.
 *
 * BEST-EFFORT ON PURPOSE
 *   One extra read per repository, capped, and every failure is swallowed into
 *   "not observed". A sync that copies twenty repositories must not fail
 *   because the twenty-first returned a 404, and an unknown is representable —
 *   which is the whole reason this can afford to give up quietly.
 *
 * @returns {Promise<Map<string, boolean>>} keyed by full name; absent = unknown
 */
async function enrichFromApi(tenantId, rows, cap = 25) {
  const extra = new Map();

  for (const repo of rows.slice(0, cap)) {
    const full = String(repo.fullName || '');
    const [owner, name] = full.split('/');
    if (!owner || !name) continue;

    const add = (k, v) => extra.set(full, { ...(extra.get(full) || {}), [k]: v });

    const wf = await attempt('github.api.workflows.list', () =>
      sdk.asTenant(tenantId, t => t.github.api.workflows.list({ owner, repo: name })));

    if (wf.ok) {
      const list = Array.isArray(wf.data) ? wf.data : (wf.data?.workflows || wf.data?.items || []);
      add('hasWorkflows', Array.isArray(list) && list.length > 0);
    }
    // Otherwise unknown, and the row simply carries no opinion.

    // How long the work went on for, and the numeric id if the listing did not
    // carry one. The repository LIST endpoint does not always include
    // `createdAt`, and without it `monthsActive` is null — so "what has been
    // worked on for six months or more?" had nothing to compare. Only fetched
    // when the list did not already answer it, so a complete listing costs
    // nothing extra.
    if (repo.monthsActive == null || repo.githubId == null) {
      const det = await attempt('github.api.repositories.get', () =>
        sdk.asTenant(tenantId, t => t.github.api.repositories.get({ owner, repo: name })));

      const created = det.ok ? (det.data?.createdAt || det.data?.created_at) : null;
      const pushed = (det.ok && (det.data?.pushedAt || det.data?.pushed_at)) || repo.pushedAt;
      const months = monthsBetween(created, pushed);
      if (months != null) add('monthsActive', months);

      const id = det.ok ? Number(det.data?.id) : NaN;
      if (Number.isFinite(id)) add('githubId', id);
    }
  }
  return extra;
}

export async function syncGithub({ tenantId, login = null, limit = 50 } = {}) {
  // Both of these carry a `detail`, because the caller shows it and an
  // unexplained refusal is the thing this file keeps having to fix. On a
  // deployment with no Corsair configured, "The sync could not run." was the
  // whole message, under a button that could never work, next to a recovery
  // line telling the candidate to connect GitHub — which would not have helped.
  if (!isConfigured()) {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      detail: 'Corsair is not configured on this server, so there is nothing to sync into. '
        + 'Import repositories with "Connect GitHub" instead.',
    };
  }
  if (!tenantId) {
    return { ok: false, reason: 'NO_TENANT',
      detail: 'No candidate is in scope — Corsair reads and writes are tenant-scoped.' };
  }

  // Read through the ordinary read-only path. The fetch half of a sync is still
  // a read, and it should be as constrained as every other read PIE makes.
  const fetched = await githubRepositories(login, { tenantId, limit });
  if (!fetched.ok) return fetched;

  const rows = fetched.repositories || [];
  if (!rows.length) {
    return { ok: true, synced: 0, source: fetched.source,
      detail: 'Nothing to sync — no repositories were visible for this account.' };
  }

  const extra = await enrichFromApi(tenantId, rows);

  // PIE does NOT write the repositories back into Corsair's entity table.
  //
  // It used to, and the attempt taught three things in one evening:
  //
  //   1. `id` in Corsair's repository schema is GitHub's number. PIE was
  //      sending the full name, so every upsert was rejected — invisibly,
  //      because `db.repositories.list()` kept answering from the rows Corsair
  //      had synced by itself.
  //   2. Keyed by full name, PIE's rows did not match Corsair's, so the writes
  //      that did land created a SECOND copy of every repository. Four
  //      repositories, eight rows, and a knowledge base answering "8 of 8".
  //   3. The two fields worth writing — hasWorkflows, monthsActive — are not in
  //      Corsair's schema and were silently dropped anyway.
  //
  // The boundary that follows from that is the right one regardless: Corsair
  // owns the mirror of what GitHub said, and keeps it current without PIE's
  // help. PIE owns what PIE concluded. So the derived signals go into PIE's own
  // store, keyed by tenant and full name, and the two are joined on read.
  const signals = [];
  for (const repo of rows) {
    const key = String(repo.fullName || repo.name || '');
    if (!key) continue;
    const found = extra.get(key) || {};

    const record = {
      id: `${tenantId}::${key}`,
      tenantId,
      fullName: key,
      // Undefined rather than false when PIE could not look. The knowledge base
      // reports an unobserved signal as unknown, never as "no".
      hasWorkflows: found.hasWorkflows,
      monthsActive: found.monthsActive ?? repo.monthsActive ?? null,
      syncedAt: new Date().toISOString(),
    };
    store.upsert('repositorySignals', record);
    signals.push(record);
  }

  const observed = signals.filter(r => r.hasWorkflows !== undefined).length;
  const unread = signals.length - observed;

  // A partial sync says so. "4 repositories synced" when PIE could not read CI
  // on two of them is how a gap becomes a surprise in front of an audience —
  // and the knowledge base will report those two as unknown, so the two
  // statements need to agree.
  const partly = unread
    ? ` CI status could not be read for ${unread} of them; those will report as unknown.`
    : '';

  checks.record('corsair-sync', {
    ok: unread === 0,
    detail: `${signals.length} repositories examined, ${observed} with CI status.${partly}`,
    config: corsairFingerprint(),
    meta: { synced: signals.length, observed, at: new Date().toISOString() },
  });

  return {
    ok: true,
    synced: signals.length,
    observed,
    source: fetched.source,
    detail: `${signals.length} repositories are searchable, ${observed} of them with their CI `
      + `status read from GitHub.${partly}`,
  };
}

/** How much this candidate has synced, and when. Cheap enough to call on page load. */
/**
 * How many repositories this candidate can actually be asked about.
 *
 * Counted the same way the answers are counted, which was not true before.
 * `repositories.count()` counts ROWS; the knowledge base dedupes by full name
 * on read. With the duplicate rows an older sync left behind, the badge said
 * "8 synced" while the answer beneath it said "4 of 4" — both correct, and
 * together an invitation to ask which one is lying.
 *
 * A number on the same screen as the thing it counts has to agree with it.
 */
export async function syncStatus({ tenantId } = {}) {
  if (!isConfigured() || !tenantId) return { ok: false, reason: 'NOT_CONFIGURED', count: 0 };

  const r = await attempt('github.db.repositories.list', () =>
    sdk.asTenant(tenantId, t => t.github.db.repositories.list({ limit: 200 })));
  if (!r.ok) return { ...r, count: 0 };

  const rows = (r.data || []).map(e => e?.data ?? e).filter(Boolean);
  const unique = uniqueRepositories(rows);

  return {
    ok: true,
    count: unique.length,
    // Kept so the difference is visible to anyone debugging rather than
    // silently smoothed over.
    ...(rows.length !== unique.length ? { rows: rows.length } : {}),
  };
}

/* -------------------------------------------------------------- linking */

/**
 * Stores a GitHub access token against a candidate's Corsair tenant.
 *
 * WHY THIS EXISTS ALONGSIDE THE HUB CONNECT FLOW
 *   Corsair Hub runs a hosted OAuth handshake and then has to deliver the
 *   resulting credential back to this server. When PIE is on localhost there is
 *   nothing for Hub to deliver to, so the SDK opens a tunnel — and a tunnel is a
 *   moving part that a corporate network, or Windows Defender deciding the frp
 *   binary is a hacking tool, will happily remove. That is a poor thing to
 *   depend on twenty minutes before a demo.
 *
 *   This is the other door. PIE already runs its own GitHub OAuth app, which
 *   works over an ordinary browser redirect and needs no tunnel at all. Once it
 *   has a token, PIE hands that token to Corsair, and from then on every Corsair
 *   path behaves identically: the credential is encrypted under CORSAIR_KEK in
 *   corsair_accounts, reads are tenant-scoped, the read-only policy applies, and
 *   the Evidence Scout's tools work.
 *
 *   It is worth being clear that this is not a workaround for the demo. PIE's
 *   own OAuth app asks for `read:user`; Corsair's managed GitHub app asks for
 *   `repo`, `user` and `read:org`. The candidate who comes through this door
 *   grants strictly less. If anything, this is the door that should be the
 *   default, and the Hub flow is the fallback for services PIE has no app for.
 *
 * The token is written and never read back, never logged, and never returned.
 */
export async function linkGithubToken({ tenantId, token, login = null, scopes = null } = {}) {
  if (!isConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (!tenantId) return { ok: false, reason: 'NO_TENANT' };
  if (!token) return { ok: false, reason: 'NO_TOKEN', detail: 'A GitHub access token is required.' };

  const corsair = await sdk.client();
  if (!corsair) return { ok: false, reason: 'CLIENT_FAILED', detail: sdk.lastError() };

  const r = await attempt('github.keys.set_access_token', async () => {
    const keys = corsair.withTenant(tenantId).github.keys;
    await keys.set_access_token(token);
    // Recorded so the connection can be explained later: which door it came
    // through, and what it was allowed to do. Neither is the token.
    if (scopes) await keys.set_scope(String(scopes).slice(0, 200));
    return true;
  });

  if (!r.ok) return r;

  checks.record('corsair-github-link', {
    ok: true,
    detail: `A GitHub token was linked to a Corsair tenant${login ? ` for @${login}` : ''}.`,
    config: corsairFingerprint(),
  });
  return { ok: true, tenantId, login, scopes };
}

/**
 * Confirms a linked token actually works, by reading something with it.
 *
 * Setting a key proves only that a write succeeded. This is the same rule the
 * rest of this file follows: an integration is connected when a real call has
 * come back, and not before.
 */
export async function verifyGithubLink({ tenantId, login = null } = {}) {
  const r = await githubRepositories(login, { tenantId, limit: 5 });
  if (!r.ok) return r;
  return { ok: true, source: r.source, repositories: r.repositories.length };
}

/* ------------------------------------------------------------------- scout */

/**
 * Runs the Evidence Scout for one candidate.
 *
 * Re-exported here so the rest of PIE has a single Corsair-shaped door: routes
 * import this module, not the agent and the tool layer separately. Gmail keys
 * are pushed first, because the plugin cannot authorise anybody without them and
 * the failure otherwise looks like a candidate problem rather than a
 * configuration one.
 */
export async function scout(opts = {}) {
  if ((opts.connected || []).includes('gmail')) await sdk.ensureGmailKeys();
  const { scout: run } = await import('../ai/evidenceScout.js');
  return run(opts);
}

/** Whether the Gmail plugin is configured on this server. */
export const gmailConfigured = sdk.gmailConfigured;
export const gmailEnvNames = sdk.gmailEnvNames;

/** Test seam — forget the built client so the next call re-reads the environment. */
export const reset = sdk.reset;
export const close = sdk.close;
