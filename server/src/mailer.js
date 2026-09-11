// PIE — outbound email.
//
// Used for the password-reset link and the four-digit registration code.
//
// TWO TRANSPORTS, AND WHY THERE HAS TO BE
//   SMTP is the obvious one and works everywhere except the place PIE is
//   actually deployed. Render blocks outbound traffic to SMTP ports 25, 465 and
//   587 on free web services, so a nodemailer connection there does not fail
//   fast with a refusal — it hangs until the timeout. The symptom on the live
//   site is a registration that stalls and then reports that the code could not
//   be sent, with credentials that are perfectly correct and work locally.
//
//   So PIE also speaks an HTTPS mail API, which nothing blocks. Set
//   MAIL_HTTP_PROVIDER and its key and that path is used in preference to SMTP;
//   set neither and the behaviour is exactly as before. Nothing is introduced
//   silently: without configuration, no third-party service is contacted.
//
// DESIGN
//   • SMTP is OPTIONAL. With nothing configured PIE still issues a valid reset
//     link and prints it to the SERVER CONSOLE, so the flow is fully testable
//     offline and the demo never depends on a mail server being reachable.
//   • nodemailer is imported lazily. If the package is not installed the server
//     still boots and simply reports the mailer as unavailable — a missing
//     dependency must never take the whole app down four days before a demo.
//   • Credentials come from server/.env and are never logged. The reset token
//     appears only in the email body (and, unconfigured, in the console).

import * as checks from './persistence/checks.js';
import { fingerprint } from './persistence/checks.js';

let transportPromise = null;
let lastError = null;
let verified = false;   // set only once a real connection has succeeded IN THIS PROCESS

/* ------------------------------------------------------------- HTTP mail */
/**
 * Providers whose send endpoint is one HTTPS POST with a JSON body.
 *
 * Deliberately small. Each entry is the request PIE would make and nothing
 * else — no SDK, no client library to drift out of date, no extra dependency
 * for something a `fetch` already does.
 */
const HTTP_PROVIDERS = {
  resend: {
    label: 'Resend',
    keyEnv: 'RESEND_API_KEY',
    url: 'https://api.resend.com/emails',
    build: ({ key, from, to, subject, text, html }) => ({
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: { from, to: [to], subject, text, html },
    }),
  },
  brevo: {
    label: 'Brevo',
    keyEnv: 'BREVO_API_KEY',
    url: 'https://api.brevo.com/v3/smtp/email',
    build: ({ key, from, to, subject, text, html }) => {
      // Brevo wants the name and address split, so "PIE <pie@x.test>" has to be
      // taken apart rather than passed through.
      const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
      return {
        headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: {
          sender: m ? { name: m[1] || 'PIE', email: m[2] } : { email: from },
          to: [{ email: to }],
          subject, textContent: text, htmlContent: html,
        },
      };
    },
  },
};

/** The HTTP transport, if one is configured. */
export function httpProvider() {
  const name = (process.env.MAIL_HTTP_PROVIDER || '').trim().toLowerCase();
  const p = HTTP_PROVIDERS[name];
  if (!p) return null;
  const key = (process.env[p.keyEnv] || '').trim();
  const from = (process.env.MAIL_FROM || process.env.SMTP_FROM || '').trim();
  if (!key || !from) return null;
  return { ...p, name, key, from };
}

