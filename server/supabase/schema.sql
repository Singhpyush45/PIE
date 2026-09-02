-- ============================================================================
--  PIE — Potential Intelligence Engine
--  Supabase schema + Row Level Security
--
--  HOW TO APPLY
--    1. Unpause your project at supabase.com
--    2. SQL Editor → New query → paste this whole file → Run
--    3. Put the keys in server/.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
--       and web/.env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
--    4. Restart the server. The banner will report the Supabase driver as active.
--
--  DESIGN NOTES
--    • Identity comes from Supabase Auth (auth.users). `profiles` extends it.
--    • Username-or-email login: the client resolves a username to its email via
--      the SECURITY DEFINER function `public.email_for_identifier`, then calls
--      Supabase Auth with that email. Passwords are never handled by PIE.
--    • Every user-owned row carries owner_id (or resolves to one), and RLS is
--      enabled on every table. Candidate A cannot read Candidate B's evidence
--      even with a valid token — the database refuses, not the frontend.
--    • `is_demo` separates the curated Grand Finale world from real accounts.
--      A demo row is readable by anyone signed in; it is writable by no one
--      except the service role, so a real user can never mutate a demo persona.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ══════════════════════════════════════════════════════════════════ IDENTITY

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  role         text not null check (role in ('candidate','recruiter','admin')),
  full_name    text not null,
  username     text unique not null,
  email        text unique not null,
  title        text,
  is_demo      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Username-or-email sign-in. SECURITY DEFINER so an anonymous caller can resolve
-- a username, but it returns ONLY an email and nothing else about the account.
create or replace function public.email_for_identifier(identifier text)
returns text language sql security definer set search_path = public stable as $$
  select email from public.profiles
   where lower(username) = lower(identifier) or lower(email) = lower(identifier)
   limit 1
