# Supabase for PIE

Two files, and you need **both**:

| File | What it does |
|---|---|
| `schema.sql` | 27 tables, foreign keys, 47 Row Level Security policies, triggers |
| `grants.sql` | the table privileges the API roles need before any of that is reachable |

`schema.sql` alone is not enough. A policy decides *which rows* a role may see; Postgres
still needs a plain `GRANT` before the role may touch the table at all. Without `grants.sql`
every request comes back `403 permission denied for table … (42501)`.

## Apply it

1. supabase.com → your project → **Resume** it if it is paused.
2. **SQL Editor → New query** → paste `schema.sql` → **Run**.
3. **New query again** → paste `grants.sql` → **Run**. Adds GRANTs only: creates nothing,
   drops nothing, changes no row, leaves RLS on. Safe to re-run.
4. **Settings → API** → copy the Project URL and the `service_role` key into `server/.env`:

   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the service_role key>
   ```

   Use the **bare project URL**. PIE appends `/rest/v1` itself (and strips it if you paste
   one anyway). Key on one line, no quotes, nothing after it.
5. Check it: `cd server && node tools/supabase-doctor.mjs` — reports the URL shape, the key's
   type and role, and one live request, without ever printing the key.
6. Restart the server, sign in as the administrator, open **Integrations →
   Where PIE's data lives → Verify connection**.

## If something is wrong, what the state means

| State | Meaning | Fix |
|---|---|---|
| `CONNECTED` | all 20 mapped tables answered | nothing |
| `PERMISSION_DENIED` | tables exist, key is valid, no GRANT | run `grants.sql` |
| `AUTH_REJECTED` | project answered, key refused | re-copy the `service_role` key |
| `REACHABLE_SCHEMA_MISSING` | reached the project, no PIE tables | run `schema.sql`, or check `SUPABASE_URL` |
| `UNREACHABLE` | no answer at all | project paused, or wrong host |
| `NOT_CONFIGURED` | no credentials | PIE uses `server/data/pie.json` |

## What the policies actually enforce

- A candidate reads and writes only their own profile, evidence, projects, certificates,
  hackathons, capability profile, gaps and learning progress.
- A recruiter reads a candidate's data **only** when that candidate has applied to one of
  their requisitions — not the whole population.
- `github_connections` holds an encrypted access token and has **no** client read policy at
  all. Only the service role (the PIE server) can touch it.
- Demo rows (`is_demo = true`) are readable by anyone signed in and writable by no one, so a
  real account can never mutate a demo persona.
- `human_decisions` is the only table with hiring authority, and every row names a reviewer
  and a reason.

Verify after applying:

```sql
select tablename, rowsecurity from pg_tables where schemaname = 'public';
```

Every row must show `rowsecurity = true`.

## Two keys, two places

| Key | Where it belongs | What it can do |
|---|---|---|
| `service_role` | `server/.env` only, never the browser | bypasses RLS entirely |
| `anon` | safe for the browser | governed by the policies above |

If the `service_role` key is ever exposed, rotate it in **Settings → API** immediately.

## Status

The driver is `server/src/persistence/supabase.js`. It speaks plain PostgREST over `fetch`
— no client library, nothing to keep in sync. With the variables unset, PIE persists to
`server/data/pie.json` and says so; nothing about the product changes.

**What `CONNECTED` does and does not mean.** It means PIE reached your project and found all
20 mapped tables. It does **not** mean your data is being written there. `mirror()` is
exported but nothing in the server calls it yet, so `server/data/pie.json` remains the system
of record and the Supabase tables stay empty. `SUPABASE_MIRROR` currently has no effect —
wiring the mirror up is a deliberate next step, not something that happens on its own.

**Validated on PostgreSQL 16.** `schema.sql` applies with zero errors: 27 tables, RLS enabled
on all 27, 47 policies, no table left with RLS on and no policy. `grants.sql` was verified by
reproducing the `permission denied for table profiles` failure first, then confirming it
clears while RLS stays on for all 27 tables, `anon` keeps zero table privileges, and
`github_connections` remains closed to both client roles.