const cfg = () => ({
  host: (process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 587),
  user: (process.env.SMTP_USER || '').trim(),
  pass: process.env.SMTP_PASS || '',
  from: (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
});

export function isConfigured() {
  if (httpProvider()) return true;
  const c = cfg();
  return Boolean(c.host && c.user && c.pass && c.from);
}

/** Which transport a message would actually go out on. */
export const activeTransport = () => (httpProvider() ? 'HTTP_API' : (isConfigured() ? 'SMTP' : 'NONE'));

/** What this check was taken against — a different host makes an old pass moot. */
const smtpFingerprint = () => {
  const http = httpProvider();
  if (http) return fingerprint(['http', http.name, http.from]);
  const c = cfg();
  return fingerprint([c.host, String(c.port), c.user, c.from]);
};

/** Never returns the password or the host's credentials — only names and state. */
export function status() {
  const c = cfg();
  // A successful check by ANOTHER process still counts. `mail-test.mjs` runs
  // standalone, so without this the server never learns that the credentials
  // were proven and the page keeps saying "no message has been sent yet".
  const http = httpProvider();
  const via = http ? http.label : c.host;
  const from = http ? http.from : c.from;
  const proven = verified ? null : checks.read('smtp', smtpFingerprint());
  // "Configured" means the variables are present, NOT that a message has ever
  // left the building. Saying "links are sent from X" before proving it is the
  // same overclaim PIE refuses to make about any integration.
  const state = !isConfigured() ? 'NOT_CONFIGURED'
    : lastError ? 'DEGRADED'
      : (verified || proven?.ok) ? 'VERIFIED' : 'CONFIGURED_UNVERIFIED';
  // Report WHEN it was proven rather than implying it is working this second.
  const when = verified ? 'this session' : proven?.ok ? checks.ageOf(proven) : null;
  const detail = {
    NOT_CONFIGURED: 'No mail transport configured. Password-reset links are printed to the server console, '
      + 'and email verification is not enforced — a gate nobody can pass would lock every candidate out.',
    CONFIGURED_UNVERIFIED: `Credentials for ${via} are present but no message has been sent yet. Run "node tools/mail-test.mjs" to prove it works before you need it.`,
    VERIFIED: `${via} accepted the message${when ? ` (checked ${when})` : ''}. Verification codes and reset links are emailed from ${from}.`,
    DEGRADED: `${via} refused the last attempt. Reset links are falling back to the server console.`,
  }[state];
  return {
    key: 'smtp',
    name: http ? `Email (${http.label} HTTPS API)` : 'Email (SMTP)',
    state,
    detail,
    transport: activeTransport(),
    lastError: lastError || null,
    limitation: (!http && isConfigured())
      ? 'This deployment sends over SMTP. Render blocks outbound SMTP ports on free web services, so this '
        + 'will time out there however correct the credentials are. Set MAIL_HTTP_PROVIDER to send over HTTPS instead.'
      : undefined,
    requires: http
      ? `MAIL_HTTP_PROVIDER, ${http.keyEnv}, MAIL_FROM`
      : 'SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM — or MAIL_HTTP_PROVIDER + a provider key for hosts that block SMTP',
  };
}

/**
 * Opens a real connection and authenticates, without sending anything.
 * This is the difference between "the variables are filled in" and "this works".
 */
export async function verify() {
  if (!isConfigured()) {
    return { ok: false, reason: 'NOT_CONFIGURED', detail: 'SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM must all be set.' };
  }
  const http = httpProvider();
  if (http) {
    // There is no "connect but do not send" for an HTTP mail API. Claiming
    // verified because a key is present would be exactly the overclaim this
    // whole status system exists to avoid.
    const proven = checks.read('smtp', smtpFingerprint());
    return proven?.ok
      ? { ok: true, detail: `${http.label} accepted a message previously (${checks.ageOf(proven)}).` }
      : { ok: false, reason: 'UNPROVEN',
        detail: `${http.label} is configured, but an HTTPS mail API cannot be tested without actually `
          + 'sending. Run "node tools/mail-test.mjs your@address" to send one and prove it.' };
  }

  try {
    const t = await transport();
    if (!t) return { ok: false, reason: 'TRANSPORT_UNAVAILABLE', detail: lastError };
    await t.verify();
    verified = true; lastError = null;
    // Written to disk so the running server — and the next one — knows.
    checks.record('smtp', { ok: true, detail: 'credentials accepted', config: smtpFingerprint() });
    return { ok: true, host: cfg().host, detail: 'The server accepted the connection and the credentials.' };
  } catch (e) {
    lastError = e.message?.slice(0, 200) || 'verify failed';
    verified = false;
    checks.record('smtp', { ok: false, detail: lastError, config: smtpFingerprint() });
    return { ok: false, reason: 'REJECTED', detail: lastError, code: e.code || null };
  }
}

async function transport() {
  if (!isConfigured()) return null;
  if (transportPromise) return transportPromise;
  transportPromise = (async () => {
    let nodemailer;
    try {
      nodemailer = (await import('nodemailer')).default;
    } catch {
      lastError = 'nodemailer is not installed. Run: npm install nodemailer';
      return null;
    }
    const c = cfg();
    const ms = Number(process.env.SMTP_TIMEOUT_MS || 12000);
    return nodemailer.createTransport({
      host: c.host,
      port: c.port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: c.secure || c.port === 465,
      auth: { user: c.user, pass: c.pass },
      // Never hang. A blocked port 587 would otherwise stall the reset request
      // (and the test tool) indefinitely instead of falling back to the console.
      connectionTimeout: ms, greetingTimeout: ms, socketTimeout: ms,
    });
  })();
  return transportPromise;
}

/**
 * Sends one message. Resolves to a result object rather than throwing, because a
 * mail failure must never surface as a 500 to the person resetting a password —
 * and must never tell them whether the address existed.
 */
export async function send({ to, subject, text, html }) {
  if (!isConfigured()) return { sent: false, reason: 'NOT_CONFIGURED' };

  const http = httpProvider();
  if (http) {
    try {
      const { headers, body } = http.build({ key: http.key, from: http.from, to, subject, text, html });
      const res = await fetch(http.url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.MAIL_HTTP_TIMEOUT_MS || 12000)),
      });
      if (!res.ok) {
        // The body may name a rejected sender domain, which is nearly always
        // the real problem. It never contains the key.
        const detail = (await res.text().catch(() => '')).slice(0, 200) || res.statusText;
        lastError = `${http.label} returned ${res.status}: ${detail}`;
        console.warn(`[mailer] could not send "${subject}": ${lastError}`);
        checks.record('smtp', { ok: false, detail: lastError, config: smtpFingerprint() });
        return { sent: false, reason: 'SEND_FAILED', detail: lastError };
      }
      lastError = null; verified = true;
      checks.record('smtp', { ok: true, detail: `${http.label} accepted the message`, config: smtpFingerprint() });
      return { sent: true, transport: 'HTTP_API', provider: http.label };
    } catch (e) {
      lastError = (e.name === 'TimeoutError' ? `${http.label} did not respond in time` : e.message?.slice(0, 200))
        || 'send failed';
      console.warn(`[mailer] could not send "${subject}": ${lastError}`);
      return { sent: false, reason: 'SEND_FAILED', detail: lastError };
    }
  }

  try {
    const t = await transport();
    if (!t) return { sent: false, reason: 'TRANSPORT_UNAVAILABLE', detail: lastError };
    const info = await t.sendMail({ from: cfg().from, to, subject, text, html });
    lastError = null; verified = true;
    // A delivered message is the strongest proof there is; remember it.
    checks.record('smtp', { ok: true, detail: 'a message was accepted for delivery', config: smtpFingerprint() });
    return { sent: true, messageId: info?.messageId || null };
  } catch (e) {
    // The message may name the host; it never carries the password.
    lastError = e.message?.slice(0, 200) || 'send failed';
    console.warn(`[mailer] could not send "${subject}": ${lastError}`);
    return { sent: false, reason: 'SEND_FAILED', detail: lastError };
  }
}

