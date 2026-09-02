// GitHub evidence adapter.
//
// Deliberately separated from all AI logic: this module only FETCHES and NORMALISES
// repository metadata into PIE evidence objects. It draws no conclusions.
//
// Two modes:
//   LIVE  — a GITHUB_TOKEN is configured, so the public REST API is used.
//   DEMO  — no token, so a small deterministic fixture set is returned, clearly
//           labelled as demo data. The demo never silently pretends to be live.
//
// HONESTY BOUNDARY: repository activity is SUPPORTING evidence. It does not prove
// skill, and this adapter never says it does.

const cfg = () => ({
  token: process.env.GITHUB_TOKEN || '',
  api: process.env.GITHUB_API_URL || 'https://api.github.com',
});

// A GitHub token is ghp_/gho_/ghu_/ghs_/ghr_ + 36+ chars, or the legacy 40-hex form.
// Anything else is a leftover shell variable, not a credential, and treating it as
// one would make PIE claim connectivity it does not have.
const looksLikeToken = t => /^gh[pousr]_[A-Za-z0-9]{20,}$/.test(t) || /^[0-9a-f]{40}$/.test(t);

export function isConfigured() { return looksLikeToken(cfg().token); }

const oauthConfigured = () =>
  Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

export function status() {
  const token = cfg().token;
  const oauth = oauthConfigured();

  // The candidate-facing authorization flow is what matters most, so it leads.
  let state, detail;
  if (oauth) {
    state = 'OAUTH_CONFIGURED';
    detail = 'Real GitHub authorization is active. The candidate approves access on github.com; PIE requests the read:user scope only and can never modify code.';
  } else if (isConfigured()) {
    state = 'LIVE_API_READ_ONLY';
    detail = 'A server token is configured, so public repository metadata is read from the GitHub REST API. No per-candidate authorization flow — set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET for that.';
  } else if (token) {
    state = 'MISCONFIGURED';
    detail = 'GITHUB_TOKEN is set but is not a valid GitHub token. Repository import falls back to labelled demo fixtures rather than failing silently.';
  } else {
    state = 'DEMO_FIXTURES';
    detail = 'No GitHub credentials configured. Repository import returns clearly-labelled demo fixtures so the flow is fully demonstrable offline. Nothing is presented as API-derived.';
  }

  return {
    key: 'github',
    name: 'GitHub',
    state,
    detail,
    classification: oauth ? 'CONFIRMED — OAuth app configured'
      : isConfigured() ? 'CONFIRMED — read-only token'
      : 'OPTIONAL — not configured',
    scopes: oauth ? ['read:user'] : [],
    limitation: 'Repository activity is supporting evidence for capability. It does not prove skill, and PIE never presents it as proof.',
    requires: 'GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET for candidate authorization; GITHUB_TOKEN for anonymous public lookups.',
  };
}

/* ------------------------------------------------------------ demo fixtures */
// Deterministic, clearly-labelled fixtures. Keyed loosely so any username returns
// a sensible, varied repository set for the demo.
const DEMO_REPOS = {
  meerak: [
    { name: 'nashik-air-quality', description: 'Air-quality analysis for Nashik district open data', language: 'Python',
      languages: ['Python'], stars: 7, commits: 94, monthsActive: 14, hasTests: true, hasReadme: true,
      readmeQuality: 'high', topics: ['pandas', 'matplotlib', 'data-analysis'], pushedAt: '2025-11-20',
      structure: ['src/', 'tests/', 'notebooks/', 'README.md'] },
    { name: 'civic-data-pipeline', description: 'Python ETL pipeline for a district open-data feed', language: 'Python',
      languages: ['Python', 'SQL'], stars: 4, commits: 61, monthsActive: 9, hasTests: true, hasReadme: true,
      readmeQuality: 'high', topics: ['etl', 'postgresql', 'github-actions'], pushedAt: '2026-02-11',
      structure: ['pipeline/', 'tests/', '.github/workflows/ci.yml', 'README.md'] },
  ],
  arjund: [
    { name: 'batch-reconciler', description: 'Reconciliation tool comparing source extracts against a warehouse', language: 'Python',
      languages: ['Python', 'SQL'], stars: 12, commits: 148, monthsActive: 21, hasTests: true, hasReadme: true,
      readmeQuality: 'high', topics: ['data-quality', 'reconciliation', 'pytest'], pushedAt: '2026-05-02',
      structure: ['reconciler/', 'tests/', 'docs/', 'README.md'] },
  ],
  farahs: [
    { name: 'pipeline-guard', description: 'Data validation framework with rules, reconciliation and drift detection', language: 'Python',
      languages: ['Python', 'SQL'], stars: 31, commits: 203, monthsActive: 26, hasTests: true, hasReadme: true,
      readmeQuality: 'high', topics: ['data-validation', 'great-expectations', 'ci'], pushedAt: '2026-07-14',
      structure: ['guard/', 'tests/', 'docs/', 'CONTRIBUTING.md', '.github/workflows/'] },
  ],
  rahulv: [
    { name: 'campus-resource-booking', description: 'Booking platform with role-based access and conflict resolution', language: 'JavaScript',
      languages: ['JavaScript', 'React'], stars: 3, commits: 187, monthsActive: 19, hasTests: false, hasReadme: true,
      readmeQuality: 'medium', topics: ['react', 'express', 'mongodb'], pushedAt: '2026-06-01',
      structure: ['client/', 'server/', 'README.md'] },
    { name: 'notes-api', description: 'REST API with auth and pagination', language: 'JavaScript',
      languages: ['JavaScript'], stars: 1, commits: 125, monthsActive: 11, hasTests: false, hasReadme: true,
      readmeQuality: 'medium', topics: ['express', 'rest-api'], pushedAt: '2026-04-18',
      structure: ['src/', 'README.md'] },
  ],
};

