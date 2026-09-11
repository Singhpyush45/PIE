// PIE — Corsair operations, offered to an agent as a bounded tool set.
//
// WHAT THIS IS FOR
//   PIE's Evidence Scout agent decides which of a candidate's connected tools to
//   look at. "This person claims Python and testing — go and see whether the
//   commits, the CI workflows and the repository structure agree." That is a
//   genuinely agentic job, and Corsair is what makes it one API instead of four.
//
// WHY AN ALLOWLIST, WHEN THE SDK IS ALREADY READ-ONLY
//   `buildCorsairTools()` returns EVERY operation a plugin exposes — 53 for
//   GitHub, 25 for Gmail — and that includes `repositories.star`,
//   `messages.send`, `messages.delete` and `messages.trash`. The SDK's readonly
//   policy would refuse all of those at execution time, so nothing could
//   actually happen.
//
//   That is not a reason to hand them to a model. A refusal is a control on the
//   ACT; the allowlist below is a control on the CHOICE. A model that is never
//   told `gmail.api.messages.delete` exists cannot propose it, cannot be talked
//   into proposing it by something it read in a repository description, and
//   cannot produce a plan that a reader has to be reassured about. The two
//   controls fail in different ways, which is the only reason to have both.
//
//   So: the operations below are the ones PIE needs to gather evidence. Nothing
//   else reaches the model, and PIE validates every proposed call against the
//   real schema before it runs.
//
// WHY ARGUMENTS ARE CONSTRAINED TOO
//   An allowlisted operation with free arguments is not a bounded tool.
//   `gmail.api.messages.list` with a model-chosen query is a whole inbox. So
//   each operation below carries a policy that PIE applies AFTER the model has
//   spoken and BEFORE anything executes:
//
//     • Gmail search is always AND-ed with PIE's own credential-evidence filter.
//       The model may narrow it further; it cannot widen it.
//     • Gmail messages are always fetched with `format: 'metadata'` and only the
//       From, Subject and Date headers. PIE does not request the body of
//       anyone's email — not "does not store it", does not ask for it.
//     • Page sizes are clamped, so a plan cannot turn into a scrape.
//
//   These are applied by `run()`, not suggested to the model, because a
//   constraint a model is asked to respect is a request, not a constraint.

import * as sdk from './corsairClient.js';

/* ------------------------------------------------------------- gmail policy */

/**
 * The only mail PIE looks for: proof that somebody completed something.
 *
 * This is the entire justification for touching a candidate's inbox at all. A
 * candidate who finished a course but lost the PDF still has the completion
 * mail, and "potential over pedigree" is empty if PIE cannot see it. Anything
 * outside this filter is none of PIE's business, so the filter is not optional
 * and not model-controlled.
 */
const CREDENTIAL_QUERY = [
  'subject:(certificate OR certification OR "course completion" OR completed',
  'OR credential OR badge OR "you passed" OR hackathon OR "certificate of")',
].join(' ');

/** Never fetch the body. Headers are enough to identify an issuer and a date. */
const METADATA_HEADERS = ['From', 'Subject', 'Date'];

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : dflt;
};

/* ---------------------------------------------------------------- allowlist */

/**
 * operation → what it is for, and how PIE bounds its arguments.
 *
 * `purpose` is what the model is told. It is written as evidence-gathering
 * guidance rather than API documentation, because the model is choosing what to
 * investigate, not what to call.
 */
