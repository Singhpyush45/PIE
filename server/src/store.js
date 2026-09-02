// PIE — lightweight server-side JSON persistence.
// Deliberately not SQLite: zero native deps, zero migration risk before the Grand
// Finale, and the whole demo state is one inspectable file you can reset or ship.
//
// Every collection is an array of objects with an `id`. Writes are debounced and
// atomic (write temp → rename) so a crash mid-write cannot corrupt the store.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PIE_DATA_DIR || path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'pie.json');

export const COLLECTIONS = [
  'users', 'organizations', 'recruiters', 'candidateProfiles', 'requisitions',
  'applications', 'evidence', 'githubConnections', 'githubRepositories', 'projects',
  'certificates', 'hackathons', 'agentRuns',
  'matchResults', 'assessmentAttempts', 'proctoringEvents', 'biasAudits',
  'humanDecisions', 'learningProgress', 'auditEvents', 'sessions', 'passwordResets',
  // Questions a recruiter wrote themselves, per requisition.
  'recruiterQuestions',
];

const empty = () => Object.fromEntries(COLLECTIONS.map(c => [c, []]));

let db = empty();
let dirty = false;
let timer = null;

/* ------------------------------------------------------------ change feed
   Optional subscribers, notified after a row is written. The mirror uses this
   so store.js needs no knowledge of Supabase, and a subscriber that throws can
   never corrupt a write. */
const subscribers = [];
export function onChange(fn) { if (typeof fn === 'function') subscribers.push(fn); }
function announce(collection, id) {
  for (const fn of subscribers) {
    try { fn(collection, id); } catch { /* a listener must never break a write */ }
  }
}

/* ------------------------------------------------------------------- load */
export function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...empty(), ...raw };
      // Tolerate a store written by an older build that lacks newer collections.
      for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
      return { loaded: true, path: DB_FILE, counts: counts() };
    }
  } catch (e) {
    console.warn(`[store] could not read ${DB_FILE}: ${e.message}. Starting empty.`);
    db = empty();
  }
  return { loaded: false, path: DB_FILE, counts: counts() };
}

/* ------------------------------------------------------------------ write */
function flush() {
  if (!dirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);      // atomic on the same filesystem
    dirty = false;
  } catch (e) {
    console.warn(`[store] write failed: ${e.message}`);
  }
}

function schedule() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 120);
}

export function persistNow() { flush(); }

// Never lose the last few writes on shutdown.
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit']) {
  process.on(sig, () => { flush(); if (sig !== 'beforeExit') process.exit(0); });
}

/* --------------------------------------------------------------- accessors */
export const id = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();

function coll(name) {
  if (!COLLECTIONS.includes(name)) throw new Error(`Unknown collection: ${name}`);
  return db[name];
}

export const all = (name) => coll(name).slice();
export const find = (name, pred) => coll(name).find(pred);
export const findById = (name, itemId) => coll(name).find(r => r.id === itemId);
export const filter = (name, pred) => coll(name).filter(pred);
export const count = (name) => coll(name).length;

export function insert(name, record) {
  const row = { id: record.id || id(name.slice(0, 3)), createdAt: record.createdAt || now(), ...record };
  coll(name).push(row);
  schedule();
  announce(name, row.id);
  return row;
}

export function insertMany(name, records) {
  return records.map(r => insert(name, r));
}

export function update(name, itemId, patch) {
  const row = findById(name, itemId);
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: now() });
  schedule();
  announce(name, itemId);
  return row;
}

export function upsert(name, record) {
  const existing = record.id && findById(name, record.id);
  return existing ? update(name, record.id, record) : insert(name, record);
}

export function remove(name, itemId) {
  const c = coll(name);
  const i = c.findIndex(r => r.id === itemId);
  if (i < 0) return false;
  c.splice(i, 1);
  schedule();
  return true;
}

export function replaceCollection(name, records) {
  db[name] = records.slice();
  schedule();
}

export function counts() {
  return Object.fromEntries(COLLECTIONS.map(c => [c, (db[c] || []).length]));
}

export function resetAll() {
  db = empty();
  schedule();
  flush();
}

/** Raw snapshot — used only by the admin export and the test harness. */
export function snapshot() { return JSON.parse(JSON.stringify(db)); }

/* ------------------------------------------------------------ audit trail */
export function audit(event) {
  return insert('auditEvents', {
    ts: now(),
    actor: event.actor || 'system',
    actorRole: event.actorRole || null,
    action: event.action,
    subjectType: event.subjectType || null,
    subjectId: event.subjectId || null,
    note: event.note || '',
    meta: event.meta || null,
  });
}
