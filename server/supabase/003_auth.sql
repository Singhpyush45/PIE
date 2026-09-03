-- ============================================================================
--  PIE — migration 003: durable accounts, email verification, face identity
--
--  WHY THIS IS NEEDED
--    Migration 002 made PIE's rows mirrorable. It did not make an ACCOUNT
--    survive: the mirror was dropping password_hash, and no table existed for
--    email verification state or a registered face. So an instance that lost its
--    filesystem — which is every Render free-plan restart — came back with the
--    user row present and the user unable to sign in.
--
--    This migration adds the three things an account needs to be restorable:
--      1. the bcrypt hash, so the restored user can authenticate
--      2. the email-verified flag, so nobody has to re-prove an email
--      3. face_identities, so a registered identity is not lost on restart
--
--  ON STORING A PASSWORD HASH
--    A bcrypt hash is a verifier, not a credential. It cannot be replayed
--    against PIE, it is what a users table exists to hold, and it is reachable
--    only with the service-role key. Session tokens are the opposite and are
--    still never mirrored.
--
--  WHAT THIS DOES AND DOES NOT DO
--    • Adds columns and one table. Drops nothing, changes no existing row.
--    • Enables RLS on the new table with NO policies, so the anon and
--      authenticated roles cannot read it at all. Only the service-role key,
--      which bypasses RLS and lives on the server, can.
--    • Safe to run more than once.
--
--  HOW TO APPLY
--    supabase.com -> SQL Editor -> New query -> paste -> Run
--    Run AFTER schema.sql, grants.sql and 002_mirror.sql.
-- ============================================================================

-- ─────────────────────────────────────────────────────── accounts that restore

alter table public.profiles add column if not exists password_hash     text;
alter table public.profiles add column if not exists email_verified    boolean not null default false;
alter table public.profiles add column if not exists email_verified_at timestamptz;

-- A user row owns the profiles it points at. Those are PIE's own string ids, so
-- they are named explicitly rather than borrowing the uuid column names.
alter table public.profiles add column if not exists candidate_profile_legacy_id text;
alter table public.profiles add column if not exists recruiter_legacy_id         text;
alter table public.profiles add column if not exists organization_legacy_id      text;

comment on column public.profiles.password_hash is
  'bcrypt hash. Reachable only with the service-role key; RLS denies every other role. Never returned by any PIE endpoint.';

-- ───────────────────────────────────────────────────────────── face identity

create table if not exists public.face_identities (
  id                    uuid primary key default gen_random_uuid(),
  legacy_id             text,
  legacy_candidate_id   text,
  legacy_user_id        text,
  candidate_profile_id  uuid references public.candidate_profiles(id) on delete cascade,

  -- Which model produced the template. A template is only comparable with
  -- another from the same model and version, so both are recorded and a
  -- mismatch forces re-registration rather than a meaningless comparison.
  algorithm             text not null,
  template_version      text,
  dimensions            int,

  -- The face descriptor: an array of numbers, not an image. PIE does not keep
  -- the captured photograph.
  template              jsonb not null,

  quality               numeric,
  locked                boolean not null default true,
  registered_at         timestamptz not null default now(),
  is_demo               boolean not null default false,
  created_at            timestamptz not null default now(),
  mirrored_at           timestamptz
);

drop index if exists public.face_identities_legacy_id_key;
create unique index face_identities_legacy_id_key on public.face_identities (legacy_id);
create index if not exists face_identities_candidate_idx on public.face_identities (legacy_candidate_id);

comment on table public.face_identities is
  'Biometric templates. RLS is on with NO policies: anon and authenticated cannot read a single row. '
  'Only the service-role key, held by the PIE server, reaches this table.';

-- RLS on, no policies. In Postgres that means: denied to every role except one
-- that bypasses RLS. This is deliberate and must not be "fixed" by adding a
-- read policy — nothing outside the server has any business reading a template.
alter table public.face_identities enable row level security;

-- The service role bypasses RLS, so it needs the table grant and nothing else.
grant select, insert, update, delete on public.face_identities to service_role;
revoke all on public.face_identities from anon, authenticated;

-- ============================================================================
--  VERIFY
--    select column_name from information_schema.columns
--     where table_schema='public' and table_name='profiles'
--       and column_name in ('password_hash','email_verified','candidate_profile_legacy_id');
--    -- expect three rows
--
--    select relrowsecurity from pg_class where relname = 'face_identities';
--    -- expect t
--
--    select count(*) from pg_policies where tablename = 'face_identities';
--    -- expect 0 — that is the point
-- ============================================================================
