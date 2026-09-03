// PIE — proving a candidate owns the email address they typed.
//
// WHAT THIS IS FOR
//   Before this existed, anyone could register as anyone: type a stranger's
//   address, get an account, and every notification about that account goes to
//   a person who never asked for it. For a hiring platform that is worse than
//   untidy — an assessment invitation and a rejection both land in the wrong
//   inbox.
//
// WHAT PROTECTS THE CODE
//   Not the hash. A four-digit code has ten thousand possible values, so any
//   digest of it can be reversed by trying all ten thousand. Saying "the OTP is
//   hashed, therefore it is safe" would be false.
//
//   Three things protect it, and they are the ones that are actually enforced:
//     • it expires in five minutes
//     • five wrong guesses burn it
//     • the stored digest is HMAC'd with a server-side key that is not in the
//       database, so a leaked row cannot be brute-forced offline
//   The hash exists so the code is not sitting in plaintext in a table someone
//   might reasonably open. That is a real benefit and a modest one.
//
// WHAT IT IS NOT
//   Not a third-party service. No Twilio, no Firebase, no Auth0, no Clerk. The
//   code is generated here with crypto.randomInt and sent through PIE's own
//   configured mail transport.

import crypto from 'node:crypto';
import * as db from './store.js';
import { keyedHash, sameHash } from './secrets.js';

/* ------------------------------------------------------------------ policy */
export const POLICY = {
  digits: 4,
  ttlMs: 5 * 60_000,          // the code is dead after five minutes
  maxAttempts: 5,             // five wrong guesses burn it
  resendCooldownMs: 60_000,   // one code a minute
  maxSendsPerHour: 5,         // and five an hour, per address
  ticketTtlMs: 30 * 60_000,   // how long the post-registration ticket lives
};

/* -------------------------------------------------------------------- code */
/**
 * A four-digit code from the CSPRNG.
 *
 * crypto.randomInt, not Math.random and not `randomBytes % 10000`. The first is
 * not a CSPRNG at all; the second is biased, because 256 does not divide evenly
 * into the range and the low values come up slightly more often. With only ten
 * thousand possibilities, a bias is worth avoiding for free.
 */
export const generateCode = () =>
  String(crypto.randomInt(0, 10 ** POLICY.digits)).padStart(POLICY.digits, '0');

const digest = (email, code) => keyedHash(code, `otp:${String(email).toLowerCase()}`);

/* ------------------------------------------------------------------ record */
const rowFor = email =>
  db.find('emailVerifications', r => r.email === String(email).toLowerCase() && !r.consumedAt);

/** Housekeeping. Expired rows have no value and should not accumulate. */
export function prune() {
  const now = Date.now();
  let n = 0;
  for (const r of db.all('emailVerifications')) {
    const dead = new Date(r.expiresAt).getTime() < now - 60 * 60_000;
    if (dead) { db.remove('emailVerifications', r.id); n += 1; }
  }
  return n;
}

/* ----------------------------------------------------------------- request */
/**
 * Issues a fresh code for an address, invalidating any previous one.
 *
 * @returns {{ok:true, code:string, row:object}|{ok:false, reason:string, detail:string, retryInMs?:number}}
 *   The plaintext code is returned to the CALLER so it can be mailed. It is
 *   never stored, never logged, and never returned by any route.
 */
export function request({ email, userId = null, purpose = 'REGISTRATION' }) {
  const addr = String(email || '').toLowerCase().trim();
  if (!addr) return { ok: false, reason: 'NO_EMAIL', detail: 'An email address is required.' };

  const now = Date.now();
  const existing = rowFor(addr);

  if (existing) {
    const since = now - new Date(existing.lastSentAt || existing.createdAt).getTime();
    if (since < POLICY.resendCooldownMs) {
      return { ok: false, reason: 'COOLDOWN', retryInMs: POLICY.resendCooldownMs - since,
        detail: `Please wait ${Math.ceil((POLICY.resendCooldownMs - since) / 1000)} seconds before asking for another code.` };
    }
    const windowStart = now - 60 * 60_000;
    const sends = (existing.sendTimes || []).filter(t => t > windowStart);
    if (sends.length >= POLICY.maxSendsPerHour) {
      return { ok: false, reason: 'TOO_MANY_SENDS',
        detail: 'Too many codes have been requested for this address in the last hour. Please try again later.' };
    }
  }

  const code = generateCode();
  const sendTimes = [...(existing?.sendTimes || []).filter(t => t > now - 60 * 60_000), now];

  // A new code replaces the old one outright, and the attempt counter resets
  // with it — otherwise a candidate who mistyped four times would be locked out
  // of a code they had not even seen yet.
  const fields = {
    email: addr,
    userId,
    purpose,
    codeHash: digest(addr, code),
    expiresAt: new Date(now + POLICY.ttlMs).toISOString(),
    attempts: 0,
    sendTimes,
    lastSentAt: new Date(now).toISOString(),
    verified: false,
    verifiedAt: null,
    consumedAt: null,
    // Proves this browser is the one that just registered, so the code alone is
    // not enough to finish someone else's registration.
    ticketHash: null,
  };

  const row = existing
    ? db.update('emailVerifications', existing.id, fields)
    : db.insert('emailVerifications', fields);

  return { ok: true, code, row };
}

/* ------------------------------------------------------------------ verify */
/**
 * Checks a submitted code.
 *
 * @returns {{ok:true, row:object}|{ok:false, reason:string, detail:string, attemptsLeft?:number}}
 */