export const ALLOWED = {
  /* ----------------------------------------------------------------- GitHub */
  'github.api.users.get': {
    purpose: 'Public profile for one GitHub user: name, bio, company, public repository count. '
      + 'Use once, early, to confirm the account exists before spending calls on it.',
    policy: a => ({ username: String(a.username || '').slice(0, 60) }),
  },
  'github.api.repositories.list': {
    purpose: 'A user\'s repositories, most recently pushed first. The usual first real step.',
    policy: a => ({
      ...(a.owner ? { owner: String(a.owner).slice(0, 60) } : {}),
      sort: 'pushed', direction: 'desc',
      perPage: clamp(a.perPage, 1, 50, 30),
    }),
  },
  'github.api.repositories.get': {
    purpose: 'One repository in detail. Use when a repository looks relevant to the target skills.',
    policy: a => ({ owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100) }),
  },
  'github.api.repositories.listCommits': {
    purpose: 'Commits on one repository. Evidence of sustained work rather than a single upload — '
      + 'the difference between a project and a snapshot.',
    policy: a => ({
      owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100),
      ...(a.author ? { author: String(a.author).slice(0, 60) } : {}),
      perPage: clamp(a.perPage, 1, 50, 30),
    }),
  },
  'github.api.repositories.listBranches': {
    purpose: 'Branches on one repository. Several long-lived branches suggest a real workflow.',
    policy: a => ({
      owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100),
      perPage: clamp(a.perPage, 1, 30, 15),
    }),
  },
  'github.api.workflows.list': {
    purpose: 'GitHub Actions workflows on one repository. The strongest cheap signal for '
      + 'engineering practice: someone who set up CI tests their work.',
    policy: a => ({ owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100) }),
  },
  'github.api.pullRequests.list': {
    purpose: 'Pull requests on one repository. Evidence of collaboration and review, not just commits.',
    policy: a => ({
      owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100),
      state: a.state === 'open' || a.state === 'closed' ? a.state : 'all',
      perPage: clamp(a.perPage, 1, 30, 15),
    }),
  },
  'github.api.releases.list': {
    purpose: 'Releases on one repository. Shipping something and versioning it is a different '
      + 'signal from writing code.',
    policy: a => ({
      owner: String(a.owner || '').slice(0, 60), repo: String(a.repo || '').slice(0, 100),
      perPage: clamp(a.perPage, 1, 20, 10),
    }),
  },

  /* ------------------------------------------------------------------ Gmail */
  'gmail.api.messages.list': {
    purpose: 'Search the candidate\'s own mail for course, certificate and hackathon completion '
      + 'notices. PIE always applies its own credential filter; anything you add NARROWS the '
      + 'search further (for example a provider name). You cannot widen it, and you cannot '
      + 'read ordinary mail.',
    policy: a => {
      // The model's contribution is AND-ed on. It cannot replace the filter,
      // cannot introduce an OR at the top level, and cannot reach spam or trash.
      const narrowing = String(a.narrow || a.q || '').replace(/[()]/g, ' ').slice(0, 120).trim();
      return {
        q: narrowing ? `${CREDENTIAL_QUERY} ${narrowing}` : CREDENTIAL_QUERY,
        maxResults: clamp(a.maxResults, 1, 25, 15),
        includeSpamTrash: false,
      };
    },
  },
  'gmail.api.messages.get': {
    purpose: 'Headers of one matched mail — who sent it, its subject, and when. PIE requests '
      + 'metadata only, so the body of the message is never retrieved.',
    policy: a => ({
      id: String(a.id || '').slice(0, 80),
      format: 'metadata',
      metadataHeaders: METADATA_HEADERS,
    }),
  },
};

export const OPERATIONS = Object.keys(ALLOWED);

/** Operations for one plugin, e.g. `pluginOperations('gmail')`. */
export const pluginOperations = plugin =>
  OPERATIONS.filter(op => op.startsWith(`${plugin}.`));

/* ---------------------------------------------------------------- catalogue */

/**
 * What the agent is allowed to consider, in the form it is shown to a model.
 *
 * Deliberately does NOT include the zod schema: the model is asked for an
 * operation and plain arguments, and PIE validates against the real schema
 * itself. Handing a model a schema it might satisfy is weaker than handing it
 * nothing and checking.
 */
