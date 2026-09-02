// PIE — shared server helpers: demo sessions, authorisation middleware, request
// validation, and the mappers that turn persisted rows into API shapes.
// Kept separate from index.js so route modules never import the app itself.

import crypto from 'node:crypto';
import * as db from './store.js';

/* ================================================================ SESSIONS
   Real sessions live in the store and are addressed by an opaque token delivered
   as an HTTP-only cookie. A Bearer header is also accepted so the test suite and
   any future non-browser client can authenticate without a cookie jar. */
import { SESSION_COOKIE, resolveSession } from './auth.js';

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = req.cookies?.[SESSION_COOKIE] || bearer || null;

  req.user = null;
  req.session = null;
  req.token = token;
  req.sessionExpired = false;

  if (!token) return next();
  const resolved = resolveSession(token);
  if (!resolved) return next();
  if (resolved.expired) { req.sessionExpired = true; return next(); }
  req.user = resolved.user;
  req.session = resolved.session;
  next();
}

export const requireAuth = (req, res, next) => {
  if (req.user) return next();
  if (req.sessionExpired)
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'SESSION_EXPIRED' });
  return res.status(401).json({ error: 'Sign in required.', code: 'UNAUTHENTICATED' });
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return requireAuth(req, res, next);
  if (!roles.includes(req.user.role))
    return res.status(403).json({ error: `This action requires the ${roles.join(' or ')} role.`, code: 'FORBIDDEN' });
  next();
};

/* ============================================================ DEMO ISOLATION
   A demo session may only ever touch demo records; a real session may only ever
   touch real records. This is enforced server-side on ownership resolution, not
   by hiding things in the UI. */
export const isDemoSession = req => Boolean(req.user?.isDemo);

/** True when `row` belongs to the same world (demo or real) as the caller. */
export const sameWorld = (req, row) =>
  Boolean(row) && Boolean(row.isDemo) === isDemoSession(req);

/** Scope any collection to the caller's world. */
export const inWorld = (req, rows) => rows.filter(r => Boolean(r.isDemo) === isDemoSession(req));

/** Stamp new records with the caller's world so they can never leak across. */
export const worldStamp = req => ({ isDemo: isDemoSession(req) });

/** Candidate isolation: a candidate may only ever act on their own profile. */
export function ownedProfileId(req, requested) {
  return req.user.role === 'candidate' ? req.user.candidateProfileId : requested;
}

/** Recruiter isolation: a recruiter may only act on requisitions they own. */
export function ownsRequisition(req, requisitionId) {
  const r = db.findById('requisitions', requisitionId);
  if (!r) return { ok: false, code: 404, error: 'Requisition not found.' };
  if (!sameWorld(req, r))
    return { ok: false, code: 404, error: 'Requisition not found.' };
  if (req.user.role === 'admin') return { ok: true, requisition: r };
  if (req.user.role !== 'recruiter' || r.recruiterId !== req.user.recruiterId)
    return { ok: false, code: 403, error: 'This requisition belongs to another recruiter.' };
  return { ok: true, requisition: r };
}

/** Candidate profile access, honouring both isolation rules. */
export function readableProfile(req, profileId) {
  const p = db.findById('candidateProfiles', profileId);
  if (!p) return { ok: false, code: 404, error: 'Candidate not found.' };
  if (!sameWorld(req, p)) return { ok: false, code: 404, error: 'Candidate not found.' };
  if (req.user.role === 'candidate' && p.id !== req.user.candidateProfileId)
    return { ok: false, code: 403, error: 'That profile belongs to another candidate.' };
  return { ok: true, profile: p };
}

/* ------------------------------------------------------ rate limiting (light) */
const hits = new Map();
export const rateLimit = (max, windowMs) => (req, res, next) => {
  const key = `${req.ip}:${req.route?.path || req.path}`;
  const now = Date.now();
  const rec = hits.get(key) || { n: 0, reset: now + windowMs };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
  rec.n += 1; hits.set(key, rec);
  if (rec.n > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  next();
};

/* --------------------------------------------------------------- validation */
export const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max).trim() : '');
export const bad = (res, msg) => res.status(400).json({ error: msg });
export const isEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

export { sanitize, safeFilename } from './sanitize.js';

