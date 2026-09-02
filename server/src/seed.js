// PIE — demo ecosystem seed.
// Builds the multi-org / multi-recruiter / multi-requisition world on top of the
// existing personas and requisitions in data.js. Existing demo personas (Meera,
// Rahul, Arjun, Farah, Nikhil) are preserved verbatim — this only adds around them.

import * as db from './store.js';
import { PERSONAS, REQUISITIONS } from './data.js';

/* ------------------------------------------------------------ organizations */
const ORGS = [
  { id: 'org_illustrative', name: 'Illustrative Enterprise Pvt. Ltd.', industry: 'Enterprise software', size: '1,200 employees', hq: 'Pune, India' },
  { id: 'org_northwind',    name: 'Northwind Data Systems',            industry: 'Data platforms',      size: '340 employees',   hq: 'Bengaluru, India' },
  { id: 'org_meridian',     name: 'Meridian Product Co.',              industry: 'Consumer product',    size: '95 employees',    hq: 'Remote-first, India' },
];

/* ---------------------------------------------------------------- recruiters */
const RECRUITERS = [
  { id: 'rec_ananya', name: 'Ananya Sharma', username: 'ananya', email: 'ananya.sharma@illustrative.co',
    title: 'Senior Technical Recruiter', organizationId: 'org_illustrative' },
  { id: 'rec_rajiv',  name: 'Rajiv Mehta',  username: 'rajiv', email: 'rajiv.mehta@northwind.co',
    title: 'Talent Lead — Engineering', organizationId: 'org_northwind' },
  { id: 'rec_priya',  name: 'Priya Nair',   username: 'priya', email: 'priya.nair@meridian.co',
    title: 'Head of People', organizationId: 'org_meridian' },
];

const ADMINS = [
  { id: 'adm_kavita', name: 'Kavita Rao', username: 'kavita', email: 'kavita.rao@illustrative.co',
    title: 'Trust & Integrity Administrator', organizationId: 'org_illustrative' },
];

/* -------------------------------------------------------------- requisitions */
// The two original requisitions keep their ids and text (matching logic depends on
// the free text), and gain the richer structured fields.
const EXTRA_REQS = [
  {
    id: 'req-dataanalyst', recruiterId: 'rec_rajiv', organizationId: 'org_northwind',
    title: 'Data Analyst', company: 'Northwind Data Systems',
    location: 'Bengaluru (hybrid)', employmentType: 'Full-time',
    experience: '2+ years or demonstrable equivalent', educationRequirements: 'No specific degree required',
    text: `Data Analyst — Northwind Data Systems.

Required:
- Advanced SQL for analysis and query optimisation
- Python for data analysis (pandas)
- Data analysis and clear communication of findings
- Data quality awareness

Preferred:
- Dashboarding and visualisation
- Exposure to cloud data platforms

We assess on demonstrated analysis work. Portfolios, notebooks and open-data projects are accepted
evidence. No minimum years of experience and no degree requirement.`,
  },
  {
    id: 'req-aiengineer', recruiterId: 'rec_rajiv', organizationId: 'org_northwind',
    title: 'AI Engineer', company: 'Northwind Data Systems',
    location: 'Remote (India)', employmentType: 'Full-time',
    experience: '3+ years', educationRequirements: 'Preferably from a top engineering college',
    text: `AI Engineer — Northwind Data Systems.

Required:
- Strong Python
- SQL for data preparation
- Test automation for model pipelines
- CI/CD for reproducible training runs
- Cloud fundamentals

Preferred:
- Docker and containerised inference
- API testing

Candidate requirements:
- 3+ years of continuous experience
- Preferably from a top-tier college
- Must be a digital native comfortable in a young, fast-moving team`,
  },
  {
    id: 'req-backend', recruiterId: 'rec_ananya', organizationId: 'org_illustrative',
    title: 'Backend Developer', company: 'Illustrative Enterprise Pvt. Ltd.',
    location: 'Pune (hybrid) / Remote', employmentType: 'Full-time',
    experience: 'Open — capability assessed directly', educationRequirements: 'None',
    text: `Backend Developer — Illustrative Enterprise.

Required:
- JavaScript and Node.js
- Express / REST API development
- SQL or MongoDB data modelling
- Git and version control fluency

Preferred:
- Docker
- CI/CD
- API testing
- Clear written documentation

We evaluate on demonstrated work. Self-directed projects, open-source contributions and portfolio
work all count as evidence. Career breaks are not a screening criterion.`,
  },
  {
    id: 'req-cloud', recruiterId: 'rec_priya', organizationId: 'org_meridian',
    title: 'Cloud Engineer', company: 'Meridian Product Co.',
    location: 'Remote (India)', employmentType: 'Full-time',
    experience: 'Open', educationRequirements: 'None',
    text: `Cloud Engineer — Meridian Product Co.

Required:
- Cloud fundamentals
- Docker and containers
- CI/CD pipelines
- Git and version control

Preferred:
- Python scripting
- Test automation
- SQL

We hire on demonstrated capability. Show us what you have built.`,
  },
  {
    id: 'req-productanalyst', recruiterId: 'rec_priya', organizationId: 'org_meridian',
    title: 'Product Analyst', company: 'Meridian Product Co.',
    location: 'Remote (India)', employmentType: 'Full-time',
    experience: 'Open', educationRequirements: 'None',
    text: `Product Analyst — Meridian Product Co.

Required:
- SQL
- Data analysis
- Written communication

Preferred:
- Python
- Dashboarding

Evidence of analysis you have actually done matters more than job titles.`,
  },
];

