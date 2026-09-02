// Candidate workspace routes: profile, evidence ingestion, applications.

import * as db from '../store.js';
import {
  requireAuth, requireRole, rateLimit, str, bad, sanitize, safeFilename,
  materializeCandidate, publicProfile, publicApp, candidateApplications, publicReq,
  ownedProfileId, advanceApplication, inWorld, sameWorld,
} from '../lib.js';
import * as sapLearningHub from '../integrations/sapLearningHub.js';
import { parseResume } from '../ai/agents.js';

const TRUST = {
  api_derived: 'API-DERIVED', issuer_verified: 'ISSUER-VERIFIED', self_reported: 'SELF-REPORTED',
};

/** Every evidence write funnels through here so trust tier can never be spoofed. */
function addEvidence(profileId, e, { actor, isDemo = false }) {
  const verification = ['api_derived', 'issuer_verified', 'self_reported'].includes(e.verification)
    ? e.verification : 'self_reported';
  const row = db.insert('evidence', {
    candidateProfileId: profileId,
    isDemo: Boolean(isDemo),
    type: e.source, source: e.source,
    verification, trustTier: TRUST[verification],
    title: sanitize(e.title, 240),
    text: sanitize(e.text, 4000),
    date: str(e.date, 10) || null,
    verifyRef: e.verifyRef ? sanitize(e.verifyRef, 120) : null,
    metrics: e.metrics || null,
    status: 'INGESTED',
    importMode: e.importMode || null,
    caveat: e.caveat || null,
    extractedSignals: e.extractedSignals || null,
    capabilities: [],
  });
  db.audit({
    actor, actorRole: 'candidate', action: 'EVIDENCE_ADDED',
    subjectType: 'evidence', subjectId: row.id,
    meta: { candidateProfileId: profileId, source: e.source, trustTier: row.trustTier },
    note: `${row.trustTier} evidence added: ${row.title}`,
  });
  return row;
}

