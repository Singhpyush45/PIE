# PIE — Handover

**Project:** PIE Career Orchestrator · Hack & Build 2026 (Nagarro, Gurugram)
**Team:** Vision Nexus, Galgotias University
**Repo:** `F:\PIE_V3` · **Live:** https://pie-w5w3.onrender.com
**Updated:** 10 September 2026

This is a handover, not a transcript. It records the decisions that are easy to
undo by accident, the bugs that were subtle, and what is honestly not finished.

**If you are a new session picking this up: read §2 and §3 first.** §3 is the
open problem the user is currently stuck on.

---

## 1. Run it

```
cd F:\PIE_V3\web
npm install            # once — web/node_modules was missing for a long time

cd F:\PIE_V3
npm start              # builds the frontend, THEN starts the server
```

`npm start` from the **root** builds first. `cd server && npm start` only starts
the server and serves whatever is already in `web/dist` — that is why UI changes
appeared to do nothing for a whole day. The server now warns when the bundle is
stale, and a busy port explains itself instead of printing a stack trace.

| Command | What it does |
|---|---|
| `npm start` (root) | build + server |
| `npm run start:api` | server only, no rebuild |
| `cd server && npm test` | 11 test files, each in its own process |
| `node uiwalk.mjs` | 40 browser checks, every screen and every tab |
| `node assesswalk.mjs` | 16 checks, the full assessment flow |
| `node recruiterwalk.mjs` | 7 checks, question authoring and modes |
| `cd server && node tools/mail-test.mjs` | proves SMTP and records it |
| `cd server && node tools/corsair-test.mjs` | proves the Corsair key with a real call |
| `cd server && node tools/supabase-doctor.mjs` | diagnoses Supabase |

Green as of this writing: **11/11 test files, 40 + 16 + 7 browser checks, 0 console errors.**

---

## 2. Do not undo these

Each looks simplifiable. Each was written after something broke, and most have a
test that fails if reverted.

**The LLM never touches a number.** Every score, gap, ranking and bias signal is
computed in `server/src/agents.js` with no model involved. The AI layer
(`server/src/ai/agents.js`) reads the finished result and writes English. This is
the product's main claim.

**`publicAttempt` and `publicQuestion` are allowlists, not denylists.** They used
to spread the attempt and delete known-bad keys; then generated questions started
living on the attempt and the spread serialised every answer key to the browser.

**Hidden test cases are masked in two places** — the question envelope and the
finalised answer. Removing either leaks them. Both have tests.

**Face detection memory must stay at 1.** `web/src/faceWatch.js` →
`instantiate_detection_memory(1)`. At 4 it accumulates confidences across frames
and reports **one person as two** — a false breach that locks honest candidates
out, and only those with something face-like behind them. Measured: memory=4 gave
`[1,2,2,2,2,2,2,2]` for a single face. `facedetect.test.mjs` reads this constant.

**`CONF = 5.0` was calibrated on real photographs**, not guessed. True faces score
7.5–25; false positives scored 0.7 and 3.0.

**The decision-brief agents are never given identity or pedigree.** No name, no
institution, no history. `brief.test.mjs` passes those in deliberately and asserts
they are not forwarded.

**Candidate code never runs in the server process.** A child there inherits the
environment: Supabase service key, model keys, session secret.
`execution.test.mjs` asserts every container isolation flag.

**A coding answer PIE cannot score is `pending`, never 0.** Zero says "the
candidate got it wrong", which is a different and false statement.

**Integration adapters must never claim CONNECTED from environment variables.**
SMTP, Supabase and Corsair all require a real call, and the
result is recorded in `server/data/service-checks.json`, keyed to a fingerprint of
the settings it was taken against. Change the host and the old pass stops
counting. Reverting any of this fails 3+ tests per adapter.

---

**The identity gate is enforced on the server, in `routes/assessment.js`
`/api/assessment/start`.** Every condition there has an attacker behind it. A
check moved into the browser, or a `claimCheck` made advisory, is a gate that
developer tools can walk through. `gate.test.mjs` is twelve attempts to get past
it; two deliberate mutations were run to confirm it fails when the gate is
weakened.

