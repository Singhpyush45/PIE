import React, { useEffect, useState } from 'react';
import { api, setToken } from '../api.js';
import { Icon, Button, Badge, Alert, Skeleton, Empty, cx } from '../kit.jsx';

/* PIE entry experience.
   The landing page shows exactly four choices and nothing else. Demo personas,
   service diagnostics and integration detail live inside the application, where
   they belong — not in front of a first-time visitor or a juror. */

const ROLES = {
  candidate: {
    icon: 'user', title: 'Candidate',
    line: 'Build your capability profile from real evidence.',
    actions: ['signin', 'register'],
  },
  recruiter: {
    icon: 'brief', title: 'Recruiter',
    line: 'Discover capability and make evidence-based hiring decisions.',
    actions: ['signin', 'register'],
  },
  admin: {
    icon: 'shield', title: 'Trust & Integrity',
    line: 'Review AI recommendations, bias signals and assessment integrity.',
    actions: ['signin'],
  },
  demo: {
    icon: 'play', title: 'Grand Finale Demo',
    line: 'Explore the complete PIE story with curated personas.',
    actions: ['demo'],
  },
};

export default function AuthScreen({ onSignedIn, theme, setTheme, notice }) {
  // landing | signin | register | demo | forgot | reset
  const [mode, setMode] = useState('landing');
  const [role, setRole] = useState('candidate');
  const [resetToken, setResetToken] = useState(null);

  const openSignIn = r => { setRole(r); setMode('signin'); };
  const openRegister = r => { setRole(r); setMode('register'); };

  // A reset link lands on "/?reset=<token>". Pick it up, then strip it from the
  // address bar so the token is not left sitting in history or a shared screen.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('reset');
    if (!t) return;
    setResetToken(t);
    setMode('reset');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  return (
    <div className="entry">
      <header className="entry__bar">
        <div className="entry__brand">
          <div className="entry__mark"><img src="/pie-logo.svg" alt="" /></div>
          <div>
            <div className="entry__name">PIE</div>
            <div className="entry__sub">Potential Intelligence Engine · Career Orchestrator</div>
          </div>
        </div>
        <button className="entry__theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title="Toggle theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </header>

      <main className="entry__main">
        {mode === 'landing' && (
          <Landing onSignIn={openSignIn} onRegister={openRegister} onDemo={() => setMode('demo')} notice={notice} />
        )}
        {mode === 'signin' && (
          <SignIn role={role} onBack={() => setMode('landing')} onSignedIn={onSignedIn}
            onRegister={() => setMode('register')} onForgot={() => setMode('forgot')} />
        )}
        {mode === 'forgot' && (
          <Forgot role={role} onBack={() => setMode('signin')} />
        )}
        {mode === 'reset' && (
          <ResetPassword token={resetToken}
            onDone={r => { setRole(r || 'candidate'); setMode('signin'); }}
            onBack={() => setMode('landing')} />
        )}
        {mode === 'register' && (
          <Register role={role} onBack={() => setMode('landing')} onSignedIn={onSignedIn}
            onSignIn={() => setMode('signin')} />
        )}
        {mode === 'demo' && <DemoPicker onBack={() => setMode('landing')} onSignedIn={onSignedIn} />}
      </main>

      <footer className="entry__foot">
        <span><b>PIE</b> · Potential over pedigree</span>
        <span className="entry__dot">·</span>
        <span>Hack &amp; Build 2026 — inclusive, evidence-first hiring</span>
      </footer>
    </div>
  );
}

