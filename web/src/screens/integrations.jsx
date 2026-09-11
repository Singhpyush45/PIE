import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon, Button, Card, CardHead, Badge, Stat, Alert, Skeleton, cx } from '../kit.jsx';

/* PIE — Integrations.
   Every row on this page is an adapter's own answer, read when the page loaded.
   Nothing here is written by hand, which is why an integration can never look
   more finished on this screen than it is in the code. */

const STATE_TONE = {
  CONNECTED: 'on', LIVE: 'on', LIVE_API: 'on', LIVE_API_READ_ONLY: 'on',
  OAUTH_CONFIGURED: 'on', VERIFIED: 'on', ENFORCED: 'on', RESTORED: 'on', CURRENT: 'on',
  ADAPTER_READY: 'part', DEMO_DATA: 'part', DEMO_FIXTURES: 'part', DEGRADED: 'part',
  CONFIGURED_UNVERIFIED: 'part', REACHABLE_SCHEMA_PARTIAL: 'part', MISCONFIGURED: 'part',
  PERMISSION_DENIED: 'part', AUTH_REJECTED: 'part', INCOMPLETE: 'part', IDLE: 'part',
  OFFLINE: 'off', OFFLINE_TEMPLATE_MODE: 'off', NOT_CONFIGURED: 'off', OFF: 'off',
  UNREACHABLE: 'off', REACHABLE_SCHEMA_MISSING: 'off', REFUSED: 'off', UNAVAILABLE: 'off',
};
const STATE_BADGE = { on: 'ok', part: 'warn', off: 'neutral' };

