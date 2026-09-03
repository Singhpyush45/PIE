// PIE — the server half of face verification.
//
// WHY THE COMPARISON IS HERE AND NOT IN THE BROWSER
//   A check the browser performs is a check the browser can be told to skip.
//   Anyone with developer tools can set `matched = true` and walk into an
//   assessment. So the browser's only job is to compute a descriptor from the
//   live camera; this file holds the registered template, decides whether the
//   two are the same person, and hands back a ticket that the assessment routes
//   demand before they will create a session.
//
//   The registered template never travels to the browser. Not on registration,
//   not on verification, not in any serialiser. If it did, "does this match"
//   would become a question the client could answer for itself.
//
// WHAT THIS DOES NOT CLAIM
//   It is not liveness detection and it is not anti-spoofing. The descriptor
//   arrives from the candidate's browser, and a browser can be modified. What
//   this stops is candidate A sitting candidate B's assessment from an ordinary
//   browser, and it stops it at the server rather than in the interface. What it
//   does not stop is a doctored client, or a photograph held to the camera.
//   Those need liveness, which PIE has not implemented and does not pretend to.

import crypto from 'node:crypto';
import * as db from './store.js';

export const ALGORITHM = 'face-api/faceRecognitionNet';
export const TEMPLATE_VERSION = '1';
export const DIMENSIONS = 128;

/**
 * Distance below which two descriptors are the same person.
 *
 * Must equal MATCH_THRESHOLD in web/src/faceIdentity.js. The browser shows a
 * preview of the decision; the server makes it. If the two ever drift, the
 * preview lies — so a test asserts they are equal.
 */
export const MATCH_THRESHOLD = 0.55;

/** How long a passed check is good for, and what it may be used for. */
export const CHECK_TTL_MS = Number(process.env.PIE_IDENTITY_TICKET_TTL_MS || 3 * 60_000);

/* ------------------------------------------------------------- descriptors */
/** A descriptor is 128 finite numbers, roughly unit length. Anything else is
 *  not a face — it is someone poking at the endpoint. */
export function validDescriptor(d) {
  if (!Array.isArray(d) || d.length !== DIMENSIONS) return false;
  let sum = 0;
  for (const v of d) {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 4) return false;
    sum += v * v;
  }
  // The model L2-normalises its output, so a real descriptor has length very
  // close to 1. A loose window here would accept a vector of small constants —
  // which is what an endpoint prober sends — and store it as somebody's face.
  const norm = Math.sqrt(sum);
  return norm > 0.85 && norm < 1.15;
}

export function distance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

/* ------------------------------------------------------------- registration */
export const identityFor = candidateProfileId =>
  db.find('faceIdentities', r => r.candidateProfileId === candidateProfileId);

/**
 * Records a candidate's face template. Once. On purpose.
 *
 * A candidate who can re-register their own face can hand the account to
 * somebody else at any time, which would make every later check meaningless.
 * Re-registration exists, but it is an administrator action with its own audit
 * entry — see `unlock`.
 */
export function register({ candidateProfileId, userId, descriptor, quality = null }) {
  if (!candidateProfileId || !userId) {
    return { ok: false, reason: 'NO_CANDIDATE', detail: 'No candidate account was identified.' };
  }
  if (!validDescriptor(descriptor)) {
    return { ok: false, reason: 'BAD_DESCRIPTOR',
      detail: 'The capture did not produce a usable face template. Try again in better light.' };
  }
  const existing = identityFor(candidateProfileId);
  if (existing && existing.locked !== false) {
    return { ok: false, reason: 'ALREADY_REGISTERED',
      detail: 'An identity is already registered for this account and is locked. '
        + 'Ask Trust & Integrity to reset it if it genuinely needs to change.' };
  }

  const fields = {
    candidateProfileId,
    userId,
    algorithm: ALGORITHM,
    templateVersion: TEMPLATE_VERSION,
    dimensions: DIMENSIONS,
    template: descriptor,
    quality: typeof quality === 'number' ? quality : null,
    locked: true,
    registeredAt: new Date().toISOString(),
    isDemo: false,
  };

  const row = existing
    ? db.update('faceIdentities', existing.id, fields)
    : db.insert('faceIdentities', fields);
  return { ok: true, row };
}

/** Trust & Integrity only. Lets the candidate register once more. */
export function unlock(candidateProfileId) {
  const row = identityFor(candidateProfileId);
  if (!row) return { ok: false, reason: 'NONE' };
  db.remove('faceIdentities', row.id);
  return { ok: true };
}

/* -------------------------------------------------------------- comparison */
/**
 * Compares a live descriptor with the registered template and, on a match,
 * issues a single-use ticket.
 *
 * The ticket is what the assessment routes actually check. It is bound to one
 * candidate, expires in minutes, and is spent the first time it is used — so a
 * successful check cannot be replayed, shared with another account, or held over
 * from yesterday.
 */
