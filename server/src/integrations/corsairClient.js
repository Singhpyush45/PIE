// PIE — the Corsair SDK instance.
//
// WHY THIS FILE EXISTS SEPARATELY FROM corsair.js
//   corsair.js is PIE's adapter: it answers "what state is this integration in"
//   and "give me this candidate's repositories" in PIE's own vocabulary. This
//   file owns the one thing underneath it — the SDK client — and nothing else.
//   Keeping them apart means the adapter's honesty rules stay readable, and the
//   SDK's construction (which can fail for four different reasons) stays in one
//   place with one error path.
//
// WHAT CORSAIR ACTUALLY IS
//   Not a REST endpoint PIE calls with a bearer token. An earlier version of
//   this integration assumed exactly that and was wrong end to end: Corsair is
//   an npm SDK that runs INSIDE this server. It owns five tables in PIE's own
//   Postgres (corsair_integrations, corsair_accounts, corsair_entities,
//   corsair_events, corsair_permissions), stores each candidate's third-party
//   credentials there encrypted under PIE's KEK, and exposes two surfaces per
//   plugin:
//
//       corsair.withTenant(t).github.api.<group>.<method>()   live GitHub call
//       corsair.withTenant(t).github.db.<group>.<method>()    already-synced rows
//
//   Corsair Hub is the hosted half: it runs the OAuth dance and hands back a
//   connect URL. The credential still lands in PIE's database, not Corsair's.
//   That is the property that makes this defensible for candidate data at all.
//
// TENANCY
//   PIE has candidates, so PIE has tenants. One tenant per candidate profile,
//   so one candidate's GitHub credential can never be read while acting for
//   another. `tenantFor()` is the only place that mapping is decided.
//
// READ-ONLY, STRUCTURALLY
//   PIE reads evidence. It has no reason to open an issue, push a commit or
//   star a repository on a candidate's behalf, and a candidate should not have
//   to take that on trust. Two independent mechanisms enforce it:
//     1. the plugin is constructed with `permissions: { mode: 'readonly' }`,
//        so every write endpoint is denied by policy;
//     2. every call PIE makes is wrapped in the SDK's `runReadonly()`, which
//        throws on any non-read endpoint reached from inside that scope —
//        including from nested async code.
//   Either alone would be a promise. Together they are a mechanism.
//
// NOTHING HERE THROWS AT IMPORT
//   PIE must start with Corsair absent, half-configured or misconfigured. Every
//   failure below turns into a state the Integrations screen can render.
//
//   That is also why the SDK is loaded with a dynamic import rather than at the
//   top of the file. `corsair`, `@corsair-dev/github` and `pg` are three
//   packages an optional integration has no business making mandatory: with a
//   static import, a checkout where `npm install` has not been re-run does not
//   degrade to NOT_CONFIGURED — the whole server fails to start, on an
//   integration nothing depends on. Loading it on first use, behind a
//   configuration check, keeps that failure the size it should be.

/* ------------------------------------------------------------------ config */

const env = (k, d = '') => (process.env[k] || d).trim();

/**
 * The environment variable NAMES this integration needs. Values are never read
 * into a log line, a status payload or an error message anywhere in this file.
 */
export const envNames = {
  API_KEY: 'CORSAIR_API_KEY',
  SIGNING_SECRET: 'CORSAIR_SIGNING_SECRET',
  KEK: 'CORSAIR_KEK',
  DATABASE_URL: 'CORSAIR_DATABASE_URL',
};

/**
 * Gmail's variables, kept separate from the four above because they are
 * optional in a way the others are not: Corsair is either configured or it is
 * not, whereas Gmail is a plugin PIE adds only if someone has done the Google
 * Cloud work. Missing these means "no Gmail evidence", not "no Corsair".
 */
export const gmailEnvNames = {
  CLIENT_ID: 'GMAIL_CLIENT_ID',
  CLIENT_SECRET: 'GMAIL_CLIENT_SECRET',
  REDIRECT_URL: 'GMAIL_REDIRECT_URL',
};

/**
 * Whether the Gmail plugin can be constructed at all.
 *
 * Unlike GitHub, the Gmail plugin has no `managed` auth type — Corsair does not
 * lend you an app for it. Every deployment that wants Gmail evidence must
 * register its own Google Cloud OAuth client, and `gmail.readonly` is one of
 * Google's restricted scopes, so an unverified app reaches only the test users
 * its owner has added by hand. That is a legitimate demo configuration and a
 * poor production one, and PIE says which it is on the Integrations screen
 * rather than letting the difference go unnoticed.
 */
export const gmailConfigured = () =>
  Boolean(env('GMAIL_CLIENT_ID') && env('GMAIL_CLIENT_SECRET'));

