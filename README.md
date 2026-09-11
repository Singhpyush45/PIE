# PIE — Potential Intelligence Engine
### Career Orchestrator · Hack & Build 2026 — inclusive, evidence-first hiring

**Potential over pedigree. AI recommends. Recruiters decide.**

PIE does not simply rank candidates. It discovers capability from evidence, explains the reasoning,
identifies development gaps, builds personalised pathways, matches people to opportunities
inclusively — and keeps a human in control of every decision that affects a livelihood.

---

## Run it

```bash
cd server && npm install && npm start        # → http://localhost:5174
```

Open **http://localhost:5174**. The UI is pre-built and served by the API — **one port, one process.**

Frontend development with hot reload:
```bash
cd web && npm install && npm run dev         # → http://localhost:5173 (proxies /api)
```

Tests (API must be running):
```bash
cd server && npm test        # 40 API guarantees
node uiwalk.mjs              # 38-check browser regression walk (from the project root)
```

**No keys are required.** Everything below works offline.

### Configuration — `server/.env`

A ready-to-edit `server/.env` ships with the project. Open it, paste your values, restart.

```bash
# after editing server/.env
cd server && npm start          # the banner tells you what it picked up
cd server && npm run env:check  # or check without starting: prints key NAMES, never values
```

The server loads `server/.env` (then a root `.env`) using Node's built-in parser — no dependency,
nothing to install. Real shell variables win over the file, so `OPENAI_API_KEY=… npm start` still works.

On startup you get an honest banner:

```
  env: loaded .env
  env: AI provider → OPENAI_API_KEY set
  AI: OpenAI [LIVE]
```

**The only line you probably need is `OPENAI_API_KEY=`.** Everything else can stay blank — an empty
integrations block is the honest default, and the Integrations screen reports NOT_CONFIGURED
rather than pretending. `server/.env` is git-ignored; never commit it or paste it into a chat.

The file is grouped so you only read the part you need:

| Section | Variables | Blank means |
|---|---|---|
| 1. AI provider | `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `AI_TIMEOUT_MS` | deterministic engine + template narration |
| 2. Accounts | `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_TTL_HOURS`, `TOKEN_ENCRYPTION_KEY` | admin password generated once to the console; encryption key generated to `data/.token-key` |
| 3. GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL`, `GITHUB_TOKEN` | Connect GitHub offers labelled demo repositories |
| 4. Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_MIRROR` | PIE persists to `server/data/pie.json` |
| 5. Email (SMTP) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `RESET_TTL_MINUTES`, `APP_BASE_URL` | reset links are printed to the server console instead of emailed |
| 6. Corsair | `CORSAIR_API_KEY`, `CORSAIR_SIGNING_SECRET`, `CORSAIR_KEK`, `CORSAIR_DATABASE_URL` (all four, plus `supabase/004_corsair.sql`) | GitHub evidence falls back to PIE's own adapter |
| 7. Server | `PORT`, `PIE_DATA_DIR`, `NODE_ENV` | port 5174, local data directory, development cookies |

`server/.env.example` is the same file with the same comments, safe to commit.

---

## Accounts

PIE has **two separate doors**, and the landing page shows both without mixing them.

### Real accounts (password authentication)

Register as a **Candidate** or a **Recruiter** from the landing page and sign in with either your
**username or your email**. Passwords are hashed with bcrypt; the plaintext is never stored, never
logged and never returned by any endpoint. Sessions are opaque tokens delivered in an HTTP-only,
SameSite=Lax cookie — the token itself is stored only as a SHA-256 hash on the server.

A real account starts genuinely empty. Demo data is invisible to it, and it is invisible to the demo.

### The administrator (Trust & Integrity)

There is **no public sign-up** for the administrator — the card offers *Sign in* only. The account is
provisioned server-side on first boot and its credentials are printed **once, to the server console**:

```
  ── ADMINISTRATOR ACCOUNT (server console only — never shown in the UI) ──
     username: admin
     email:    admin@pie.local
     password: <generated>