export default function Integrations({ ctx }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.services(), api.integrationLandscape()])
      .then(([s, l]) => setData({ services: s, landscape: l }))
      .catch(e => setErr(e.message));
  }, []);

  if (err) return <Card pad><Alert tone="crit" title="Could not read the integration landscape">{err}</Alert></Card>;
  if (!data) return <Skeleton lines={6} />;

  const all = data.services.services;
  const live = all.filter(s => STATE_TONE[s.state] === 'on');
  const ready = all.filter(s => STATE_TONE[s.state] === 'part');
  const off = all.filter(s => STATE_TONE[s.state] === 'off' || !STATE_TONE[s.state]);
  const corsair = all.find(s => s.key === 'corsair');
  const github = all.find(s => s.key === 'github');

  return (
    <div className="stack">
      <Alert tone="info" title="How to read this page" icon="lock">
        {data.landscape.principle} Nothing here is hand-written — each row is the adapter's own
        answer, read when you loaded the page.
      </Alert>

      <div className="grid g-3">
        <Card><Stat label="Live now" value={live.length} tone="ok" icon="plug"
          detail="configured and answering" /></Card>
        <Card><Stat label="Adapter ready" value={ready.length} tone="warn" icon="layers"
          detail="interface built, not verified" /></Card>
        <Card><Stat label="Not configured" value={off.length} icon="clock"
          detail="no credentials on this deployment" /></Card>
      </div>

      <Card flush>
        <CardHead icon="plug" eyebrow="Landscape" title="Integrations"
          sub="Every service, its real state, and exactly what it would take to light it up" />
        <div className="card__body">
          <div className="grid" style={{ gap: 10 }}>
            {all.map(s => {
              const tone = STATE_TONE[s.state] || 'off';
              return (
                <div className="svc" key={s.key || s.name}>
                  <span className={`svc__dot svc__dot--${tone}`} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row row--wrap" style={{ gap: 8 }}>
                      <span className="svc__n">{s.name}</span>
                      <Badge tone={STATE_BADGE[tone]} dot>{s.state.replace(/_/g, ' ')}</Badge>
                      {s.classification && <Badge tone="neutral">{s.classification.split('—')[0].trim()}</Badge>}
                    </div>
                    <div className="svc__d">{s.detail}</div>
                    {s.limitation && (
                      <p className="note">
                        <Icon name="info" size={12} className="note__i" />
                        <span>{s.limitation}</span>
                      </p>
                    )}
                    {s.requires && (
                      <details className="setup">
                        <summary>Setup</summary>
                        <div className="setup__body">
                          Requires <span className="mono">{s.requires}</span>
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <div className="grid g-2">
        <Card flush className="sapcard">
          <CardHead icon="plug" eyebrow="Evidence plumbing" title="Corsair"
            right={corsair && <Badge tone={STATE_BADGE[STATE_TONE[corsair.state] || 'off']} dot>
              {corsair.state.replace(/_/g, ' ')}</Badge>} />
          <div className="card__body sapcard__body">
            <p className="lede">
              PIE reads a candidate's real work out of the tools they already use. The hard part was
              never the reasoning — it was OAuth per service, tokens to refresh, and a different
              client for every API. Corsair collapses that into one shape, and its synced database
              turns evidence gathering from a fan-out of live calls into a local read.
            </p>
            <p className="muted small">
              Corsair runs <b>inside</b> this server as an SDK — it is not a service PIE calls. Each
              candidate is a separate tenant, and every stored authorisation lives in PIE's own
              Postgres, encrypted. Corsair Hub performs the OAuth handshake and does not keep the
              resulting token.
            </p>
            {corsair?.plugins?.length > 0 && (
              <div className="row row--wrap" style={{ gap: 6, marginBottom: 10 }}>
                {corsair.plugins.map(p => <Badge key={p} tone="ok" icon="check">{p}</Badge>)}
              </div>
            )}
            <Alert tone={corsair?.state === 'CONNECTED' ? 'ok' : 'warn'}
              title={corsair?.state === 'CONNECTED' ? 'Proven, not assumed' : 'What is actually true right now'}>
              {corsair?.detail}
            </Alert>
            {corsair?.guarantees?.length > 0 && (
              <ul className="ticks small" style={{ marginTop: 10 }}>
                {corsair.guarantees.map(g => <li key={g}>{g}</li>)}
              </ul>
            )}
            {corsair?.limitation && (
              // Shown at the same size as the guarantee it qualifies. A caveat in
              // smaller print than the claim it limits is a way of not making it.
              <Alert tone="neutral" title="The limit of that guarantee">
                {corsair.limitation}
              </Alert>
            )}
            {corsair?.missing?.length > 0 && (
              <p className="muted small" style={{ marginTop: 8 }}>
                Not set: {corsair.missing.map((m, i) => (
                  <span key={m}><span className="mono">{m}</span>{i < corsair.missing.length - 1 ? ', ' : ''}</span>
                ))}. All four are required together — three out of four is not a working integration.
              </p>
            )}
          </div>
        </Card>

        <Card flush className="sapcard">
          <CardHead icon="git" eyebrow="Evidence source" title="GitHub"
            right={github && <Badge tone={STATE_BADGE[STATE_TONE[github.state] || 'off']} dot>
              {github.state.replace(/_/g, ' ')}</Badge>} />
          <div className="card__body sapcard__body">
            <p className="lede">
              Repositories, languages and activity become <b>supporting</b> evidence — never proof of
              skill. PIE prefers Corsair's synced data when it is available and falls back to
              GitHub's own API, then to labelled demo data. Whichever it used is shown to the
              candidate on the import screen.
            </p>
            <Alert tone="neutral" title="Why there are three sources">
              An integration that has to be working for the product to run is a single point of
              failure. Each source degrades to the next, and PIE names the one it actually used
              rather than letting you assume the best one.
            </Alert>
          </div>
        </Card>
      </div>

      <ProviderChain />

      <Persistence ctx={ctx} services={all} />

      <Card flush>
        <CardHead icon="layers" eyebrow="Architecture" title="PIE Core and the integration boundary"
          sub="The intelligence is stack-independent; integrations are how evidence gets in and decisions get out" />
        <div className="card__body">
          <div className="grid g-2">
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>PIE Core (stack-independent)</div>
              {['Evidence ingestion and trust tiering', 'Potential Intelligence Engine (deterministic)',
                'The six specialised agents', 'Orchestrator control plane and audit',
                'Assessment engine and integrity policy', 'Bias audit service'].map(x => (
                <div key={x} className="row" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--line-1)' }}>
                  <Icon name="check" size={13} style={{ color: 'var(--ok-fg)' }} />
                  <span className="t-13">{x}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--accent-600)' }}>Integration layer</div>
              {[['Corsair', 'Synced evidence from the candidate\u2019s own tools'],
                ['GitHub', 'Repository activity as supporting evidence'],
                ['Supabase', 'Durable accounts, evidence and decisions'],
                ['Email', 'Verification codes and reset links'],
                ['LLM provider', 'Narration only \u2014 never a score']].map(([n, d]) => (
                <div key={n} className="row" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--line-1)' }}>
                  <Icon name="plug" size={13} style={{ color: 'var(--accent-600)' }} />
                  <span className="t-13" style={{ flex: 1 }}><b>{n}</b> — {d}</span>
                </div>
              ))}
            </div>
          </div>
          <Alert tone="neutral" title="The rule">
            Every adapter lives in <span className="mono">server/src/integrations/</span> and exposes
            the same shape: <span className="mono">isConfigured()</span> and <span className="mono">status()</span>,
            plus its domain methods. No integration-specific logic sits in any UI component, and no
            adapter fabricates a response when it is not configured.
          </Alert>
        </div>
      </Card>
    </div>
  );
}

/* ============================================================= PERSISTENCE
   Where PIE's data actually lives, and what it would take to move it. The
   state shown is the driver's own answer, never a hard-coded claim.        */
function Persistence({ ctx, services }) {
  const [check, setCheck] = useState(null);
  const [checkedAt, setCheckedAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const isAdmin = ctx.user?.role === 'admin';
  const sb = services.find(s => s.key === 'supabase');

  async function verify() {
    setBusy(true); setErr(null);
    try {
      setCheck(await api.supabaseCheck());
      setCheckedAt(new Date().toLocaleTimeString());
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const state = check?.state || sb?.state || 'NOT_CONFIGURED';
  const tone = STATE_TONE[state] || 'off';

  return (
    <Card flush>
      <CardHead icon="layers" eyebrow="Persistence" title="Where PIE's data lives"
        sub="System of record, and the enterprise path out of it"
        right={<Badge tone={STATE_BADGE[tone]} dot>{state.replace(/_/g, ' ')}</Badge>} />
      <div className="card__body">
        <div className="grid g-2">
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>Today — local JSON store</div>
            <p className="t-13 muted" style={{ lineHeight: 1.6 }}>
              Every account, evidence item, run, decision and audit event is written to a single
              inspectable file on the server. It needs no network, so the demo behaves identically
              with the connection unplugged, and the whole state can be reset in one click.
            </p>
            <div className="t-12 muted" style={{ marginTop: 8 }}>
              Passwords are stored as bcrypt hashes. GitHub tokens are encrypted with AES-256-GCM.
              Neither the plaintext password nor the token is ever written, logged or returned.
            </div>
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--accent-600)' }}>
              Next — Supabase (PostgreSQL + Row Level Security)
            </div>
            <p className="t-13 muted" style={{ lineHeight: 1.6 }}>
              A complete schema ships with the project at{' '}
              <span className="mono">server/supabase/schema.sql</span>: every table, foreign key and
              RLS policy, so one candidate cannot read another's evidence even with a valid token —
              the database refuses, not the UI. It activates when the two environment variables are
              set; nothing about the product changes if they are not.
            </p>
            {/* One place for the state sentence, and the live check wins over the
                cached one — otherwise a CONNECTED badge can sit above text still
                asking you to verify. */}
            <div className="t-12 muted" style={{ marginTop: 8 }}>
              {check?.detail || sb?.detail}
            </div>
          </div>
        </div>

        {isAdmin && (
          <div className="row row--wrap" style={{ gap: 10, marginTop: 14 }}>
            <Button variant="secondary" icon="refresh" onClick={verify} disabled={busy}>
              {busy ? 'Checking…' : 'Verify connection'}
            </Button>
            {check && (
              // The sentence already appears above; here just say what was checked.
              <span className="t-12 muted">
                {check.host || 'checked'}
                {check.tables?.length ? ` · ${check.tables.length} tables found` : ''}
                {checkedAt ? ` · ${checkedAt}` : ''}
              </span>
            )}
          </div>
        )}
        {err && <Alert tone="crit" title="Could not check Supabase">{err}</Alert>}
        {/* Only a genuine schema gap sends anyone to schema.sql. A privilege or
            credential failure also leaves every table "missing" — naming the wrong
            file there costs an hour. */}
        {check?.missing?.length > 0 && check.state === 'REACHABLE_SCHEMA_PARTIAL' && (
          <Alert tone="warn" title="Schema not fully applied">
            Missing tables: <span className="mono">{check.missing.join(', ')}</span>. Run{' '}
            <span className="mono">server/supabase/schema.sql</span> in the Supabase SQL editor.
          </Alert>
        )}
        {check?.state === 'PERMISSION_DENIED' && (
          <Alert tone="warn" title="The tables are there — the API role has no privileges">
            Run <span className="mono">server/supabase/grants.sql</span> in the Supabase SQL editor.
            It adds GRANTs only: nothing is created, altered or dropped, no row changes, and Row
            Level Security stays on for every table.
          </Alert>
        )}
        {!isAdmin && (
          <div className="t-11 faint" style={{ marginTop: 12 }}>
            The live connection check names the database host, so it is available to Trust &amp;
            Integrity administrators only.
          </div>
        )}
      </div>
    </Card>
  );
}

/* ========================================================== PROVIDER CHAIN
   The honest answer to two questions a juror is likely to ask: "are you locked
   to one AI vendor?" and "does candidate data have to leave our building?".
   Every row is the adapter's own state, not a claim typed into a slide.        */
const PROVIDER_TONE = {
  ACTIVE: 'ok', CONFIGURED_STANDBY: 'info', FALLBACK: 'neutral', NOT_CONFIGURED: 'neutral',
};

function ProviderChain() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.aiProviders().then(setData).catch(e => setErr(e.message));
  }, []);

  if (err) return null;                     // never let this block the page
  if (!data) return <Card pad><Skeleton lines={3} /></Card>;

  const hasLocal = data.providers.some(p => p.dataLeavesMachine === false && p.key !== 'templates');

  return (
    <Card flush>
      <CardHead icon="sparkle" eyebrow="AI layer" title="Which model writes the words"
        sub="One adapter, four possible providers, and a deterministic floor underneath"
        right={(() => {
          const act = data.providers.find(x => x.state === 'ACTIVE');
          return <Badge tone={act?.key === 'templates' ? 'neutral' : 'ok'} dot>
            {act ? `in use: ${act.name}` : 'none'}
          </Badge>;
        })()} />
      <div className="card__body">
        <Alert tone="info" title="Why the provider barely matters here" icon="lock">
          {data.principle}
        </Alert>

        <div className="grid" style={{ gap: 8, marginTop: 14 }}>
          {data.providers.map((p, i) => (
            <div className="svc" key={p.key}>
              <span className={cx('svc__dot', `svc__dot--${p.state === 'ACTIVE' ? 'on' : p.state === 'CONFIGURED_STANDBY' ? 'part' : 'off'}`)}
                aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row row--wrap" style={{ gap: 8 }}>
                  <span className="t-11 faint tnum" style={{ minWidth: 16 }}>{i + 1}</span>
                  <span className="svc__n">{p.name}</span>
                  <Badge tone={PROVIDER_TONE[p.state] || 'neutral'} dot>{p.state.replace(/_/g, ' ')}</Badge>
                  {p.model && <span className="mono t-11 muted">{p.model}</span>}
                  {p.dataLeavesMachine === false && p.key !== 'templates' && (
                    <Badge tone="ok" icon="lock">stays on your infrastructure</Badge>
                  )}
                </div>
                {p.caution && (
                  <p className="note">
                    <Icon name="info" size={12} className="note__i" />
                    <span>{p.caution}</span>
                  </p>
                )}
                {p.state === 'NOT_CONFIGURED' && (
                  <details className="setup">
                    <summary>Setup</summary>
                    <div className="setup__body">
                      Requires <span className="mono">{p.requires}</span>
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>

        {hasLocal && (
          <Alert tone="neutral" title="For institutions that cannot send candidate data to a third party"
            icon="shield">
            PIE can run its narration against a model you host yourself — Ollama, reached through the
            same adapter as every other provider. Because every score is computed <i>before</i> any
            model is called, switching to a local model changes the wording and not one number: the
            capability profile, the match, the gaps and the bias signals are identical.
          </Alert>
        )}
      </div>
    </Card>
  );
}
