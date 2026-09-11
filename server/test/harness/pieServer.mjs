// A throwaway PIE server with a working mailbox, for tests that need one.
//
// The shared test server in run.mjs deliberately has no mail transport, because
// that is the honest local default and most of the suite asserts behaviour under
// it. Email verification and everything gated behind it only exist when mail
// does, so those tests bring up their own process — with SMTP pointed at a fake
// server started here, so codes can be read the way a candidate reads an inbox.
//
// Nothing is stubbed. PIE generates the code, nodemailer delivers it, and the
// test reads it off the wire.

import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const uniq = () => Math.random().toString(36).slice(2, 8);

/* --------------------------------------------------------------- fake SMTP */
function fakeSmtp() {
  const messages = [];
  const srv = net.createServer(sock => {
    let buf = ''; let inData = false; let body = '';
    sock.write('220 fake.smtp.test ESMTP\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; messages.push(body); body = ''; sock.write('250 OK\r\n'); }
          else body += `${line}\n`;
          continue;
        }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (cmd === 'AUTH') sock.write('235 ok\r\n');
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
    port: srv.address().port, messages, close: () => srv.close(),
  })));
}

/**
 * A port nothing is listening on, asked of the operating system rather than
 * guessed.
 *
 * Picking a random number in a range looked fine and was not: a run killed
 * before its cleanup leaves a PIE holding a port, and the next run has a real
 * chance of choosing it. That shows up as a test file failing perhaps one time
 * in ten, with an error about a server that never came up — which reads like a
 * broken feature rather than a busy socket.
 *
 * Binding to 0 and reading the assigned port leaves a tiny window between
 * closing this socket and the server opening its own. `startPie` retries a few
 * times, which closes it in practice.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts a PIE server on a free port with mail wired to a fake SMTP.
 *
 * @param {object} opts
 * @param {string} opts.name        used for the throwaway data directory
 * @param {object} [opts.env]       extra environment for the server process
 */