```

Set `ADMIN_PASSWORD` in `server/.env` to choose your own, delete `server/data/pie.json`, and restart.

### One door per role

The landing page has one card per workspace, and the server enforces it. A correct password
presented at the wrong card is refused — an administrator cannot fall out of the candidate door.
The refusal uses the **same message as a wrong password**, because "that is an administrator
account" would confirm both that the account exists and what privilege it holds.

### Forgotten passwords

**Forgot password?** on the sign-in screen emails a reset link.

- The response is **identical** whether or not an account exists for that address. A reset form
  that says "no such user" is a free list of who has an account — and on a hiring platform, of who
  is job-hunting.
- The link is **single-use** and expires in 45 minutes (`RESET_TTL_MINUTES`). Only a SHA-256 hash of
  the token is stored, so a leaked store cannot reset anyone's password.
- Requesting a new link retires the previous one.
- Completing a reset **ends every existing session** for that account, including an attacker's.
- With **no SMTP configured** the flow still works end to end: PIE issues a valid link and prints it
  to the server console, and the UI says nothing different. The demo never depends on a mail server.

Gmail needs an **App Password** (2-Step Verification → App passwords), not your normal password.
See section 5 of `server/.env`.

### The Grand Finale demo

Behind its own door, **Enter demo** offers the curated personas. No password is involved and PIE says
so — this is an account picker, not authentication. Personas never appear on the landing page and can
never be signed into through the real login form.

| Role | Persona | What they see |
|---|---|---|
| **Recruiter** | Ananya Sharma | Data Quality / SDET + Backend Developer requisitions |
| Recruiter | Rajiv Mehta | Data Analyst + AI Engineer |
| Recruiter | Priya Nair | Cloud Engineer + Product Analyst |
| **Candidate** | Meera Kulkarni | The Grand Finale persona |
| Candidate | Farah Sheikh, Arjun Deshmukh, Nikhil Rao, Rahul Verma | Contrast cases |
| **Trust & Integrity** | Kavita Rao | Bias reviews, locked attempts, decisions, audit |

### Two worlds that cannot touch each other

Every row carries an `isDemo` flag and every read is filtered through it.

- A real recruiter cannot orchestrate against a demo candidate, even by guessing the id (404).
- A demo session cannot see, read or modify a real account.
- **Reset demo** wipes and reseeds the demo world only. Real accounts, evidence and decisions —
  and your current session — survive it untouched.

---

## Evidence types

Every source is a typed record, and every record carries a **trust tier** the candidate can see and
cannot fake.

| Source | Record | Trust tier |
|---|---|---|
| **Resume** | text + parsed fields (parsing needs the AI layer) | `SELF-REPORTED` |
| **GitHub** | typed repository records: languages, commits, months active, tests, README quality | `API-DERIVED` with a real OAuth connection, `SELF-REPORTED` from demo fixtures |
| **Project** | name, role, problem, solution, technologies, outcome, repository, team size, duration | `SELF-REPORTED` |
| **Certificate** | title, issuer, issue date, credential ID, verification URL, skills covered, what it required | `ISSUER-VERIFIED` when a credential ID or verification URL is supplied, otherwise `SELF-REPORTED` |
| **Hackathon** | name, organiser, year, role, project, how you built it, technologies, outcome, team size, link | `SELF-REPORTED` |
| **Non-traditional** | volunteering, community work, study during a caregiving period, mentoring | `SELF-REPORTED` |

Two deliberate lines:

- **PIE never verifies a certificate on the issuer's behalf.** A credential reference raises the tier
  because a *recruiter* can follow it, not because PIE checked. The UI says so as you type.
- **A hackathon placement is an outcome, not a skill.** PIE reads what you built and what you owned.
  An unplaced hackathon where you shipped something hard is stronger evidence than a win where you
  did not.

The **candidate journey** — account, profile, resume, GitHub, projects/certificates/hackathons,
capability profile, job matching, skill gap and learning, assessment, recruiter decision — is
rendered on the dashboard with each step's state derived from the candidate's own data, so "what do I
do next?" always has an answer on screen. The steps can be done in any order; PIE reasons over
whatever exists and an incomplete profile is never held against anyone.

A real candidate gets a capability profile **without waiting for anyone to be hiring.** With no open
requisition in their world, PIE still runs Capability Intelligence and says plainly that matching and
learning pathway need a role a recruiter has posted.

---

## Connecting GitHub

**Connect GitHub** starts the real OAuth web flow when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
are set: the candidate is redirected to **github.com's own consent screen**, approves, and is returned
to PIE. The code-for-token exchange happens server-side; the browser never sees a token, and no token
ever appears in a URL.

- **Scope requested: `read:user` only.** PIE cannot push, modify, delete, or read private
  repositories. The consent screen says so in those words before the candidate clicks.
- The access token is encrypted at rest with **AES-256-GCM** and stored with a short fingerprint, so
  the UI can prove a connection exists without ever handling the token.
- **Disconnect** destroys the stored credential whether or not GitHub confirms the revocation, and
  asks the candidate whether to keep or delete the evidence already imported.
- With no OAuth app configured, **Connect GitHub** offers clearly-labelled demo repositories instead
  and the UI states that plainly. Demo-sourced evidence is always `SELF-REPORTED`, never
  `API-DERIVED`.

CSRF is handled with a short-lived, single-use `state` bound to the signed-in user; a forged or
replayed state is refused.

---

## Architecture

```
                          PIE ORCHESTRATOR
                                 |
         +-------------+---------+---------+-------------+
         |             |                   |             |
   Capability     Explainability      Career Roadmap   Inclusive
   Intelligence       Agent               Agent        Matching
      Agent                                              Agent
