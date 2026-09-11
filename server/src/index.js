import './env.js';                 // MUST be first: loads .env before anything reads it
import { printEnvBanner } from './env.js';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ONTOLOGY, LEARNING_PROVIDERS, PROHIBITED_INPUTS } from './data.js';
import { AGENT_MANIFEST, SERVICE_MANIFEST, PIPELINE, TRIGGERS } from './orchestrator.js';
import { providerStatus, providerLandscape } from './ai/provider.js';
import * as db from './store.js';
import { seedIfEmpty } from './seed.js';
import { landscape } from './integrations/index.js';
import * as githubAdapter from './integrations/githubEvidenceAdapter.js';
import * as corsairSdk from './integrations/corsairClient.js';
import { SESSION_COOKIE, resolveSession } from './auth.js';
import * as supabase from './persistence/supabase.js';
import * as mailer from './mailer.js';
import * as otp from './emailVerification.js';
import * as mirror from './persistence/mirror.js';
import * as hydrate from './persistence/hydrate.js';
import {
  authenticate, requireAuth, rateLimit, str, bad, isEmail,
  sessionUser, publicProfile, publicReq, publicApp, candidateApplications, inWorld,
} from './lib.js';

import { registerAuthRoutes } from './routes/auth.js';
import { registerCandidateRoutes } from './routes/candidate.js';
import { registerGithubRoutes } from './routes/github.js';
import { registerRecruiterRoutes } from './routes/recruiter.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { registerAssessmentRoutes } from './routes/assessment.js';
import { registerAdminRoutes } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(cors());

// ---------------------------------------------------------------- Corsair
//
// Mounted BEFORE express.json(), and that ordering is the whole point rather
// than a style preference. Corsair Hub signs its deliveries with an HMAC over
// the exact bytes on the wire; express.json() consumes the request stream and
// hands on a parsed object, and re-serialising that object does not reproduce
// those bytes — key order and whitespace both move. Behind the parser every
// signed delivery fails verification, for a reason nothing in the error says.
//
// Nothing is mounted at all unless Corsair is fully configured, so a PIE with
// no Corsair credentials has exactly the routing table it had before.
if (corsairSdk.isConfigured()) {
  const [corsairClient, toExpressHandler] = await Promise.all([
    corsairSdk.client(), corsairSdk.expressHandler(),
  ]);
  if (corsairClient && toExpressHandler) {
    app.use('/api/corsair', toExpressHandler(corsairClient, {
      basePath: '/api/corsair',
      // The tenant comes from PIE's own session cookie, never from the request
      // body. Without this a browser could name any tenant it liked and read
      // another candidate's connection state.
      resolveTenant: req => {
        try {
          const raw = req.headers.get('cookie') || '';
          const hit = raw.split(';').map(s => s.trim())
            .find(s => s.startsWith(`${SESSION_COOKIE}=`));
          if (!hit) return null;
          const resolved = resolveSession(decodeURIComponent(hit.slice(SESSION_COOKIE.length + 1)));
          return resolved ? corsairSdk.tenantFor(resolved.user) : null;
        } catch { return null; }
      },
    }));
  }
}

app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(authenticate);

db.load();

// Restore anything this instance has lost before deciding whether to seed.
//
// On a host with an ephemeral filesystem the local store is empty on every cold
// start, and without this line the next step would cheerfully reseed the demo
// world over the top of an account the candidate created yesterday — which is
// exactly how a working sign-in becomes "those credentials do not match an
// account" in production and nowhere else. Runs before the mirror subscribes,
// so restored rows are not immediately pushed back out as if they were new.
const hydration = await hydrate.run();

seedIfEmpty();

// Exactly one administrator, provisioned server-side. Never registrable publicly.
import { ensureAdminAccount } from './auth.js';
const adminBoot = await ensureAdminAccount();

// Subscribe the mirror AFTER the store is loaded and seeded, so a boot does not
// re-push the whole demo world as if it were new writes.
const mirrorOn = mirror.attach();

/* ================================================================== HEALTH */
app.get('/api/health', (_req, res) => res.json({
  ok: true, service: 'PIE Career Orchestrator', version: '4.0.0',
  ai: providerStatus(), store: db.counts(),
}));