**A registered face is locked and a candidate cannot replace their own.** There is
no route that does it. A candidate who could re-register at will could hand the
account to somebody else the day before an assessment. Resetting is a Trust &
Integrity action with its own audit entry.

**`passwordHash` is mirrored to Supabase and session tokens are not.** That
distinction is the whole of the mirror's secrets policy: a bcrypt hash is a
verifier and cannot be replayed against PIE; a session token IS the credential.
Removing the hash from the mirror silently recreates the original production bug.

**Email verification is enforced only where mail can actually be sent.** With no
transport configured PIE does not require a code, because a gate nobody can pass
is an outage rather than security — and it says so in the integrity panel.

**`rateLimit` keys on the signed-in account, not the IP, for authenticated
routes.** Behind Render's proxy every candidate can arrive with the same
`req.ip`, so an IP-keyed limit on an authenticated endpoint is a limit shared by
everyone at once.

---

**`test/run.mjs` clears SMTP, mail-API and Supabase variables before starting
the shared test server, and that is load-bearing.** Without it the suite reads
whatever is in the developer's own `server/.env`: a machine with real SMTP
credentials sees sixteen failures in `auth.test.mjs` (registration correctly
withholds the session, so `cand.data.user` is null) and a machine without sees
none. A real Supabase project would be read *and written to* by a test run. The
configured mail path is still covered — `otphttp` and `gate` each start their
own PIE with a fake SMTP server.

**The Python execution tests skip rather than fail when there is no interpreter,
and the probe asks Python to print a marker rather than checking that the command
exists.** Windows ships an App Execution Alias for `python` and `python3` that is
not an interpreter. A command-exists check is satisfied by it, and then two of
those tests PASS for the wrong reason — they assert something scores zero, and a
missing interpreter also scores zero.

---

**`EMAIL_VERIFICATION=off` exists so nobody has to delete the OTP feature to
escape a broken mail server.** A configured-but-failing SMTP leaves a candidate
with an account they cannot use, and the instinct is to rip the feature out.
The switch turns off the whole step — registration signs candidates in, no code
is sent, and every gate behind it stops demanding a verified email, so the dead
end does not simply move to the assessment screen. It is never the default and
it is reported as `OFF` on its own line in the integrity panel, because a check
that has been switched off is a reduction in what PIE claims.

---

## 3. THE OPEN PROBLEMS

### 3a. Live data does not survive a restart — SOLVED IN CODE, needs SQL

**This was the big one and it is fixed.** What remains is four SQL files.

**What was wrong.** `server/src/store.js` reads and writes `server/data/pie.json`
on the local filesystem. Render's filesystem is ephemeral: wiped on every deploy,
every restart, and every cold start after the free instance spins down. The file
disappears, `seedIfEmpty()` runs, and the store is demo data again. Meanwhile
Supabase was receiving writes and **nothing ever read from it** — a write-behind
mirror with no read half, which is why creating a Supabase project changed
nothing on its own.

**What was built.**

- `server/src/persistence/hydrate.js` — pulls every mirrored collection back at
  boot, parents first, running the mirror's own mapping tables backwards so the
  two directions cannot drift apart. It **merges**: a row already in the local
  store wins, nothing is overwritten, nothing is deleted.
- Called from `server/src/index.js` **before** `seedIfEmpty()` and before the
  mirror subscribes, so restored rows are not immediately pushed back out as if
  they were new writes.
- The mirror now carries `password_hash`. It did not, and that was the hidden
  half of the bug: an account restored without its hash comes back as a user who
  exists and can never sign in again. `hydrate.test.mjs` test 2 stages exactly
  that failure so nobody removes it again.
- Mirroring is now **on by default** whenever Supabase is configured. It used to
  be opt-in, which meant a configured database that stayed empty and a restore
  that found nothing — with no error anywhere.