```

**Four specialised agents** are the core AI model, each with its own isolated system instruction and
structured JSON output — never one prompt pretending to be four.

**Orchestrator services** (not agents) supply the rest: JD Requirement Extraction, Employer Readiness,
Bias Audit, and the Human-in-the-Loop gate.

> **Agent mapping.** The pitch deck names four agents; the architecture names six functions
> for Theme 2. PIE keeps the four agents and implements the remaining handbook functions as services
> with identical rigour — manifests, scoped inputs, validation, audit. The mapping is rendered on the
> **Orchestrator run** screen so a juror asking *"where are the six agents?"* gets the answer on
> screen: Skills Discovery → Capability Intelligence · Market Intelligence → JD Requirement Extraction
> · Learning Pathway → Career Roadmap · Inclusive Matching · Employer Readiness · Bias Audit · HITL.

### Selective invocation

The orchestrator does **not** run every agent for every operation:

| Trigger | Pipeline |
|---|---|
| `RESUME_UPLOADED` / `GITHUB_CONNECTED` / `EVIDENCE_ADDED` | Capability Intelligence only |
| `RECRUITER_CREATES_JD` | JD Requirements → Employer Readiness → Bias Audit |
| `CANDIDATE_APPLIES` | Capability → JD → Matching → Explainability |
| `ASSESSMENT_COMPLETED` | Everything except Employer Readiness |
| `FULL_ORCHESTRATION` | All seven steps |

Skipped steps render as *"Not required"* with the reason, rather than silently disappearing.

### Division of labour (why the demo cannot fail)

- The **deterministic engine** computes every number: capability confidence, dimensions, match score,
  coverage, gap severity, bias signals.
- The **LLM agents** add interpretation: transferable skills, non-traditional evidence signals,
  plain-language reasoning, roadmap sequencing.
- An LLM may never emit a score, ranking or decision. The orchestrator's `llm_did_not_emit_scores`
  validator drops any numeric field it tries to return.

---

## Grand Finale demo flow

A **Grand Finale demo** screen ships in the app (top bar) with all 23 beats, the line to say on each,
and a *Go* button that jumps to the right screen. Summary:

1. **Recruiter → Overview** — five candidates, one role. Watch who ends up on top.
2. **Candidate pool** — Nikhil (tier-1, resume claims everything, all self-reported) ranks **fourth**,
   below Farah, Meera and Arjun who can *evidence* their skills. That inversion is the product.
3. **Compare** — same axes, same scales, equal-height cards; "different shapes, both valid".
4. **Meera's profile** — the handbook's named persona: a woman re-entering in a tier-2 city.
5. **Capability Intelligence** — Problem Solving is *gated*, not inferred from keywords. Growth
   Readiness is the number a resume cannot express.
6. **Explainability** — why matched → what the gap is → what to do, each line clickable to evidence.
7. **Career Roadmap** — prioritised skills, projects that produce verifiable evidence, milestones.
8. **Requisition → Employer Readiness** — **inclusion 0.19, six barriers.** "No career gaps."
   "Tier-1 institution." "Digital native." The bias was never in Meera.
9. **Inclusive Matching** — both scores shown, never blended; 19 attributes withheld and verified.
10. **Switch to Meera** — her gap and pathway are hers regardless of any shortlist.
11. **Learning pathway**, with the honest completion notice — PIE only claims to verify what it reassesses.
12. **Assessment** — consent → device check → **isolated mode** (sidebar gone) → integrity warning
    *"1 of 5, here's what happened and what to do"*.
13. **Reassess** — new evidence, orchestrator re-runs, match moves, a gap closes.
14. **Bias Audit → Trust & Integrity review → Human decision → Audit trail.**
15. **Integrations.**

**Closing line:** *"PIE didn't decide to hire Meera. It made her visible, told her exactly what to
learn, told the employer their job description was the problem — and then got out of the way."*

---

## Browser and security limitations (stated, not hidden)

A normal browser **cannot** close other tabs, close desktop applications, disable extensions, or
guarantee device lockdown. PIE never claims otherwise. What it actually uses:

- `getUserMedia` for a real camera preview and camera/microphone track state
- `visibilitychange`, window blur/focus, and `fullscreenchange`
- a server-authoritative clock (the client renders a countdown; it cannot pause, extend or replay it)
- single-use, short-lived JIT question tokens
- forward-only state machine — a finalised question can never be reopened
- derived integrity events only; **raw camera and microphone media is never retained**

The consent screen discloses all of it before anything is monitored, and the assessment states
plainly that extension activity cannot be fully verified in a normal browser — full lockdown needs a
secure browser or managed exam environment.

**Face detection is a clearly-labelled simulation layer.** No face-detection model is bundled. The
live screen exposes explicit *Simulate* controls, and every simulated event is stored with
`metadata.simulated = true` so nothing is passed off as real detection.

At threshold the attempt is **submitted and locked for human review — never auto-rejected.**

---

## Integrations: what is real

Read live from each adapter on the **Integrations** screen.

| Service | State | Reality |
|---|---|---|
| **Corsair** | `CONNECTED` once a real call succeeds, else `NOT_CONFIGURED` | One shape for every third-party service: `db` for already-synced data, `api` for the live call. PIE reads GitHub evidence through it when configured. `CONFIGURED_UNVERIFIED` means a key is present and nothing has been proven — that is not the same as working, and the screen says so. |
| **GitHub** | `OAUTH_CONFIGURED` / `DEMO_FIXTURES` | Repositories, languages and activity as **supporting** evidence. Three sources in order: Corsair's synced data, GitHub's own API, then labelled demo fixtures. PIE names the one it used. |
| **Supabase** | `CONNECTED` when configured | Durable accounts, evidence and decisions. Without it, nothing survives a restart on a host with an ephemeral filesystem. |
| **Email** | `VERIFIED` once a message is accepted | Verification codes and reset links, over SMTP or an HTTPS mail API. |
| **LLM provider** | `LIVE` / `OFFLINE` | Narration only. Every score is identical with or without it. |

Adapters live in `server/src/integrations/` and all expose `isConfigured()` + `status()`. **No
integration-specific logic sits in any UI component**, and no adapter fabricates a response.

---

## The AI layer — four providers, one adapter

PIE uses the **first provider configured**, in this order:

```
OpenAI → Google Gemini → Ollama (local) → deterministic templates
```

OpenAI, Gemini and Ollama all speak the same `/chat/completions` shape — Gemini through its
OpenAI-compatibility layer, Ollama through its own — so they are one code path with a different
base URL, key and model, not three clients to keep in sync.

| Provider | Configure with | Data leaves your machine |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | yes |
| Google Gemini | `GEMINI_API_KEY` | yes — and free-tier prompts may be used for training |
| **Ollama (local)** | `OLLAMA_BASE_URL` | **no** |
| Deterministic templates | nothing | no |

**Why a local model is a real option and not a slogan.** Every score, gap, ranking and audit
signal is computed *before* any model is called. Swapping to a self-hosted model changes the
wording and not one number. For an institution that cannot send candidate evidence to a third
party, PIE runs entirely inside their own infrastructure — with the deterministic engine unchanged.

Ollama is honest about its cost: a small local model is slower and weaker at structured output.
PIE validates every response and falls back to templates, so a bad answer costs the narration and
nothing else. It is a deployment option, not a recommendation for a live stage demo.

The **Which model writes the words** panel on the Integrations screen renders this
chain live — each row is the adapter's own state, including whether that provider sends data off
the machine.

---

## OpenAI / AI integration status

- The key is **server-side only** (`OPENAI_API_KEY`), read in `server/src/ai/provider.js`. It is never
  sent to the browser, never in Vite env vars, never in `web/`.
- Provider order: **OpenAI → Gemini → Ollama → offline templates.**
- A **circuit breaker** stops retrying after 3 failures for 60s, so a dead key cannot add latency to
  every request mid-demo.
- Any failure — unavailable, rate-limited, misconfigured, malformed JSON — falls back to deterministic
  output. The sidebar and Integrations screen show the live mode (`LIVE` / `DEGRADED` / `OFFLINE`).

**With no key configured, every score, gap, ranking and audit signal is identical.**

---

## Persistence

**Today: server-side JSON** at `server/data/pie.json` — deliberately not SQLite: no native deps, no
migration risk before the finale, and the whole state is one inspectable file. Writes are debounced
and atomic (temp file + rename).

Collections: `users · sessions · organizations · recruiters · candidateProfiles · requisitions ·
applications · evidence · githubConnections · githubRepositories · projects · certificates ·
hackathons · agentRuns · matchResults · assessmentAttempts · proctoringEvents · biasAudits ·
humanDecisions · learningProgress · auditEvents`

Delete the file, or press **Reset demo**, to reseed the demo world.

**Next: Supabase (PostgreSQL + Row Level Security).** `server/supabase/schema.sql` ships the whole
thing — 27 tables, their foreign keys, 47 RLS policies, and the trigger that keeps `profiles` in step
with `auth.users`. It has been applied against a real PostgreSQL instance with zero errors; every
table has RLS enabled and none is left with RLS on and no policy.

What the policies enforce, at the database rather than in the UI:

- A candidate reads and writes only their own evidence, projects, certificates, hackathons,
  capability profile, gaps and learning progress.
- A recruiter reads a candidate's data **only** when that candidate applied to one of their
  requisitions — never the whole population.
- `github_connections` holds an encrypted token and has **no client read policy at all**.
- Demo rows are readable by anyone signed in and writable by no one.

The driver is `server/src/persistence/supabase.js` — plain PostgREST over `fetch`, no client library.
It activates when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set; until then PIE says
`NOT_CONFIGURED` and names the JSON store as the system of record instead of implying a connection.
Sign in as the administrator and use **Integrations → Where PIE's data lives → Verify
connection** for a live reachability and schema check. Full instructions: `server/supabase/README.md`.

The `service_role` key bypasses RLS and belongs in `server/.env` only. It is never sent to the
browser, never logged, and never returned by any endpoint.

---

## Security practices implemented

**Credentials**

- Passwords are hashed with **bcrypt**. The plaintext is never stored, logged, echoed, or returned.
- Session tokens are 32 random bytes, stored server-side as a **SHA-256 hash**, delivered in an
  **HTTP-only, SameSite=Lax** cookie (Secure in production). Nothing sensitive is kept in
  `localStorage`.
- **Login errors are uniform.** A wrong password, a missing account and a demo persona all return the
  same message, and a dummy bcrypt comparison runs when the account does not exist so response time
  does not disclose existence either.
- The administrator is provisioned server-side and its password is **never rendered in the UI**.
- GitHub access tokens are encrypted at rest with **AES-256-GCM**; the key comes from
  `TOKEN_ENCRYPTION_KEY` or a generated `data/.token-key` (mode 0600). Rotating the key means
  candidates reconnect — it never means data loss.
- The OpenAI key is **server-side only**, read in `server/src/ai/provider.js`. It is never in a Vite
  env var, never in `web/`, never in a response.

**Authorization and isolation**

- Every mutating endpoint validates and sanitises its payload (control characters stripped,
  script-shaped markup neutralised, filenames de-pathed).
- **Role enforcement is server-side.** A candidate cannot create a requisition or open the system
  readiness check; a recruiter has no candidate profile to write to.
- **The sign-in door is enforced too.** The role card a person used is sent with the credentials and
  checked after the password verifies; a mismatch is refused with the generic message and no session
  is created.
- **Password reset cannot enumerate accounts**, cannot be replayed, and invalidates every session for
  the account it changes.
- **Recruiter isolation** — a recruiter cannot read or modify another recruiter's requisition (403).
- **Candidate isolation** — the server ignores a spoofed `candidateProfileId`; a candidate can only
  ever act on their own profile, and cannot read another candidate's evidence.
- **World isolation** — a real account and the demo world cannot see or modify each other, including
  by guessing an id.
- **Assessment attempt ownership** is checked on every call; ids cannot be guessed into.
- **Token replay rejected** — a stale or forged question token returns 409; a finalised question is
  idempotent.
- **Client-side scores are never trusted.** A client sending `score: 1` is ignored; grading is
  server-side against a rubric that is never serialised.
- **Evidence trust tier cannot be spoofed** — a self-declared project is always `SELF-REPORTED`.
- Rate limiting on registration, login, orchestration, uploads, GitHub authorization and assessment.
- Every security and integrity event is written to the audit trail.

---

## Test results

`cd server && npm test` — **56/56 passing.**

### Flow and safety guarantees (17)

| # | Guarantee | Result |
|---|---|---|
| 1 | Prohibited inputs never reach the matching agent | PASS |
| 2 | Human gate required before any final decision (with a mandatory reason) | PASS |
| 3 | A candidate cannot record a hiring decision | PASS |
| 4 | Assessment token replay rejected; navigation forward-only; no answer keys on the wire | PASS |
| 5 | Warning threshold locks for review, never auto-rejects | PASS |
| 6 | A candidate cannot alter a server-side score | PASS |
| 7 | Deterministic scoring is stable across repeated runs | PASS |
| 8 | Recruiter isolation | PASS |
| 9 | Candidate isolation | PASS |
| 10 | AI failure falls back without breaking the run | PASS |
| 11 | Integrations never claim connectivity they lack | PASS |
| 12 | Bias signals are indicators, never proof; audit is read-only | PASS |
| 13 | Reassessment produces new evidence and improves the match | PASS |
| 14 | Selective invocation runs only the needed pipeline | PASS |
| 15 | Evidence trust tier cannot be spoofed by the client | PASS |
| 16 | The AI-enabled path produces identical scores to the deterministic path | PASS |
| 17 | The matching agent is never handed capability dimension data | PASS |

### Authentication, authorization and isolation (23)

| # | Guarantee | Result |
|---|---|---|
| 1 | Registration creates a real, non-demo account with a session | PASS |
| 2 | The password is never returned, echoed or stored in plaintext | PASS |
| 3 | Weak passwords, malformed usernames and duplicates are refused | PASS |
| 4 | The administrator cannot be created from the public form | PASS |
| 5 | Login works with the username | PASS |
| 6 | Login works with the email address (case-insensitive) | PASS |
| 7 | A wrong password is refused, and the error is identical to a missing account | PASS |
| 8 | A demo persona cannot be signed into through the real login form | PASS |
| 9 | Logout ends the session and the token stops working | PASS |
| 10 | Protected endpoints reject anonymous and forged tokens | PASS |
| 11 | A candidate cannot use recruiter or administrator endpoints | PASS |
| 12 | A recruiter cannot act as a candidate | PASS |
| 13 | A real account cannot see or touch demo data — including by guessing an id | PASS |
| 14 | A demo session cannot see or modify a real account | PASS |
| 15 | Resetting the demo leaves real accounts signed in and intact | PASS |
| 16 | One candidate cannot read another candidate's evidence | PASS |
| 17 | GitHub status is reported honestly and never overclaims | PASS |
| 18 | Authorization is a redirect to github.com, never a password prompt | PASS |
| 19 | The OAuth callback rejects a forged or replayed state | PASS |
| 20 | Imported repositories are SELF-REPORTED when not API-derived | PASS |
| 21 | No GitHub access token is ever exposed to the client | PASS |
| 22 | No server secret leaks through any authenticated surface | PASS |
| 23 | Supabase reports its real state and never claims a connection it lacks | PASS |

### UI regression walk — `node uiwalk.mjs`

**38/38 checks passed, 0 console errors**, driving the real built app in a real browser: landing page
(four cards, no personas leaked) · theme toggle persisting across reload · candidate registration ·
signed-in vs demo badging · empty-state isolation · all nine candidate views · GitHub connect mode
disclosure · sign out · username sign-in · non-disclosing wrong-password error · demo door · demo
persona entry · a full orchestrator run · all nine recruiter views · four viewports from 1440 to 390
with no horizontal overflow · one `h1` per screen and no unlabelled control.

`node adminwalk.mjs` additionally walks the nine Trust & Integrity views, confirms the administrator
card offers sign-in only, and confirms the generated password appears nowhere in the UI.

### Schema validation

`server/supabase/schema.sql` applied against a real PostgreSQL 16 instance: **0 errors, 27 tables,
RLS enabled on all 27, 47 policies, and no table left with RLS on and no policy.**

---

## Project layout

```
server/src/
  env.js                loads server/.env with Node's own parser (no dependency)
  index.js              app wiring, service landscape, bootstrap
  auth.js               bcrypt hashing, sessions, admin provisioning, demo entrance
  lib.js                session middleware, authorisation, world isolation, API shapes
  secrets.js            AES-256-GCM encryption for tokens at rest
  store.js              JSON persistence (atomic, debounced)
  persistence/
    supabase.js         PostgREST driver — activates on env vars, reports honestly otherwise
  seed.js               demo ecosystem, every row stamped isDemo
  agents.js             DETERMINISTIC engine — every number is computed here
  orchestrator.js       control plane: manifests, triggers, scoped payloads, validation, audit
  assessment.js         policy, question bank, JIT delivery, state machine, warning engine
  sanitize.js           input sanitisation
  ai/provider.js        OpenAI -> Gemini -> Ollama -> templates, with a circuit breaker
  ai/agents.js          the four agents' isolated prompts + structured outputs
  integrations/         sapGenAiHub · sapLearningHub · sapBtpCap · sapHanaRepository ·
                        successFactors · sapAnalytics · githubEvidenceAdapter · githubOAuth
  routes/               auth · candidate · github · recruiter · orchestration · assessment · admin
  supabase/schema.sql   27 tables, foreign keys, 47 RLS policies
  test/flows.test.mjs   the 17 flow guarantees
  test/auth.test.mjs    the 23 auth, authorization and isolation guarantees