/** Single place the UI reads the real state of every external dependency. */
app.get('/api/services', requireAuth, (req, res) => {
  const ai = providerStatus();
  res.json({
    principle: 'Every state below is read from its adapter at request time. PIE never claims connectivity it does not have.',
    services: [
      { key: 'ai', name: ai.provider, state: ai.mode, detail: ai.note,
        classification: ai.enabled ? 'CONFIRMED — configured' : 'OFFLINE — deterministic engine only',
        limitation: ai.caution || undefined,
        requires: 'One of: OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_BASE_URL — or none at all.' },
      githubAdapter.status(),
      supabase.status(),
      mailer.status(),
      emailVerificationStatus(),
      mirror.status(),
      hydrateStatus(),
      ...landscape().services,
    ],
  });
});

/**
 * Whether a candidate has to prove their email address.
 *
 * Its own line rather than a footnote on the mail status, because "we can send
 * email" and "we require a code" are different claims and a jury is entitled to
 * see which one is true. Switching it off is a real reduction in what PIE
 * checks, so it is reported as one.
 */
function emailVerificationStatus() {
  const required = otp.REQUIRED();
  const canSend = mailer.isConfigured();
  const state = !required ? 'OFF' : canSend ? 'ENFORCED' : 'UNAVAILABLE';
  return {
    key: 'email_verification',
    name: 'Candidate email verification',
    state,
    detail: {
      ENFORCED: 'A candidate account is not usable until a four-digit code sent to that address is '
        + 'entered. The code is generated and checked by PIE — no third-party verification service.',
      OFF: 'Switched off with EMAIL_VERIFICATION=off. Candidates are signed in at registration and the '
        + 'address they typed is NOT proven to be theirs. Remove that variable to turn it back on.',
      UNAVAILABLE: 'No mail transport is configured, so no code can be sent and none is required. '
        + 'A gate nobody can pass would lock every candidate out rather than protect anything. '
        + 'Configure SMTP_* or MAIL_HTTP_PROVIDER to enforce it.',
    }[state],
    classification: state === 'ENFORCED'
      ? 'CONFIRMED — enforced server-side before an account becomes usable'
      : 'OFF — the address a candidate typed is not proven',
    requires: 'A mail transport, and EMAIL_VERIFICATION unset (or anything other than "off")',
  };
}

/** What the last boot managed to restore. Read by the integrity dashboard. */
function hydrateStatus() {
  const configured = supabase.isConfigured();
  const state = !configured ? 'NOT_CONFIGURED'
    : hydration?.reason === 'DISABLED' ? 'OFF'
      : !hydration?.ok ? 'INCOMPLETE'
        : hydration.total ? 'RESTORED' : 'CURRENT';
  return {
    key: 'supabase_hydrate',
    name: 'Supabase restore at boot',
    state,
    detail: configured
      ? hydration?.detail
      : 'Supabase is not configured, so nothing is restored at boot. On a host with an ephemeral '
        + 'filesystem (Render\'s free plan included) that means accounts created in production do not '
        + 'survive a restart.',
    classification: state === 'RESTORED' || state === 'CURRENT'
      ? 'CONFIRMED — Supabase is the durable source of truth across restarts'
      : 'OPTIONAL — not configured',
    systemOfRecord: configured ? 'Supabase across restarts; the JSON store within a run' : 'Local JSON store',
  };
}

/** Live Supabase reachability + schema check. Admin-only: it names the project host. */
app.get('/api/system/supabase', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Trust & Integrity (administrator) role required.' });
  res.json(await supabase.verify({ force: req.query.force === '1' }));
});

/** Mirror state + an on-demand full push. Administrator only. */
app.get('/api/system/mirror', requireAuth, (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Trust & Integrity (administrator) role required.' });
  res.json(mirror.status());
});

app.post('/api/system/mirror/sync', requireAuth, rateLimit(4, 60_000), async (req, res) => {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Trust & Integrity (administrator) role required.' });
  const r = await mirror.syncAll({ includeDemo: req.body?.includeDemo === true });
  db.audit({ actor: req.user.email, actorRole: 'admin', action: 'SUPABASE_SYNC',
    note: r.ok ? 'Full push of the local store into Supabase. The JSON store remains the system of record.'
      : `Sync refused: ${r.reason}` });
  res.json({ ...r, status: mirror.status() });
});