/* ================================================================= LANDING */
function Landing({ onSignIn, onRegister, onDemo, notice }) {
  return (
    <div className="entry__hero">
      <h1 className="entry__title">Welcome to PIE</h1>
      <p className="entry__lede">Discover potential. Build capability. Match opportunity.</p>

      {notice && <div style={{ maxWidth: 560, margin: '0 auto var(--s-5)' }}>
        <Alert tone={notice.tone}>{notice.msg}</Alert>
      </div>}

      <div className="rolegrid">
        {Object.entries(ROLES).map(([key, r]) => (
          <section className={cx('rolecard', key === 'demo' && 'rolecard--demo')} key={key}>
            <div className="rolecard__icon"><Icon name={r.icon} size={20} /></div>
            <h2 className="rolecard__title">{r.title}</h2>
            <p className="rolecard__line">{r.line}</p>
            <div className="rolecard__actions">
              {r.actions.includes('signin') && (
                <Button variant="primary" className="btn--block" onClick={() => onSignIn(key)}>Sign in</Button>
              )}
              {r.actions.includes('register') && (
                <Button variant="secondary" className="btn--block" onClick={() => onRegister(key)}>Create account</Button>
              )}
              {r.actions.includes('demo') && (
                <Button variant="secondary" className="btn--block" iconRight="right" onClick={onDemo}>Enter demo</Button>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== SIGN IN */
function SignIn({ role, onBack, onSignedIn, onRegister, onForgot }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.login(identifier.trim(), password, role);
      setToken(r.token);
      onSignedIn(r.user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Panel onBack={onBack} title="Welcome back"
      sub={role === 'admin' ? 'Trust & Integrity Administration' : ROLES[role].title}>
      <form onSubmit={submit} className="stack">
        {error && <Alert tone="crit" title="Could not sign in">{error}</Alert>}

        <div className="field">
          <label htmlFor="ident">Username or email</label>
          <input id="ident" name="identifier" className="input" autoFocus autoComplete="username"
            value={identifier} onChange={e => setIdentifier(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" name="password" className="input" type="password" autoComplete="current-password"
            value={password} onChange={e => setPassword(e.target.value)} required />
        </div>

        <Button variant="primary" size="lg" type="submit" className="btn--block"
          disabled={busy || !identifier || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="linkbtn" onClick={onForgot}>Forgot password?</button>
          {role !== 'admin' && (
            <button type="button" className="linkbtn" onClick={onRegister}>Create an account</button>
          )}
        </div>

        {/* Shown always, so it can never hint at whether an account exists. */}
        <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5 }}>
          Each card on the previous screen is a separate workspace. Sign in through the one that
          matches your account — a candidate cannot sign in at the recruiter or administrator door.
        </p>

        {role === 'admin' && (
          <Alert tone="neutral" title="Administrator accounts are provisioned, not self-registered">
            There is no public sign-up for Trust &amp; Integrity. The account is created server-side and
            its credentials are printed once to the server console — never to this screen.
          </Alert>
        )}
      </form>
    </Panel>
  );
}

/* ================================================================= REGISTER */
function Register({ role, onBack, onSignedIn, onSignIn }) {
  const isCandidate = role === 'candidate';
  const [step, setStep] = useState(1);
  const [f, setF] = useState({
    name: '', username: '', email: '', password: '', confirmPassword: '',
    organization: '', title: '',
    education: '', targetRole: '', experienceLevel: '', location: '', headline: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when the server says the address has to be proven before the account
  // exists in any usable sense. Holds the ticket it issued — never the code.
  const [verify, setVerify] = useState(null);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  const accountReady = f.name.trim().length >= 2 && f.username.trim().length >= 3
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email) && f.password.length >= 8
    && f.password === f.confirmPassword
    && (isCandidate || f.organization.trim().length >= 2);

  const mismatch = f.confirmPassword.length > 0 && f.password !== f.confirmPassword;

  async function submit(e) {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.register({ role, ...f });
      if (r.requiresEmailVerification) {
        // No token and no user came back, because there is no session yet.
        setVerify({ email: r.email || f.email, ticket: r.ticket || null });
        setBusy(false);
        return;
      }
      setToken(r.token);
      onSignedIn(r.user);
    } catch (err) {
      // The account may exist even when the code could not be sent. Move to the
      // verification screen anyway, where "Resend" is the obvious next step —
      // sending them back to a filled-in form that now says "username taken"
      // would be a dead end.
      if (err.data?.requiresEmailVerification) {
        setVerify({ email: err.data.email || f.email, ticket: null, mailFailed: true });
        setBusy(false);
        return;
      }
      setError(err.message);
      setBusy(false);
      setStep(1);
    }
  }

  if (verify) {
    return (
      <VerifyEmail
        email={verify.email}
        ticket={verify.ticket}
        mailFailed={verify.mailFailed}
        onVerified={u => onSignedIn(u)}
        onBack={() => { setVerify(null); setStep(1); }}
      />
    );
  }

  return (
    <Panel onBack={onBack}
      title={isCandidate ? 'Create your candidate account' : 'Create your recruiter account'}
      sub={isCandidate
        ? 'Your evidence, your profile — visible to a recruiter only when you apply.'
        : 'Create requisitions and match on capability rather than pedigree.'}>
      {isCandidate && (
        <div className="steps" style={{ marginBottom: 'var(--s-5)' }}>
          {['Account', 'Career profile'].map((s, i) => (
            <React.Fragment key={s}>
              {i > 0 && <div className={cx('steps__line', step > 1 && 'steps__line--done')} />}
              <div className={cx('steps__node', step > i + 1 && 'steps__node--done', step === i + 1 && 'steps__node--now')}>
                <span className="steps__dot">{step > i + 1 ? '✓' : i + 1}</span>
                <span>{s}</span>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      <form onSubmit={submit} className="stack">
        {error && <Alert tone="crit" title="Could not create the account">{error}</Alert>}

        {step === 1 && (
          <>
            <div className="field">
              <label htmlFor="rn">Full name</label>
              <input id="rn" name="name" className="input" autoFocus value={f.name}
                onChange={e => set('name', e.target.value)} required />
            </div>
            {!isCandidate && (
              <div className="grid g-2">
                <div className="field">
                  <label htmlFor="ro">Organization</label>
                  <input id="ro" name="organization" className="input" value={f.organization}
                    onChange={e => set('organization', e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="rt">Your title <span className="muted">(optional)</span></label>
                  <input id="rt" name="title" className="input" value={f.title}
                    onChange={e => set('title', e.target.value)} placeholder="Technical Recruiter" />
                </div>
              </div>
            )}
            <div className="grid g-2">
              <div className="field">
                <label htmlFor="ru">Username</label>
                <input id="ru" name="username" className="input" autoComplete="username" value={f.username}
                  onChange={e => set('username', e.target.value.toLowerCase())} required />
                <span className="hint">You can sign in with this or your email.</span>
              </div>
              <div className="field">
                <label htmlFor="re">{isCandidate ? 'Email' : 'Work email'}</label>
                <input id="re" name="email" className="input" type="email" autoComplete="email" value={f.email}
                  onChange={e => set('email', e.target.value)} required />
              </div>
            </div>
            <div className="grid g-2">
              <div className="field">
                <label htmlFor="rp">Password</label>
                <input id="rp" name="password" className="input" type="password" autoComplete="new-password"
                  value={f.password} onChange={e => set('password', e.target.value)} required />
                <span className="hint">At least 8 characters, with a letter and a number.</span>
              </div>
              <div className="field">
                <label htmlFor="rc">Confirm password</label>
                <input id="rc" name="confirmPassword" className="input" type="password" autoComplete="new-password"
                  value={f.confirmPassword} onChange={e => set('confirmPassword', e.target.value)} required
                  aria-invalid={mismatch || undefined} />
                {mismatch && <span className="hint" style={{ color: 'var(--crit-fg)' }}>The passwords do not match.</span>}
              </div>
            </div>

            {isCandidate ? (
              <Button variant="primary" size="lg" type="button" className="btn--block"
                disabled={!accountReady} onClick={() => setStep(2)}>Continue</Button>
            ) : (
              <Button variant="primary" size="lg" type="submit" className="btn--block"
                disabled={busy || !accountReady}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            )}
          </>
        )}

        {step === 2 && isCandidate && (
          <>
            <Alert tone="neutral" title="All optional — and never used to rank you">
              PIE records this as context so it can talk to you about your goals. Education, location
              and experience level are withheld from the matching agent by the orchestrator.
            </Alert>
            <div className="field">
              <label htmlFor="rh">Headline</label>
              <input id="rh" name="headline" className="input" value={f.headline}
                onChange={e => set('headline', e.target.value)}
                placeholder="What you do, in one line" />
            </div>
            <div className="grid g-2">
              <div className="field">
                <label htmlFor="red">Education</label>
                <input id="red" name="education" className="input" value={f.education}
                  onChange={e => set('education', e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="rtr">Target role</label>
                <input id="rtr" name="targetRole" className="input" value={f.targetRole}
                  onChange={e => set('targetRole', e.target.value)} placeholder="Data Analyst" />
              </div>
              <div className="field">
                <label htmlFor="rex">Experience level</label>
                <input id="rex" name="experienceLevel" className="input" value={f.experienceLevel}
                  onChange={e => set('experienceLevel', e.target.value)} placeholder="2 years, or self-taught" />
              </div>
              <div className="field">
                <label htmlFor="rl">Location</label>
                <input id="rl" name="location" className="input" value={f.location}
                  onChange={e => set('location', e.target.value)} />
              </div>
            </div>
            <div className="row">
              <Button variant="ghost" type="button" onClick={() => setStep(1)}>Back</Button>
              <span className="spacer" style={{ flex: 1 }} />
              <Button variant="secondary" type="submit" disabled={busy}>Skip for now</Button>
              <Button variant="primary" type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create account'}
              </Button>
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: 'center' }}>
          <span className="t-12 muted">Already have an account?</span>
          <button type="button" className="linkbtn" onClick={onSignIn}>Sign in</button>
        </div>
      </form>
    </Panel>
  );
}

/* =============================================================== DEMO DOOR */
function DemoPicker({ onBack, onSignedIn }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => { api.demoPersonas().then(setData).catch(e => setError(e.message)); }, []);

  async function enter(userId) {
    setBusy(userId);
    try {
      const r = await api.demoEnter(userId);
      setToken(r.token);
      onSignedIn(r.user);
    } catch (e) { setError(e.message); setBusy(null); }
  }

  const group = (title, sub, rows) => rows?.length ? (
    <div style={{ marginBottom: 'var(--s-6)' }} key={title}>
      <div className="row" style={{ gap: 8, marginBottom: 4 }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        <span className="t-12 muted">{sub}</span>
      </div>
      <div className="grid g-2">
        {rows.map(p => (
          <button key={p.id} className="acct" disabled={busy} onClick={() => enter(p.id)}>
            <div className="acct__av">{p.name.split(' ').map(n => n[0]).join('').slice(0, 2)}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="acct__n">{p.name}</div>
              <div className="acct__t">{p.headline || p.title || p.organization}</div>
            </div>
            {p.evidenceCount != null && <span className="badge badge--neutral">{p.evidenceCount} evidence</span>}
            <Icon name="right" size={15} className="faint" />
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <Panel onBack={onBack} title="Grand Finale demo" sub="Curated personas with a complete evidence history" wide>
      {error && <Alert tone="crit" title="Could not load the demo">{error}</Alert>}
      {!data && !error && <Skeleton lines={6} />}
      {data && (
        <>
          <Alert tone="info" title="Demo data is kept separate from real accounts">
            {data.notice}
          </Alert>
          <div style={{ marginTop: 'var(--s-5)' }}>
            {group('Candidates', 'the Theme 2 inclusion stories', data.candidates)}
            {group('Recruiters', 'each owns their own requisitions', data.recruiters)}
            {group('Trust & Integrity', 'bias reviews and assessment integrity', data.admins)}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------- shared panel */
function Panel({ title, sub, onBack, children, wide }) {
  return (
    <div className={cx('entry__panel', wide && 'entry__panel--wide')}>
      <button className="backbtn" onClick={onBack} style={{ marginBottom: 'var(--s-4)' }}>
        <Icon name="right" size={14} style={{ transform: 'rotate(180deg)' }} />
        Back
      </button>
      <h1 className="entry__panelTitle">{title}</h1>
      {sub && <p className="entry__panelSub">{sub}</p>}
      {children}
    </div>
  );
}

/* ========================================================= FORGOT PASSWORD
   The response is deliberately identical whether or not the address has an
   account. A reset form that says "no such user" is a free list of who banks
   here — and for a hiring platform, of who is job-hunting. */
function Forgot({ role, onBack }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.forgotPassword(email.trim());
      setSent(r.message);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  if (sent) {
    return (
      <Panel onBack={onBack} title="Check your email" sub="Password reset">
        <Alert tone="ok" title="Request received" icon="check">{sent}</Alert>
        <p className="t-12 muted" style={{ lineHeight: 1.6 }}>
          Nothing arrived? Check spam, and confirm you used the address you registered with.
          You can request another link — the newest one is the only one that works.
        </p>
        <Button variant="secondary" className="btn--block" onClick={onBack}>Back to sign in</Button>
      </Panel>
    );
  }

  return (
    <Panel onBack={onBack} title="Forgot your password?"
      sub={role === 'admin' ? 'Trust & Integrity Administration' : ROLES[role]?.title || 'Password reset'}>
      <form onSubmit={submit} className="stack">
        {error && <Alert tone="crit" title="Could not send the link">{error}</Alert>}

        <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
          Enter the email address on your account. We will send a link that lets you choose a new
          password. It works once and expires in 45 minutes.
        </p>

        <div className="field">
          <label htmlFor="fe">Email address</label>
          <input id="fe" name="email" className="input" type="email" autoFocus autoComplete="email"
            value={email} onChange={e => setEmail(e.target.value)} required />
        </div>

        <Button variant="primary" size="lg" type="submit" className="btn--block" disabled={busy || !email}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>

        <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5 }}>
          For your safety we give the same answer whether or not an account exists for that address.
        </p>
      </form>
    </Panel>
  );
}


/* ========================================================= VERIFY EMAIL (OTP)
   The account exists but is not usable until the address is proven. Everything
   that decides that lives on the server; this screen only collects four digits
   and reports what the server said.

   The code is never held anywhere but this component's state, and never written
   to storage — a verification code in localStorage is a verification code an
   extension can read. */
function VerifyEmail({ email, ticket, mailFailed, onVerified, onBack }) {
  const LEN = 4;
  const [digits, setDigits] = useState(Array(LEN).fill(''));
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState(mailFailed
    ? { title: 'The code could not be sent', message: 'Your account was created, but the email did not go out. Ask for a new code below.' }
    : null);
  const [notice, setNotice] = useState(null);
  const [attemptsLeft, setAttemptsLeft] = useState(null);
  const [cooldown, setCooldown] = useState(mailFailed ? 0 : 60);
  const [held, setHeld] = useState(ticket);
  const boxes = React.useRef([]);

  const code = digits.join('');
  const complete = code.length === LEN && /^\d+$/.test(code);
  const burnt = attemptsLeft === 0;

  useEffect(() => {
    if (!cooldown) return undefined;
    const t = setInterval(() => setCooldown(c => (c > 0 ? c - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  useEffect(() => { boxes.current[0]?.focus(); }, []);

  function put(i, raw) {
    const only = raw.replace(/\D/g, '');
    if (!only) { setDigits(d => { const n = [...d]; n[i] = ''; return n; }); return; }
    // A pasted code fills the row rather than dropping all but the first digit.
    setDigits(d => {
      const n = [...d];
      for (let k = 0; k < only.length && i + k < LEN; k += 1) n[i + k] = only[k];
      return n;
    });
    const next = Math.min(i + only.length, LEN - 1);
    boxes.current[next]?.focus();
  }

  function onKey(i, e) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      boxes.current[i - 1]?.focus();
      setDigits(d => { const n = [...d]; n[i - 1] = ''; return n; });
    }
    if (e.key === 'ArrowLeft' && i > 0) boxes.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < LEN - 1) boxes.current[i + 1]?.focus();
  }

  async function submit(e) {
    e?.preventDefault();
    if (!complete || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.confirmEmailCode({ email, code, ticket: held });
      setToken(r.token);
      onVerified(r.user);
    } catch (err) {
      const d = err.data || {};
      if (typeof d.attemptsLeft === 'number') setAttemptsLeft(d.attemptsLeft);
      setError({
        title: {
          EXPIRED: 'That code has expired',
          TOO_MANY_ATTEMPTS: 'Too many attempts',
          TICKET_INVALID: 'Start again in this browser',
          NO_CODE: 'No code is waiting',
        }[d.reason] || 'That code was not accepted',
        message: err.message,
      });
      setDigits(Array(LEN).fill(''));
      boxes.current[0]?.focus();
      setBusy(false);
    }
  }

  async function resend() {
    setResending(true); setError(null); setNotice(null);
    try {
      const r = await api.requestEmailCode(email);
      if (r.ticket) setHeld(r.ticket);
      setNotice(r.notice || 'A new code is on its way.');
      setDigits(Array(LEN).fill(''));
      setAttemptsLeft(null);
      setCooldown(60);
      boxes.current[0]?.focus();
    } catch (err) {
      const d = err.data || {};
      setError({
        title: d.reason === 'MAIL_NOT_CONFIGURED' ? 'Email is not available here' : 'Could not send a new code',
        message: err.message,
      });
      if (d.reason === 'COOLDOWN') setCooldown(60);
    }
    setResending(false);
  }

  return (
    <Panel onBack={onBack} title="Verify your email"
      sub="Your account is not active until this address is confirmed">
      <form onSubmit={submit} className="stack">
        {error && <Alert tone="crit" title={error.title}>{error.message}</Alert>}
        {notice && !error && <Alert tone="ok" title="Sent" icon="check">{notice}</Alert>}

        <p className="t-13 muted" style={{ margin: 0, lineHeight: 1.6 }}>
          We have sent a {LEN}-digit verification code to<br />
          <strong style={{ color: 'var(--fg)' }}>{email}</strong>
        </p>

        <div style={{ display: 'flex', gap: 'var(--s-3)', justifyContent: 'center', margin: 'var(--s-2) 0' }}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={el => { boxes.current[i] = el; }}
              className="input"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              aria-label={`Digit ${i + 1} of ${LEN}`}
              maxLength={LEN}
              disabled={busy || burnt}
              value={d}
              onChange={e => put(i, e.target.value)}
              onKeyDown={e => onKey(i, e)}
              style={{
                width: 58, height: 64, textAlign: 'center',
                fontSize: 26, fontWeight: 600, letterSpacing: 0,
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              }}
            />
          ))}
        </div>

        {attemptsLeft !== null && attemptsLeft > 0 && (
          <p className="t-12 muted" style={{ margin: 0, textAlign: 'center' }}>
            {attemptsLeft} attempt{attemptsLeft === 1 ? '' : 's'} remaining before this code is retired.
          </p>
        )}

        <Button variant="primary" size="lg" type="submit" className="btn--block"
          disabled={!complete || busy || burnt}>
          {busy ? 'Verifying…' : 'Verify email'}
        </Button>

        <div style={{ textAlign: 'center' }}>
          <p className="t-12 muted" style={{ margin: '0 0 var(--s-2)' }}>Didn&rsquo;t receive the code?</p>
          <Button variant="secondary" type="button" onClick={resend} disabled={resending || cooldown > 0}>
            {resending ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
          </Button>
        </div>

        <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5, textAlign: 'center' }}>
          Codes are valid for five minutes and are generated by PIE itself — no third-party
          verification service is involved. Check your spam folder if nothing arrives.
        </p>
      </form>
    </Panel>
  );
}

/* ========================================================== RESET PASSWORD */
function ResetPassword({ token, onDone, onBack }) {
  const [check, setCheck] = useState(null);      // null = still checking
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    api.checkResetToken(token)
      .then(r => { if (alive) setCheck(r); })
      .catch(() => { if (alive) setCheck({ valid: false, reason: 'INVALID' }); });
    return () => { alive = false; };
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.resetPassword({ token, password, confirmPassword: confirm });
      setDone(r);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  if (done) {
    return (
      <Panel title="Password changed" sub="You can sign in now">
        <Alert tone="ok" title="Done" icon="check">{done.message}</Alert>
        <Button variant="primary" size="lg" className="btn--block" onClick={() => onDone(done.role)}>
          Go to sign in
        </Button>
      </Panel>
    );
  }

  if (check === null) return <Panel title="Checking your link…"><Skeleton lines={3} /></Panel>;

  if (!check.valid) {
    const why = check.reason === 'EXPIRED' ? 'That link has expired.'
      : check.reason === 'USED' ? 'That link has already been used.'
        : 'That link is not valid.';
    return (
      <Panel onBack={onBack} title="This link cannot be used" sub="Password reset">
        <Alert tone="warn" title={why}>
          Reset links work once and expire after 45 minutes. Request a fresh one from the sign-in
          screen and use the newest email.
        </Alert>
        <Button variant="secondary" className="btn--block" onClick={onBack}>Back to start</Button>
      </Panel>
    );
  }

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <Panel onBack={onBack} title="Choose a new password" sub="Password reset">
      <form onSubmit={submit} className="stack">
        {error && <Alert tone="crit" title="Could not change your password">{error}</Alert>}

        <div className="field">
          <label htmlFor="np">New password</label>
          <input id="np" name="password" className="input" type="password" autoFocus
            autoComplete="new-password" value={password}
            onChange={e => setPassword(e.target.value)} required />
          <span className="hint">At least 8 characters, with a letter and a number.</span>
        </div>
        <div className="field">
          <label htmlFor="nc">Confirm new password</label>
          <input id="nc" name="confirmPassword" className="input" type="password"
            autoComplete="new-password" value={confirm}
            onChange={e => setConfirm(e.target.value)} required />
          {mismatch && <span className="hint" style={{ color: 'var(--crit-fg)' }}>The two passwords do not match.</span>}
        </div>

        <Button variant="primary" size="lg" type="submit" className="btn--block"
          disabled={busy || !password || !confirm || tooShort || mismatch}>
          {busy ? 'Changing…' : 'Change password'}
        </Button>

        <p className="t-11 faint" style={{ margin: 0, lineHeight: 1.5 }}>
          Changing your password signs out every device currently using this account.
        </p>
      </form>
    </Panel>
  );
}