- Demo rows are no longer mirrored. `seed.js` regenerates them for free, and
  pushing them accumulated a fresh set of orphans in Supabase on every restart.

**What is still needed:** run the four SQL files in order (see DEPLOYMENT.md),
especially `003_auth.sql` — without it the restore brings accounts back with no
password hash and the failure is silent.

### 3c. GitHub OAuth is broken on the live site

`githubOAuth.js:19-20` falls back to `http://localhost:5174/api/github/callback`
when `GITHUB_CALLBACK_URL` is unset, so the live site redirects to localhost.

Two changes, both needed:
- Render env: `GITHUB_CALLBACK_URL=https://pie-w5w3.onrender.com/api/github/callback`
  and `APP_BASE_URL=https://pie-w5w3.onrender.com`
- The GitHub OAuth App's own **Authorization callback URL** must match

### 3d. Email on Render — SOLVED IN CODE, needs configuration

Render blocked outbound SMTP ports 25/465/587 on free web services from
26 September 2025. Gmail SMTP works locally and will not work there — it does not
fail fast, it hangs until the timeout, with credentials that are perfectly
correct.

`server/src/mailer.js` now speaks the **Resend** and **Brevo** HTTPS APIs
directly, in about sixty lines and with no new dependency. Set
`MAIL_HTTP_PROVIDER`, the provider key and `MAIL_FROM` and that path is used in
preference to SMTP. Set neither and nothing third-party is contacted.

The usual remaining cause of failure is the sender domain: these providers only
send from a domain you own and have verified with them. A `gmail.com` sender is
rejected.

`node tools/mail-test.mjs you@example.com` sends a real message on whichever
transport is configured and records the result, so the running server's integrity
panel updates without a restart.

---

## 4. Corsair — current state

PIE moved off SAP on 10 September, when the SAP Hackfest ended and the project was
entered into **Hack & Build 2026** (Nagarro, Gurugram, 12 September). That event
asks for Corsair-powered capabilities, so every SAP adapter, screen, test, tool
and document was removed rather than left dormant.

**What exists.** `server/src/integrations/corsair.js` — the client, `verify()`,
and a `status()` that reports CONNECTED only after a real call comes back. GitHub
evidence prefers Corsair's synced data when configured.

**What is deliberate.** Corsair is preferred, never required. `fetchRepositories`
tries Corsair, then GitHub's own API, then labelled demo fixtures, and names the
source it used. An integration two days old must not be able to break evidence
import on the morning of a demo.

**What is missing.** A Corsair account. Until `CORSAIR_API_KEY` exists the adapter
has never made a call, and the Integrations screen says exactly that. Prove it
with `node tools/corsair-test.mjs` before relying on it — a key in `.env` is not a
working integration, which is the lesson SAP HANA taught this project the hard way.

**Where the value is, for a pitch.** Not "we added an integration". PIE's reasoning
was never the hard part; getting a candidate's real work out of the tools they
already use is. Corsair collapses OAuth-per-service, token refresh and a client per
API into one shape, and its synced database turns evidence gathering from a fan-out
of live calls into a local read.

---

## 5. What was built in this session (3 September)

Four things, in this order, all tested.

**Durable accounts (Phase 0).** `persistence/hydrate.js`, `003_auth.sql`, the
password hash added to the mirror, mirroring on by default, demo rows kept local.
9 tests in `hydrate.test.mjs`, including the mutation that proves the hash is what
carries it.

**Email OTP (Phase 1).** `emailVerification.js` — four digits from
`crypto.randomInt`, HMAC'd with a server-side key so a leaked row cannot be
brute-forced, five-minute expiry, five attempts, one code a minute and five an
hour. A candidate gets **no session at all** until the code is accepted; the
ticket issued at registration binds the verification to that browser, so a guessed
code alone cannot take over an account. Recruiter and admin sign-in untouched.
`otp.test.mjs` (12) and `otphttp.test.mjs` (9, over real SMTP to a fake server
this repo starts).