export function config() {
  return {
    apiKey: env('CORSAIR_API_KEY'),
    signingSecret: env('CORSAIR_SIGNING_SECRET'),
    kek: env('CORSAIR_KEK'),
    // Corsair speaks SQL, not Supabase's REST API, so it needs a real Postgres
    // connection string. Supabase gives one out under Settings → Database. It
    // points at the same database PIE already mirrors to, which is the point:
    // one system of record, not two.
    databaseUrl: env('CORSAIR_DATABASE_URL') || env('DATABASE_URL'),
    // OFF unless asked for.
    //
    // The tunnel exists so Corsair Hub can deliver a credential back to a server
    // running on localhost. PIE does not need that: a candidate authorises
    // through PIE's own GitHub OAuth app — an ordinary browser redirect — and
    // the callback hands the grant to Corsair directly (see linkGithubToken in
    // corsair.js). There is nothing for Hub to deliver.
    //
    // Leaving it on meant the SDK spawned an frp binary at every boot and
    // printed `tunnel failed to start: spawn EPERM` when Windows Defender, quite
    // reasonably, refused to run a tunnelling tool it classifies as a hacking
    // utility. A red "failed" line at startup for a component the product does
    // not use is worse than useless: it invites someone watching a demo to ask
    // about a failure that is not one.
    //
    // Set CORSAIR_TUNNEL=1 to turn it back on for the Hub connect flow.
    tunnel: env('CORSAIR_TUNNEL') === '1' && process.env.NODE_ENV !== 'production',
    redirectURL: env('APP_BASE_URL') ? `${env('APP_BASE_URL').replace(/\/+$/, '')}/integrations` : undefined,
  };
}

/** Which required variables are absent. Names only — this is shown to admins. */
export function missing() {
  const c = config();
  const out = [];
  if (!c.apiKey) out.push(envNames.API_KEY);
  if (!c.signingSecret) out.push(envNames.SIGNING_SECRET);
  if (!c.kek) out.push(envNames.KEK);
  if (!c.databaseUrl) out.push(envNames.DATABASE_URL);
  return out;
}

export const isConfigured = () => missing().length === 0;

/* ------------------------------------------------------------------ tenancy */

/**
 * The Corsair tenant for a PIE user.
 *
 * A candidate is their profile, because that is the thing evidence hangs off
 * and the thing that survives a session. Anyone else gets their user id, kept
 * in a separate namespace so the two can never collide.
 */
export function tenantFor(user) {
  if (!user) return null;
  if (user.candidateProfileId) return `cand_${user.candidateProfileId}`;
  if (user.id) return `user_${user.id}`;
  return null;
}

/* ------------------------------------------------------------------- client */

let cached = null;      // { corsair, pool }
let building = null;    // in-flight construction, so concurrent callers share one
let buildError = null;  // string | null — why the last construction failed
let modules = null;     // the lazily imported SDK

async function loadSdk() {
  if (modules) return modules;
  const [corsairMod, githubMod, gmailMod, pgMod] = await Promise.all([
    import('corsair'),
    import('@corsair-dev/github'),
    // Gmail is optional even at the module level: a checkout that never wants it
    // should not fail to boot because the package is absent.
    import('@corsair-dev/gmail').catch(() => null),
    import('pg'),
  ]);
  modules = {
    createCorsair: corsairMod.createCorsair,
    runReadonly: corsairMod.runReadonly,
    toExpressHandler: corsairMod.toExpressHandler,
    github: githubMod.github,
    gmail: gmailMod?.gmail || null,
    pg: pgMod.default || pgMod,
  };
  return modules;
}

/** The SDK's Express adapter, or null if the packages are not installed. */
export async function expressHandler() {
  try { return (await loadSdk()).toExpressHandler; } catch { return null; }
}

/** The SDK's read-only scope guard, or null if the packages are not installed. */
export async function readonlyScope() {
  try { return (await loadSdk()).runReadonly; } catch { return null; }
}

/**
 * The SDK client, built once.
 *
 * Resolves to null when Corsair is not configured or could not be constructed;
 * `lastError()` says which. Callers must treat null as "PIE carries on without
 * Corsair", never as an error to surface to a candidate.
 */
export function client() {
  if (cached) return Promise.resolve(cached.corsair);
  if (building) return building;
  if (!isConfigured()) {
    buildError = `Not configured: ${missing().join(', ')} not set.`;
    return Promise.resolve(null);
  }
  building = build().finally(() => { building = null; });
  return building;
}

