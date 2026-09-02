import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon, Button, Card, CardHead, Badge, Stat, Alert, Skeleton, cx } from '../kit.jsx';

const STATE_TONE = {
  CONNECTED: 'on', LIVE: 'on', LIVE_API: 'on', LIVE_API_READ_ONLY: 'on',
  LINK_REDIRECTION_ACTIVE: 'on', OAUTH_CONFIGURED: 'on',
  ADAPTER_READY: 'part', ANALYTICS_INTEGRATION_POINT: 'part', DEMO_DATA: 'part',
  DEMO_FIXTURES: 'part', DEGRADED: 'part', CONFIGURED_UNVERIFIED: 'part',
  REACHABLE_SCHEMA_PARTIAL: 'part', MISCONFIGURED: 'part',
  PERMISSION_DENIED: 'part', AUTH_REJECTED: 'part',
  OFFLINE: 'off', OFFLINE_TEMPLATE_MODE: 'off', FUTURE_INTEGRATION: 'off',
  NOT_CONFIGURED: 'off', UNREACHABLE: 'off', REACHABLE_SCHEMA_MISSING: 'off',
};
const STATE_BADGE = { on: 'ok', part: 'warn', off: 'neutral' };

export default function SapReadiness({ ctx }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.services(), api.sapLandscape()])
      .then(([s, l]) => setData({ services: s, landscape: l }))
      .catch(e => setErr(e.message));
  }, []);

  if (err) return <Card pad><Alert tone="crit" title="Could not read the integration landscape">{err}</Alert></Card>;
  if (!data) return <Skeleton lines={6} />;

  const all = data.services.services;
  const live = all.filter(s => STATE_TONE[s.state] === 'on');
  const ready = all.filter(s => STATE_TONE[s.state] === 'part');
  const future = all.filter(s => STATE_TONE[s.state] === 'off');

  return (
    <div className="stack">
      <Alert tone="info" title="How to read this page" icon="lock">
        {data.landscape.principle} Nothing on this page is hand-written — each row is the adapter's
        own answer, read when you loaded the page.
      </Alert>

      <div className="grid g-3">
        <Card><Stat label="Live now" value={live.length} tone="ok" icon="plug"
          detail="configured and answering" /></Card>
        <Card><Stat label="Adapter ready" value={ready.length} tone="warn" icon="layers"
          detail="interface built, not provisioned" /></Card>
        <Card><Stat label="Future integration" value={future.length} icon="clock"
          detail="requires tenant or documentation" /></Card>
      </div>

      <Card flush>
        <CardHead icon="plug" eyebrow="Landscape" title="SAP integration readiness"
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
          <CardHead icon="learn" eyebrow="Where SAP is real today" title="SAP Learning Hub, student edition" />
          <div className="card__body sapcard__body">
            <p className="lede">
              PIE maps a skill gap to an SAP-provided learning objective and hands the candidate off to
              learning.sap.com with their own SAP Universal ID.
            </p>
            <Alert tone="warn" title="The boundary we do not cross">
              There is no verified enrolment or completion API for the student edition. PIE therefore
              never asserts that a candidate completed anything on SAP's side. Capability change is
              proven by PIE reassessment, which produces its own evidence.
            </Alert>
            <div className="sapcard__foot">
              <a className="btn btn--primary" href="https://learning.sap.com/free-student-edition"
                target="_blank" rel="noreferrer">
                <Icon name="ext" size={14} />Open SAP Learning Hub
              </a>
            </div>
          </div>
        </Card>

        <Card flush className="sapcard">
          <CardHead icon="sparkle" eyebrow="Where SAP is real today" title="SAP Generative AI Hub" />
          <div className="card__body sapcard__body">
            <p className="lede">
              The four PIE agents route their language calls through one adapter. It prefers SAP
              Generative AI Hub when an SAP AI Core deployment is configured, and otherwise uses the
              first provider that is — including a model you host yourself.
            </p>
            <Alert tone="info" title="Why this cannot break the demo">
              The LLM layer only interprets and narrates. Every score, gap, ranking and audit signal is
              computed deterministically, so the numbers are identical whether SAP Generative AI Hub is
              connected, another provider is connected, or nothing is.
            </Alert>
            <div className="sapcard__foot">
              <div className="sapcard__meta">
                <span className="eyebrow">Current provider</span>
                <span className="row" style={{ gap: 8, marginTop: 4 }}>
                  <b className="t-13">{ctx.boot?.ai?.provider}</b>
                  <Badge tone={ctx.boot?.ai?.mode === 'LIVE' ? 'ok' : 'neutral'} dot>
                    {ctx.boot?.ai?.mode}
                  </Badge>
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <ProviderChain />

      <Persistence ctx={ctx} services={all} />

      <Card flush>
        <CardHead icon="layers" eyebrow="Architecture" title="PIE Core and the SAP integration boundary"
          sub="PIE Core runs on the technology best suited to each component; SAP is used where it adds real value" />
        <div className="card__body">
          <div className="grid g-2">
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>PIE Core (stack-independent)</div>
              {['Evidence ingestion and trust tiering', 'Potential Intelligence Engine (deterministic)',
                'The four specialised agents', 'Orchestrator control plane and audit',
                'Assessment engine and integrity policy', 'Bias audit service'].map(x => (
                <div key={x} className="row" style={{ gap: 8, padding: '6px 0', borderTop: '1px solid var(--line-1)' }}>
                  <Icon name="check" size={13} style={{ color: 'var(--ok-fg)' }} />
                  <span className="t-13">{x}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--accent-600)' }}>SAP integration layer</div>
              {[['Generative AI Hub', 'Agent language calls'], ['Learning Hub', 'Learning resources'],
                ['BTP / CAP', 'Enterprise services'], ['HANA Cloud', 'Enterprise persistence'],
                ['Analytics Cloud / BDC', 'Cohort analytics'], ['SuccessFactors / TIH', 'Talent workflow']].map(([n, d]) => (
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
            plus its domain methods. No SAP-specific logic sits in any UI component, and no adapter
            fabricates a response when it is not configured.
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