**Mail over HTTPS.** `mailer.js` now speaks Resend and Brevo, because Render
blocks SMTP. No new dependency; nothing contacted unless configured.

**Face identity (Phases 2–4).** `web/src/faceIdentity.js` computes a 128-number
descriptor with `@vladmandic/face-api` (MIT, weights served locally from
`web/public/face/models`, lazily loaded as its own 1.3 MB chunk).
`server/src/faceIdentity.js` holds the template, makes the comparison, and issues
a single-use ticket bound to one candidate. `/api/assessment/start` refuses to
create an attempt without one. `identity.test.mjs` (13) and `gate.test.mjs` (12,
every request one an attacker could send with curl).

Also: `rateLimit` keyed per account rather than per IP, which matters behind a
proxy; `test/harness/pieServer.mjs` so a test can bring up a PIE with a working
mailbox.

**State:** 16/16 test files, 40/40 uiwalk, 16/16 assesswalk, 7/7 recruiterwalk,
0 console errors, web build clean.

---

## 6. Bugs found and fixed (the non-obvious ones)

| Symptom | Actual cause |
|---|---|
| Decision tab white screen | `<Skeleton>` used in `panels.jsx` without importing it. Build passes; an undefined identifier is a runtime error |
| UI changes did nothing | `cd server && npm start` never rebuilds `web/dist`, and `web/node_modules` had never been installed |
| Step circle overlapping the card | Card `top: 106`, stepper `bottom: 106` — zero gap, plus a 4 px focus ring |
| Role cards ragged widths | `.repocard` is a `<button>`; buttons shrink-to-fit even at `display:flex` |
| Tests failed on Windows only | Generated import paths used raw `F:\...`; backslashes are escape sequences in a JS string. Also the fake docker was a bash script |
| Test files interleaving | `--test-concurrency=1` was not respected. Each file now runs in its own process |
| Every rejection had an empty learning path | The agent emits `objectives`; `pathway` is metadata. The test fixture used the wrong shape, so the test passed while production was empty |
| Applications page crash | `candidateApplications` overwrote `publicApp.decision` (an object other screens read) with a string |
| One face reported as two | Detection memory accumulating — see §2 |

**The lesson worth keeping:** several of these passed the test suite. A fixture
that does not match production proves nothing, and a walk that never clicks a tab
cannot see it crash. `uiwalk.mjs` now clicks every tab.

---

### The face-verification bug, and why the tests missed it

Registration worked. Every verification afterwards failed. Both mistakes came
from one wrong assumption — that the model emits unit vectors.

It does not. `FaceRecognitionNet.forwardInput` ends at a matMul with no L2
normalisation, and a real descriptor measures about **1.39** long. Measured, in
a real browser, on a real face:

```
raw descriptor norm                 1.390
same face, raw vs raw mean          0.058
same face, raw vs UNIT-normalised   0.393   <- six times larger, pure arithmetic
```

1. `validDescriptor` required a norm between 0.85 and 1.15, so it rejected every
   genuine live capture as `BAD_DESCRIPTOR`.
2. `averageDescriptors` rescaled the registered template to exactly 1, putting
   the stored template in a different space from every later capture.

Registration survived both, because the rescaling landed its template inside the
window. That is why the failure looked like it was about the assessment step.

**The tests did not catch it because the synthetic descriptors were unit vectors
too.** Test data that satisfies an invariant the product violates will agree with
the product all day. `test/fixtures/descriptors.json` now holds four descriptors
from the real model, `test/harness/pieServer.mjs` generates at the measured
scale, and `server/tools/face-descriptor-probe.mjs` regenerates the fixture if
the model ever changes. Two mutations were run to confirm the new tests fail when
either mistake is put back.

`TEMPLATE_VERSION` is now `2`. A template stored under `1` cannot be compared, so
`/api/assessment/identity/verify` clears it, records the reset, and asks the
candidate to register again — rather than refusing them forever with a message
about their face.

---

## 7. What is honestly not done

