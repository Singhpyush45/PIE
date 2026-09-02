// PIE — SMTP test.
//
//   cd F:\PIE_V3\server
//   node tools/mail-test.mjs                  → check the config and the connection
//   node tools/mail-test.mjs you@gmail.com    → and send a real test message
//
// Answers the only question that matters before a demo: will the password-reset
// email actually leave the machine?
//
// SAFETY: never prints SMTP_PASS. It reports the password's LENGTH and shape,
// which is enough to catch the two mistakes people actually make — pasting a
// normal Gmail password, or pasting an app password with the spaces still in.

import '../src/env.js';
import * as mailer from '../src/mailer.js';

const line = (l, v) => console.log(`  ${l.padEnd(24)} ${v}`);
const to = process.argv[2];

console.log('\nPIE — SMTP TEST');
console.log('='.repeat(64));

/* ------------------------------------------------------------------ config */
console.log('\n1. CONFIGURATION  (the password is never printed)');
const host = (process.env.SMTP_HOST || '').trim();
const port = (process.env.SMTP_PORT || '').trim();
const user = (process.env.SMTP_USER || '').trim();
const from = (process.env.SMTP_FROM || '').trim();
const pass = process.env.SMTP_PASS || '';

line('SMTP_HOST', host || 'NOT SET  <-- required');
line('SMTP_PORT', port || '(default 587)');
line('SMTP_USER', user || 'NOT SET  <-- required');
line('SMTP_FROM', from || '(falls back to SMTP_USER)');
line('SMTP_SECURE', process.env.SMTP_SECURE || '(false)');

if (!pass) {
  line('SMTP_PASS', 'NOT SET  <-- required');
} else {
  const stripped = pass.replace(/\s/g, '');
  const looksLikeAppPassword = /^[a-z]{16}$/i.test(stripped);
  line('SMTP_PASS length', `${pass.length} characters`);
  if (/\s/.test(pass)) {
    line('', `contains spaces  <-- remove them (${stripped.length} without)`);
  }
  line('SMTP_PASS shape', looksLikeAppPassword
    ? 'looks like a Gmail App Password'
    : /gmail\.com$/i.test(host)
      ? 'does NOT look like a 16-letter App Password  <-- Gmail will refuse a normal password'
      : '(not Gmail — shape not checked)');
}

// Gmail rewrites or rejects a From it did not authenticate as.
if (/gmail\.com$/i.test(host) && from && user) {
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
  line('FROM vs USER', fromAddr === user.toLowerCase()
    ? 'match — good'
    : `MISMATCH  <-- Gmail only sends as ${user}`);
}

line('APP_BASE_URL', process.env.APP_BASE_URL || '(default http://localhost:5174)');
if (/localhost|127\.0\.0\.1/.test(process.env.APP_BASE_URL || 'localhost')) {
  line('', 'reset links will only open on THIS computer');
}

/* -------------------------------------------------------------- dependency */
console.log('\n2. DEPENDENCY');
try {
  await import('nodemailer');
  line('nodemailer', 'installed');
} catch {
  line('nodemailer', 'MISSING  <-- run: npm install');
  console.log('\n  Without it PIE still issues reset links, but prints them to the');
  console.log('  server console instead of emailing them.\n');
  process.exit(1);
}

/* ------------------------------------------------------------- connection */
console.log('\n3. CONNECTION  (authenticates, sends nothing)');
const v = await mailer.verify();
line('result', v.ok ? 'ACCEPTED' : `REFUSED (${v.reason})`);
if (v.detail) line('server said', v.detail);
if (v.ok) {
  // The result is written to server/data/service-checks.json, so the running
  // server picks it up. It used to live only in this process's memory, which is
  // why the SAP page kept saying "no message has been sent yet" after a pass.
  line('recorded', 'saved — the app will now show Email (SMTP) as VERIFIED');
}

if (!v.ok) {
  console.log('\n  WHAT THIS USUALLY MEANS');
  if (v.reason === 'NOT_CONFIGURED') {
    console.log('    • Section 1 above shows which variable is still empty.');
    console.log('      Fill it in server/.env and run this again.');
  } else if (/invalid login|username and password not accepted|535/i.test(v.detail || '')) {
    console.log('    • Gmail rejected the credentials. Use an App Password, not your');
    console.log('      normal password, and make sure 2-Step Verification is on.');
  } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(v.code || v.detail || '')) {
    console.log('    • Could not reach the server. Check SMTP_HOST/SMTP_PORT, and whether');
    console.log('      a firewall or your network blocks outbound port 587.');
  } else {
    console.log('    • The message above is what the mail server returned.');
  }
  console.log('\n  PIE keeps working either way — reset links go to the server console.\n');
  process.exit(1);
}

/* ------------------------------------------------------------------- send */
if (!to) {
  console.log('\n  Connection is good. To send a real test message:');
  console.log('    node tools/mail-test.mjs your-address@example.com\n');
  process.exit(0);
}

console.log(`\n4. SENDING A TEST MESSAGE TO ${to}`);
const sample = mailer.resetEmail({
  name: 'Test',
  link: `${(process.env.APP_BASE_URL || 'http://localhost:5174').replace(/\/+$/, '')}/?reset=THIS-IS-ONLY-A-TEST`,
  minutes: 45,
});
const r = await mailer.send({
  to,
  subject: '[TEST] ' + sample.subject,
  text: 'This is a PIE SMTP test. The link below is deliberately invalid.\n\n' + sample.text,
  html: '<p style="font:14px system-ui;color:#8a94a3">This is a PIE SMTP test. The link below is deliberately invalid.</p>' + sample.html,
});

line('result', r.sent ? 'SENT' : `FAILED (${r.reason})`);
if (r.messageId) line('message id', r.messageId);
if (r.detail) line('detail', r.detail);

console.log(r.sent
  ? '\n  Check that inbox (and spam). If it arrived, password reset will work.\n'
  : '\n  Sending failed. PIE will fall back to printing links on the console.\n');
process.exit(r.sent ? 0 : 1);
