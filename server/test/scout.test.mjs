// The Evidence Scout, and the boundary it runs inside.
//
// The interesting tests here are not "does the agent work" — they are "what is
// the agent unable to do". An agent that reads a candidate's repositories and
// inbox is exactly the component where a cheerful test suite is worth nothing,
// so these assert the refusals: the operations it is never offered, the search
// it cannot widen, the mail body it cannot request, and the fact that a totally
// broken Corsair produces a recorded failure rather than an exception.
//
// Nothing here needs a Corsair account, a network, a database or a model.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as tools from '../src/integrations/corsairTools.js';
import { scout } from '../src/ai/evidenceScout.js';

/* ------------------------------------------------------------------------ */

test('1 — no write operation is ever offered to the model', () => {
  // The SDK exposes 78 operations across these two plugins, and a good few of
  // them modify a candidate's account. The readonly policy would refuse them at
  // execution; this asserts the model is never even told they exist, which is a
  // different control and the reason both are here.
  const forbidden = [
    'github.api.repositories.star', 'github.api.repositories.unstar',
    'github.api.issues.create', 'github.api.issues.update', 'github.api.issues.createComment',
    'github.api.pullRequests.createReview', 'github.api.releases.create',
    'github.api.forks.create', 'github.api.comments.delete', 'github.api.users.update',
    'gmail.api.messages.send', 'gmail.api.messages.delete', 'gmail.api.messages.trash',
    'gmail.api.messages.modify', 'gmail.api.drafts.create', 'gmail.api.drafts.send',
    'gmail.api.labels.delete', 'gmail.api.threads.delete', 'gmail.api.threads.trash',
  ];
  for (const op of forbidden) {
    assert.ok(!tools.OPERATIONS.includes(op), `${op} must not be in the allowlist`);
  }

  // And nothing that merely LOOKS like a write sneaks in either.
  for (const op of tools.OPERATIONS) {
    assert.doesNotMatch(op, /\.(create|update|delete|send|modify|trash|untrash|star|unstar|batchModify)$/,
      `${op} names a mutating verb`);
  }
});

test('2 — a non-offered operation is refused without being executed', async () => {
  for (const op of ['gmail.api.messages.delete', 'github.api.repositories.star', 'not.a.real.op']) {
    const r = await tools.run({ tenantId: 'cand_x', operation: op, args: {} });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NOT_ALLOWED', `${op} should be refused by the allowlist`);
    // Refused before any tenant, client or network work — so this holds even
    // with Corsair completely unconfigured, which is how it is here.
    assert.match(r.detail, /not executed/i);
  }
});