const GENERIC = [
  { name: 'portfolio-site', description: 'Personal portfolio', language: 'JavaScript',
    languages: ['JavaScript'], stars: 0, commits: 42, monthsActive: 6, hasTests: false, hasReadme: true,
    readmeQuality: 'medium', topics: ['react'], pushedAt: '2026-05-10', structure: ['src/', 'README.md'] },
  { name: 'algorithms-practice', description: 'Practice solutions with unit tests', language: 'Python',
    languages: ['Python'], stars: 2, commits: 96, monthsActive: 12, hasTests: true, hasReadme: true,
    readmeQuality: 'medium', topics: ['algorithms', 'pytest'], pushedAt: '2026-06-22', structure: ['solutions/', 'tests/'] },
];

/* ----------------------------------------------------------------- fetching */
export async function fetchRepositories(username, { limit = 8 } = {}) {
  const clean = String(username || '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) throw new Error('A GitHub username is required.');

  if (!isConfigured()) {
    const repos = DEMO_REPOS[clean] || GENERIC;
    return { mode: 'DEMO_DATA', username: clean, repositories: repos.slice(0, limit),
      notice: 'Demo repository data — no GitHub token is configured, so nothing was fetched from github.com.' };
  }

  const c = cfg();
  let raw;
  try {
    const res = await fetch(`${c.api}/users/${encodeURIComponent(clean)}/repos?per_page=${limit}&sort=pushed`, {
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) throw new Error(`GitHub user "${clean}" not found on github.com.`);
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    raw = await res.json();
  } catch (e) {
    // Demo reliability: a bad token, a rate limit or no network must not break the
    // flow on stage. Fall back to labelled demo data and say so plainly.
    if (/not found on github\.com/.test(e.message)) throw e;
    const repos = DEMO_REPOS[clean] || GENERIC;
    return {
      mode: 'DEMO_DATA', username: clean, repositories: repos.slice(0, limit),
      notice: `The GitHub API could not be reached (${e.message}). Showing labelled demo repository data instead — nothing was fetched from github.com.`,
      degraded: true,
    };
  }

  const repositories = raw.filter(r => !r.fork).map(r => ({
    name: r.name, description: r.description || '', language: r.language,
    languages: [r.language].filter(Boolean), stars: r.stargazers_count,
    commits: null, monthsActive: monthsBetween(r.created_at, r.pushed_at),
    hasTests: null, hasReadme: null, readmeQuality: null,
    topics: r.topics || [], pushedAt: (r.pushed_at || '').slice(0, 10), structure: null,
  }));
  return { mode: 'LIVE_API', username: clean, repositories,
    notice: 'Fetched from the GitHub REST API. Commit counts and file structure require additional per-repository calls and are not included here.' };
}

function monthsBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(1, Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24 * 30)));
}

/* ------------------------------------------------- normalise into evidence */
/**
 * Turn repositories into PIE evidence objects.
 * The narrative text is factual and hedged: it lists observed signals, and never
 * asserts skill. The Capability Intelligence Agent decides what it means.
 */
export function toEvidence(repositories, username, mode) {
  return repositories.map(r => {
    const signals = [];
    if (r.languages?.length) signals.push(`Languages observed: ${r.languages.join(', ')}`);
    if (r.topics?.length) signals.push(`Topics: ${r.topics.join(', ')}`);
    if (r.commits != null && r.monthsActive) signals.push(`${r.commits} commits across ${r.monthsActive} active months`);
    else if (r.monthsActive) signals.push(`Active across roughly ${r.monthsActive} months`);
    if (r.hasTests === true) signals.push('Test directory present');
    if (r.hasReadme && r.readmeQuality) signals.push(`README present (${r.readmeQuality} detail)`);
    if (r.structure?.length) signals.push(`Structure: ${r.structure.join(', ')}`);

    return {
      source: 'github',
      verification: mode === 'LIVE_API' ? 'api_derived' : 'self_reported',
      trustTier: mode === 'LIVE_API' ? 'API-DERIVED' : 'SELF-REPORTED',
      title: `github.com/${username} — ${r.name}`,
      text: `${r.description || 'No description provided.'} ${signals.join('. ')}.`,
      date: r.pushedAt || null,
      metrics: {
        commits: r.commits, months_active: r.monthsActive,
        languages: r.languages, readme_quality: r.readmeQuality,
        has_tests: r.hasTests, stars: r.stars,
      },
      importMode: mode,
      caveat: 'Repository activity is supporting evidence for capability. It is not proof of skill, and code quality is not inferred from metadata alone.',
    };
  });
}