export function verify({ email, code }) {
  const addr = String(email || '').toLowerCase().trim();
  const submitted = String(code || '').trim();
  const row = rowFor(addr);

  if (!row) {
    return { ok: false, reason: 'NO_CODE',
      detail: 'There is no active verification code for that address. Request a new one.' };
  }
  if (row.verified) return { ok: true, row, already: true };

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'EXPIRED',
      detail: 'That code has expired. Request a new one — codes are valid for five minutes.' };
  }
  if ((row.attempts || 0) >= POLICY.maxAttempts) {
    return { ok: false, reason: 'TOO_MANY_ATTEMPTS',
      detail: 'Too many incorrect attempts. Request a new code to try again.' };
  }
  if (!/^\d+$/.test(submitted) || submitted.length !== POLICY.digits) {
    // Counted as an attempt: a malformed guess is still a guess.
    db.update('emailVerifications', row.id, { attempts: (row.attempts || 0) + 1 });
    return { ok: false, reason: 'INCORRECT',
      detail: `The code is ${POLICY.digits} digits.`,
      attemptsLeft: Math.max(0, POLICY.maxAttempts - (row.attempts || 0) - 1) };
  }

  if (!sameHash(digest(addr, submitted), row.codeHash)) {
    const attempts = (row.attempts || 0) + 1;
    db.update('emailVerifications', row.id, { attempts });
    const left = Math.max(0, POLICY.maxAttempts - attempts);
    return { ok: false, reason: 'INCORRECT', attemptsLeft: left,
      detail: left
        ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} remaining.`
        : 'That code is not correct, and no attempts remain. Request a new code.' };
  }

  // Correct. The hash is cleared immediately: the row's job is done, and there
  // is no reason to keep even a keyed digest of a code that has been spent.
  const updated = db.update('emailVerifications', row.id, {
    verified: true,
    verifiedAt: new Date().toISOString(),
    codeHash: null,
    attempts: 0,
  });
  return { ok: true, row: updated };
}

/* ------------------------------------------------------------------ ticket */
/**
 * A one-time ticket handed back after a successful verification.
 *
 * Registration does not sign a candidate in. Verifying the code is what does,
 * and this is how the browser proves — without holding the password again —
 * that it is the same browser that just registered. Single use, thirty minutes,
 * bound to the one account.
 */
export function issueTicket(rowId, userId) {
  const ticket = crypto.randomBytes(24).toString('base64url');
  db.update('emailVerifications', rowId, {
    ticketHash: keyedHash(ticket, `ticket:${userId}`),
    ticketExpiresAt: new Date(Date.now() + POLICY.ticketTtlMs).toISOString(),
    userId,
  });
  return ticket;
}

/** Does this ticket belong to this row, and is it still alive? */
export function ticketMatches(row, ticket) {
  if (!row?.ticketHash || !ticket || !row.userId) return false;
  if (new Date(row.ticketExpiresAt || 0).getTime() < Date.now()) return false;
  return sameHash(row.ticketHash, keyedHash(ticket, `ticket:${row.userId}`));
}

/** Spends the ticket, so a replay of the same code cannot sign in twice. */
export function consumeTicket(rowId) {
  db.update('emailVerifications', rowId, {
    ticketHash: null, consumedAt: new Date().toISOString(),
  });
}

/** The open row for an address, or undefined. Never returns a hash to a caller
 *  that has not already earned it — routes read `userId` and nothing else. */
export const openRowFor = email => rowFor(email);

/* -------------------------------------------------------------------- mail */
/** The message a candidate receives. Deliberately free of anything sensitive. */
export function otpEmail({ name, code, minutes = Math.round(POLICY.ttlMs / 60_000) }) {
  const who = name ? `Hello ${name},` : 'Hello,';
  const text = [
    who, '',
    'Your PIE verification code is:', '',
    `    ${code}`, '',
    `This code expires in ${minutes} minutes.`,
    'If you did not create a PIE account, you can ignore this message — no account is activated without it.',
    '', '— PIE, Potential Intelligence Engine',
  ].join('\n');

  const html = `<div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6;color:#1f2430;max-width:520px">
  <p style="margin:0 0 18px">${who}</p>
  <p style="margin:0 0 10px">Your PIE verification code is:</p>
  <p style="margin:0 0 18px;font-size:34px;letter-spacing:10px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>
  <p style="margin:0 0 10px">This code expires in ${minutes} minutes.</p>
  <p style="margin:0 0 18px;color:#606a7b;font-size:13px">If you did not create a PIE account, you can ignore this message — no account is activated without it.</p>
  <p style="margin:0;color:#606a7b;font-size:13px">— PIE, Potential Intelligence Engine</p>
</div>`;

  return { subject: 'PIE Email Verification Code', text, html };
}

/* ------------------------------------------------------------------ status */
/** Never returns a code, a hash or a ticket. Counts and states only. */
export function publicState(email) {
  const row = rowFor(email);
  if (!row) return { pending: false };
  return {
    pending: !row.verified,
    verified: Boolean(row.verified),
    expiresAt: row.expiresAt,
    attemptsLeft: Math.max(0, POLICY.maxAttempts - (row.attempts || 0)),
    resendAvailableAt: new Date(
      new Date(row.lastSentAt || row.createdAt).getTime() + POLICY.resendCooldownMs).toISOString(),
  };
}
