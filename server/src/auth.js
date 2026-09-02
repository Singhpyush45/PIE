// PIE — real password authentication.
//
// • Passwords are hashed with bcrypt. A plaintext password is never stored, never
//   logged, and never returned by any endpoint.
// • Sessions are opaque random tokens delivered as an HTTP-only, SameSite=Lax
//   cookie. JavaScript in the browser cannot read them.
// • Login accepts a username OR an email, plus a password.
// • Demo personas are a separate mechanism (see demoSignIn) and carry no password.

import crypto from 'node:crypto';
import bcryptjs from 'bcryptjs';
import * as db from './store.js';

const bcrypt = bcryptjs.default || bcryptjs;

export const SESSION_COOKIE = 'pie_session';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

/* ------------------------------------------------------------------ hashing */
export const hashPassword = pw => bcrypt.hash(pw, BCRYPT_ROUNDS);
export const verifyPassword = (pw, hash) => (hash ? bcrypt.compare(pw, hash) : Promise.resolve(false));

/** Minimum viable password policy, stated to the user rather than silently enforced. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

export function usernameProblem(u) {
  if (typeof u !== 'string' || u.length < 3) return 'Username must be at least 3 characters.';
  if (u.length > 32) return 'Username must be 32 characters or fewer.';
  if (!/^[a-z0-9_.-]+$/i.test(u)) return 'Username may contain only letters, numbers, dots, hyphens and underscores.';
  return null;
}

/* ----------------------------------------------------------------- sessions */
export function createSession(user, { userAgent } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const row = db.insert('sessions', {
    id: `sess_${crypto.randomUUID().slice(0, 8)}`,
    tokenHash: sha(token),
    userId: user.id,
    role: user.role,
    isDemo: Boolean(user.isDemo),
    userAgent: (userAgent || '').slice(0, 200),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return { token, session: row, expiresAt: row.expiresAt };
}

const sha = v => crypto.createHash('sha256').update(v).digest('hex');

export function resolveSession(token) {
  if (!token) return null;
  const row = db.find('sessions', s => s.tokenHash === sha(token));
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    db.remove('sessions', row.id);
    return { expired: true };
  }
  const user = db.findById('users', row.userId);
  if (!user) { db.remove('sessions', row.id); return null; }
  return { session: row, user };
}

export function destroySession(token) {
  if (!token) return false;
  const row = db.find('sessions', s => s.tokenHash === sha(token));
  if (!row) return false;
  db.remove('sessions', row.id);
  return true;
}

export function destroyAllSessionsFor(userId) {
  for (const s of db.filter('sessions', x => x.userId === userId)) db.remove('sessions', s.id);
}

/** Housekeeping so expired rows do not accumulate in the store. */
export function pruneSessions() {
  const now = Date.now();
  let n = 0;
  for (const s of db.all('sessions')) {
    if (new Date(s.expiresAt).getTime() < now) { db.remove('sessions', s.id); n += 1; }
  }
  return n;
}

export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: SESSION_TTL_MS,
  path: '/',
});

/* ------------------------------------------------------------------- lookup */
/** Find a user by username or email — the single login identifier. */
export function findByIdentifier(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return null;
  return db.find('users', u =>
    (u.username || '').toLowerCase() === id || (u.email || '').toLowerCase() === id);
}

export const usernameTaken = u =>
  Boolean(db.find('users', x => (x.username || '').toLowerCase() === String(u).toLowerCase()));
export const emailTaken = e =>
  Boolean(db.find('users', x => (x.email || '').toLowerCase() === String(e).toLowerCase()));

/* ------------------------------------------------------------- admin seeding */
/**
 * Exactly one administrator, provisioned server-side. There is no public admin
 * registration. The password comes from ADMIN_PASSWORD; if unset, one is generated
 * and printed to the SERVER CONSOLE once — never to the UI, never to an API.
 */
