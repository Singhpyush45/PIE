# Deploying PIE

A Render instance exists at `https://pie-w5w3.onrender.com` and is **not currently working** —
sign-in and the GitHub connect both fail there. The demo runs locally. This document is what has
to be true for that deployment to actually work — not a plan, a checklist against the current code.

**Known state, 11 September 2026.** The whole of `server/.env` was copied into Render's
environment, which brought the localhost values with it: `APP_BASE_URL` and `GITHUB_CALLBACK_URL`
still point at `localhost:5174`, so OAuth redirects off the live site and comes back as an expired
link. `NODE_ENV` is not `production`, so the session cookie is not `Secure` and `CORSAIR_TUNNEL=1`
made Render try to open the same tunnel as the developer's laptop — two apps registering the same
delivery URL against one Corsair dev key, each overwriting the other. Supabase restore works
(4215 rows). Fix the four variables in the table below before trusting anything on that host, and
do not put the Corsair variables on it at all while a laptop is using the same key.

Everything below has been implemented and tested. What remains is configuration, and the two
sections marked **DO THIS** are the difference between a working deployment and one that looks
fine until somebody signs in tomorrow.

---

## The one thing that decides everything

PIE's request path reads and writes an in-memory store backed by `server/data/pie.json`. On a host
with an ephemeral filesystem — Render's free plan among them — that file is thrown away every time
the instance is recycled, which happens after about fifteen minutes of inactivity.

The symptom is not an error. It is a candidate who registered yesterday being told *"those
credentials do not match an account"*, while the same credentials work on localhost. Nothing in the
logs says anything is wrong, because from the server's point of view nothing is: it has genuinely
never seen that user.

**This is now solved, but only if Supabase is configured.** Every write is mirrored to Supabase in
the background (`server/src/persistence/mirror.js`), and `server/src/persistence/hydrate.js` reads
it all back at boot before anything else happens. Configure Supabase and accounts survive a
restart. Do not, and they do not — and the integrity dashboard says so in those words.

| | Vercel | Render free | Render paid / Railway / Fly |
|---|---|---|---|
| Long-running Express | No — serverless | Yes | Yes |
| Filesystem | Ephemeral per invocation | Wiped on restart and spin-down | Persistent disk available |
| **Accounts survive a restart** | Only with Supabase | **Only with Supabase** | Only with Supabase |
| Outbound SMTP (587) | Unreliable | **Blocked** | Allowed |
| Cold start | Per invocation | Sleeps after ~15 min idle | None |

Vercel remains the wrong platform for the backend: any request may land on a different instance, so
even within a single session state would be inconsistent. One service serving both the API and
`web/dist`, exactly as it works locally, is the shape PIE is built for.

---

## DO THIS 1 — Run the SQL, in order

In the Supabase SQL editor, run each file once:

```
server/supabase/schema.sql       the tables
server/supabase/grants.sql       table privileges for the API role
server/supabase/002_mirror.sql   legacy_id columns, so PIE's own ids survive
server/supabase/003_auth.sql     password hashes, email verification, face_identities
server/supabase/004_corsair.sql  the five tables the Corsair SDK owns — only if you use Corsair
```

`003_auth.sql` is the new one and it is not optional. Without it, an account restored after a
restart comes back **with no password hash**, which means the user exists and can never sign in
again. That failure is silent. `server/test/hydrate.test.mjs` test 2 exists specifically to keep
anyone from removing it.

Verify:

```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='profiles'
   and column_name in ('password_hash','email_verified','candidate_profile_legacy_id');
-- expect three rows

select count(*) from pg_policies where tablename = 'face_identities';
-- expect 0 — RLS is on with no policies, so only the service-role key reaches templates
```

---

## DO THIS 2 — Do not send email over SMTP on Render

Render blocks outbound traffic to SMTP ports 25, 465 and 587 on free web services. The credentials
are not the problem and never will be: the connection simply hangs until it times out.

Symptom on the live site: registration stalls for ten seconds, then reports that the verification
code could not be sent — with SMTP settings that work perfectly on your laptop.

Two ways out:

1. **Send over HTTPS instead** (recommended, free). PIE speaks the Resend and Brevo APIs directly:

   ```
   MAIL_HTTP_PROVIDER=resend
   RESEND_API_KEY=<your key>
   MAIL_FROM=PIE <noreply@your-verified-domain>
   ```

   Nothing is contacted unless you set these. The provider will only send from a domain you own and
   have verified with them — a sender on `gmail.com` is rejected, and that rejection is the single
   most common cause of "it still does not work".