/* ------------------------------------------------------------ reset email */
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function resetEmail({ name, link, minutes }) {
  const safeName = esc(name || 'there');
  const safeLink = esc(link);
  return {
    subject: 'Reset your PIE password',
    text: [
      `Hi ${name || 'there'},`, '',
      'Someone asked to reset the password for your PIE account.',
      `Open this link to choose a new one. It works once and expires in ${minutes} minutes:`,
      '', link, '',
      'If this was not you, ignore this email — your password has not changed,',
      'and the link above cannot be used without opening it.',
      '', '— PIE, Potential Intelligence Engine',
    ].join('\n'),
    html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#182231;max-width:520px">
  <p style="margin:0 0 16px">Hi ${safeName},</p>
  <p style="margin:0 0 16px">Someone asked to reset the password for your PIE account.</p>
  <p style="margin:0 0 20px">Choose a new one with the button below. It works <b>once</b> and expires in <b>${minutes} minutes</b>.</p>
  <p style="margin:0 0 24px">
    <a href="${safeLink}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;
       padding:12px 22px;border-radius:8px;font-weight:600">Reset my password</a>
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#5b6879">Or paste this into your browser:</p>
  <p style="margin:0 0 24px;font-size:12px;word-break:break-all;color:#5b6879">${safeLink}</p>
  <p style="margin:0;font-size:13px;color:#5b6879">
    If this was not you, ignore this email. Your password has not changed.
  </p>
  <p style="margin:24px 0 0;font-size:12px;color:#8a94a3">PIE — Potential Intelligence Engine</p>
</div>`,
  };
}
