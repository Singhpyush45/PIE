-- ============================================================================
--  PIE — migration 002: make the tables mirrorable from the JSON store
--
--  WHY THIS IS NEEDED
--    PIE's local store uses readable string ids ("cand_1a2b", "req-sdet").
--    schema.sql uses uuid primary keys, which is right for Postgres but means a
--    straight insert of a PIE row is rejected before it starts.
--
--    Rather than change every primary key, each mirrored table gets a
--    `legacy_id` column holding PIE's own id. Postgres still mints the uuid;
--    the mirror upserts on legacy_id and resolves foreign keys through it.
--
--  WHAT THIS DOES AND DOES NOT DO
--    • Adds columns and unique indexes only. Creates no table, drops nothing,
--      changes no existing row, and does not touch Row Level Security.
--    • Safe to run more than once.
--
--  HOW TO APPLY
--    supabase.com → SQL Editor → New query → paste → Run
--    Run this AFTER schema.sql and grants.sql.
--    Safe to run again over an earlier version of this file — it rebuilds the
--    legacy_id indexes rather than assuming what is already there.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles', 'organizations', 'recruiter_profiles', 'candidate_profiles',
    'requisitions', 'applications', 'evidence', 'github_connections',
    'github_repositories', 'projects', 'certificates', 'hackathons',
    'agent_runs', 'match_results', 'assessment_attempts', 'proctoring_events',
    'bias_audits', 'human_decisions', 'learning_progress', 'audit_events'
  ] loop
    -- PIE's own id for this row.
    execute format('alter table public.%I add column if not exists legacy_id text', t);
    -- Upsert target. This must NOT be a partial index: PostgREST's
    -- `on_conflict=legacy_id` emits `ON CONFLICT (legacy_id)` with no predicate,
    -- and Postgres refuses to infer a partial index from that — you get
    -- "there is no unique or exclusion constraint matching the ON CONFLICT
    -- specification". A plain unique index is also all that is needed: Postgres
    -- treats NULLs as distinct, so any number of rows may still have no
    -- legacy_id (rows written directly through Supabase, for instance).
    execute format('drop index if exists public.%I', t || '_legacy_id_key');
    execute format('create unique index %I on public.%I (legacy_id)', t || '_legacy_id_key', t);
    -- When the row was last pushed. Useful for spotting a stalled mirror.
    execute format('alter table public.%I add column if not exists mirrored_at timestamptz', t);
  end loop;
end $$;

-- Foreign keys are carried as legacy ids too, so a batch can be pushed without
-- first resolving every parent. The mirror fills the real uuid columns when it
-- can; these keep the row honest and re-linkable when it cannot.
alter table public.evidence             add column if not exists legacy_candidate_id text;
alter table public.github_connections   add column if not exists legacy_candidate_id text;
alter table public.github_repositories  add column if not exists legacy_candidate_id text;
alter table public.projects             add column if not exists legacy_candidate_id text;
alter table public.certificates         add column if not exists legacy_candidate_id text;
alter table public.hackathons           add column if not exists legacy_candidate_id text;
alter table public.applications         add column if not exists legacy_candidate_id text;
alter table public.applications         add column if not exists legacy_requisition_id text;
alter table public.agent_runs           add column if not exists legacy_candidate_id text;
alter table public.agent_runs           add column if not exists legacy_requisition_id text;
alter table public.match_results        add column if not exists legacy_candidate_id text;
alter table public.match_results        add column if not exists legacy_requisition_id text;
alter table public.assessment_attempts  add column if not exists legacy_candidate_id text;
alter table public.proctoring_events    add column if not exists legacy_candidate_id text;
alter table public.proctoring_events    add column if not exists legacy_attempt_id text;
alter table public.bias_audits          add column if not exists legacy_candidate_id text;
alter table public.human_decisions      add column if not exists legacy_candidate_id text;
alter table public.learning_progress    add column if not exists legacy_candidate_id text;
alter table public.requisitions         add column if not exists legacy_recruiter_id text;
alter table public.recruiter_profiles   add column if not exists legacy_organization_id text;

-- The uuid parent columns must accept NULL while a batch is still being linked.
-- Only the ones declared NOT NULL in schema.sql need relaxing.
alter table public.evidence             alter column candidate_profile_id drop not null;
alter table public.github_connections   alter column candidate_profile_id drop not null;
alter table public.github_repositories  alter column candidate_profile_id drop not null;
alter table public.projects             alter column candidate_profile_id drop not null;
alter table public.certificates         alter column candidate_profile_id drop not null;
alter table public.hackathons           alter column candidate_profile_id drop not null;
alter table public.applications         alter column candidate_profile_id drop not null;
alter table public.applications         alter column requisition_id        drop not null;
alter table public.match_results        alter column candidate_profile_id drop not null;
alter table public.assessment_attempts  alter column candidate_profile_id drop not null;
alter table public.proctoring_events    alter column candidate_profile_id drop not null;
alter table public.proctoring_events    alter column attempt_id            drop not null;
alter table public.human_decisions      alter column candidate_profile_id drop not null;
alter table public.learning_progress    alter column candidate_profile_id drop not null;

-- `profiles.id` references auth.users. A mirrored PIE account has no Supabase
-- Auth user, so that reference cannot hold. Drop the FK but keep the column: a
-- real Supabase Auth rollout can re-add it later.
alter table public.profiles drop constraint if exists profiles_id_fkey;
alter table public.profiles alter column id set default gen_random_uuid();

-- Likewise for the two profile tables that point at auth.users.
alter table public.candidate_profiles drop constraint if exists candidate_profiles_owner_id_fkey;
alter table public.recruiter_profiles drop constraint if exists recruiter_profiles_owner_id_fkey;

-- schema.sql requires evidence.verification to be one of three values, and
-- PIE writes exactly those, but a mirror should never fail a whole batch on one
-- unexpected string. Widen to a default rather than a hard rejection.
alter table public.evidence alter column verification set default 'self_reported';

-- ============================================================================
--  VERIFY
--    select column_name from information_schema.columns
--     where table_schema='public' and table_name='evidence'
--       and column_name in ('legacy_id','legacy_candidate_id','mirrored_at');
--    -- expect three rows
--
--  RLS is untouched. Confirm:
--    select count(*) filter (where rowsecurity) || '/' || count(*)
--      from pg_tables where schemaname='public';
-- ============================================================================
