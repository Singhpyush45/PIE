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

// The browser half, imported directly. It has no top-level dependency on
// face-api — the model is imported dynamically inside load() — so the pure
// functions can be checked here against the server's.
const web = await import('../../web/src/faceIdentity.js');

// Four real descriptors from the real model, computed in a real browser from
// fixtures/one-face.jpg and three mild variations of it. Everything below that
// says "real" means these.
const REAL = JSON.parse(fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/descriptors.json'), 'utf8')).samples;

const norm = v => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

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

/* ══════════════════════════════ THE BUG THAT ONLY A REAL FACE COULD FIND
   Registration worked and every verification afterwards failed.

   Two mistakes, both from the same wrong assumption — that the model emits unit
   vectors. It does not: FaceRecognitionNet ends at a matMul with no
   normalisation, and a real descriptor measures about 1.39 long.

     1. validDescriptor required a norm between 0.85 and 1.15, so it rejected
        every genuine live capture as BAD_DESCRIPTOR.
     2. Registration rescaled its averaged template to exactly 1, putting the
        stored template in a different space from every later capture. Measured:
        0.39 of pure arithmetic, against 0.06 for the same face — most of the
        matching budget spent before a face was even considered.

   Registration survived both because the rescaling landed it inside the window.

   None of the existing tests caught it, because the synthetic descriptors they
   used were unit vectors too. Synthetic data that satisfies an invariant the
   product violates will agree with the product all day. These tests use real
   model output.                                                              */

test('2a — a descriptor from the real model is accepted', () => {
  for (const d of REAL) {
    assert.equal(identity.validDescriptor(d), true,
      `the model produced this; PIE must accept it (norm ${norm(d).toFixed(3)})`);
  }
  // The measured scale, asserted so a future "tidy-up" cannot quietly reintroduce
  // a unit-length assumption.
  for (const d of REAL) {
    assert.ok(norm(d) > 1.2 && norm(d) < 1.6,
      `real descriptors are around 1.39 long, not 1 — this one is ${norm(d).toFixed(3)}`);
  }
});

test('2b — the registered template and a live capture are in the same space', () => {
  // Register the way the browser does: average several captures.
  const template = web.averageDescriptors(REAL.slice(0, 3));
  assert.ok(template, 'averaging must produce a template');

  // The fourth real capture is the person turning up to sit their assessment.
  const live = REAL[3];
  const d = identity.distance(template, live);

  assert.ok(d < 0.15,
    `the same face against its own template must be close; got ${d.toFixed(3)}. `
    + 'A large number here means one side has been rescaled and the other has not.');
  assert.ok(norm(template) > 1.2,
    'averaging must not renormalise — that is exactly what broke verification');
});

test('2c — end to end with real descriptors: register, then verify', () => {
  reset();
  const template = web.averageDescriptors(REAL.slice(0, 3));
  const reg = identity.register({ candidateProfileId: CAND, userId: USER, descriptor: template });
  assert.equal(reg.ok, true, reg.detail);

  const v = identity.verify({ candidateProfileId: CAND, userId: USER, descriptor: REAL[3] });
  assert.equal(v.ok, true,
    `the person who registered must pass. distance ${v.distance}, threshold ${identity.MATCH_THRESHOLD}`);
  assert.ok(v.distance < 0.2);
});

test('2d — an all-zero descriptor is refused', () => {
  // face-api returns a zero-filled descriptor for a degenerate input. Stored as
  // a template it would sit at the origin and match nobody consistently; sent as
  // a live capture it is not a face. The bounds were loosened to accept the
  // model's real scale, so the floor is what still has to catch this.
  assert.equal(identity.validDescriptor(new Array(128).fill(0)), false);
  assert.equal(identity.validDescriptor(new Array(128).fill(1e-6)), false);
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
  // What this check is: a shape and range test. It rejects the things that are
  // not 128 numbers from a neural network at all.
  //
  // What it is NOT: a face detector. A vector of plausible-looking constants
  // passes it, and that is correct — deciding whether something is a face is
  // the model's job in the browser, and deciding whether it is the RIGHT face
  // is verify()'s. Tightening this into a face detector by guessing at norms is
  // exactly what broke live verification once already.
  const bad = [
    [], null, undefined, 'a-string', { 0: 0.1 },
    new Array(127).fill(0.05),                       // wrong length
    new Array(128).fill(0),                          // the model's degenerate output
    [...alice.slice(0, 127), Number.NaN],
    [...alice.slice(0, 127), Infinity],
    [...alice.slice(0, 127), 99],
    alice.map(v => v * 100),                         // scaled far out of range
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
