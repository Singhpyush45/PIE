// Authentication routes — real password auth, plus a separate demo entrance.

import * as db from '../store.js';
import {
  hashPassword, verifyPassword, passwordProblem, usernameProblem,
  createSession, destroySession, destroyAllSessionsFor, findByIdentifier,
  usernameTaken, emailTaken, demoSignIn, cookieOptions, SESSION_COOKIE, pruneSessions,
  createPasswordReset, resolvePasswordReset, completePasswordReset, pruneResets, findByEmail,
} from '../auth.js';
import * as mailer from '../mailer.js';
import { requireAuth, rateLimit, str, bad, isEmail, sanitize, sessionUser } from '../lib.js';

/** Generic on purpose: never confirm whether an identifier exists. */
const INVALID = 'Those credentials do not match an account.';

export function registerAuthRoutes(app) {
  /* ------------------------------------------------------------- register */
  app.post('/api/auth/register', rateLimit(20, 60_000), async (req, res) => {
    const role = str(req.body?.role, 20);
    if (!['candidate', 'recruiter'].includes(role))
      return bad(res, 'Choose whether you are registering as a candidate or a recruiter.');

    const name = sanitize(req.body?.name, 120);
    const username = str(req.body?.username, 32).toLowerCase();
    const email = str(req.body?.email, 200).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : password;

    if (name.length < 2) return bad(res, 'Please enter your full name.');
    const uProblem = usernameProblem(username);
    if (uProblem) return bad(res, uProblem);
    if (!isEmail(email)) return bad(res, 'Please enter a valid email address.');
    const pProblem = passwordProblem(password);
    if (pProblem) return bad(res, pProblem);
    if (password !== confirm) return bad(res, 'The two passwords do not match.');
    if (usernameTaken(username)) return res.status(409).json({ error: 'That username is already taken.' });
    if (emailTaken(email)) return res.status(409).json({ error: 'An account already exists for that email.' });

    const passwordHash = await hashPassword(password);
    let user;

    if (role === 'candidate') {
      const profile = db.insert('candidateProfiles', {
        isDemo: false,
        name,
        headline: sanitize(req.body?.headline, 200) || 'Building a capability profile',
        context: {
          location: sanitize(req.body?.location, 120) || '',
          education: sanitize(req.body?.education, 200) || '',
          priorExperience: sanitize(req.body?.experienceLevel, 200) || '',
          targetRole: sanitize(req.body?.targetRole, 160) || '',
        },
        protectedContext: [], githubUsername: null, githubLogin: null,
        onboardingComplete: false,
      });
      user = db.insert('users', {
        role, name, username, email, passwordHash,
        candidateProfileId: profile.id, isDemo: false,
      });
    } else {
      const orgName = sanitize(req.body?.organization ?? req.body?.organizationName, 160)
        || `${name}'s organization`;
      const org = db.insert('organizations', {
        isDemo: false, name: orgName,
        industry: sanitize(req.body?.industry, 120) || 'Not stated',
        size: 'Not stated', hq: sanitize(req.body?.location, 120) || 'Not stated',
      });
      const recruiter = db.insert('recruiters', {
        isDemo: false, name, username, email,
        title: sanitize(req.body?.title, 120) || 'Recruiter',
        organizationId: org.id,
      });
      user = db.insert('users', {
        role, name, username, email, passwordHash,
        title: recruiter.title, organizationId: org.id, recruiterId: recruiter.id, isDemo: false,
      });
    }

    const { token, expiresAt } = createSession(user, { userAgent: req.headers['user-agent'] });
    res.cookie(SESSION_COOKIE, token, cookieOptions());
    db.audit({ actor: email, actorRole: role, action: 'ACCOUNT_CREATED',
      subjectType: 'user', subjectId: user.id,
      note: `Real ${role} account created. Password stored as a bcrypt hash; the plaintext is never persisted.` });

    res.status(201).json({ token, expiresAt, user: sessionUser(user) });
  });

  /* ---------------------------------------------------------------- login */
  app.post('/api/auth/login', rateLimit(20, 60_000), async (req, res) => {
    const identifier = str(req.body?.identifier ?? req.body?.username ?? req.body?.email, 200);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    // Which door was used. The landing page has one card per role, and an
    // administrator must not fall out of the candidate door.
    const door = str(req.body?.role, 20);
    if (door && !['candidate', 'recruiter', 'admin'].includes(door))
      return bad(res, 'Unknown sign-in role.');
    if (!identifier || !password) return bad(res, 'Enter your username or email, and your password.');

    const user = findByIdentifier(identifier);

    // Demo personas have no password and are not reachable from this form —
    // the same generic error is returned so this endpoint leaks nothing.
    if (!user || user.isDemo || !user.passwordHash) {
      await verifyPassword(password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu');
      return res.status(401).json({ error: INVALID, code: 'INVALID_CREDENTIALS' });
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      db.audit({ actor: identifier, action: 'SIGN_IN_FAILED',
        note: 'Failed password authentication attempt.' });
      return res.status(401).json({ error: INVALID, code: 'INVALID_CREDENTIALS' });
    }

    // The password was right, but for a different workspace. Refuse, and refuse
    // with the SAME message — telling the caller "that is an admin account"
    // would confirm the account exists and name its privilege level. No session
    // is created, so nothing is left behind to resume.
    if (door && user.role !== door) {
      db.audit({ actor: user.email, actorRole: user.role, action: 'SIGN_IN_WRONG_WORKSPACE',
        subjectType: 'user', subjectId: user.id,
        note: `Correct password presented at the ${door} door by a ${user.role} account. Refused.` });
      return res.status(401).json({ error: INVALID, code: 'INVALID_CREDENTIALS' });
    }

    const { token, expiresAt } = createSession(user, { userAgent: req.headers['user-agent'] });
    res.cookie(SESSION_COOKIE, token, cookieOptions());
    db.audit({ actor: user.email, actorRole: user.role, action: 'SIGN_IN',
      subjectType: 'user', subjectId: user.id, note: 'Password authentication succeeded.' });
    pruneSessions();
    res.json({ token, expiresAt, user: sessionUser(user) });
  });

  /* --------------------------------------------------------------- logout */
  app.post('/api/auth/logout', (req, res) => {
    if (req.token) destroySession(req.token);
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
    if (req.user) {
      db.audit({ actor: req.user.email, actorRole: req.user.role, action: 'SIGN_OUT',
        subjectType: 'user', subjectId: req.user.id, note: 'Session ended by the user.' });
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/logout-all', requireAuth, (req, res) => {
    destroyAllSessionsFor(req.user.id);
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req, res) =>
    res.json({ user: sessionUser(req.user), expiresAt: req.session?.expiresAt || null }));

  /* -------------------------------------------------- availability checks */
  app.get('/api/auth/available', rateLimit(120, 60_000), (req, res) => {
    const username = str(req.query?.username, 32).toLowerCase();
    const email = str(req.query?.email, 200).toLowerCase();
    res.json({
      username: username ? { value: username, available: !usernameTaken(username), problem: usernameProblem(username) } : null,
      email: email ? { value: email, available: !emailTaken(email) } : null,
    });
  });

  /* ================================================== PASSWORD RESET ======
     Two endpoints. Neither one ever reveals whether an address has an account:
     the response is identical either way, which is the whole point — a reset
     form is otherwise a free account-enumeration oracle. */

  app.post('/api/auth/forgot', rateLimit(6, 15 * 60_000), async (req, res) => {
    const email = str(req.body?.email, 200).toLowerCase();

    // The same answer for every input, always. Say what WOULD happen, not what did.
    const ALWAYS = {
      ok: true,
      message: 'If an account exists for that email address, a reset link is on its way. '
        + 'The link works once and expires in 45 minutes.',
    };
    if (!isEmail(email)) return res.json(ALWAYS);

    const user = findByEmail(email);
    if (!user) {
      db.audit({ actor: email, action: 'PASSWORD_RESET_REQUESTED',
        note: 'Reset requested for an address with no account. Nothing was sent; the caller was told nothing.' });
      return res.json(ALWAYS);
    }

    const { token, expiresAt } = createPasswordReset(user, {
      ip: req.ip, userAgent: req.headers['user-agent'],
    });
    const base = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5174}`).replace(/\/+$/, '');
    const link = `${base}/?reset=${encodeURIComponent(token)}`;
    const minutes = Math.round((Date.parse(expiresAt) - Date.now()) / 60_000);

    const mail = mailer.resetEmail({ name: user.name, link, minutes });
    const result = await mailer.send({ to: user.email, ...mail });

    if (!result.sent) {
      // No mail server, or it refused. The operator gets the link on the console
      // so the flow still works; the CALLER is told nothing different.
      console.log('\n  ── PASSWORD RESET LINK (no email was sent) ─────────────────────');
      console.log(`     account: ${user.email}`);
      console.log(`     link:    ${link}`);
      console.log(`     reason:  ${result.reason}${result.detail ? ` — ${result.detail}` : ''}`);
      console.log('  ────────────────────────────────────────────────────────────────\n');
    }

    db.audit({ actor: user.email, actorRole: user.role, action: 'PASSWORD_RESET_REQUESTED',
      subjectType: 'user', subjectId: user.id,
      note: result.sent
        ? 'Reset link emailed. The token is stored only as a hash.'
        : `Reset link issued but not emailed (${result.reason}); printed to the server console.` });

    pruneResets();
    res.json(ALWAYS);
  });

  /** Lets the reset screen tell the user a link is stale BEFORE they type a password. */
  app.get('/api/auth/reset/check', rateLimit(60, 60_000), (req, res) => {
    const { error } = resolvePasswordReset(str(req.query?.token, 400));
    res.json({ valid: !error, reason: error || null });
  });

  app.post('/api/auth/reset', rateLimit(10, 15 * 60_000), async (req, res) => {
    const token = str(req.body?.token, 400);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body?.confirmPassword === 'string' ? req.body.confirmPassword : password;

    const { error, row, user } = resolvePasswordReset(token);
    if (error) {
      const message = error === 'EXPIRED'
        ? 'That reset link has expired. Request a new one.'
        : error === 'USED'
          ? 'That reset link has already been used. Request a new one.'
          : 'That reset link is not valid. Request a new one.';
      return res.status(400).json({ error: message, code: error });
    }

    const problem = passwordProblem(password);
    if (problem) return bad(res, problem);
    if (password !== confirm) return bad(res, 'The two passwords do not match.');

    await completePasswordReset(row, user, password);
    // Every existing session for this account is gone, including any an attacker held.
    res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });

    db.audit({ actor: user.email, actorRole: user.role, action: 'PASSWORD_RESET_COMPLETED',
      subjectType: 'user', subjectId: user.id,
      note: 'Password changed via emailed link. All existing sessions were ended.' });

    res.json({
      ok: true,
      message: 'Your password has been changed and every existing session was signed out. You can sign in now.',
      role: user.role,
    });
  });

  /* ====================================================== DEMO ENTRANCE ====
     Deliberately a separate door. Demo personas are never listed on, or
     reachable from, the real sign-in form. */
  app.get('/api/demo/personas', (_req, res) => {
    const users = db.filter('users', u => u.isDemo);
    const shape = u => ({
      id: u.id, role: u.role, name: u.name, username: u.username,
      title: u.title || null,
      organization: u.organizationId ? db.findById('organizations', u.organizationId)?.name : null,
      headline: u.candidateProfileId
        ? db.findById('candidateProfiles', u.candidateProfileId)?.headline : null,
      evidenceCount: u.candidateProfileId
        ? db.filter('evidence', e => e.candidateProfileId === u.candidateProfileId).length : null,
    });
    res.json({
      notice: 'Curated Grand Finale personas. Demo data is stored separately from real accounts — a demo action can never modify a real account, and a real account can never modify a demo persona.',
      candidates: users.filter(u => u.role === 'candidate').map(shape),
      recruiters: users.filter(u => u.role === 'recruiter').map(shape),
      admins: users.filter(u => u.role === 'admin').map(shape),
    });
  });

  app.post('/api/demo/enter', rateLimit(60, 60_000), (req, res) => {
    const result = demoSignIn(str(req.body?.userId, 80));
    if (!result) return res.status(404).json({ error: 'That demo persona does not exist.' });
    res.cookie(SESSION_COOKIE, result.token, cookieOptions());
    db.audit({ actor: result.user.email, actorRole: result.user.role, action: 'DEMO_ENTERED',
      subjectType: 'user', subjectId: result.user.id,
      note: 'Entered the Grand Finale demo as a curated persona. No password was involved; this is not authentication.' });
    res.json({ token: result.token, expiresAt: result.expiresAt, user: sessionUser(result.user) });
  });
}