$$;
revoke all on function public.email_for_identifier(text) from public;
grant execute on function public.email_for_identifier(text) to anon, authenticated;

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  industry    text, size text, hq text,
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.candidate_profiles (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid references auth.users(id) on delete cascade,
  persona_id           text,
  name                 text not null,
  headline             text,
  context              jsonb not null default '{}'::jsonb,
  -- Recorded for transparency and accommodation. NEVER an input to matching.
  protected_context    text[] not null default '{}',
  accommodation        jsonb,
  github_login         text,
  onboarding_complete  boolean not null default false,
  is_demo              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.recruiter_profiles (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid references auth.users(id) on delete cascade,
  organization_id  uuid references public.organizations(id) on delete set null,
  name             text not null,
  title            text,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now()
);

-- ═════════════════════════════════════════════════════════════════ EVIDENCE

create table if not exists public.evidence (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  source                text not null,
  type                  text,
  verification          text not null check (verification in ('api_derived','issuer_verified','self_reported')),
  trust_tier            text generated always as (
                          case verification
                            when 'api_derived'     then 'API-DERIVED'
                            when 'issuer_verified' then 'ISSUER-VERIFIED'
                            else 'SELF-REPORTED' end) stored,
  title                 text not null,
  body                  text,
  evidence_date         text,
  verify_ref            text,
  metrics               jsonb,
  extracted_signals     jsonb,
  status                text not null default 'INGESTED',
  import_mode           text,
  is_demo               boolean not null default false,
  created_at            timestamptz not null default now()
);
create index if not exists evidence_candidate_idx on public.evidence(candidate_profile_id);

create table if not exists public.resume_evidence (
  id                    uuid primary key default gen_random_uuid(),
  evidence_id           uuid not null references public.evidence(id) on delete cascade,
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  filename              text,
  raw_text              text,
  parsed                jsonb,
  parsed_by             text,
  is_demo               boolean not null default false,
  created_at            timestamptz not null default now()
);

-- The access token is encrypted by the SERVER before it ever reaches this table.
-- It is never selected by a browser client: RLS forbids reading this table from
-- the anon/authenticated roles entirely.
create table if not exists public.github_connections (
  id                       uuid primary key default gen_random_uuid(),
  candidate_profile_id     uuid not null unique references public.candidate_profiles(id) on delete cascade,
  login                    text not null,
  github_user_id           bigint,
  name                     text, avatar_url text, html_url text,
  scopes                   text,
  access_token_encrypted   text,
  token_fingerprint        text,
  mode                     text not null default 'REAL',
  is_demo                  boolean not null default false,
  created_at               timestamptz not null default now()
);

create table if not exists public.github_repositories (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  login                 text, name text not null, full_name text,
  description           text, languages text[], visibility text,
  commits int, months_active int, has_tests boolean, readme_quality text,
  topics text[], stars int, structure text[], pushed_at text,
  import_mode           text,
  is_demo               boolean not null default false,
  created_at            timestamptz not null default now()
);

create table if not exists public.projects (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  evidence_id           uuid references public.evidence(id) on delete set null,
  name text not null, description text, role text, technologies text[],
  repository text, demo_url text, problem text, solution text, outcome text,
  team_size int, duration text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.certificates (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  evidence_id           uuid references public.evidence(id) on delete set null,
  title text not null, issuer text, issued_on text,
  credential_id text, verification_url text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.hackathons (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  evidence_id           uuid references public.evidence(id) on delete set null,
  name text not null, organiser text, year text, role text,
  project text, achievement text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.learning_evidence (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  evidence_id           uuid references public.evidence(id) on delete set null,
  provider text, resource_id text, title text, skill_id text,
  -- PIE never asserts completion from an external provider it cannot verify.
  completion_verification text not null default 'CANDIDATE_DECLARED'
    check (completion_verification in ('CANDIDATE_DECLARED','PIE_REASSESSMENT','NOT_AVAILABLE')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- ═════════════════════════════════════════════════════════ ROLES & MATCHING

create table if not exists public.requisitions (
  id                     uuid primary key default gen_random_uuid(),
  recruiter_profile_id   uuid references public.recruiter_profiles(id) on delete cascade,
  organization_id        uuid references public.organizations(id) on delete set null,
  title text not null, company text, location text, employment_type text,
  experience text, education_requirements text,
  body text not null,
  required_skills text[], preferred_skills text[],
  employer_readiness jsonb,
  status text not null default 'OPEN' check (status in ('DRAFT','OPEN','CLOSED')),
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.job_requirements (
  id              uuid primary key default gen_random_uuid(),
  requisition_id  uuid not null references public.requisitions(id) on delete cascade,
  skill_id text not null, name text, category text,
  mandatory boolean not null default false,
  required_level numeric, weight numeric, market_demand numeric
);

create table if not exists public.applications (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid not null references public.requisitions(id) on delete cascade,
  status text not null default 'DISCOVERED' check (status in
    ('DISCOVERED','APPLIED','ASSESSMENT_REQUIRED','ASSESSMENT_COMPLETED','UNDER_REVIEW','HUMAN_DECISION')),
  applied_at timestamptz,
  assessment_attempt_id uuid,
  match_result_id uuid,
  integrity_status text,
  decision jsonb,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  unique (candidate_profile_id, requisition_id)
);

-- ══════════════════════════════════════════════ CAPABILITY & AGENT OUTPUT

create table if not exists public.capability_profiles (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  profile_version text, evidence_count int,
  potential jsonb, growth_readiness jsonb, dimensions jsonb,
  model_version text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.capability_signals (
  id                      uuid primary key default gen_random_uuid(),
  capability_profile_id   uuid not null references public.capability_profiles(id) on delete cascade,
  skill_id text not null, name text, category text,
  confidence numeric, corroborated boolean, sources text[], mentions jsonb
);

create table if not exists public.skill_gaps (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete cascade,
  skill_id text not null, name text, category text,
  mandatory boolean, current_confidence numeric, required_level numeric, severity numeric,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete set null,
  trigger text not null, status text not null,
  total_ms int, ai_provider text, ai_mode text,
  step_summary jsonb,
  is_demo boolean not null default false,
  started_at timestamptz not null default now()
);

create table if not exists public.match_results (
  id                    uuid primary key default gen_random_uuid(),
  agent_run_id          uuid references public.agent_runs(id) on delete cascade,
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete cascade,
  skills_first_score numeric, potential_adjusted numeric,
  growth_uplift numeric, match_tier text, gap_count int, confidence numeric,
  breakdown jsonb, disclosure text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- ══════════════════════════════════════════════════════════════ ASSESSMENT

create table if not exists public.assessments (
  id              uuid primary key default gen_random_uuid(),
  requisition_id  uuid references public.requisitions(id) on delete cascade,
  policy_id text not null, blueprint jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.assessment_attempts (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete set null,
  application_id        uuid references public.applications(id) on delete set null,
  policy_id text, state text not null default 'IN_PROGRESS',
  question_count int, skill_coverage text[],
  overall numeric, warning_count int not null default 0,
  requires_human_review boolean not null default false,
  integrity_status text, reviewed_by text, reviewed_at timestamptz, review_reason text,
  is_demo boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.proctoring_events (
  id                    uuid primary key default gen_random_uuid(),
  attempt_id            uuid not null references public.assessment_attempts(id) on delete cascade,
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  event_type text not null, severity text, source text,
  -- Derived events only. Raw camera and microphone media is never stored.
  metadata jsonb,
  occurred_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════ GOVERNANCE & AUDIT

create table if not exists public.bias_audits (
  id                    uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('requisition','match')),
  subject_id text not null,
  candidate_profile_id  uuid references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete cascade,
  -- A signal is an indicator requiring human judgement. It is never proof.
  severity text not null check (severity in ('None','Low','Medium','High')),
  signal_count int not null default 0,
  signals jsonb,
  status text not null default 'OPEN'
    check (status in ('OPEN','CLEAR','CLEARED','RETAKE_REQUESTED','ESCALATED','UNRESOLVED')),
  reviewed_by text, reviewed_at timestamptz, review_action text, review_reason text,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

-- The only table in the system with hiring authority.
create table if not exists public.human_decisions (
  id                    uuid primary key default gen_random_uuid(),
  agent_run_id          uuid references public.agent_runs(id) on delete set null,
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  requisition_id        uuid references public.requisitions(id) on delete set null,
  reviewer text not null, reviewer_email text, reviewer_role text,
  action text not null check (action in ('SHORTLIST','PROCEED_TO_INTERVIEW','HOLD','REJECT')),
  reason text not null,
  ai_recommendation text,
  overrode_ai boolean not null default false,
  is_demo boolean not null default false,
  decided_at timestamptz not null default now()
);

create table if not exists public.learning_progress (
  id                    uuid primary key default gen_random_uuid(),
  candidate_profile_id  uuid not null references public.candidate_profiles(id) on delete cascade,
  skill_id text not null, resource_id text,
  state text not null default 'STARTED',
  completion_verification text not null default 'CANDIDATE_DECLARED',
  evidence_id uuid references public.evidence(id) on delete set null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_events (
  id           uuid primary key default gen_random_uuid(),
  actor        text not null,
  actor_role   text,
  action       text not null,
  subject_type text, subject_id text,
  note         text,
  meta         jsonb,
  is_demo      boolean not null default false,
  occurred_at  timestamptz not null default now()
);
create index if not exists audit_action_idx on public.audit_events(action);

-- ─────────────────────────────────────────────────────────── helper functions
create or replace function public.current_role_name()
returns text language sql stable as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.my_candidate_profile()
returns uuid language sql stable as $$
  select id from public.candidate_profiles where owner_id = auth.uid() limit 1
$$;

create or replace function public.my_recruiter_profile()
returns uuid language sql stable as $$
  select id from public.recruiter_profiles where owner_id = auth.uid() limit 1
$$;

-- ════════════════════════════════════════════════════ ROW LEVEL SECURITY
-- Enabled on EVERY table. With no matching policy the default is deny.

alter table public.profiles              enable row level security;
alter table public.organizations         enable row level security;
alter table public.candidate_profiles    enable row level security;
alter table public.recruiter_profiles    enable row level security;
alter table public.evidence              enable row level security;
alter table public.resume_evidence       enable row level security;
alter table public.github_connections    enable row level security;
alter table public.github_repositories   enable row level security;
alter table public.projects              enable row level security;
alter table public.certificates          enable row level security;
alter table public.hackathons            enable row level security;
alter table public.learning_evidence     enable row level security;
alter table public.requisitions          enable row level security;
alter table public.job_requirements      enable row level security;
alter table public.applications          enable row level security;
alter table public.capability_profiles   enable row level security;
alter table public.capability_signals    enable row level security;
alter table public.skill_gaps            enable row level security;
alter table public.agent_runs            enable row level security;
alter table public.match_results         enable row level security;
alter table public.assessments           enable row level security;
alter table public.assessment_attempts   enable row level security;
alter table public.proctoring_events     enable row level security;
alter table public.bias_audits           enable row level security;
alter table public.human_decisions       enable row level security;
alter table public.learning_progress     enable row level security;
alter table public.audit_events          enable row level security;

-- ── profiles ────────────────────────────────────────────────────────────────
create policy "read own profile"   on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "update own profile" on public.profiles for update using (id = auth.uid());
create policy "insert own profile" on public.profiles for insert with check (id = auth.uid());

-- ── organizations: readable by any signed-in user; only the owner writes ─────
create policy "read organizations" on public.organizations for select using (auth.uid() is not null);
create policy "write own organization" on public.organizations for all
  using (not is_demo and exists (
    select 1 from public.recruiter_profiles r
     where r.organization_id = organizations.id and r.owner_id = auth.uid()))
  with check (not is_demo);

-- ── candidate_profiles ──────────────────────────────────────────────────────
-- A candidate reads and writes only their own. A recruiter may read a candidate
-- who has applied to one of their requisitions — never the whole population.
create policy "candidate reads own profile" on public.candidate_profiles for select
  using (owner_id = auth.uid() or is_demo or public.is_admin()
      or exists (select 1 from public.applications a
                   join public.requisitions q on q.id = a.requisition_id
                  where a.candidate_profile_id = candidate_profiles.id
                    and q.recruiter_profile_id = public.my_recruiter_profile()));
create policy "candidate writes own profile" on public.candidate_profiles for all
  using (owner_id = auth.uid() and not is_demo)
  with check (owner_id = auth.uid() and not is_demo);

create policy "recruiter reads own profile" on public.recruiter_profiles for select
  using (owner_id = auth.uid() or is_demo or public.is_admin());
create policy "recruiter writes own profile" on public.recruiter_profiles for all
  using (owner_id = auth.uid() and not is_demo)
  with check (owner_id = auth.uid() and not is_demo);

-- ── candidate-owned data: one policy shape, applied to every table ──────────
-- Readable by the owning candidate, by a recruiter the candidate applied to, by
-- an admin, or if it is demo data. Writable ONLY by the owning candidate, and
-- never when is_demo — so a real user can never mutate a demo persona.
do $$
declare t text;
begin
  foreach t in array array[
    'evidence','resume_evidence','github_repositories','projects','certificates',
    'hackathons','learning_evidence','capability_profiles','skill_gaps',
    'learning_progress'
  ] loop
    execute format($f$
      create policy "read %1$s" on public.%1$I for select using (
        candidate_profile_id = public.my_candidate_profile()
        or is_demo
        or public.is_admin()
        or exists (select 1 from public.applications a
                     join public.requisitions q on q.id = a.requisition_id
                    where a.candidate_profile_id = %1$I.candidate_profile_id
                      and q.recruiter_profile_id = public.my_recruiter_profile())
      );$f$, t);
    execute format($f$
      create policy "write %1$s" on public.%1$I for all
        using (candidate_profile_id = public.my_candidate_profile() and not is_demo)
        with check (candidate_profile_id = public.my_candidate_profile() and not is_demo);
    $f$, t);
  end loop;
end $$;

-- ── github_connections: NO client access at all ─────────────────────────────
-- The row holds an encrypted access token. Only the service role (the PIE server)
-- may touch it. There is deliberately no select policy for anon/authenticated.
create policy "no client access to github tokens" on public.github_connections
  for select using (false);

-- ── requisitions ────────────────────────────────────────────────────────────
create policy "read open requisitions" on public.requisitions for select
  using (status = 'OPEN' or recruiter_profile_id = public.my_recruiter_profile()
      or is_demo or public.is_admin());
create policy "recruiter writes own requisitions" on public.requisitions for all
  using (recruiter_profile_id = public.my_recruiter_profile() and not is_demo)
  with check (recruiter_profile_id = public.my_recruiter_profile() and not is_demo);

create policy "read job requirements" on public.job_requirements for select
  using (exists (select 1 from public.requisitions q where q.id = requisition_id));

-- ── applications: the candidate and the owning recruiter, nobody else ───────
create policy "read applications" on public.applications for select using (
  candidate_profile_id = public.my_candidate_profile()
  or is_demo or public.is_admin()
  or exists (select 1 from public.requisitions q
              where q.id = applications.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));
create policy "candidate applies" on public.applications for insert
  with check (candidate_profile_id = public.my_candidate_profile() and not is_demo);
create policy "participants update application" on public.applications for update using (
  (candidate_profile_id = public.my_candidate_profile() and not is_demo)
  or exists (select 1 from public.requisitions q
              where q.id = applications.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));

-- ── agent output, assessments, governance ──────────────────────────────────
create policy "read agent runs" on public.agent_runs for select using (
  candidate_profile_id = public.my_candidate_profile() or is_demo or public.is_admin()
  or exists (select 1 from public.requisitions q
              where q.id = agent_runs.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));

create policy "read match results" on public.match_results for select using (
  candidate_profile_id = public.my_candidate_profile() or is_demo or public.is_admin()
  or exists (select 1 from public.requisitions q
              where q.id = match_results.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));

create policy "read capability signals" on public.capability_signals for select using (
  exists (select 1 from public.capability_profiles c
           where c.id = capability_profile_id
             and (c.candidate_profile_id = public.my_candidate_profile()
               or c.is_demo or public.is_admin())));

create policy "read assessments" on public.assessments for select using (auth.uid() is not null);

create policy "read attempts" on public.assessment_attempts for select using (
  candidate_profile_id = public.my_candidate_profile() or is_demo or public.is_admin());
create policy "candidate writes own attempts" on public.assessment_attempts for all
  using (candidate_profile_id = public.my_candidate_profile() and not is_demo)
  with check (candidate_profile_id = public.my_candidate_profile() and not is_demo);

-- A candidate sees their own integrity events; only Trust & Integrity sees all.
create policy "read proctoring events" on public.proctoring_events for select using (
  candidate_profile_id = public.my_candidate_profile() or public.is_admin());

-- Bias signals are governance data: the admin reviews them, the recruiter sees
-- the ones on their own requisitions. A candidate is not shown signals about
-- themselves that they cannot act on.
create policy "read bias audits" on public.bias_audits for select using (
  public.is_admin() or is_demo
  or exists (select 1 from public.requisitions q
              where q.id = bias_audits.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));
create policy "admin actions bias audits" on public.bias_audits for update using (public.is_admin());

-- Everyone involved can see the decision that was made about them.
create policy "read human decisions" on public.human_decisions for select using (
  candidate_profile_id = public.my_candidate_profile() or is_demo or public.is_admin()
  or exists (select 1 from public.requisitions q
              where q.id = human_decisions.requisition_id
                and q.recruiter_profile_id = public.my_recruiter_profile()));

-- A candidate can see the trail concerning them; an admin sees everything.
create policy "read audit events" on public.audit_events for select using (
  public.is_admin()
  or (meta ->> 'candidateProfileId')::uuid = public.my_candidate_profile());

-- ════════════════════════════════════════════════════════════════ TRIGGERS
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists candidate_profiles_touch on public.candidate_profiles;
create trigger candidate_profiles_touch before update on public.candidate_profiles
  for each row execute function public.touch_updated_at();

-- New auth user → profile row, using the metadata the client supplied at sign-up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, role, full_name, username, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'role', 'candidate'),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ════════════════════════════════════════════════════════════════════ DONE
-- Verify: select tablename, rowsecurity from pg_tables where schemaname='public';
-- Every row must show rowsecurity = true.