/** Every LLM provider PIE can use, and where each stands. Read by the UI. */
app.get('/api/ai/providers', requireAuth, (_req, res) => res.json(providerLandscape()));

app.get('/api/integrations/landscape', requireAuth, (_req, res) => res.json(landscape()));

/* ============================================================== BOOTSTRAP */
app.get('/api/bootstrap', requireAuth, (req, res) => {
  const base = {
    user: sessionUser(req.user),
    ontologySize: ONTOLOGY.length,
    providers: LEARNING_PROVIDERS,
    prohibitedInputs: PROHIBITED_INPUTS,
    ai: providerStatus(),
    pipeline: PIPELINE.map(s => ({
      key: s.key, kind: s.kind, name: s.name, order: s.order,
      handbookRole: s.handbookRole, responsibility: s.responsibility,
    })),
    agentManifest: AGENT_MANIFEST,
    serviceManifest: SERVICE_MANIFEST,
    triggers: TRIGGERS,
    organizations: db.all('organizations'),
  };

  if (req.user.role === 'candidate') {
    const profile = db.findById('candidateProfiles', req.user.candidateProfileId);
    return res.json({
      ...base,
      profile: profile ? publicProfile(profile) : null,
      evidence: db.filter('evidence', e => e.candidateProfileId === req.user.candidateProfileId),
      applications: candidateApplications(req.user.candidateProfileId),
      openRequisitions: inWorld(req, db.filter('requisitions', r => r.status === 'OPEN')).map(publicReq),
    });
  }

  if (req.user.role === 'recruiter') {
    const mine = inWorld(req, db.filter('requisitions', r => r.recruiterId === req.user.recruiterId));
    return res.json({
      ...base,
      recruiter: db.findById('recruiters', req.user.recruiterId),
      requisitions: mine.map(publicReq),
      candidates: inWorld(req, db.all('candidateProfiles')).map(publicProfile),
      applications: db.filter('applications', a => mine.some(r => r.id === a.requisitionId)).map(publicApp),
    });
  }

  return res.json({
    ...base,
    candidates: inWorld(req, db.all('candidateProfiles')).map(publicProfile),
    requisitions: inWorld(req, db.all('requisitions')).map(publicReq),
    recruiters: inWorld(req, db.all('recruiters')),
    applications: inWorld(req, db.all('applications')).map(publicApp),
  });
});

/* ================================================================= ROUTES */
registerAuthRoutes(app);
registerCandidateRoutes(app);
registerGithubRoutes(app);
registerRecruiterRoutes(app);
registerOrchestrationRoutes(app);
registerAssessmentRoutes(app);
registerAdminRoutes(app);

/* ------------------------------------------------------------ demo controls */
/** Resets ONLY the demo world. Real accounts, evidence and decisions are untouched. */
app.post('/api/demo/reset', rateLimit(10, 60_000), async (_req, res) => {
  const COLLECTIONS = ['users', 'organizations', 'recruiters', 'candidateProfiles', 'requisitions',
    'applications', 'evidence', 'githubRepositories', 'projects', 'sessions'];
  let removed = 0;
  for (const c of COLLECTIONS) {
    for (const row of db.all(c)) {
      if (row.isDemo) { db.remove(c, row.id); removed += 1; }
    }
  }
  seedIfEmpty({ force: false, demoOnly: true });
  await ensureAdminAccount();
  res.json({ ok: true, removed, counts: db.counts(),
    notice: 'Demo world reset and reseeded. Real accounts were not touched.' });
});

app.get('/api/audit', requireAuth, (req, res) => {
  let events = db.all('auditEvents');
  if (req.user.role === 'candidate') {
    const pid = req.user.candidateProfileId;
    events = events.filter(e =>
      e.subjectId === pid || e.actor === req.user.email || e.meta?.candidateProfileId === pid);
  }
  res.json({ events: events.slice(-400) });
});