export function registerCandidateRoutes(app) {
  const asCandidate = [requireAuth, requireRole('candidate')];

  /* ------------------------------------------------------------- profile */
  app.get('/api/candidate/profile', ...asCandidate, (req, res) => {
    const p = db.findById('candidateProfiles', req.user.candidateProfileId);
    if (!p) return res.status(404).json({ error: 'Profile not found.' });
    res.json({
      profile: publicProfile(p),
      evidence: db.filter('evidence', e => e.candidateProfileId === p.id),
      applications: candidateApplications(p.id),
    });
  });

  app.patch('/api/candidate/profile', ...asCandidate, (req, res) => {
    const id = req.user.candidateProfileId;
    const patch = {};
    if (req.body?.name) patch.name = sanitize(req.body.name, 120);
    if (req.body?.headline) patch.headline = sanitize(req.body.headline, 200);
    if (req.body?.githubUsername !== undefined)
      patch.githubUsername = sanitize(req.body.githubUsername, 60).replace(/^@/, '') || null;
    if (req.body?.context && typeof req.body.context === 'object') {
      const c = req.body.context;
      patch.context = {
        location: sanitize(c.location, 120),
        education: sanitize(c.education, 200),
        priorExperience: sanitize(c.priorExperience, 200),
        constraints: sanitize(c.constraints, 300),
      };
    }
    if (req.body?.onboardingComplete === true) patch.onboardingComplete = true;
    const updated = db.update('candidateProfiles', id, patch);
    if (!updated) return res.status(404).json({ error: 'Profile not found.' });
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'PROFILE_UPDATED',
      subjectType: 'candidateProfile', subjectId: id, meta: { candidateProfileId: id },
      note: `Fields updated: ${Object.keys(patch).join(', ') || 'none'}` });
    res.json({ profile: publicProfile(updated) });
  });

  /* ------------------------------------------------------------ evidence */
  app.get('/api/candidate/evidence', ...asCandidate, (req, res) =>
    res.json({ evidence: db.filter('evidence', e => e.candidateProfileId === req.user.candidateProfileId) }));

  app.post('/api/candidate/evidence', ...asCandidate, rateLimit(60, 60_000), (req, res) => {
    const source = str(req.body?.source, 30);
    const allowed = ['project', 'certificate', 'hackathon', 'nontraditional', 'resume', 'sap_learning'];
    if (!allowed.includes(source)) return bad(res, `source must be one of: ${allowed.join(', ')}`);
    const title = sanitize(req.body?.title, 240);
    if (title.length < 3) return bad(res, 'Please give this evidence a title.');

    // Only an issuer reference can raise a certificate above self-reported.
    const verification = source === 'certificate' && str(req.body?.verifyRef, 120)
      ? 'issuer_verified' : 'self_reported';

    const row = addEvidence(req.user.candidateProfileId, {
      source, verification, title,
      text: req.body?.text, date: req.body?.date, verifyRef: req.body?.verifyRef,
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
    res.status(201).json({ evidence: row });
  });

  app.delete('/api/candidate/evidence/:id', ...asCandidate, (req, res) => {
    const row = db.findById('evidence', req.params.id);
    if (!row || row.candidateProfileId !== req.user.candidateProfileId)
      return res.status(404).json({ error: 'Evidence not found.' });
    db.remove('evidence', row.id);
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'EVIDENCE_WITHDRAWN',
      subjectType: 'evidence', subjectId: row.id,
      meta: { candidateProfileId: row.candidateProfileId }, note: `Withdrawn: ${row.title}` });
    res.json({ ok: true });
  });

  /* -------------------------------------------------------------- projects */
  app.post('/api/candidate/projects', ...asCandidate, rateLimit(40, 60_000), (req, res) => {
    const name = sanitize(req.body?.name, 160);
    if (name.length < 2) return bad(res, 'A project needs a name.');
    const project = db.insert('projects', {
      candidateProfileId: req.user.candidateProfileId,
      isDemo: Boolean(req.user.isDemo),
      name,
      description: sanitize(req.body?.description, 2000),
      technologies: Array.isArray(req.body?.technologies)
        ? req.body.technologies.slice(0, 20).map(t => sanitize(t, 40)).filter(Boolean) : [],
      role: sanitize(req.body?.role, 120),
      problem: sanitize(req.body?.problem, 1000),
      solution: sanitize(req.body?.solution, 1000),
      repository: sanitize(req.body?.repository, 300),
      demo: sanitize(req.body?.demo, 300),
      outcome: sanitize(req.body?.outcome, 600),
      teamSize: Number.isFinite(+req.body?.teamSize) ? Math.min(500, Math.max(1, +req.body.teamSize)) : null,
      duration: sanitize(req.body?.duration, 80),
      evidenceSource: 'candidate_declared',
    });
    // A project is first-class evidence, so it also enters the evidence stream.
    const parts = [
      project.description, project.problem && `Problem: ${project.problem}`,
      project.solution && `Solution: ${project.solution}`,
      project.technologies.length && `Technologies: ${project.technologies.join(', ')}`,
      project.role && `Role: ${project.role}`,
      project.outcome && `Outcome: ${project.outcome}`,
      project.repository && `Repository: ${project.repository}`,
    ].filter(Boolean);
    const ev = addEvidence(req.user.candidateProfileId, {
      source: 'project', verification: 'self_reported',
      title: project.name, text: parts.join('. '),
      date: new Date().toISOString().slice(0, 7),
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
    db.update('projects', project.id, { evidenceId: ev.id });
    res.status(201).json({ project, evidence: ev });
  });

  app.get('/api/candidate/projects', ...asCandidate, (req, res) =>
    res.json({ projects: db.filter('projects', p => p.candidateProfileId === req.user.candidateProfileId) }));

  /* --------------------------------------------------------- certificates */
  // A certificate is a typed record, not a free-text note: the issuer and the
  // credential reference are what let a recruiter check it themselves. A record
  // WITH a verifiable reference is ISSUER-VERIFIED; without one it stays
  // SELF-REPORTED. PIE never verifies it on the issuer's behalf.
  app.post('/api/candidate/certificates', ...asCandidate, rateLimit(40, 60_000), (req, res) => {
    const title = sanitize(req.body?.title, 200);
    if (title.length < 2) return bad(res, 'A certificate needs a title.');
    const credentialId = sanitize(req.body?.credentialId, 120);
    const verificationUrl = sanitize(req.body?.verificationUrl, 400);
    const verifiable = Boolean(credentialId || /^https?:\/\//i.test(verificationUrl));

    const cert = db.insert('certificates', {
      candidateProfileId: req.user.candidateProfileId,
      isDemo: Boolean(req.user.isDemo),
      title,
      issuer: sanitize(req.body?.issuer, 160),
      issuedOn: sanitize(req.body?.issuedOn, 10),
      credentialId, verificationUrl,
      skills: Array.isArray(req.body?.skills)
        ? req.body.skills.slice(0, 20).map(t => sanitize(t, 40)).filter(Boolean) : [],
      summary: sanitize(req.body?.summary, 1200),
    });

    const parts = [
      cert.issuer && `Issued by ${cert.issuer}`,
      cert.summary,
      cert.skills.length && `Skills covered: ${cert.skills.join(', ')}`,
      credentialId && `Credential ID: ${credentialId}`,
      verificationUrl && `Verify at: ${verificationUrl}`,
    ].filter(Boolean);

    const ev = addEvidence(req.user.candidateProfileId, {
      source: 'certificate',
      verification: verifiable ? 'issuer_verified' : 'self_reported',
      title: cert.issuer ? `${cert.title} — ${cert.issuer}` : cert.title,
      text: parts.join('. '),
      date: cert.issuedOn || new Date().toISOString().slice(0, 7),
      verifyRef: credentialId || verificationUrl || null,
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
    db.update('certificates', cert.id, { evidenceId: ev.id });

    res.status(201).json({
      certificate: cert, evidence: ev,
      notice: verifiable
        ? 'Recorded as issuer-verified: a recruiter can check this reference themselves. PIE does not contact the issuer.'
        : 'Recorded as self-reported. Add a credential ID or verification URL to raise its trust tier.',
    });
  });

  app.get('/api/candidate/certificates', ...asCandidate, (req, res) =>
    res.json({ certificates: db.filter('certificates', c => c.candidateProfileId === req.user.candidateProfileId) }));

  /* ----------------------------------------------------------- hackathons */
  // Hackathons are where a lot of real capability is built and almost no hiring
  // system looks. Typed so the role, the build and the outcome survive intact.
  app.post('/api/candidate/hackathons', ...asCandidate, rateLimit(40, 60_000), (req, res) => {
    const name = sanitize(req.body?.name, 200);
    if (name.length < 2) return bad(res, 'A hackathon needs a name.');

    const hack = db.insert('hackathons', {
      candidateProfileId: req.user.candidateProfileId,
      isDemo: Boolean(req.user.isDemo),
      name,
      organiser: sanitize(req.body?.organiser ?? req.body?.organizer, 160),
      year: sanitize(req.body?.year, 10),
      role: sanitize(req.body?.role, 120),
      project: sanitize(req.body?.project, 200),
      built: sanitize(req.body?.built ?? req.body?.description, 1500),
      achievement: sanitize(req.body?.achievement, 200),
      teamSize: Number.isFinite(+req.body?.teamSize) ? Math.min(50, Math.max(1, +req.body.teamSize)) : null,
      technologies: Array.isArray(req.body?.technologies)
        ? req.body.technologies.slice(0, 20).map(t => sanitize(t, 40)).filter(Boolean) : [],
      link: sanitize(req.body?.link, 400),
    });

    const parts = [
      hack.organiser && `Organised by ${hack.organiser}`,
      hack.role && `Role: ${hack.role}`,
      hack.project && `Built: ${hack.project}`,
      hack.built,
      hack.technologies.length && `Technologies: ${hack.technologies.join(', ')}`,
      hack.achievement && `Outcome: ${hack.achievement}`,
      hack.link && `Link: ${hack.link}`,
    ].filter(Boolean);

    const ev = addEvidence(req.user.candidateProfileId, {
      source: 'hackathon', verification: 'self_reported',
      title: hack.project ? `${hack.name} — ${hack.project}` : hack.name,
      text: parts.join('. '),
      date: hack.year || new Date().toISOString().slice(0, 7),
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
    db.update('hackathons', hack.id, { evidenceId: ev.id });

    res.status(201).json({
      hackathon: hack, evidence: ev,
      notice: 'Recorded as self-reported. A placement is an outcome, not a verified skill — PIE reads what you built, not what you won.',
    });
  });

  app.get('/api/candidate/hackathons', ...asCandidate, (req, res) =>
    res.json({ hackathons: db.filter('hackathons', h => h.candidateProfileId === req.user.candidateProfileId) }));

  /* ---------------------------------------------------------------- resume */
  app.post('/api/candidate/resume', ...asCandidate, rateLimit(15, 60_000), async (req, res) => {
    const text = str(req.body?.text, 40_000);
    const filename = safeFilename(req.body?.filename || 'resume.txt');
    if (text.length < 80)
      return bad(res, 'Paste or upload at least a paragraph of resume text so it can be parsed.');

    const parsed = await parseResume(text);
    const profileId = req.user.candidateProfileId;

    // The resume itself is always recorded as self-reported evidence.
    const ev = addEvidence(profileId, {
      source: 'resume', verification: 'self_reported',
      title: `Resume — ${filename}`,
      text: sanitize(text, 4000),
      date: new Date().toISOString().slice(0, 7),
    }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });

    let structured = null;
    if (parsed.ok && parsed.data) {
      structured = parsed.data;
      db.update('evidence', ev.id, { extractedSignals: structured });
      // Each extracted project becomes its own evidence item, still self-reported.
      for (const p of (structured.projects || []).slice(0, 6)) {
        addEvidence(profileId, {
          source: 'project', verification: 'self_reported',
          title: sanitize(p.name, 160) || 'Project from resume',
          text: `${sanitize(p.description, 1200)} ${Array.isArray(p.technologies) ? `Technologies: ${p.technologies.join(', ')}` : ''}`,
          date: new Date().toISOString().slice(0, 7),
        }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
      }
      for (const c of (structured.certifications || []).slice(0, 6)) {
        addEvidence(profileId, {
          source: 'certificate', verification: 'self_reported',
          title: sanitize(c.title, 160) || 'Certificate from resume',
          text: `Issuer: ${sanitize(c.issuer, 120) || 'not stated'}. ${sanitize(c.year, 20)}`,
          date: /^\d{4}$/.test(str(c.year, 4)) ? `${c.year}-01` : null,
        }, { actor: req.user.email, isDemo: Boolean(req.user.isDemo) });
      }
      if (structured.headline) db.update('candidateProfiles', profileId, { headline: sanitize(structured.headline, 200) });
    }

    res.status(201).json({
      evidence: ev,
      parsed: structured,
      parsedBy: parsed.source,
      notice: parsed.ok
        ? 'Resume parsed into structured evidence. Nothing was invented — fields absent from your resume were left empty.'
        : 'Resume stored as evidence. Structured parsing needs the AI layer, which is currently offline, so no fields were extracted rather than guessed.',
      evidenceCount: db.filter('evidence', e => e.candidateProfileId === profileId).length,
    });
  });

  /* ------------------------------------------------------------- discovery */
  app.get('/api/candidate/jobs', ...asCandidate, (req, res) => {
    const applied = new Set(db.filter('applications', a => a.candidateProfileId === req.user.candidateProfileId)
      .map(a => a.requisitionId));
    res.json({
      requisitions: inWorld(req, db.filter('requisitions', r => r.status === 'OPEN'))
        .map(r => ({ ...publicReq(r), applied: applied.has(r.id) })),
    });
  });

  /* ---------------------------------------------------------- applications */
  app.get('/api/candidate/applications', ...asCandidate, (req, res) =>
    res.json({ applications: candidateApplications(req.user.candidateProfileId) }));

  app.post('/api/candidate/applications', ...asCandidate, rateLimit(30, 60_000), (req, res) => {
    const requisitionId = str(req.body?.requisitionId, 60);
    const requisition = db.findById('requisitions', requisitionId);
    if (!requisition || requisition.status !== 'OPEN')
      return bad(res, 'That role is not open for applications.');
    const profileId = req.user.candidateProfileId;
    if (!db.filter('evidence', e => e.candidateProfileId === profileId).length)
      return bad(res, 'Add at least one piece of evidence before applying — PIE matches on evidence, not on a form.');

    const existing = db.find('applications',
      a => a.candidateProfileId === profileId && a.requisitionId === requisitionId);
    if (existing && existing.status !== 'DISCOVERED')
      return res.status(409).json({ error: 'You have already applied to this role.', application: publicApp(existing) });

    const application = existing
      ? advanceApplication(existing.id, 'APPLIED', { appliedAt: db.now() })
      : db.insert('applications', {
          candidateProfileId: profileId, requisitionId, status: 'APPLIED',
          appliedAt: db.now(), assessmentAttemptId: null, matchResultId: null, decision: null,
        });

    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'APPLICATION_SUBMITTED',
      subjectType: 'application', subjectId: application.id,
      meta: { candidateProfileId: profileId, requisitionId },
      note: `Applied to ${requisition.title} at ${requisition.company}.` });

    res.status(201).json({ application: publicApp(application) });
  });

  /* --------------------------------------------------------------- learning */
  app.get('/api/candidate/learning', ...asCandidate, (req, res) => {
    res.json({
      progress: db.filter('learningProgress', l => l.candidateProfileId === req.user.candidateProfileId),
      provider: sapLearningHub.status(),
      resources: sapLearningHub.fetchCourses(),
    });
  });

  app.post('/api/candidate/learning/progress', ...asCandidate, rateLimit(60, 60_000), (req, res) => {
    const skillId = str(req.body?.skillId, 60);
    const resourceId = str(req.body?.resourceId, 60);
    if (!skillId) return bad(res, 'skillId is required.');
    const row = db.insert('learningProgress', {
      candidateProfileId: req.user.candidateProfileId, skillId, resourceId: resourceId || null,
      state: 'STARTED', declaredAt: db.now(),
      // Completion is never asserted from the provider — this is the honest record.
      completionVerification: 'CANDIDATE_DECLARED',
      notice: 'Candidate-declared progress. PIE verifies capability change through reassessment, not through a provider completion claim.',
    });
    db.audit({ actor: req.user.email, actorRole: 'candidate', action: 'LEARNING_STARTED',
      subjectType: 'learningProgress', subjectId: row.id,
      meta: { candidateProfileId: req.user.candidateProfileId, skillId },
      note: `Learning started for ${skillId}. Completion is not asserted from any external provider.` });
    res.status(201).json({ progress: row });
  });

  /* ------------------------------------------------------------ transparency */
  app.get('/api/candidate/access-log', ...asCandidate, (req, res) => {
    const pid = req.user.candidateProfileId;
    res.json({
      events: db.all('auditEvents').filter(e =>
        e.meta?.candidateProfileId === pid && ['CANDIDATE_VIEWED', 'HUMAN_DECISION_RECORDED', 'MATCH_COMPUTED'].includes(e.action)),
      notice: 'Every recruiter view of your evidence profile and every decision recorded against you appears here.',
    });
  });
}

export { addEvidence };
