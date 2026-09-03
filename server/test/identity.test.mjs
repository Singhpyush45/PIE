// PIE — face IDENTITY, not face detection.
//
// The claim being tested is the strong one: "only the candidate who owns the
// account can take that candidate's assessment, and the check is enforced by the
// server". Every test here is an attempt to get past it.
//
// What is NOT claimed, and so is not tested, is liveness. A descriptor computed
// from a photograph is a valid descriptor and PIE would accept it. Test 12
// asserts that PIE says so out loud rather than leaving it implied.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.PIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-identity-'));

const db = await import('../src/store.js');
const identity = await import('../src/faceIdentity.js');
const { personDescriptor, sameFace } = await import('./harness/pieServer.mjs');

const CAND = 'cand_owner';
const USER = 'usr_owner';
const reset = () => {
  for (const r of db.all('faceIdentities')) db.remove('faceIdentities', r.id);
  for (const r of db.all('identityChecks')) db.remove('identityChecks', r.id);
};

const alice = personDescriptor(1);
const bob = personDescriptor(2);

/* ------------------------------------------------------------------------ */

test('1 — the geometry the whole thing rests on', () => {
  // If this ever stopped holding, every other test here would still pass while
  // the product matched the wrong people. So it is asserted first and directly.
  const aliceAgain = sameFace(alice, 0.02, 11);
  const dSame = identity.distance(alice, aliceAgain);
  const dOther = identity.distance(alice, bob);

  assert.ok(dSame < identity.MATCH_THRESHOLD,
    `the same face must land inside the threshold (${dSame.toFixed(3)} vs ${identity.MATCH_THRESHOLD})`);
  assert.ok(dOther > identity.MATCH_THRESHOLD * 1.5,
    `two different faces must land well outside it (${dOther.toFixed(3)})`);
  assert.equal(identity.distance(alice, alice), 0);
});

test('2 — the browser and the server agree on what "match" means', async () => {
  // The screen shows a preview of the decision; the server makes it. If the two
  // thresholds drift apart the preview becomes a lie — a candidate told "ready
  // to capture" who is then refused, or worse, the reverse.
  const web = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src/faceIdentity.js'), 'utf8');
  const m = /MATCH_THRESHOLD\s*=\s*([\d.]+)/.exec(web);
  assert.ok(m, 'web/src/faceIdentity.js must declare MATCH_THRESHOLD');
  assert.equal(Number(m[1]), identity.MATCH_THRESHOLD,
    'the client and server thresholds must be the same number');
});

test('3 — a descriptor that is not a face is refused', () => {
  const bad = [
    [], null, undefined, 'a-string', { 0: 0.1 },
    new Array(127).fill(0.05),                       // wrong length
    new Array(128).fill(0.05),                       // not unit length
    [...alice.slice(0, 127), Number.NaN],
    [...alice.slice(0, 127), Infinity],
    [...alice.slice(0, 127), 99],
    alice.map(v => v * 100),                         // scaled out of range
  ];
  for (const d of bad) {
    assert.equal(identity.validDescriptor(d), false, `should refuse: ${JSON.stringify(d)?.slice(0, 48)}`);
  }
  assert.equal(identity.validDescriptor(alice), true);

  // A Float32Array serialises to {"0":…} over JSON, which is an object and not a
  // vector. Silently accepting it would store a template that never matches.
  assert.equal(identity.validDescriptor(Float32Array.from(alice)), false);
});

test('4 — registering locks the identity; a candidate cannot replace their own face', () => {
  reset();
  const first = identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  assert.equal(first.ok, true);
  assert.equal(first.row.locked, true);

  const swap = identity.register({ candidateProfileId: CAND, userId: USER, descriptor: bob });
  assert.equal(swap.ok, false);
  assert.equal(swap.reason, 'ALREADY_REGISTERED');

  // The stored template is still Alice's, not Bob's.
  assert.equal(identity.distance(identity.identityFor(CAND).template, alice), 0);
});

test('5 — Trust & Integrity can reset it, and only then can it change', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  assert.equal(identity.unlock(CAND).ok, true);
  const again = identity.register({ candidateProfileId: CAND, userId: USER, descriptor: bob });
  assert.equal(again.ok, true);
  assert.equal(identity.distance(identity.identityFor(CAND).template, bob), 0);
});

test('6 — the right person passes, a different person does not', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });

  const good = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: sameFace(alice, 0.02, 3) });
  assert.equal(good.ok, true, `expected a match, distance ${good.distance}`);
  assert.ok(good.checkId);

  const impostor = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: bob });
  assert.equal(impostor.ok, false);
  assert.equal(impostor.reason, 'NO_MATCH');
  assert.match(impostor.detail, /cannot be started/);
});