/* ---------------------------------------------------------- error handling */
app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ------------------------------------------------------- static (prod build) */
const dist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = process.env.PORT || 5174;
if (process.env.PIE_NO_LISTEN !== '1') {
  const server = app.listen(PORT, () => {
    const ai = providerStatus();
    const c = db.counts();
    console.log(`\n  PIE Career Orchestrator — http://localhost:${PORT}`);
    warnIfStaleBuild();
    printEnvBanner();
    console.log(`  AI: ${ai.provider} [${ai.mode}]`);
    if (mirrorOn) console.log('  Supabase mirror: ON (writes are pushed in the background)');
    if (corsairSdk.isConfigured()) {
      console.log('  Corsair: SDK active — evidence reads are tenant-scoped and read-only.');
      // The SDK prints a notice at init offering to enable workflow execution.
      // Saying here that the answer is no stops it reading as something left
      // undone: it evaluates Hub-delivered code in-process, and PIE has no use
      // for it.
      console.log('           Hub workflow execution is deliberately OFF (it would run remote code in-process).');
    }
    const restore = hydrate.bootLine(hydration);
    if (restore) console.log(restore);
    console.log(`  Store: ${c.users} users · ${c.candidateProfiles} candidates · ${c.requisitions} requisitions · ${c.evidence} evidence`);
    if (adminBoot?.created) {
      console.log('\n  ── ADMINISTRATOR ACCOUNT ──');
      console.log(`     username: ${adminBoot.username}`);
      console.log(`     email:    ${adminBoot.email}`);

      // The password is printed ONLY when PIE generated it, because otherwise
      // nobody can sign in — there is nowhere else it exists.
      //
      // A password the operator CHOSE is never printed. They already have it,
      // so printing it buys nothing and costs a great deal: "server console"
      // stopped meaning a terminal on your own machine the moment this was
      // deployed. On Render the boot log is a web page, kept, and pasted into
      // chats when something needs debugging. That is exactly how this one
      // reached a transcript.
      if (adminBoot.generated) {
        console.log(`     password: ${adminBoot.password}`);
        console.log('     ^ generated because ADMIN_PASSWORD was not set — copy it now.');
        console.log('       Set ADMIN_PASSWORD to choose your own; it will not be printed.');
        if (process.env.NODE_ENV === 'production') {
          console.log('       This log is not private. Set ADMIN_PASSWORD and redeploy.');
        }
      } else {
        console.log('     password: from ADMIN_PASSWORD — not printed.');
      }
      console.log('  ───────────────────────────\n');
    } else {
      console.log(`  Admin: sign in as "${adminBoot?.username || 'admin'}" (password set previously; not printed)`);
    }
    console.log(`  Scores are deterministic and identical with or without an LLM.\n`);
  });

  // A busy port is the single most common way to fail to start, and Node's
  // default answer is an unhandled 'error' event and a stack trace about
  // net.js internals. Say what actually happened and what to do about it.
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`\n  Port ${PORT} is already in use — PIE did not start.`);
    console.error('  Another PIE server is almost certainly still running in a different terminal.\n');
    console.error('  Either close that window, or free the port:');
    if (process.platform === 'win32') {
      console.error(`    netstat -ano | findstr :${PORT}       (the last column is the process id)`);
      console.error('    taskkill /PID <that id> /F');
    } else {
      console.error(`    lsof -ti:${PORT} | xargs kill`);
    }
    console.error(`\n  Or start this one somewhere else:   set PORT=5175 && npm start\n`);
    process.exit(1);
  });
}

/**
 * Says so when the browser bundle is older than the source it was built from.
 *
 * The server serves web/dist, which is COMPILED output. `npm start` only starts
 * the server, so editing web/src and restarting changes nothing on screen — the
 * old bundle is still being served. That failure is completely silent: the app
 * runs, nothing errors, and the change simply is not there. This turns it into
 * one obvious line.
 */
function warnIfStaleBuild() {
  try {
    const web = path.resolve(__dirname, '../../web');
    const dist = path.join(web, 'dist', 'assets');
    const src = path.join(web, 'src');
    if (!fs.existsSync(dist) || !fs.existsSync(src)) return;

    const newest = dir => {
      let t = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        t = Math.max(t, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
      }
      return t;
    };

    const built = newest(dist);
    const edited = newest(src);
    if (edited > built + 1000) {
      const mins = Math.round((edited - built) / 60000);
      console.log('\n  ⚠  The web bundle is out of date — you are seeing an OLD interface.');
      console.log(`     web/src was edited ${mins} minute(s) after web/dist was last built.`);
      console.log('     Fix:  cd web && npm run build     (then restart, or just use "npm start" from the project root)');
    }
  } catch { /* a missing web/ folder is not worth failing a server start over */ }
}