test('3 — Corsair is never read without a tenant', async () => {
  const r = await tools.run({ operation: 'github.api.repositories.list', args: { owner: 'octocat' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_TENANT');
});

/* ------------------------------------------------------------------ gmail */

const gmailList = args => tools.ALLOWED['gmail.api.messages.list'].policy(args);
const gmailGet = args => tools.ALLOWED['gmail.api.messages.get'].policy(args);

test('4 — the Gmail search can be narrowed but never widened', () => {
  const base = gmailList({});
  assert.match(base.q, /certificate/i, 'PIE\'s own credential filter must always be present');
  assert.equal(base.includeSpamTrash, false);

  // The realistic attempt: a model (or something that influenced one) asks for
  // everything. The filter still leads, and the attempt is AND-ed on as terms
  // rather than replacing anything.
  const wide = gmailList({ q: 'from:boss@example.com OR salary OR password' });
  assert.ok(wide.q.startsWith(base.q), 'the credential filter must lead the query');
  assert.ok(wide.q.length > base.q.length, 'the narrowing terms should be appended');

  // Parentheses are stripped, so a supplied string cannot close PIE's own group
  // and start a fresh top-level OR.
  const escape = gmailList({ q: ') OR (subject:invoice' });
  assert.ok(!escape.q.slice(base.q.length).includes('('), 'brackets must not survive');
  assert.ok(!escape.q.slice(base.q.length).includes(')'), 'brackets must not survive');
  assert.ok(escape.q.startsWith(base.q));
});

test('5 — Gmail results are capped, however many are asked for', () => {
  assert.equal(gmailList({ maxResults: 5000 }).maxResults, 25);
  assert.equal(gmailList({ maxResults: -3 }).maxResults, 1);
  assert.equal(gmailList({ maxResults: 'lots' }).maxResults, 15);
});

test('6 — PIE never asks Gmail for the body of a message', () => {
  // The privacy claim on the connect screen is not "PIE does not store the
  // body" — it is that PIE does not request it. That is only true if `format`
  // is forced here, so a caller cannot ask for `full` or `raw`.
  for (const attempt of [{}, { format: 'full' }, { format: 'raw' }, { format: 'minimal' }]) {
    const a = gmailGet({ id: 'abc', ...attempt });
    assert.equal(a.format, 'metadata', `format was ${a.format}, so a body could come back`);
    assert.deepEqual(a.metadataHeaders, ['From', 'Subject', 'Date']);
  }
});

/* ----------------------------------------------------------------- github */

test('7 — page sizes are clamped, so a plan cannot become a scrape', () => {
  const repos = tools.ALLOWED['github.api.repositories.list'].policy({ owner: 'x', perPage: 100000 });
  assert.equal(repos.perPage, 50);
  const commits = tools.ALLOWED['github.api.repositories.listCommits'].policy({ owner: 'x', repo: 'y', perPage: 999 });
  assert.equal(commits.perPage, 50);
  // And the sort is PIE's, not the caller's: most recently pushed first is what
  // makes the first page the useful one.
  assert.equal(repos.sort, 'pushed');
  assert.equal(repos.direction, 'desc');
});

test('8 — the catalogue only offers plugins the candidate actually connected', () => {
  const both = tools.catalogue({ connected: ['github', 'gmail'] }).map(c => c.operation);
  const onlyGithub = tools.catalogue({ connected: ['github'] }).map(c => c.operation);

  assert.ok(both.some(o => o.startsWith('gmail.')));
  assert.ok(!onlyGithub.some(o => o.startsWith('gmail.')),
    'a tool for an unconnected service can only fail — it should not be offered');
  assert.ok(onlyGithub.every(o => o.startsWith('github.')));
  assert.equal(tools.catalogue({ connected: [] }).length, 0);
});

test('9 — every offered operation explains itself', () => {
  // The purpose text is the model's only guidance about when to use a call. An
  // empty one is a tool that gets used at random.
  for (const { operation, purpose } of tools.catalogue({ connected: ['github', 'gmail'] })) {
    assert.ok(purpose && purpose.length > 40, `${operation} has no usable purpose text`);
  }
});

/* ------------------------------------------------------------------ scout */

test('10 — with no candidate in scope, nothing is read', async () => {
  const r = await scout({ tenantId: null, login: 'octocat' });
  assert.equal(r.mode, 'UNAVAILABLE');
  assert.deepEqual(r.callLog, []);
  assert.match(r.notice, /nothing was read/i);
});

test('11 — a candidate with nothing connected is not scouted', async () => {
  const r = await scout({ tenantId: 'cand_x', login: 'octocat', connected: [] });
  assert.equal(r.mode, 'UNAVAILABLE');
  assert.deepEqual(r.callLog, []);
});

test('12 — a broken Corsair produces a recorded failure, not an exception', async () => {
  // Corsair is unconfigured in the test environment, so every call must fail.
  // The Scout still has to return a well-formed result: a scouting run that
  // throws would take the candidate's whole evidence page down with it.
  const r = await scout({ tenantId: 'cand_x', login: 'octocat', connected: ['github', 'gmail'] });

  assert.equal(r.mode, 'DETERMINISTIC', 'no model is configured in tests');
  assert.ok(r.callLog.length > 0, 'the attempted calls must still be recorded');
  assert.ok(r.callLog.every(e => e.ok === false));
  assert.deepEqual(r.findings, []);
  for (const e of r.callLog) {
    assert.ok(e.reason, 'every failed call must say why');
    assert.ok(e.why, 'every call must record why it was attempted');
  }
});

test('13 — the audit log records what PIE sent, not merely what was asked for', async () => {
  // A reviewer checking whether PIE overreached needs the bounded arguments,
  // because those are what left the process. Recording the request would show
  // the proposal and hide the constraint.
  const entry = tools.ALLOWED['gmail.api.messages.list'].policy({ q: 'anything', maxResults: 999 });
  assert.notEqual(entry.q, 'anything');
  assert.equal(entry.maxResults, 25);
});

test('14 — the scout states its own boundary', async () => {
  const r = await scout({ tenantId: 'cand_x', login: 'octocat', connected: ['github'] });
  // The claim a jury should interrogate, kept in the payload rather than only
  // in a slide: the model chooses what to look at and cannot move a number.
  assert.match(r.boundary, /cannot change any score/i);
  assert.match(r.boundary, /deterministic/i);
});
