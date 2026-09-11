import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import { VIEWS, HOME, navFor, crumbsFor, useNavStack } from './nav.js';
import { Icon, Button, Badge, Alert, Skeleton, Tooltip, cx } from './kit.jsx';
import AuthScreen from './screens/auth.jsx';
import CandidateScreens from './screens/candidate.jsx';
import RecruiterScreens from './screens/recruiter.jsx';
import AdminScreens from './screens/admin.jsx';
import Integrations from './screens/integrations.jsx';
import DemoMode from './screens/demo.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [boot, setBoot] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('pie-theme') || 'light');
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [services, setServices] = useState(null);
  const [examMode, setExamMode] = useState(false);
  const [entryNotice, setEntryNotice] = useState(null);

  const nav = useNavStack('c-dash');

  /* ------------------------------------------------------------- session */
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pie-theme', theme);
  }, [theme]);

  // The GitHub callback returns to "/" with a status flag. Read it, tell the user,
  // and strip it from the URL so a refresh does not repeat the message.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const gh = q.get('github');
    if (!gh) return;
    const reason = q.get('reason');
    const msg = gh === 'connected'
      ? 'GitHub connected. Choose the repositories you want PIE to analyse.'
      : `GitHub could not be connected${reason ? `: ${reason}` : '.'}`;
    setEntryNotice({ tone: gh === 'connected' ? 'ok' : 'crit', msg });
    setToast({ tone: gh === 'connected' ? 'ok' : 'crit', msg });
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (!getToken()) { setBooting(false); return; }
    api.me()
      .then(r => { setUser(r.user); nav.reset(HOME[r.user.role]); })
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setBoot(b);
      return b;
    } catch (e) {
      if (e.status === 401) { setUser(null); setToken(null); }
      else notify('crit', e.message);
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!user) { setBoot(null); return; }
    reload();
    api.services().then(setServices).catch(() => {});
  }, [user, reload]);

  const notify = useCallback((tone, msg) => setToast({ tone, msg }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  function signedIn(u) {
    setUser(u);
    nav.reset(HOME[u.role]);
  }

  async function signOut() {
    try { await api.logout(); } catch { /* demo session may already be gone */ }
    setToken(null); setUser(null); setBoot(null); setExamMode(false);
  }

  async function resetDemo() {
    await api.reset();   // resets the demo world only; real accounts are untouched
    setToken(null); setUser(null); setBoot(null); setExamMode(false);
    notify('ok', 'Demo state reset and reseeded.');
  }

  /* --------------------------------------------------------------- gates */
  if (booting) {
    return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 32 }}>
      <div style={{ width: 420 }}><Skeleton lines={4} /></div>
    </div>;
  }
  if (!user) return <AuthScreen onSignedIn={signedIn} theme={theme} setTheme={setTheme} notice={entryNotice} />;

  const groups = navFor(user.role);
  const meta = VIEWS[nav.view] || { title: '' };
  const crumbs = crumbsFor(nav.view, nav.params);

  const ctx = {
    user, boot, services, nav, notify, reload,
    setExamMode, examMode, theme,
  };

  return (
    <div className={cx('shell', examMode && 'shell--exam')}>
      <a className="skip-link" href="#main">Skip to content</a>
      {navOpen && <div className="navscrim" onClick={() => setNavOpen(false)} />}

      {/* ============================================================ NAV */}
      <aside id="primary-nav" className={cx('nav', navOpen && 'nav--open')} aria-label="Primary">
        <div className="nav__brand">
          <div className="nav__mark"><img src="/pie-logo.svg" alt="" /></div>
          <div>
            <div className="nav__name">PIE</div>
            <div className="nav__sub">Career Orchestrator</div>
          </div>
        </div>

        <div className="nav__scroll">
          <div className="nav__group">
            <div className="nav__label">Signed in as</div>
            <div className="acct" style={{ cursor: 'default' }}>
              <div className="acct__av">{user.name.split(' ').map(n => n[0]).join('').slice(0, 2)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="acct__n">{user.name}</div>
                <div className="acct__t">{user.title || user.organization || user.role}</div>
              </div>
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              {user.isDemo
                ? <Badge tone="warn" icon="play">Demo persona</Badge>
                : <Badge tone="ok" icon="check">Signed in</Badge>}
              <Badge tone="info">{user.role}</Badge>
            </div>
          </div>

          {groups.map(g => (
            <div className="nav__group" key={g.section}>
              <div className="nav__label">{g.section}</div>
              {g.items.map(it => (
                <button key={it.key} className="nav__item"
                  aria-current={nav.view === it.key ? 'page' : undefined}
                  onClick={() => { nav.go(it.key); setNavOpen(false); }}>
                  <Icon name={it.icon} size={16} />
                  {it.title}
                  {counterFor(it.key, boot) > 0 && <span className="count">{counterFor(it.key, boot)}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="nav__foot">
          <div className="col" style={{ gap: 8 }}>
            <ServiceChip services={services} />
            <Badge tone="sap" icon="award" >Hack &amp; Build 2026</Badge>
            <Button variant="ghost" size="sm" icon="x" onClick={signOut} style={{ justifyContent: 'flex-start' }}>
              Sign out
            </Button>
            <div className="t-11 faint" style={{ lineHeight: 1.5 }}>
              Potential over pedigree.<br />AI recommends. Recruiters decide.
            </div>
          </div>
        </div>
      </aside>

      {/* =========================================================== MAIN */}
      <main className="main">
        {examMode ? (
          <div className="examtop">
            <div className="examtop__brand">
              <span className="examtop__mark"><img src="/pie-logo.svg" alt="" /></span>
              PIE Secure Assessment
            </div>
            <Badge tone="crit" dot>Isolated mode — navigation hidden</Badge>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="t-12 muted">{user.name}</span>
          </div>
        ) : (
        <header className="topbar">
          <Button variant="ghost" className="btn--icon menubtn" onClick={() => setNavOpen(o => !o)}
            aria-label="Toggle navigation" aria-expanded={navOpen} aria-controls="primary-nav">
            <Icon name="menu" size={18} />
          </Button>

          {nav.canBack && (
            <button className="backbtn" onClick={nav.back}
              aria-label={`Back to ${VIEWS[nav.previous.view]?.title || 'previous view'}`}>
              <Icon name="right" size={14} style={{ transform: 'rotate(180deg)' }} />
              Back
            </button>
          )}

          <div style={{ minWidth: 0 }}>
            {/* The view title is the page heading: screen-reader users land on it. */}
            <h1 className="topbar__title">{nav.params.title || meta.title}</h1>
            <nav className="crumbs" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <React.Fragment key={`${c.key}-${i}`}>
                  {i > 0 && <span className="sep" aria-hidden="true">/</span>}
                  {c.key && i < crumbs.length - 1
                    ? <button onClick={() => nav.go(c.key)}>{c.title}</button>
                    : <span className={i === crumbs.length - 1 ? 'cur' : ''}>{c.title}</span>}
                </React.Fragment>
              ))}
            </nav>
          </div>

          <span className="spacer" />

          {user.isDemo && (
            <Button variant="ghost" size="sm" icon="play" onClick={() => nav.go('demo')}
              aria-label="Open the Grand Finale demo">
              <span className="hide-sm">Grand Finale demo</span>
            </Button>
          )}
          <Button variant="ghost" className="btn--icon"
            onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
          </Button>
          {user.isDemo && (
            <Button variant="secondary" size="sm" icon="refresh" onClick={resetDemo}
              aria-label="Reset the demo world">
              <span className="hide-sm">Reset demo</span>
            </Button>
          )}
        </header>
        )}

        <div className="content" id="main">
          {toast && (
            <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 120, maxWidth: 420 }} className="fadein">
              <Alert tone={toast.tone}>{toast.msg}</Alert>
            </div>
          )}

          {!boot ? <BootSkeleton /> : (
            <>
              {user.role === 'candidate' && <CandidateScreens ctx={ctx} />}
              {user.role === 'recruiter' && <RecruiterScreens ctx={ctx} />}
              {user.role === 'admin' && <AdminScreens ctx={ctx} />}
              {nav.view === 'integrations' && <Integrations ctx={ctx} />}
              {nav.view === 'demo' && <DemoMode ctx={ctx} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */
function counterFor(key, boot) {
  if (!boot) return 0;
  switch (key) {
    case 'c-apps': return boot.applications?.length || 0;
    case 'c-evidence': return boot.evidence?.length || 0;
    case 'r-reqs': return boot.requisitions?.length || 0;
    case 'r-pool': return boot.candidates?.length || 0;
    default: return 0;
  }
}

function ServiceChip({ services }) {
  if (!services) return null;
  const live = services.services.filter(s =>
    ['LIVE', 'CONNECTED', 'LINK_REDIRECTION_ACTIVE', 'LIVE_API'].includes(s.state)).length;
  const total = services.services.length;
  return (
    <Tooltip text={services.services.map(s => `${s.name}: ${s.state.replace(/_/g, ' ')}`).join(' · ')}>
      <span className={cx('badge', live > 1 ? 'badge--ok' : 'badge--warn')} style={{ width: '100%' }}>
        <Icon name="plug" size={11} />{live}/{total} services live
      </span>
    </Tooltip>
  );
}

function BootSkeleton() {
  return (
    <div>
      <Skeleton lines={2} />
      <div className="grid g-4" style={{ marginTop: 16 }}>
        {[0, 1, 2, 3].map(i => <div key={i} className="sk sk--block" />)}
      </div>
      <div className="sk sk--block" style={{ height: 280, marginTop: 16 }} />
    </div>
  );
}