web/src/
  tokens.css / app.css  design system (light + dark)
  kit.jsx               Button/Card/Badge/Stat/Alert/Meter/Tabs/Modal/Skeleton/Insight + icons
  charts.jsx            radar, gauge, bar list, comparison, trajectory, funnel, evidence mix
  panels.jsx            pipeline, agent detail, match, employer, learning, bias, decision, audit
  nav.js                view stack, breadcrumbs, role-scoped navigation
  screens/              auth (landing, sign-in, register, demo door) · candidate · recruiter ·
                        admin · sap · demo
  assessmentUI.jsx      consent -> device check -> isolated live attempt -> result
uiwalk.mjs              38-check browser regression walk
adminwalk.mjs           Trust & Integrity walk
```

---

## Known limitations (stated, not hidden)

1. **Resume parsing needs the AI layer.** Without a key the resume is stored as evidence but not
   decomposed — by design, since guessing fields would be worse. PDF/DOCX are not parsed; paste text.
2. **Face detection is simulated.** `faceDetectionAdapter` is the labelled simulation layer; a real
   model (e.g. MediaPipe) drops in behind the same interface. Every simulated event carries
   `metadata.simulated = true`.
3. **Runs are cached in memory** (last 60). A slim record persists, but reopening a very old run
   returns 404. A production build would rehydrate from the store.
4. **GitHub without an OAuth app is demo data**, clearly labelled as such and always `SELF-REPORTED`.
   A stray invalid `GITHUB_TOKEN` in the shell environment is detected by shape and reported as
   `MISCONFIGURED` rather than being treated as a live connection.
5. **Supabase ships as schema + driver, not as a running database.** The schema is validated but PIE
   persists to the JSON store until you supply the two environment variables. The Integrations screen
   states which one is the system of record.
6. **Password recovery is not implemented.** There is no email flow; the UI says "coming soon" rather
   than offering a button that does nothing.
7. **A configured integration is not a working one.** `CONFIGURED_UNVERIFIED` means credentials
   exist and no call has been made. Only a real round trip promotes an adapter to `CONNECTED`, and
   the Integrations screen is deliberately worded for exactly this question.
8. **PIE never makes a hiring decision.** It analyses, recommends, explains and flags. Every decision
   with authority is recorded against a named human and a written reason.

---

## Deploying

See **`DEPLOYMENT.md`**. Short version: not before 3 September, and the JSON store has to become
Supabase first or every restart loses the data.

---

**Team Vision Nexus** — Snehal Vats · Rahul Pratap Singh · Piyush Yadav · Prachi Rastogi
Galgotias University

*All persona, organization and requisition data is illustrative and labelled as such in the UI.*