/* ------------------------------------------------- candidate materialisation */
/** Build the shape the deterministic engine expects from the persisted store. */
export function materializeCandidate(profileId) {
  const p = db.findById('candidateProfiles', profileId);
  if (!p) return null;
  const evidence = db.filter('evidence', e => e.candidateProfileId === profileId).map(e => ({
    id: e.id, source: e.source, verification: e.verification,
    title: e.title, text: e.text, date: e.date,
    verifyRef: e.verifyRef || undefined, metrics: e.metrics || undefined,
  }));
  return {
    id: p.id, personaId: p.personaId, name: p.name, headline: p.headline,
    context: p.context || {}, protectedContext: p.protectedContext || [],
    accommodation: p.accommodation || null,
    githubUsername: p.githubUsername || null,
    onboardingComplete: p.onboardingComplete !== false,
    evidence,
  };
}

/* --------------------------------------------------------------- API shapes */
export const sessionUser = u => ({
  id: u.id, role: u.role, name: u.name,
  username: u.username || null, email: u.email, title: u.title || null,
  organizationId: u.organizationId || null,
  organization: u.organizationId ? db.findById('organizations', u.organizationId)?.name : null,
  candidateProfileId: u.candidateProfileId || null,
  recruiterId: u.recruiterId || null,
  // True only for the curated Grand Finale personas, never for a real account.
  isDemo: Boolean(u.isDemo),
});

export const publicProfile = p => ({
  id: p.id, personaId: p.personaId, isDemo: Boolean(p.isDemo), name: p.name, headline: p.headline,
  context: p.context, protectedContext: p.protectedContext, accommodation: p.accommodation,
  githubUsername: p.githubUsername, githubConnected: Boolean(p.githubLogin),
  githubLogin: p.githubLogin || null,
  onboardingComplete: p.onboardingComplete !== false,
  evidenceCount: db.filter('evidence', e => e.candidateProfileId === p.id).length,
});

export const publicReq = r => ({
  id: r.id, recruiterId: r.recruiterId, organizationId: r.organizationId,
  title: r.title, company: r.company, location: r.location, employmentType: r.employmentType,
  experience: r.experience, educationRequirements: r.educationRequirements,
  requiredSkills: r.requiredSkills || null, preferredSkills: r.preferredSkills || null,
  text: r.text, status: r.status, createdAt: r.createdAt, demoDefault: r.demoDefault,
  recruiterName: db.findById('recruiters', r.recruiterId)?.name || null,
  applicationCount: db.filter('applications', a => a.requisitionId === r.id).length,
});

export const publicApp = a => {
  const cand = db.findById('candidateProfiles', a.candidateProfileId);
  const rq = db.findById('requisitions', a.requisitionId);
  return {
    id: a.id, status: a.status, appliedAt: a.appliedAt,
    candidateProfileId: a.candidateProfileId, candidateName: cand?.name || null,
    requisitionId: a.requisitionId, requisitionTitle: rq?.title || null,
    company: rq?.company || null, recruiterId: rq?.recruiterId || null,
    assessmentAttemptId: a.assessmentAttemptId || null,
    matchResultId: a.matchResultId || null,
    decision: a.decision || null,
    integrityStatus: a.integrityStatus || null,
  };
};

/**
 * A candidate's applications, each carrying the outcome once a human has decided.
 *
 * The outcome is attached here rather than left on the decision record, because
 * a candidate should not have to go looking for the answer — and a rejection
 * that arrives without the reason and the learning pathway is the version of
 * this product PIE exists to replace.
 */
export const candidateApplications = profileId =>
  db.filter('applications', a => a.candidateProfileId === profileId).map(a => {
    const app = publicApp(a);
    const decision = db.filter('humanDecisions', d =>
      d.candidateProfileId === profileId && d.requisitionId === a.requisitionId)
      .sort((x, y) => String(y.at).localeCompare(String(x.at)))[0];
    if (!decision) return app;
    return {
      ...app,
      // The reviewer's private note is NOT included. What the candidate gets is
      // the evidence-grounded outcome computed when the decision was recorded.
      outcome: decision.candidateOutcome || null,
      decidedAt: decision.at || null,
      // NOT `decision`: publicApp already carries that, and other screens read
      // it as the decision OBJECT. Overwriting it with the action string crashed
      // every view that reached for decision.action.
      decisionAction: decision.action || null,
    };
  });

/* --------------------------------------------------------- application state */
export const APPLICATION_STATES = [
  'DISCOVERED', 'APPLIED', 'ASSESSMENT_REQUIRED', 'ASSESSMENT_COMPLETED',
  'UNDER_REVIEW', 'HUMAN_DECISION',
];

export function advanceApplication(applicationId, nextStatus, meta = {}) {
  if (!APPLICATION_STATES.includes(nextStatus)) throw new Error(`Unknown application state ${nextStatus}`);
  return db.update('applications', applicationId, { status: nextStatus, ...meta });
}
