// PIE — durable record of "this integration was actually proven to work".
//
// WHY THIS EXISTS
//   Verification used to live in a module variable. Two consequences, both of
//   which people hit immediately:
//
//     1. `node tools/mail-test.mjs` is a SEPARATE Node process. It proved the
//        credentials, set `verified = true` in its own memory, and exited. The
//        running server never found out, so the page still said "no message has
//        been sent yet" after a successful test.
//     2. Supabase's verify result died on every restart, so someone had to press
//        "Verify connection" again each time the server came up.
//
//   A successful check is a fact about the deployment, not about one process.
//   It belongs on disk.
//
// WHAT IS AND IS NOT REMEMBERED
//   The record says a check SUCCEEDED AT A TIME. It never claims the service is
//   working right now — callers surface the timestamp so a day-old verification
//   reads as a day-old verification. And a record is bound to the configuration
//   it was taken against: change SMTP_HOST or the Supabase URL and the old
//   result stops counting, because it was about a different server.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.PIE_DATA_DIR
  ? path.resolve(process.env.PIE_DATA_DIR)
  : path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../data');
const FILE = path.join(DIR, 'service-checks.json');

/** A short, non-reversible fingerprint of the settings a check was taken against. */
export function fingerprint(parts) {
  return crypto.createHash('sha256')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex').slice(0, 16);
}

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function writeAll(all) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch { /* a read-only disk must not break a working server */ }
}

/**
 * Records the outcome of a real check.
 * `config` is the fingerprint of what was checked, so the result can be
 * invalidated when the settings change.
 */
export function record(key, { ok, detail = null, config = null, meta = null } = {}) {
  const all = readAll();
  all[key] = { ok: Boolean(ok), detail, config, meta, at: new Date().toISOString() };
  writeAll(all);
  return all[key];
}

/**
 * The last recorded check for `key`, or null.
 * Pass the CURRENT config fingerprint: a record taken against different settings
 * is discarded rather than reported, because it was about a different server.
 */
export function read(key, config = null) {
  const row = readAll()[key];
  if (!row) return null;
  if (config && row.config && row.config !== config) return null;
  return row;
}

/** Human-readable age, for surfacing when a verification actually happened. */
export function ageOf(row) {
  if (!row?.at) return null;
  const mins = Math.round((Date.now() - new Date(row.at).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export const CHECK_FILE = FILE;
