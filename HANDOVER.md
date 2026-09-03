# PIE — Handover

**Project:** PIE Career Orchestrator · SAP Hackfest 2026, Theme 2 (Inclusive Workforce)
**Team:** Vision Nexus, Galgotias University
**Repo:** `F:\PIE_V3` · **Live:** https://pie-w5w3.onrender.com
**Updated:** 3 September 2026

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
| `cd server && node tools/hana-test.mjs --create` | proves SAP HANA and creates its tables |
| `cd server && node tools/sap-ai-test.mjs --infer` | proves SAP Generative AI Hub |
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
SMTP, Supabase, SAP HANA and SAP AI Core all now require a real call, and the
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

### 3b. SAP HANA is blocked on access the user does not have

**Confirmed, twice.** Signing in to the BTP cockpit as
`rahul.25scse1010427@galgotiasuniversity.ac.in` returns:

> We couldn't find any global accounts associated with your user.

This was also seen earlier on both the APAC and EMEA cockpit regions. It is the
account's real state, not a glitch.

**Both of these are true at once, and it is not a contradiction:**

- HANA Cloud Central works — the user opened `Hackfest-DB` and read its config
- The BTP cockpit reports no global account

The Hackfest practice system is granted through **SAP Learning Hub**, which opens
the tools in a scoped session for that practice system. It does not make the
user's identity a member of the global account. So HANA Cloud Central opens, and
the cockpit does not.

**Consequence: the Service Marketplace and `cf create-service` path is not
available to this user.** Do not send them there again — it was suggested twice
and cannot work without someone granting cockpit access first.

**What is left to try, in order:**

1. **SAP Learning Hub → My Learning → the Hackfest 2026 practice system entry.**
   The "Get started" dialog says "You can find more information about this
   Practice System in your My Learning". Practice systems often publish their
   credentials or an exercise guide there. Not yet checked.
2. **Ask the organisers** — Rahul Sachdev (SAP, sent the access email) or Manish
   Pant (university coordinator). Ask for *either* a HANA service key / database
   user for the app, *or* cockpit access to the subaccount. Also ask whether the
   instance is shared with other teams.

**Do not reset DBADMIN.** The instance may be shared (group numbers appeared as 2
in the organisers' email and 93 in the user's screenshot), and resetting could
lock other teams out.

**Nothing else is blocked by this.** Both SAP adapters are complete and tested;
they need credentials, not code. §3a is unrelated and is the real problem.

### 3b-old. Reference: what the service-key path would have been

Everything for SAP HANA is built and tested. The only thing missing is a database
user, and the user is blocked on finding the cockpit to create one.

**Do not reset DBADMIN.** The Hackfest instance may be shared with other teams
(group numbers appeared as 2 in the organisers' email and 93 in the user's
screenshot). Resetting it could lock other teams out, and it is not needed.

**The right path:** create a `SAP HANA Schemas & HDI Containers` service instance
with plan **`schema`**, then a service key. SAP generates a dedicated user,
password and schema. That is also correct practice — an application should never
connect as the database administrator.

**Their identifiers** (safe to record; these are not secrets):

| | |
|---|---|
| Global Account ID | `1358fa2c-c9d2-4351-b59f-4f020b261b9b` |
| Subaccount ID | `ee0b8b25-c837-4d12-bb07-3e65870ada08` |
| Region | `eu10` (from the HANA endpoint `prod-eu10`) |
| HANA instance | `Hackfest-DB`, Running, 16 GB / 80 GB |
| SQL endpoint | `64e8c26b-3e07-47e9-b246-617058b0306e.hna3.prod-eu10.hanacloud.ondemand.com:443` |
| Allowed connections | Allow all IP addresses ✓ |
| Practice system expires | 16 September 2026 |

Direct cockpit URL:
`https://cockpit.eu10.hana.ondemand.com/cockpit/#/globalaccount/1358fa2c-c9d2-4351-b59f-4f020b261b9b/subaccount/ee0b8b25-c837-4d12-bb07-3e65870ada08`

Then: **Services → Service Marketplace → SAP HANA Schemas & HDI Containers →
Create** (plan `schema`), then **Instances and Subscriptions → the instance →
Create Service Key**.

Or with the cf CLI:
```
cf login -a https://api.cf.eu10.hana.ondemand.com
cf create-service hana schema PIE-DB
cf create-service-key PIE-DB PIE-KEY
cf service-key PIE-DB PIE-KEY
```

Note: **HANA Cloud Central cannot create these.** Its "Schemas & HDI Containers"
page has no Create button — only Instances and Migrations do. The user spent time
looking there.

If the service is absent from the marketplace, the subaccount lacks the
entitlement and only the Hackfest organisers can add it.

**Do not make HANA the system of record.** The practice instance expires on 16
September. PIE writes only its **audit trail and match results** there —
append-only enterprise records. Accounts and evidence stay in PIE's own store.

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

## 4. SAP integration — current state

| Service | State | What is real |
|---|---|---|
| SAP HANA Cloud | Adapter complete, **needs a service-key user** | Real `@sap/hana-client` connection, `verify()` runs a live query, two tables, background writes that never block a request |
| SAP Generative AI Hub | Adapter complete, **needs an AI Core service key** | Real OAuth2 client-credentials flow with token refresh, deployment listing, first in PIE's provider chain |
| SAP Learning Hub | Confirmed | Skill gaps map to learning objectives and hand off to learning.sap.com. No enrolment API is claimed |
| SAP BTP / CAP | Proposed | Adapter interface only |
| SAP Analytics Cloud | Recommended | Rendered in-app today |
| SuccessFactors | Future | Not implemented |

Both new adapters were previously **stubs that reported CONNECTED from
environment variables alone**. The HANA one had no driver at all. Both now
require a real call, and mutation tests confirm the old behaviour fails.

The Generative AI Hub adapter also had a real bug: it used a static bearer token,
but AI Core issues tokens that expire in hours — the AI layer would have died
partway through a demo with unexplained 401s. It now fetches from the service key
and refreshes 60 seconds before expiry.

Environment variable names are in `server/.env.example`. **Never commit values.**

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
- **SAP HANA and SAP AI Core** — adapters finished, blocked on access (§3b).
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
5. SAP HANA and SAP AI Core (§3b) — **blocked on access nobody on the team has.**
   The adapters are finished. Do not spend more time on the cockpit; the next
   move is a message to the organisers, not more configuration.
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
  ai/provider.js               SAP GenAI → OpenAI → Gemini → Ollama → templates
  execution/runner.js          docker arguments and the execute() contract
  integrations/sapHanaRepository.js   real HANA connection, schema, writes
  integrations/sapGenAiHub.js         real OAuth2 to SAP AI Core
  persistence/mirror.js        write-behind Supabase mirror
  persistence/hydrate.js       reads it all back at boot — accounts survive a restart
  persistence/hanaMirror.js    audit + match results into HANA
  persistence/checks.js        durable verification records
  emailVerification.js         four-digit codes: generation, hashing, attempts, tickets
  faceIdentity.js              the template, the comparison, the single-use ticket
  mailer.js                    SMTP and the Resend/Brevo HTTPS APIs
  supabase/003_auth.sql        password hashes, email verification, face_identities
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