2. **Upgrade the Render service to a paid instance**, where SMTP is allowed, and keep the existing
   `SMTP_*` variables.

Prove it before you need it:

```
cd server
node tools/mail-test.mjs you@example.com
```

That sends a real message and records the result, so the running server's integrity panel updates
without a restart.

**If no mail transport is configured at all**, PIE does not pretend otherwise: reset links go to
the server console, and email verification is **not enforced** — because a gate nobody can pass is
an outage, not security. The integrity panel states this explicitly.

### Turning email verification off deliberately

If mail is configured but not delivering, a candidate registers, the send fails, and they are left
with an account they cannot use. That is worse than not checking the address. One line switches the
whole step off without removing anything:

```
EMAIL_VERIFICATION=off
```

Registration then signs candidates in as it did before the feature existed, no code is sent, and
nothing downstream demands a verified email. It is reported as `OFF` on its own line in the
integrity panel, with the words "the address a candidate typed is not proven" — switching off a
check is a reduction in what PIE claims, and it is shown as one. Remove the variable to turn it
back on; nothing else changes.

---

## Environment variables

`.env` is git-ignored and is **not** deployed. Every variable is set in the platform's Environment
settings. The names are below; the values are yours and belong nowhere else.

**Required**

```
NODE_ENV=production
PORT                        the platform sets this — read it, never hardcode 5174
APP_BASE_URL                https://your-app.onrender.com
ADMIN_PASSWORD              choose one, or it is generated into the logs
TOKEN_ENCRYPTION_KEY        32+ characters, fixed forever
SUPABASE_URL                https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY   Settings → API → service_role
```

**Email** — one of these two groups

```
MAIL_HTTP_PROVIDER=resend | brevo
RESEND_API_KEY   or   BREVO_API_KEY
MAIL_FROM

  …or…

SMTP_HOST  SMTP_PORT  SMTP_USER  SMTP_PASS  SMTP_FROM  SMTP_SECURE

  …or, to switch the whole step off…

EMAIL_VERIFICATION=off
```

**GitHub OAuth** — only if you want repository import

```
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_CALLBACK_URL         https://your-app.onrender.com/api/github/callback
```

**AI** — optional; PIE's scores are identical with or without it

```
OPENAI_API_KEY   or   GEMINI_API_KEY   or   OLLAMA_BASE_URL
```

**Corsair** — optional; GitHub evidence falls back to PIE's own adapter without it

Corsair is an SDK that runs inside this server, not a REST service PIE calls. That is why it needs
a real database connection and an encryption key, and why **all four are required together** —
three out of four is not a working integration, and PIE reports it as unconfigured.

```
CORSAIR_API_KEY             the project key from the Corsair dashboard
CORSAIR_SIGNING_SECRET      verifies that a Hub delivery really came from Corsair
CORSAIR_KEK                 encrypts stored authorisations. Generate ONCE:
                              openssl rand -base64 32
CORSAIR_DATABASE_URL        Postgres connection string. Supabase → Settings →
                              Database → Connection string → URI
```

Optional:

```
CORSAIR_TUNNEL=0            do not open a tunnel (set automatically in production)
CORSAIR_DB_POOL_MAX         connections Corsair may hold open (default 4)
```

**Gmail evidence** — a Corsair plugin, but the credentials are yours. The Gmail
plugin has no managed auth type, so this needs a Google Cloud OAuth client you
register. `GMAIL_SETUP.md` walks through it; budget an hour.

```
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REDIRECT_URL          optional; must match the URI registered with Google exactly
```

Absent these, PIE simply does not load the Gmail plugin: the Evidence Scout is
offered GitHub operations only, and no screen mentions a Gmail feature that does
not exist. `gmail.readonly` is a Google restricted scope, so an unpublished app
reaches only the test users you add by hand — which is fine for a demo and is
reported as such rather than glossed over.

Run `server/supabase/004_corsair.sql` first, or nothing works — the SDK owns five tables in PIE's
own database and cannot create them itself.

**`CORSAIR_KEK` is a one-way door.** It encrypts every stored authorisation. Change it and every
candidate who connected through Corsair has to reconnect, with no error message that says so. Set
it once, keep it with `TOKEN_ENCRYPTION_KEY`, and never regenerate it casually.

Prove it before you need it: `cd server && node tools/corsair-test.mjs`. A key in `.env` is not a
working integration, and the Integrations screen will keep saying `CONFIGURED_UNVERIFIED` until a
real call comes back. That check reads `corsair_accounts` specifically — the plugin list looks like
a health check and is not one, because it answers out of memory and will happily report success
against a database that does not exist.