async function build() {
  const c = config();
  let createCorsair, github, gmail, pg;
  try {
    ({ createCorsair, github, gmail, pg } = await loadSdk());
  } catch (e) {
    buildError = `The Corsair packages are not installed (${String(e?.message || e).slice(0, 120)}). `
      + 'Run "npm install" in server/.';
    return null;
  }
  try {
    const pool = new pg.Pool({
      connectionString: c.databaseUrl,
      // Supabase terminates TLS with its own chain; `require` without
      // verification is what their own connection strings assume. This is the
      // same posture the Supabase client uses over HTTPS.
      ssl: /supabase|render|amazonaws/i.test(c.databaseUrl) ? { rejectUnauthorized: false } : undefined,
      max: Number(env('CORSAIR_DB_POOL_MAX', '4')),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // A pool that cannot reach the database emits 'error' on idle clients. Left
    // unhandled that is an uncaught exception and the whole server dies — for an
    // integration that is explicitly optional. It must not be able to do that.
    pool.on('error', e => { buildError = `Corsair database pool: ${String(e.message || e).slice(0, 160)}`; });

    // The Gmail plugin joins only when it can actually work. Adding an
    // unconfigured plugin would put a tool in the agent's catalogue whose every
    // call fails, and put a row on the Integrations screen that means nothing.
    const plugins = [github({
      authType: 'managed',
      // Policy half of the read-only guarantee. `readonly` maps write to deny
      // and destructive to deny; read stays allowed.
      permissions: { mode: 'readonly' },
    })];
    if (gmail && gmailConfigured()) {
      // The Gmail plugin ships send, delete, trash and modify. PIE wants none of
      // them, and `readonly` is what makes that structural rather than a promise
      // — a candidate connecting their inbox is trusting this line.
      plugins.push(gmail({ authType: 'oauth_2', permissions: { mode: 'readonly' } }));
    }

    const corsair = createCorsair({
      plugins,
      database: pool,
      kek: c.kek,
      multiTenancy: true,
      hub: {
        projectApiKey: c.apiKey,
        signingSecret: c.signingSecret,
        tunnel: c.tunnel,
        ...(c.redirectURL ? { redirectURL: c.redirectURL } : {}),
      },
    });

    cached = { corsair, pool };
    buildError = null;
    return corsair;
  } catch (e) {
    // Message only. The SDK does not put secrets in these, but this is the one
    // place a misconfigured key could plausibly end up in a string, so it is
    // truncated and never includes the config object.
    buildError = String(e?.message || e).slice(0, 200);
    cached = null;
    return null;
  }
}

export const lastError = () => buildError;

/**
 * Runs `fn` with a tenant-scoped client inside a read-only scope.
 *
 * Every read PIE performs against a candidate's connected account goes through
 * here, so the read-only guarantee cannot be forgotten at a call site.
 */
export async function asTenant(tenantId, fn) {
  const corsair = await client();
  if (!corsair || !tenantId) return null;
  const { runReadonly } = modules;
  return runReadonly(() => fn(corsair.withTenant(tenantId)));
}

/** The management namespace — tenants, plugins, connection state, connect links. */
export async function manage() {
  return (await client())?.manage ?? null;
}

/* -------------------------------------------------------------- gmail keys */

let gmailKeysWritten = false;

/**
 * Pushes the Google OAuth client into Corsair's integration-level key store.
 *
 * These are integration-level, not per-tenant: one Google app serves every
 * candidate, and each candidate's own token lands on their account row. They
 * live in `corsair_integrations`, encrypted under the KEK — which is why they
 * are written through the SDK rather than read from the environment at each
 * call.
 *
 * Idempotent, and deliberately not called at boot: a server with no Gmail
 * configuration should never touch the table, and a server with one should not
 * pay a database round trip before anybody has asked for Gmail.
 */
export async function ensureGmailKeys() {
  if (gmailKeysWritten) return { ok: true, already: true };
  if (!gmailConfigured()) return { ok: false, reason: 'NOT_CONFIGURED' };

  const corsair = await client();
  const keys = corsair?.keys?.gmail;
  if (!keys) return { ok: false, reason: 'PLUGIN_UNAVAILABLE' };

  try {
    await keys.set_client_id(env('GMAIL_CLIENT_ID'));
    await keys.set_client_secret(env('GMAIL_CLIENT_SECRET'));
    // Optional. Google will only redirect to a URI registered on the OAuth
    // client, so this string and the one in the Google Cloud console have to be
    // identical — a mismatch is the single most common reason a Gmail connect
    // dies on redirect_uri_mismatch rather than on anything to do with PIE.
    const redirect = env('GMAIL_REDIRECT_URL');
    if (redirect) await keys.set_redirect_url(redirect);

    gmailKeysWritten = true;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'FAILED', detail: String(e?.message || e).slice(0, 180) };
  }
}

/** Releases the pool. Used by tests and by a clean shutdown. */
export async function close() {
  const pool = cached?.pool;
  cached = null;
  if (pool) { try { await pool.end(); } catch { /* already closed */ } }
}

/** Test seam: forget the built client so the next call re-reads the environment. */
export function reset() { cached = null; building = null; buildError = null; gmailKeysWritten = false; }