- **Liveness / anti-spoofing does not exist.** Face verification compares the live
  capture with the registered template. It cannot tell a live person from a
  photograph or a video held up to the camera. This is stated on the identity
  screen, in `/api/candidate/identity`, and in the code, and `gate.test.mjs`
  test 11 asserts PIE keeps saying it. **Never describe this as anti-spoofing.**
- **The descriptor is computed in the browser.** The comparison is on the server,
  against a template the browser never receives, which is what stops candidate A
  sitting candidate B's assessment from an ordinary browser. It does not stop a
  modified client submitting a descriptor derived from a photo of the candidate.
  That needs liveness.
- **Docker untested on the demo machine.** The sandbox was verified through a test
  double and the harnesses run directly; no real container was ever started.
- **GitHub import reads repository metadata only** — languages and top-level file
  names. `commits` is `null`, no source code. If a judge asks how PIE knows a
  candidate can code, this is the weak answer.
- **OTP records are not mirrored to Supabase.** A five-minute code is cheaper to
  resend than to replicate. If the instance restarts mid-registration the
  candidate presses Resend. Face templates *are* mirrored — an identity that does
  not survive a restart is not an identity.
- **Corsair** — adapter finished, never called. No account exists yet (§4).
- Mirror needs `002_mirror.sql` re-run: `proctoring_events.legacy_attempt_id` is missing.

---

## 8. Priority order

1. **Run the four SQL files on Supabase** (DEPLOYMENT.md, DO THIS 1). Everything
   in §3a is code-complete and does nothing until `003_auth.sql` exists.
2. **Configure email over HTTPS** (DEPLOYMENT.md, DO THIS 2). Without it the
   OTP feature is inert on the live site — and PIE correctly stops enforcing
   email verification rather than locking every candidate out.
3. **GitHub callback env vars** (§3c) — ten minutes.
4. **Verify on the deployed instance**, especially the restart test. It is the
   one people skip and the one that matters.
5. Corsair (§4) — **create the account and prove the key.** The adapter is done;
   an unproven integration is worth nothing on stage.
6. GitHub source-code import; liveness detection.

---

## 9. Where things live

```
server/src/
  agents.js                    deterministic agents — every score
  orchestrator.js              pipeline, dependency order, audit trail
  assessment.js                policy, bank, blueprint, grading, public serialisers
  assessmentAI.js              question generation, validation, modes, languages
  ai/agents.js                 narration + decision briefs
  ai/provider.js               OpenAI → Gemini → Ollama → templates
  execution/runner.js          docker arguments and the execute() contract
  integrations/corsair.js      Corsair client, verify(), honest status()
  integrations/githubEvidenceAdapter.js  Corsair → GitHub API → demo fixtures
  persistence/mirror.js        write-behind Supabase mirror
  persistence/hydrate.js       reads it all back at boot — accounts survive a restart
  persistence/checks.js        durable verification records
  emailVerification.js         four-digit codes: generation, hashing, attempts, tickets
  faceIdentity.js              the template, the comparison, the single-use ticket
  mailer.js                    SMTP and the Resend/Brevo HTTPS APIs
  supabase/003_auth.sql        password hashes, email verification, face_identities
  tools/corsair-test.mjs       proves the Corsair key with a real call
web/src/
  assessmentUI.jsx             consent, preflight, IDENTITY, live attempt, result
  faceWatch.js                 face PRESENCE during an attempt (pico.js) — counts faces
  faceIdentity.js              face IDENTITY — the 128-number descriptor. Different job.
  identityUI.jsx               registration and the pre-assessment check
  panels.jsx                   decision panel, decision brief
web/public/face/               pico.js + cascade
web/public/face/models/        face-api weights (6.8 MB, MIT), served locally, offline-safe
server/test/                   16 files
  harness/pieServer.mjs        a throwaway PIE with a working mailbox
architecture.html              the architecture page
```

---

*Everything in §2 has a test behind it. If you change one of those and the suite
goes red, the test is right and the change is wrong.*
