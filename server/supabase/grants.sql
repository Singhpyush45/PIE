-- ============================================================================
--  PIE — table privileges for the Supabase API roles
--
--  WHY YOU NEED THIS
--    schema.sql creates the tables and the Row Level Security policies, but a
--    policy only decides WHICH ROWS a role may see. Postgres also needs a plain
--    table-level GRANT before the role may touch the table at all. Without it
--    PostgREST answers:
--
--        403  permission denied for table profiles   (SQLSTATE 42501)
--
--    That error means the opposite of what it sounds like: the table EXISTS and
--    your key is VALID — Postgres simply has not been told the role may read it.
--
--  WHAT THIS DOES AND DOES NOT DO
--    • Adds GRANTs only. It creates nothing, drops nothing, alters no column.
--    • Touches no data. Every existing row stays exactly as it is.
--    • Does NOT weaken Row Level Security. RLS still filters every row for
--      `anon` and `authenticated`. Grants decide access to the table; policies
--      decide access to the rows. You need both.
--    • Safe to run more than once.
--
--  HOW TO APPLY
--    supabase.com → your project → SQL Editor → New query → paste → Run
--    Expect "Success. No rows returned".
-- ============================================================================

-- The three roles PostgREST switches into, plus the one it connects as.
grant usage on schema public to anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────── service_role
-- This is the role PIE's server uses. It bypasses RLS by design, which is why
-- its key lives only in server/.env and never reaches a browser.
grant all privileges on all tables    in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all functions in schema public to service_role;

-- ─────────────────────────────────────────────────────────── authenticated
-- A signed-in user in the browser. RLS decides which rows they actually get —
-- these grants only make the tables addressable so the policies can run.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ─────────────────────────────────────────────────────────── anon
-- A visitor who has not signed in. Deliberately given nothing at table level:
-- PIE exposes no public data. The one thing anon may call is the sign-in helper,
-- which schema.sql already grants and which returns only an email address.

-- ──────────────────────────────────────────────── the token table, explicitly
-- github_connections stores encrypted GitHub access tokens. schema.sql already
-- denies it to clients with a `using (false)` policy; this removes the table
-- privilege as well, so the denial does not rest on a single line of policy.
revoke all on public.github_connections from anon, authenticated;

-- ──────────────────────────────────────────────────────── future objects
-- So a table added later is not missing its grants all over again.
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant all on sequences to service_role;
alter default privileges in schema public
  grant all on functions to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- ============================================================================
--  VERIFY — run this after the above and check service_role appears for a table
--
--    select grantee, privilege_type
--      from information_schema.role_table_grants
--     where table_schema = 'public' and table_name = 'profiles'
--     order by grantee, privilege_type;
--
--  RLS is untouched; confirm it is still on everywhere:
--
--    select tablename, rowsecurity from pg_tables where schemaname = 'public';
--
--  Every row must still show rowsecurity = true.
-- ============================================================================
