# Deploying PIE

**Read this first: do not deploy before the Grand Finale on 3 September.**

PIE runs today on a laptop with 56 API tests and 38 browser checks passing. Deployment adds
cold starts, blocked ports, wiped data and dashboard-managed secrets — four new ways for a demo
to fail, for no marks gained. The Hackfest handbook asks teams to *"demonstrate a functional
prototype"*; a prototype running on your machine satisfies that completely.

This document is for **after** the finale.

---

## The one thing that is not obvious

PIE writes everything to `server/data/pie.json`. That single fact decides which platforms can
host it.

| | Vercel | Render free | Render paid / Railway / Fly |
|---|---|---|---|
| Long-running Express | No — serverless | Yes | Yes |
| **The JSON store** | **Does not work** | Wiped on restart and on spin-down | Needs a persistent disk |
| Outbound SMTP (587) | Unreliable from serverless | **Blocked since Sept 2025** | Allowed |
| Cold start | Per invocation | Sleeps after ~15 min idle | None |

**Vercel is the wrong platform for PIE's backend as it stands.** Serverless functions get an
ephemeral filesystem and any request may land on a different instance, so accounts, sessions and
evidence would vanish between requests. That is not a bug to fix; it is a mismatch.

You can still put the **frontend** on Vercel and the backend elsewhere — but then you also have to
solve CORS and cross-site cookies, which is more work than keeping them together.

**Recommended: one paid Render/Railway/Fly instance serving both the API and `web/dist`,**
exactly as it works locally.

---

## Step 1 — Make Supabase the real system of record

This is the real work, and everything else is easy by comparison.

Right now Supabase is **connected and verified** (27 tables, RLS, grants applied) but PIE still
reads and writes the JSON store. `mirror()` exists in `server/src/persistence/supabase.js` and
nothing calls it.

Until this is done, any deployment loses data on every restart.

Order of work:

1. Wire `mirror()` so writes go to Supabase as well as the JSON store. Run both for a while and
   compare — the JSON store stays the source of truth during this phase.
2. Switch reads over collection by collection, starting with the ones that matter least
   (`auditEvents`, then `evidence`, then `users` and `sessions` last).
3. Only when reads are stable, stop writing JSON.

Do not skip step 1. A straight cutover with no comparison period is how silent data loss happens.

**Column mapping is unverified.** `shape()` converts camelCase to snake_case mechanically. Check
it against your own tables before trusting it.

---

## Step 2 — Replace SMTP with an HTTP email API

Gmail SMTP works on your laptop and will not work in most of the cloud:

- **Render's free tier blocks outbound ports 25, 465 and 587** (since September 2025). Paid
  instances are fine.
- Gmail frequently blocks App Password logins coming from datacenter IPs as suspicious.
- Serverless functions are a bad fit for SMTP's connection lifecycle.

An HTTP email API avoids all three: it is an HTTPS call on port 443, which nothing blocks.

| Service | Free tier | Notes |
|---|---|---|
| **Resend** | 3,000/month, 100/day | needs one verified domain |
| Brevo | free tier available | HTTP API |
| SendGrid | free tier discontinued | — |

`server/src/mailer.js` is already an abstraction — `send()`, `verify()`, `status()`. Adding a
Resend path is roughly thirty lines and does not touch the reset flow, the routes or the UI.

**Keep the console fallback.** It is what makes the flow demonstrable when email is unavailable.

---

## Step 3 — Environment variables

`.env` is git-ignored and is **not** deployed. Every variable must be set in the platform's
Environment settings.

Required:

```
NODE_ENV=production
PORT=<the platform sets this — read it, do not hardcode 5174>
APP_BASE_URL=https://your-app.onrender.com
ADMIN_PASSWORD=<choose one; otherwise it is generated into logs>
TOKEN_ENCRYPTION_KEY=<32+ chars, fixed>
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role>
```

Then whichever AI provider you want (`OPENAI_API_KEY`, or `GEMINI_API_KEY`, or none), and the
email service key.

Three that bite:

- **`APP_BASE_URL`** — leave it as localhost and every password-reset link is dead for real users.
  This is the single most common deployment mistake with this app.
- **`TOKEN_ENCRYPTION_KEY`** — leave it blank and each deploy generates a new one, so every stored
  GitHub connection becomes undecryptable and candidates are asked to reconnect.
- **`NODE_ENV=production`** makes the session cookie `Secure`. Correct over HTTPS, and it will
  break sign-in over plain HTTP. Set it only where you actually have TLS.

Also update **GitHub OAuth**: the callback URL in your OAuth App must become
`https://your-app.onrender.com/api/github/callback`, and `GITHUB_CALLBACK_URL` must match exactly.

---

## Step 4 — Build

`web/node_modules` is not in the repo, so the platform has to build the frontend.

```
Build command:  cd web && npm install && npm run build && cd ../server && npm install
Start command:  cd server && npm start
```

The server already serves `web/dist` when it exists, so one service handles both.

---

## Step 5 — Verify on the deployed instance

Do not assume any of it. Run the same checks that work locally.

1. `GET /api/health` returns `ok: true`
2. Sign in as the administrator → **SAP integration readiness**
   - Supabase → **Verify connection** → `CONNECTED`
   - Email → `VERIFIED`, not `CONFIGURED_UNVERIFIED`
   - AI layer → the provider you expect
3. Register a candidate with a **real** email address
4. Forgot password → the email arrives → the link opens **on another device** (this is the proof
   `APP_BASE_URL` is right)
5. Reset, then confirm the old password fails and the new one works
6. Connect GitHub → the OAuth callback returns to the deployed host, not localhost
7. Restart the service, then sign in again — **if your account is gone, step 1 is not finished**

Step 7 is the one people skip. It is the one that matters.

---

## What will still be true after deploying

Nothing about PIE's honesty changes with the address it runs at:

- Every score stays deterministic. The AI layer only writes prose.
- SAP Generative AI Hub still reports `OFFLINE_TEMPLATE_MODE` until an SAP AI Core deployment
  exists. Do not let a production URL tempt anyone into claiming otherwise.
- The provider chain (`/api/ai/providers`) still reports exactly which model is in use and whether
  candidate data leaves your infrastructure.