export async function ensureAdminAccount() {
  const email = (process.env.ADMIN_EMAIL || 'admin@pie.local').toLowerCase();
  const username = process.env.ADMIN_USERNAME || 'admin';
  const existing = db.find('users', u => u.role === 'admin' && !u.isDemo);
  if (existing?.passwordHash) return { created: false, username: existing.username };

  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const generated = !process.env.ADMIN_PASSWORD;
  const passwordHash = await hashPassword(password);

  const org = db.find('organizations', o => o.id === 'org_illustrative') || db.all('organizations')[0];
  if (existing) {
    db.update('users', existing.id, { username, email, passwordHash, isDemo: false });
  } else {
    db.insert('users', {
      id: 'usr_admin', role: 'admin', name: process.env.ADMIN_NAME || 'Trust & Integrity Administrator',
      username, email, passwordHash, title: 'Trust & Integrity Administrator',
      organizationId: org?.id || null, isDemo: false,
    });
  }
  db.audit({ actor: 'system', action: 'ADMIN_PROVISIONED', subjectType: 'user', subjectId: 'usr_admin',
    note: 'Administrator account provisioned server-side. There is no public admin registration.' });
  return { created: true, username, email, password, generated };
}

/* -------------------------------------------------------------- demo access */
/**
 * Demo personas have no password by design. Entering the demo is an explicit,
 * separate action — never mixed with real sign-in — and the session is flagged so
 * demo data and real data can never be confused downstream.
 */
export function demoSignIn(userId) {
  const user = db.findById('users', userId);
  if (!user || !user.isDemo) return null;
  return { user, ...createSession(user) };
}

/* ============================================================ PASSWORD RESET
   The token is random, single-use and short-lived. Only its SHA-256 hash is
   stored, so a leaked store cannot be used to reset anyone's password — the
   same reasoning as session tokens. The plaintext exists only inside the email
   we send, and is never logged. */

const RESET_TTL_MS = Number(process.env.RESET_TTL_MINUTES || 45) * 60 * 1000;
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

/** Issues a reset token for a user. Returns the PLAINTEXT token — send it, never store it. */
export function createPasswordReset(user, { ip, userAgent } = {}) {
  // One live token per account: requesting a new link silently retires the old.
  for (const r of db.filter('passwordResets', r => r.userId === user.id && !r.usedAt)) {
    db.update('passwordResets', r.id, { usedAt: new Date().toISOString(), supersededBy: 'NEW_REQUEST' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const row = db.insert('passwordResets', {
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
    usedAt: null,
    requestedIp: ip || null,
    requestedUa: (userAgent || '').slice(0, 200) || null,
    isDemo: Boolean(user.isDemo),
  });
  return { token, id: row.id, expiresAt: row.expiresAt };
}

/** Resolves a plaintext token to its user, or explains why it cannot be used. */
export function resolvePasswordReset(token) {
  if (typeof token !== 'string' || token.length < 20) return { error: 'INVALID' };
  const row = db.find('passwordResets', r => r.tokenHash === sha256(token));
  if (!row) return { error: 'INVALID' };
  if (row.usedAt) return { error: 'USED' };
  if (Date.parse(row.expiresAt) < Date.now()) return { error: 'EXPIRED' };
  const user = db.findById('users', row.userId);
  if (!user || user.isDemo || !user.passwordHash) return { error: 'INVALID' };
  return { row, user };
}

/**
 * Completes a reset: sets the new hash, burns the token, and ends every existing
 * session for that account. If the request came from someone who should not have
 * had it, they are signed out too.
 */
export async function completePasswordReset(row, user, newPassword) {
  const passwordHash = await hashPassword(newPassword);
  db.update('users', user.id, { passwordHash, passwordChangedAt: new Date().toISOString() });
  db.update('passwordResets', row.id, { usedAt: new Date().toISOString() });
  destroyAllSessionsFor(user.id);
  return true;
}

/** Housekeeping, same as sessions. */
export function pruneResets() {
  const now = Date.now();
  for (const r of db.all('passwordResets')) {
    const old = Date.parse(r.expiresAt) < now - 24 * 60 * 60 * 1000;
    if (old) db.remove('passwordResets', r.id);
  }
}

export function findByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  return db.find('users', u => !u.isDemo && String(u.email || '').toLowerCase() === e) || null;
}