export async function startPie({ name, env: extra = {} } = {}) {
  const DATA_DIR = path.join(SERVER_DIR, 'data', `.test-${name}`);
  await rm(DATA_DIR, { recursive: true, force: true });

  const smtp = await fakeSmtp();

  let server = null;
  let port = 0;
  let BASE = '';
  let out = '';

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    port = await freePort();
    BASE = `http://127.0.0.1:${port}`;
    out = '';
    server = spawnPie(port);
    if (await waitForHealth(BASE)) break;
    try { server.kill(); } catch { /* already gone */ }
    server = null;
    if (attempt === 3) {
      smtp.close();
      throw new Error(`the ${name} test server never came up on ${BASE}.\n${out}`);
    }
  }

  function spawnPie(p) {
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: String(p),
        PIE_DATA_DIR: DATA_DIR,
        NODE_ENV: 'test',
        ADMIN_PASSWORD: 'test-only-Adm1n-password',
        TOKEN_ENCRYPTION_KEY: 'a-test-key-of-at-least-thirty-two-characters',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(smtp.port),
        SMTP_USER: 'pie@example.test',
        SMTP_PASS: 'not-a-real-password',
        SMTP_FROM: 'PIE <pie@example.test>',
        SMTP_SECURE: 'false',
        // Pinned for the same reason the SMTP settings above are pinned, and
        // missed because it is a switch rather than a credential.
        //
        // Every file that starts a PIE here does so BECAUSE it is testing the
        // verification path — that is what the fake SMTP is for. Left
        // uninherited, a developer with EMAIL_VERIFICATION=off in their own
        // server/.env watched otphttp and gate fail eighteen tests between
        // them, all of them reporting NO_CODE: registration had signed the
        // candidate straight in, so there was never a code to check. Nothing
        // was wrong with PIE, and nothing was wrong with the tests. The suite
        // was simply answering a question about the developer's .env.
        //
        // A file that wants it off says so in `extra`, which is where a
        // deliberate choice belongs.
        EMAIL_VERIFICATION: 'on',
        // A real key or URL in the developer's own server/.env must not be read
        // — still less written to — by a test run.
        OPENAI_API_KEY: '', GEMINI_API_KEY: '',
        CORSAIR_API_KEY: '', CORSAIR_SIGNING_SECRET: '', CORSAIR_KEK: '',
        CORSAIR_DATABASE_URL: '', DATABASE_URL: '',
        GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', GMAIL_REDIRECT_URL: '',
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
        GITHUB_TOKEN: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
        MAIL_HTTP_PROVIDER: '', RESEND_API_KEY: '', BREVO_API_KEY: '', MAIL_FROM: '',
        ...extra,
      },
    });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    return child;
  }

  async function waitForHealth(base) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      // A port already in use makes PIE print its own message and exit, so give
      // up on this attempt immediately rather than waiting out the full timeout
      // three times over.
      if (server.exitCode !== null) return false;
      try { if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) })).ok) return true; }
      catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  }

  /** Fetch with cookie handling, returning parsed JSON and the Set-Cookie. */
  async function api(pathname, { method = 'GET', body, cookie, token } = {}) {
    const res = await fetch(BASE + pathname, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data, setCookie: res.headers.get('set-cookie') };
  }

  /**
   * The four-digit code out of the most recent message for an address.
   *
   * Quoted-printable and base64 both turn up depending on the encoding
   * nodemailer picks, so this decodes the obvious cases rather than assuming
   * plain text and mysteriously finding nothing.
   */
  function codeFor(email) {
    for (let i = smtp.messages.length - 1; i >= 0; i -= 1) {
      const raw = smtp.messages[i];
      if (!raw.includes(email)) continue;
      const decoded = raw
        .replace(/=\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      const fromB64 = decoded.split('\n')
        .filter(l => /^[A-Za-z0-9+/=]{40,}$/.test(l.trim()))
        .map(l => { try { return Buffer.from(l.trim(), 'base64').toString('utf8'); } catch { return ''; } })
        .join('\n');
      const hay = `${decoded}\n${fromB64}`;
      const m = /verification code is:\s*([\s\S]{0,80}?)(\d{4})/i.exec(hay) || /\b(\d{4})\b/.exec(hay);
      if (m) return m[2] || m[1];
    }
    return null;
  }

  /**
   * Shuts the server down and removes its data directory — in that order, and
   * actually waiting for the first part.
   *
   * `server.kill()` sends a signal and returns; it does not wait. So the
   * directory was being removed while PIE was still exiting, and PIE flushes
   * its JSON store on the way out. Every test in the file would pass and the
   * teardown hook would then fail with
   *
   *     ENOTEMPTY: directory not empty, rmdir '.../data/.test-gate'
   *
   * which node reports as a failing test file. Roughly one run in six — often
   * enough to be noticed, rarely enough to be blamed on whatever was changed
   * that afternoon. Twice today it was.
   *
   * So: wait for the exit, escalate to SIGKILL if the process is wedged, and
   * let the removal retry, because on Windows a file handle can outlive the
   * process that held it by a few milliseconds.
   */
  async function stop() {
    if (server && server.exitCode === null && !server.killed) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      try { server.kill(); } catch { /* already gone */ }
      const forced = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
      await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
      clearTimeout(forced);
    }
    smtp.close();
    await rm(DATA_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { BASE, api, codeFor, messages: smtp.messages, output: () => out, stop };
}

/* ------------------------------------------------------------- descriptors */
/**
 * Face descriptors for tests, without needing a camera or a real face.
 *
 * These MUST match the real model's geometry, and the first version of this did
 * not. It produced unit vectors, because that is what a descriptor "obviously"
 * is. The real model emits no normalisation at all — a genuine descriptor
 * measures about 1.39 — so every identity test passed against synthetic data
 * that satisfied an invariant the product violated, and the mismatch only
 * surfaced when a person stood in front of a camera.
 *
 * So the scale here is the measured one. `test/fixtures/descriptors.json` holds
 * four real descriptors from the real model if you want the genuine article;
 * these generators are for the cases that need many distinct people.
 */
const REAL_NORM = 1.39;

export function personDescriptor(seed = Math.random()) {
  let x = Math.sin(seed * 99991) * 10000;
  const rnd = () => { x = Math.sin(x) * 10000; return x - Math.floor(x) - 0.5; };
  const v = Array.from({ length: 128 }, rnd);
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
  return v.map(k => (k / n) * REAL_NORM);
}

/** The same person, captured again. `spread` controls how different the day was. */
export function sameFace(descriptor, spread = 0.02, seed = Math.random()) {
  let x = Math.sin(seed * 7717) * 10000;
  const rnd = () => { x = Math.sin(x) * 10000; return x - Math.floor(x) - 0.5; };
  // Perturb without re-scaling: a real second capture of the same face is a
  // nearby point in the same space, not a point on some sphere.
  return descriptor.map(k => k + rnd() * spread);
}
