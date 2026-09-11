-- ============================================================================
--  PIE — migration 004: Corsair integration tables
--
--  WHY THIS IS NEEDED
--    Corsair is an SDK that runs inside PIE, not a service PIE calls. It keeps
--    its own state — which candidate has authorised which provider, the
--    encrypted credential, and any data it has synced — in the application's
--    own database. These are those tables.
--
--    Nothing works before this file is run. `corsair.verify()` reads
--    corsair_integrations specifically so that a missing table is reported as a
--    refusal on the Integrations screen rather than surfacing later as an
--    unexplained failure while a candidate is importing repositories.
--
--  WHAT IS ACTUALLY STORED HERE
--    corsair_accounts.dek and corsair_integrations.dek hold DATA ENCRYPTION
--    KEYS, each encrypted under PIE's CORSAIR_KEK — envelope encryption. The
--    OAuth credential itself lives inside `config`, encrypted under that DEK.
--
--    Two consequences worth being clear about:
--      • Lose CORSAIR_KEK and every stored authorisation becomes unreadable.
--        Candidates would have to reconnect. Set it once and never rotate it
--        casually — the same rule TOKEN_ENCRYPTION_KEY already lives under.
--      • Anyone who can read these rows AND holds CORSAIR_KEK can read a
--        candidate's GitHub token. The KEK is in the server environment and
--        never in the database, so the two halves are never in one place.
--
--  ROW LEVEL SECURITY
--    RLS is enabled on all five tables with NO policies at all. That is not an
--    oversight and not a placeholder — it is the strongest available setting:
--    with RLS on and no policy granting anything, the `anon` and
--    `authenticated` roles (the ones reachable with the publishable key from a
--    browser) can read nothing. PIE reaches these tables over a direct
--    Postgres connection as the database owner, which is not subject to RLS.
--
--    So: no browser, no publishable key, and no PostgREST request can read a
--    candidate's encrypted credential, whatever else goes wrong.
--
--  SAFE TO RE-RUN
--    Every statement is IF NOT EXISTS. Running this twice changes nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
--  Integrations — one row per configured plugin (github, and any added later).
-- ---------------------------------------------------------------------------
create table if not exists public.corsair_integrations (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  name        text        not null,
  config      jsonb       not null default '{}'::jsonb,
  dek         text
);

-- ---------------------------------------------------------------------------
--  Accounts — one row per (tenant, integration). In PIE a tenant is a single
--  candidate profile, so this is the table that keeps one candidate's
--  authorisation separate from another's.
-- ---------------------------------------------------------------------------
create table if not exists public.corsair_accounts (
  id              text primary key,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  tenant_id       text        not null,
  integration_id  text        not null,
  config          jsonb       not null default '{}'::jsonb,
  dek             text
);

create index if not exists corsair_accounts_tenant_idx
  on public.corsair_accounts (tenant_id, integration_id);

-- ---------------------------------------------------------------------------
--  Entities — synced third-party objects (repositories, commits, releases…).
--  This is what makes evidence gathering a local query instead of a fan-out of
--  live API calls against a rate limit.
--
--  Not sensitive in the way the tables above are: it holds public repository
--  metadata, not credentials. RLS is on regardless, because a candidate's
--  repository list is still theirs and not a neighbour's to read.
-- ---------------------------------------------------------------------------
create table if not exists public.corsair_entities (
  id           text primary key,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  account_id   text        not null,
  entity_id    text        not null,
  entity_type  text        not null,
  version      text        not null,
  data         jsonb       not null default '{}'::jsonb
);

create unique index if not exists corsair_entities_account_type_entity_idx
  on public.corsair_entities (account_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
--  Events — inbound webhook deliveries, and their processing state.
-- ---------------------------------------------------------------------------
create table if not exists public.corsair_events (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  account_id  text        not null,
  event_type  text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  status      text
);

create index if not exists corsair_events_account_type_created_idx
  on public.corsair_events (account_id, event_type, created_at);

-- ---------------------------------------------------------------------------
--  Permissions — pending approvals for actions that need a human.
--
--  PIE runs Corsair read-only, so in normal operation this table stays empty.
--  It exists because the SDK expects it, and because an empty approvals table
--  is itself evidence: if a row ever appears here, something in PIE attempted
--  a write against a candidate's account and that is worth noticing.
--
--  expires_at is text, not timestamptz, because the SDK reads it as a string.
-- ---------------------------------------------------------------------------
create table if not exists public.corsair_permissions (
  id          text primary key,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  token       text        not null,
  plugin      text        not null,
  endpoint    text        not null,
  args        text        not null,
  tenant_id   text        not null,
  status      text        not null default 'pending',
  expires_at  text        not null,
  error       text
);

create index if not exists corsair_permissions_token_idx
  on public.corsair_permissions (token);

-- ---------------------------------------------------------------------------
--  Row Level Security: on, with no policies. See the header.
-- ---------------------------------------------------------------------------
alter table public.corsair_integrations enable row level security;
alter table public.corsair_accounts     enable row level security;
alter table public.corsair_entities     enable row level security;
alter table public.corsair_events       enable row level security;
alter table public.corsair_permissions  enable row level security;

-- ---------------------------------------------------------------------------
--  Verify (run these after; each should return what the comment says)
-- ---------------------------------------------------------------------------
-- select table_name from information_schema.tables
--  where table_schema = 'public' and table_name like 'corsair_%';
-- -- expect five rows
--
-- select count(*) from pg_policies where tablename like 'corsair_%';
-- -- expect 0 — RLS is on with no policies, so no browser-reachable role gets in
--
-- select relname, relrowsecurity from pg_class
--  where relname like 'corsair_%' and relkind = 'r';
-- -- expect relrowsecurity = true for all five
