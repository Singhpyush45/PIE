// PIE — outbound email.
//
// Used for exactly one thing today: the password-reset link.
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

const cfg = () => ({
  host: (process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 587),
  user: (process.env.SMTP_USER || '').trim(),
  pass: process.env.SMTP_PASS || '',
  from: (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
});

export function isConfigured() {
  const c = cfg();
  return Boolean(c.host && c.user && c.pass && c.from);
}

/** What this check was taken against — a different host makes an old pass moot. */
const smtpFingerprint = () => {
  const c = cfg();
  return fingerprint([c.host, String(c.port), c.user, c.from]);
};

/** Never returns the password or the host's credentials — only names and state. */
export function status() {
  const c = cfg();
  // A successful check by ANOTHER process still counts. `mail-test.mjs` runs
  // standalone, so without this the server never learns that the credentials
  // were proven and the page keeps saying "no message has been sent yet".
  const proven = verified ? null : checks.read('smtp', smtpFingerprint());
  // "Configured" means the variables are present, NOT that a message has ever
  // left the building. Saying "links are sent from X" before proving it is the
  // same overclaim PIE refuses to make about SAP.
  const state = !isConfigured() ? 'NOT_CONFIGURED'
    : lastError ? 'DEGRADED'
      : (verified || proven?.ok) ? 'VERIFIED' : 'CONFIGURED_UNVERIFIED';
  // Report WHEN it was proven rather than implying it is working this second.
  const when = verified ? 'this session' : proven?.ok ? checks.ageOf(proven) : null;
  const detail = {
    NOT_CONFIGURED: 'No SMTP server configured. Password-reset links are printed to the server console instead of being emailed, and the app says so.',
    CONFIGURED_UNVERIFIED: `Credentials for ${c.host} are present but no message has been sent yet. Run "node tools/mail-test.mjs" to prove it works before you need it.`,
    VERIFIED: `${c.host} accepted the credentials${when ? ` (checked ${when})` : ''}. Password-reset links are emailed from ${c.from}.`,
    DEGRADED: `${c.host} refused the last attempt. Reset links are falling back to the server console.`,
  }[state];
  return {
    key: 'smtp',
    name: 'Email (SMTP)',
    state,
    detail,
    lastError: lastError || null,
    requires: 'SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM',
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