/* --------------------------------------------------------------------- seed */
/**
 * Seeds the DEMO world only.
 *   default        — seed once, if no demo personas exist yet
 *   { force }      — wipe everything (development reset)
 *   { demoOnly }   — reseed demo rows without touching real accounts
 */
export function seedIfEmpty({ force = false, demoOnly = false } = {}) {
  const demoExists = db.all('users').some(u => u.isDemo);
  if (!force && !demoOnly && demoExists) {
    return { seeded: false, counts: db.counts() };
  }
  if (!force && demoOnly && demoExists) {
    return { seeded: false, counts: db.counts() };
  }
  if (force) db.resetAll();

  db.insertMany('organizations', ORGS.map(o => ({ ...o, isDemo: true })));

  /* --- recruiters + their users --- */
  for (const r of RECRUITERS) {
    db.insert('recruiters', { ...r, isDemo: true });
    db.insert('users', {
      id: `usr_${r.id}`, role: 'recruiter', name: r.name,
      username: r.username, email: r.email,
      title: r.title, organizationId: r.organizationId, recruiterId: r.id,
      // Demo identities carry no password: they are reachable only through the
      // explicit Demo entrance, never through the real sign-in form.
      isDemo: true, passwordHash: null,
    });
  }
  for (const a of ADMINS) {
    db.insert('users', {
      id: `usr_${a.id}`, role: 'admin', name: a.name,
      username: a.username, email: a.email,
      title: a.title, organizationId: a.organizationId,
      isDemo: true, passwordHash: null,
    });
  }

  /* --- candidates: preserve the existing personas exactly --- */
  for (const p of PERSONAS) {
    const profile = db.insert('candidateProfiles', {
      id: `cand_${p.id}`, personaId: p.id, name: p.name, headline: p.headline,
      isDemo: true, seeded: true,
      context: p.context, protectedContext: p.protectedContext,
      accommodation: p.accommodation || null,
      githubUsername: (p.evidence.find(e => e.source === 'github')?.title || '')
        .match(/github\.com\/([\w-]+)/)?.[1] || null,
      onboardingComplete: true,
    });
    db.insert('users', {
      id: `usr_cand_${p.id}`, role: 'candidate', name: p.name,
      username: p.id, email: `${p.id}@candidate.demo`,
      candidateProfileId: profile.id, isDemo: true, passwordHash: null,
    });
    for (const e of p.evidence) {
      db.insert('evidence', {
        id: `ev_${p.id}_${e.id}`, candidateProfileId: profile.id, isDemo: true,
        type: e.source, source: e.source, verification: e.verification,
        trustTier: { api_derived: 'API-DERIVED', issuer_verified: 'ISSUER-VERIFIED', self_reported: 'SELF-REPORTED' }[e.verification],
        title: e.title, text: e.text, date: e.date,
        verifyRef: e.verifyRef || null, metrics: e.metrics || null,
        status: 'INGESTED', extractedSignals: null, capabilities: [],
      });
    }
  }

  /* --- requisitions: originals first (ids preserved), then the new ones --- */
  const originals = REQUISITIONS.map(r => ({
    id: r.id,
    recruiterId: 'rec_ananya',
    organizationId: 'org_illustrative',
    title: r.title, company: r.company, location: r.location,
    employmentType: 'Full-time',
    experience: r.id === 'req-sdet' ? '5+ years stated in the JD' : 'Open',
    educationRequirements: r.id === 'req-sdet' ? 'Tier-1 institution preferred (flagged)' : 'None',
    text: r.text, status: 'OPEN', isDemo: true, demoDefault: Boolean(r.demoDefault),
  }));
  db.insertMany('requisitions', [
    ...originals,
    ...EXTRA_REQS.map(r => ({ ...r, status: 'OPEN', isDemo: true, demoDefault: false })),
  ]);

  /* --- a small realistic application pipeline --- */
  const app = (candPersona, reqId, status) => db.insert('applications', {
    isDemo: true,
    candidateProfileId: `cand_${candPersona}`,
    requisitionId: reqId,
    status,
    appliedAt: db.now(),
    assessmentAttemptId: null,
    matchResultId: null,
    decision: null,
  });
  app('meera', 'req-sdet', 'APPLIED');
  app('farah', 'req-sdet', 'APPLIED');
  app('arjun', 'req-sdet', 'APPLIED');
  app('nikhil', 'req-sdet', 'APPLIED');
  app('rahul', 'req-fullstack', 'APPLIED');
  app('arjun', 'req-dataanalyst', 'DISCOVERED');
  app('meera', 'req-backend', 'DISCOVERED');

  db.audit({
    actor: 'system', action: 'DEMO_DATA_SEEDED',
    note: `Seeded ${ORGS.length} organizations, ${RECRUITERS.length} recruiters, ${PERSONAS.length} candidate profiles, ${originals.length + EXTRA_REQS.length} requisitions.`,
  });
  db.persistNow();
  return { seeded: true, counts: db.counts() };
}

export { ORGS, RECRUITERS, ADMINS };