**What Corsair can and cannot do to a candidate's GitHub.** PIE runs it read-only, enforced twice:
the plugin is configured `mode: readonly`, and every call is made inside the SDK's `runReadonly`
scope, which throws on any write endpoint. `corsair-test.mjs` attempts a real write and reports
whether it was refused, so the guarantee is demonstrated rather than described. The honest limit:
Corsair's managed GitHub app requests the `repo`, `user` and `read:org` scopes, so the **token** is
broader than PIE's use of it. The restriction is PIE's code, not the token's scope, and both the
Integrations screen and the candidate's connect screen say so.

**Tuning** — sensible defaults, change only with a reason

```
SUPABASE_MIRROR=0             turn the mirror OFF (on by default when Supabase is configured)
SUPABASE_HYDRATE=0            do not restore from Supabase at boot
PIE_IDENTITY_TICKET_TTL_MS    how long a passed face check is good for (default 3 minutes)
```

### The four that bite

- **`APP_BASE_URL`** — leave it as localhost and every password-reset link is dead for real users.
- **`TOKEN_ENCRYPTION_KEY`** — leave it blank and each deploy generates a new one, so every stored
  GitHub connection becomes undecryptable and candidates are asked to reconnect. It is also what
  keys the OTP digests, so changing it invalidates codes in flight.
- **`NODE_ENV=production`** makes the session cookie `Secure`. Correct over HTTPS; it breaks
  sign-in over plain HTTP.
- **`SUPABASE_SERVICE_ROLE_KEY`** — this key bypasses Row Level Security. It belongs on the server
  and nowhere else. It is never sent to the browser, never logged, and never returned by an API.

---

## What must never be committed

Already covered by `.gitignore`, listed here so it stays that way:

```
.env, server/.env, web/.env       every secret
server/data/pie.json              accounts, face templates, OTP digests
server/data/service-checks.json   this machine's verification records
server/data/.token-key            the generated encryption key
```

There are no face images anywhere to commit: the capture is converted to numbers in the browser and
the image is discarded. The numeric templates live in `pie.json` (ignored) and in Supabase behind
RLS.

The face model weights under `web/public/face/models/` **are** committed, on purpose — about 6.8 MB
of MIT-licensed weights, served from PIE rather than a CDN so the demo works with no internet.

---

## Build

`web/node_modules` is not in the repo, so the platform builds the frontend.

```
Build command:  cd web && npm install && npm run build && cd ../server && npm install
Start command:  cd server && npm start
```

The server serves `web/dist` when it exists, so one service handles both. It also warns on startup
when `web/dist` is older than `web/src` — that warning means you are looking at an old interface.

---

## Verify on the deployed instance

Assume nothing. These are in order of how often they are the thing that is wrong.

1. **Restart the service, then sign in with an account you created before the restart.**
   If it is gone, Supabase is not configured or `003_auth.sql` has not been run. This is the one
   people skip and the one that matters.
2. `GET /api/health` → `ok: true`
3. Sign in as administrator → **Integrations**
   - Supabase → `CONNECTED`
   - Supabase restore at boot → `RESTORED` or `CURRENT`, not `INCOMPLETE`
   - Email → `VERIFIED`, not `CONFIGURED_UNVERIFIED`
4. Register a candidate with a **real** email address → the four-digit code arrives → it is accepted
5. Register an identity from the profile page → the camera opens, four captures, locked
6. Start an assessment → the identity step appears and passes
7. Ask a colleague to sit in front of the camera at step 6 → the assessment is **refused**
8. Forgot password → the email arrives → the link opens **on another device** (this proves
   `APP_BASE_URL`)
9. Connect GitHub → the OAuth callback returns to the deployed host, not localhost

---

## What is still true after deploying

- Every score stays deterministic. The AI layer only writes prose; it never moves a number.
- Face verification is **face verification, not liveness detection**. PIE compares the live capture
  with the registered template. It cannot tell a live person from a photograph held to the camera,
  and it says so on the identity screen, in `/api/candidate/identity`, and in the code. Do not let a
  production URL tempt anyone into claiming otherwise.
- Corsair reports `NOT_CONFIGURED` until a key is set, and `CONFIGURED_UNVERIFIED` until a real call succeeds.
- `/api/ai/providers` still reports exactly which model is in use and whether candidate data leaves
  your infrastructure.
