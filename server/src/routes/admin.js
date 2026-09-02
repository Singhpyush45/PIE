// Trust & Integrity Admin workspace routes.
// Bias reviews, locked attempts, proctoring events, human decisions, audit trail.
// Every action here is logged — including the decision to take no action.

import * as db from '../store.js';
import { requireAuth, requireRole, str, bad, publicApp, publicProfile } from '../lib.js';
import { RUNS } from './orchestration.js';

const ACTIONS = ['CLEAR_FOR_EVALUATION', 'REQUEST_RETAKE', 'ESCALATE', 'MARK_UNRESOLVED'];

export function registerAdminRoutes(app) {
  const asAdmin = [requireAuth, requireRole('admin')];

  /* -------------------------------------------------------------- overview */
  app.get('/api/admin/overview', ...asAdmin, (_req, res) => {
    const biasOpen = db.filter('biasAudits', b => b.status === 'OPEN');
    const locked = db.filter('assessmentAttempts', a => a.integrityStatus === 'LOCKED_FOR_REVIEW' || a.requiresHumanReview);
    res.json({
      counts: {
        openBiasReviews: biasOpen.length,
        highSeverityBias: biasOpen.filter(b => b.severity === 'High').length,
        lockedAttempts: locked.length,
        proctoringEvents: db.count('proctoringEvents'),
        humanDecisions: db.count('humanDecisions'),
        auditEvents: db.count('auditEvents'),
      },
      principle: 'A bias signal is an indicator requiring human judgement, never proof. A locked attempt is never an automatic rejection.',
    });
  });

  /* ---------------------------------------------------------- bias reviews */
  app.get('/api/admin/bias', ...asAdmin, (req, res) => {
    const status = str(req.query?.status, 20);
    let rows = db.all('biasAudits');
    if (status) rows = rows.filter(b => b.status === status);
    res.json({
      reviews: rows.slice(-120).reverse().map(b => ({
        ...b,
        candidate: b.candidateProfileId ? db.findById('candidateProfiles', b.candidateProfileId)?.name : null,
        requisition: b.requisitionId ? db.findById('requisitions', b.requisitionId)?.title : null,
      })),
    });
  });

  app.post('/api/admin/bias/:id/action', ...asAdmin, (req, res) => {
    const row = db.findById('biasAudits', req.params.id);
    if (!row) return res.status(404).json({ error: 'Bias review not found.' });
    const action = str(req.body?.action, 40);
    const reason = str(req.body?.reason, 600);
    if (!ACTIONS.includes(action)) return bad(res, `action must be one of ${ACTIONS.join(', ')}`);
    if (reason.length < 3) return bad(res, 'A reason is required — it is recorded in the audit trail.');

    const nextStatus = {
      CLEAR_FOR_EVALUATION: 'CLEARED', REQUEST_RETAKE: 'RETAKE_REQUESTED',
      ESCALATE: 'ESCALATED', MARK_UNRESOLVED: 'UNRESOLVED',
    }[action];
    const updated = db.update('biasAudits', row.id, {
      status: nextStatus, reviewedBy: req.user.name, reviewedAt: db.now(), reviewReason: reason, reviewAction: action,
    });

    // Clearing a high-severity signal unblocks the run for a recruiter decision.
    if (action === 'CLEAR_FOR_EVALUATION' && row.subjectType === 'match') {
      const run = RUNS.get(row.subjectId);
      if (run && run.status === 'BLOCKED_PENDING_INTEGRITY_REVIEW') {
        run.status = 'AWAITING_HUMAN_DECISION';
        run.integrityClearance = { by: req.user.name, at: db.now(), reason };
      }
    }

    db.audit({ actor: req.user.email, actorRole: 'admin', action: `BIAS_REVIEW_${action}`,
      subjectType: 'biasAudit', subjectId: row.id,
      meta: { candidateProfileId: row.candidateProfileId || null },
      note: `${action} — "${reason}". Severity at review: ${row.severity}.` });
    res.json({ review: updated });
  });

  /* ------------------------------------------------------- locked attempts */
  app.get('/api/admin/attempts', ...asAdmin, (_req, res) => {
    const rows = db.all('assessmentAttempts').slice(-120).reverse().map(a => ({
      ...a,
      candidate: db.findById('candidateProfiles', a.candidateProfileId)?.name || null,
      requisition: a.requisitionId ? db.findById('requisitions', a.requisitionId)?.title : null,
      events: db.filter('proctoringEvents', e => e.attemptId === a.id).length,
    }));
    res.json({ attempts: rows });
  });

  app.post('/api/admin/attempts/:id/action', ...asAdmin, (req, res) => {
    const row = db.findById('assessmentAttempts', req.params.id);
    if (!row) return res.status(404).json({ error: 'Attempt not found.' });
    const action = str(req.body?.action, 40);
    const reason = str(req.body?.reason, 600);
    if (!ACTIONS.includes(action)) return bad(res, `action must be one of ${ACTIONS.join(', ')}`);
    if (reason.length < 3) return bad(res, 'A reason is required — it is recorded in the audit trail.');

    const patch = {
      CLEAR_FOR_EVALUATION: { integrityStatus: 'CLEARED', requiresHumanReview: false },
      REQUEST_RETAKE: { integrityStatus: 'RETAKE_REQUESTED' },
      ESCALATE: { integrityStatus: 'ESCALATED' },
      MARK_UNRESOLVED: { integrityStatus: 'UNRESOLVED' },
    }[action];
    const updated = db.update('assessmentAttempts', row.id, {
      ...patch, reviewedBy: req.user.name, reviewedAt: db.now(), reviewReason: reason,
    });

    if (row.applicationId) {
      db.update('applications', row.applicationId, {
        integrityStatus: patch.integrityStatus,
        ...(action === 'REQUEST_RETAKE' ? { status: 'ASSESSMENT_REQUIRED', assessmentAttemptId: null } : {}),
        ...(action === 'CLEAR_FOR_EVALUATION' ? { status: 'UNDER_REVIEW' } : {}),
      });
    }

    db.audit({ actor: req.user.email, actorRole: 'admin', action: `ATTEMPT_${action}`,
      subjectType: 'assessmentAttempt', subjectId: row.id,
      meta: { candidateProfileId: row.candidateProfileId },
      note: `${action} — "${reason}". Warnings at review: ${row.warningCount ?? 0}.` });
    res.json({ attempt: updated });
  });

  /* ---------------------------------------------------- proctoring events */
  app.get('/api/admin/proctoring', ...asAdmin, (req, res) => {
    const attemptId = str(req.query?.attemptId, 60);
    let rows = db.all('proctoringEvents');
    if (attemptId) rows = rows.filter(e => e.attemptId === attemptId);
    res.json({
      events: rows.slice(-300).reverse().map(e => ({
        ...e, candidate: db.findById('candidateProfiles', e.candidateProfileId)?.name || null,
      })),
      notice: 'Derived integrity events only. Raw camera and microphone media is never retained.',
    });
  });

  /* ------------------------------------------------------- human decisions */
  app.get('/api/admin/decisions', ...asAdmin, (_req, res) => {
    res.json({
      decisions: db.all('humanDecisions').slice(-200).reverse().map(d => ({
        ...d,
        candidate: db.findById('candidateProfiles', d.candidateProfileId)?.name || null,
        requisition: d.requisitionId ? db.findById('requisitions', d.requisitionId)?.title : null,
      })),
      notice: 'Every hiring outcome in PIE has a named human reviewer, a timestamp and a reason. AI recommendations are recorded alongside, never as the decision.',
    });
  });

  /* ------------------------------------------------------------ full audit */
  app.get('/api/admin/audit', ...asAdmin, (req, res) => {
    const action = str(req.query?.action, 60);
    let rows = db.all('auditEvents');
    if (action) rows = rows.filter(e => e.action === action);
    res.json({ events: rows.slice(-500).reverse(), actions: [...new Set(db.all('auditEvents').map(e => e.action))].sort() });
  });

  /* --------------------------------------------------------------- people */
  app.get('/api/admin/people', ...asAdmin, (_req, res) => {
    res.json({
      candidates: db.all('candidateProfiles').map(publicProfile),
      recruiters: db.all('recruiters').map(r => ({
        ...r, organization: db.findById('organizations', r.organizationId)?.name || null,
        requisitions: db.filter('requisitions', q => q.recruiterId === r.id).length,
      })),
      applications: db.all('applications').map(publicApp),
    });
  });
}