export function verify({ candidateProfileId, userId, descriptor, requisitionId = null }) {
  const identity = identityFor(candidateProfileId);
  if (!identity) {
    return { ok: false, reason: 'NOT_REGISTERED',
      detail: 'No identity is registered for this account. Register your identity before starting an assessment.' };
  }
  if (identity.userId && identity.userId !== userId) {
    // The template belongs to a different account than the one signed in.
    return { ok: false, reason: 'IDENTITY_MISMATCH',
      detail: 'That identity does not belong to this account.' };
  }
  if (identity.algorithm !== ALGORITHM || identity.templateVersion !== TEMPLATE_VERSION) {
    return { ok: false, reason: 'STALE_TEMPLATE',
      detail: 'Your registered identity was created with an earlier version of the model and can no longer '
        + 'be compared. Ask Trust & Integrity to reset it so you can register again.' };
  }
  if (!validDescriptor(descriptor)) {
    return { ok: false, reason: 'BAD_DESCRIPTOR',
      detail: 'No usable face was captured. Make sure you are alone, centred and well lit.' };
  }

  const d = distance(identity.template, descriptor);
  const passed = d <= MATCH_THRESHOLD;

  const check = db.insert('identityChecks', {
    candidateProfileId,
    userId,
    requisitionId,
    // Rounded: two decimals is all anyone needs, and a full-precision distance
    // is a small amount of information about the template.
    distance: Math.round(d * 100) / 100,
    threshold: MATCH_THRESHOLD,
    passed,
    expiresAt: new Date(Date.now() + CHECK_TTL_MS).toISOString(),
    consumedAt: null,
    attemptId: null,
  });

  if (!passed) {
    return { ok: false, reason: 'NO_MATCH', checkId: check.id, distance: check.distance,
      detail: 'The person in the camera does not match the registered candidate. This assessment cannot be started.' };
  }
  return { ok: true, checkId: check.id, distance: check.distance,
    detail: 'Identity verified. You are verified to take this assessment.' };
}

/* ----------------------------------------------------------------- tickets */
/**
 * The gate the assessment routes call.
 *
 * Every one of these conditions has an attacker behind it: a ticket that is not
 * yours, a ticket from a failed check, a ticket already spent, a ticket from an
 * hour ago. They are checked one at a time so the audit entry can say which.
 */
export function claimCheck({ checkId, candidateProfileId, userId, attemptId = null }) {
  if (!checkId) {
    return { ok: false, reason: 'NO_CHECK',
      detail: 'This assessment requires identity verification before it can start.' };
  }
  const check = db.findById('identityChecks', checkId);
  if (!check) {
    return { ok: false, reason: 'UNKNOWN_CHECK', detail: 'That identity check is not recognised. Verify again.' };
  }
  // The decisive one: a verification belonging to somebody else is worth nothing
  // here, however valid it is for them.
  if (check.candidateProfileId !== candidateProfileId || check.userId !== userId) {
    return { ok: false, reason: 'NOT_YOURS',
      detail: 'That identity check belongs to a different account.' };
  }
  if (!check.passed) {
    return { ok: false, reason: 'CHECK_FAILED', detail: 'That identity check did not pass.' };
  }
  if (check.consumedAt) {
    return { ok: false, reason: 'ALREADY_USED',
      detail: 'That identity check has already been used. Verify again to start another assessment.' };
  }
  if (new Date(check.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'EXPIRED', detail: 'That identity check has expired. Verify again.' };
  }

  db.update('identityChecks', check.id, { consumedAt: new Date().toISOString(), attemptId });
  return { ok: true, check };
}

/** Housekeeping. A spent or expired check is of no further use. */
export function prune() {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  let n = 0;
  for (const c of db.all('identityChecks')) {
    if (new Date(c.expiresAt).getTime() < cutoff) { db.remove('identityChecks', c.id); n += 1; }
  }
  return n;
}

/* ------------------------------------------------------------------ public */
/**
 * What a candidate is allowed to know about their own identity record.
 *
 * Everything except the one field that matters. There is no shape of API
 * response, for any role, that includes the template.
 */
export function publicIdentity(candidateProfileId) {
  const row = identityFor(candidateProfileId);
  if (!row) {
    return { registered: false, locked: false,
      notice: 'No identity registered yet. You will be asked to register one before your first assessment.' };
  }
  return {
    registered: true,
    locked: row.locked !== false,
    registeredAt: row.registeredAt,
    algorithm: row.algorithm,
    dimensions: row.dimensions,
    notice: 'Your identity is registered and locked. Only Trust & Integrity can reset it.',
  };
}

/** A stable, non-reversible marker for audit lines. Proves a template existed
 *  and that two entries refer to the same one, without carrying any of it. */
export const templateFingerprint = t =>
  (Array.isArray(t)
    ? crypto.createHash('sha256').update(t.map(v => v.toFixed(4)).join(',')).digest('hex').slice(0, 12)
    : null);