export function catalogue({ plugins = ['github', 'gmail'], connected = null } = {}) {
  return OPERATIONS
    .filter(op => plugins.includes(op.split('.')[0]))
    // A tool for a service the candidate has not connected is a tool that can
    // only fail. Hiding it saves a wasted step and a confusing refusal.
    .filter(op => !connected || connected.includes(op.split('.')[0]))
    .map(op => ({ operation: op, purpose: ALLOWED[op].purpose }));
}

/* --------------------------------------------------------------------- run */

let toolCache = null;   // { tenantId, byOperation }

async function toolsFor(tenantId) {
  if (toolCache?.tenantId === tenantId) return toolCache.byOperation;
  const corsair = await sdk.client();
  if (!corsair) return null;
  const { buildCorsairTools } = await import('corsair');

  const byOperation = new Map();
  for (const plugin of ['github', 'gmail']) {
    let built = [];
    try { built = buildCorsairTools(corsair, { plugin, tenantId }); }
    catch { built = []; }          // a plugin that is not configured yields nothing
    for (const t of built) byOperation.set(t.operation, t);
  }
  toolCache = { tenantId, byOperation };
  return byOperation;
}

/**
 * Executes one proposed operation, or explains why it will not.
 *
 * Never throws, and never returns a partial success. The order matters: the
 * allowlist is checked before the tenant, the policy is applied before the
 * schema, and the schema is checked before anything reaches Corsair — so a
 * malformed or hostile proposal is rejected at the earliest point that can see
 * it is wrong.
 */
export async function run({ tenantId, operation, args = {} }) {
  const spec = ALLOWED[operation];
  if (!spec) {
    return { ok: false, reason: 'NOT_ALLOWED',
      detail: `${operation} is not one of the operations PIE offers. It was not executed.` };
  }
  if (!tenantId) return { ok: false, reason: 'NO_TENANT', detail: 'Corsair reads are tenant-scoped.' };

  let bounded;
  try { bounded = spec.policy(args && typeof args === 'object' ? args : {}); }
  catch (e) { return { ok: false, reason: 'BAD_ARGS', detail: String(e.message || e).slice(0, 160) }; }

  const tools = await toolsFor(tenantId);
  if (!tools) return { ok: false, reason: 'NOT_CONFIGURED', detail: sdk.lastError() || 'Corsair is not available.' };

  const tool = tools.get(operation);
  if (!tool) {
    return { ok: false, reason: 'PLUGIN_UNAVAILABLE',
      detail: `${operation.split('.')[0]} is not configured on this server.` };
  }

  // The real schema, from the plugin itself. A proposal that does not satisfy it
  // is a bug or a hallucination, and either way it does not run.
  const parsed = tool.schema?.safeParse?.(bounded);
  if (parsed && parsed.success === false) {
    const first = parsed.error?.issues?.[0];
    return { ok: false, reason: 'SCHEMA_REJECTED',
      detail: `${operation}: ${first ? `${(first.path || []).join('.')} ${first.message}` : 'arguments did not validate'}` };
  }

  try {
    // Executed through the SDK's read-only scope. `tool.execute` is already
    // bound to this tenant by buildCorsairTools.
    const data = await tool.execute(parsed?.success ? parsed.data : bounded);
    return { ok: true, operation, args: bounded, data };
  } catch (e) {
    const name = e?.name || '';
    if (/AuthMissing/i.test(name)) {
      return { ok: false, reason: 'NOT_CONNECTED',
        detail: `The candidate has not connected ${operation.split('.')[0]}.` };
    }
    if (/ReadonlyForbidden/i.test(name)) {
      // Should be unreachable: nothing in ALLOWED is a write. If it fires, the
      // allowlist and the policy layer have disagreed, and that is worth seeing.
      return { ok: false, reason: 'READONLY_VIOLATION',
        detail: `${operation} is a write. It was refused, and it should not have been offered.` };
    }
    return { ok: false, reason: 'FAILED', detail: String(e?.message || e).slice(0, 200) };
  }
}

/** Test seam — forget the built tools so the next call rebuilds them. */
export function reset() { toolCache = null; }