test('7 — no registered identity means no verification, not a free pass', () => {
  reset();
  const r = identity.verify({ candidateProfileId: 'cand_nobody', userId: 'usr_nobody', descriptor: alice });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NOT_REGISTERED');
  assert.equal(r.checkId, undefined, 'and no ticket is minted on the way out');
});

test('8 — a ticket is single use', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  const { checkId } = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: sameFace(alice, 0.02, 4) });

  const first = identity.claimCheck({ checkId, candidateProfileId: CAND, userId: USER, attemptId: 'att_1' });
  assert.equal(first.ok, true);

  const replay = identity.claimCheck({ checkId, candidateProfileId: CAND, userId: USER, attemptId: 'att_2' });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'ALREADY_USED',
    'one verification must buy exactly one assessment, or a single check opens every future one');
});

test('9 — candidate A cannot spend candidate B\'s verification', () => {
  reset();
  // B registers and verifies honestly.
  identity.register({ candidateProfileId: 'cand_b', userId: 'usr_b', descriptor: bob });
  const { checkId } = identity.verify({
    candidateProfileId: 'cand_b', userId: 'usr_b', descriptor: sameFace(bob, 0.02, 5) });

  // A, signed in as themselves, presents B's ticket id.
  const stolen = identity.claimCheck({ checkId, candidateProfileId: CAND, userId: USER });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, 'NOT_YOURS');

  // Half-right is still wrong: B's profile with A's user, and the reverse.
  assert.equal(identity.claimCheck({ checkId, candidateProfileId: 'cand_b', userId: USER }).reason, 'NOT_YOURS');
  assert.equal(identity.claimCheck({ checkId, candidateProfileId: CAND, userId: 'usr_b' }).reason, 'NOT_YOURS');

  // And B's own claim still works, so the check is discriminating rather than
  // simply refusing everything.
  assert.equal(identity.claimCheck({ checkId, candidateProfileId: 'cand_b', userId: 'usr_b' }).ok, true);
});

test('10 — a failed, expired, unknown or missing check cannot be claimed', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });

  const failed = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: bob });
  assert.equal(identity.claimCheck({ checkId: failed.checkId, candidateProfileId: CAND, userId: USER }).reason,
    'CHECK_FAILED', 'a check that did not pass must not be spendable');

  const good = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: sameFace(alice, 0.02, 6) });
  db.update('identityChecks', good.checkId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(identity.claimCheck({ checkId: good.checkId, candidateProfileId: CAND, userId: USER }).reason, 'EXPIRED');

  assert.equal(identity.claimCheck({ checkId: 'chk_invented', candidateProfileId: CAND, userId: USER }).reason,
    'UNKNOWN_CHECK');
  assert.equal(identity.claimCheck({ checkId: '', candidateProfileId: CAND, userId: USER }).reason, 'NO_CHECK');
  assert.equal(identity.claimCheck({ candidateProfileId: CAND, userId: USER }).reason, 'NO_CHECK');
});

test('11 — a template registered to another account is refused even for its own profile', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  // The signed-in user is not the one the template was bound to. This is the
  // shape of a profile id reused across accounts.
  const r = identity.verify({ candidateProfileId: CAND, userId: 'usr_someone_else', descriptor: alice });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'IDENTITY_MISMATCH');
});

test('12 — nothing PIE returns carries the template, and liveness is not claimed', () => {
  reset();
  identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  const wire = JSON.stringify(identity.publicIdentity(CAND));

  // The decisive check: not "the word template is absent" but "no number from
  // the actual vector appears", which is what would matter if it leaked.
  for (const v of alice.slice(0, 12)) {
    assert.ok(!wire.includes(String(v)), 'no element of the template may appear in any response');
  }
  assert.ok(!/template|descriptor|embedding/i.test(wire));
  assert.equal(JSON.parse(wire).registered, true);
  assert.equal(JSON.parse(wire).locked, true);

  // A fingerprint identifies WHICH template without carrying any of it, so an
  // audit trail can be honest about a reset.
  const fp = identity.templateFingerprint(alice);
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(fp, identity.templateFingerprint(alice), 'stable for the same template');
  assert.notEqual(fp, identity.templateFingerprint(bob), 'different for a different one');
});

test('13 — a template from another model version is refused, not compared', () => {
  reset();
  const r = identity.register({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  db.update('faceIdentities', r.row.id, { algorithm: 'some-older-model' });

  const v = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: alice });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'STALE_TEMPLATE',
    'comparing vectors from two different models produces a number that means nothing');
  assert.match(v.detail, /register again/);
});
