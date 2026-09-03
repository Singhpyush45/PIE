#!/usr/bin/env node
// PIE — SAP HANA Cloud connection test.
//
//   node tools/hana-test.mjs             check the connection and the schema
//   node tools/hana-test.mjs --create    also create PIE's two tables
//
// Proves the connection is real rather than assuming it from environment
// variables, and records the result so the running app shows CONNECTED without
// being restarted. The password is never printed.

import '../src/env.js';
import * as hana from '../src/integrations/sapHanaRepository.js';

const arg = process.argv.slice(2);
const wantCreate = arg.includes('--create');

const line = (k, v) => console.log(`  ${k.padEnd(24)} ${v}`);
const rule = () => console.log('  ' + '─'.repeat(64));

console.log('\nPIE — SAP HANA CLOUD TEST');
rule();

/* 1 — configuration */
console.log('\n1. CONFIGURATION  (the password is never printed)');
const host = (process.env.SAP_HANA_HOST || '').trim();
const user = (process.env.SAP_HANA_USER || '').trim();
const pass = process.env.SAP_HANA_PASSWORD || '';
line('SAP_HANA_HOST', host || '(not set)');
line('SAP_HANA_PORT', (process.env.SAP_HANA_PORT || '443').trim());
line('SAP_HANA_USER', user || '(not set)');
line('SAP_HANA_SCHEMA', (process.env.SAP_HANA_SCHEMA || '').trim() || '(unset — the user\'s own default schema is used)');
line('SAP_HANA_PASSWORD', pass ? `${pass.length} characters` : '(not set)');
if (host && !/hanacloud\.ondemand\.com$/i.test(host.split(':')[0])) {
  line('host shape', 'unusual — a HANA Cloud endpoint normally ends in hanacloud.ondemand.com');
}
if (host.includes(':')) {
  line('note', 'HOST contains a port. Put the port in SAP_HANA_PORT and the hostname alone in SAP_HANA_HOST.');
}

if (!hana.isConfigured()) {
  console.log('\n  Nothing to test until HOST, USER and PASSWORD are all set in server/.env');
  console.log('  You do NOT need the DBADMIN password. In the BTP cockpit, create a');
  console.log('  "SAP HANA Schemas & HDI Containers" service instance (plan: schema) and');
  console.log('  then a service key — it contains host, port, user, password and schema.\n');
  process.exit(1);
}

/* 2 — driver */
console.log('\n2. DRIVER');
try {
  await import('@sap/hana-client');
  line('@sap/hana-client', 'installed');
} catch {
  line('@sap/hana-client', 'MISSING — run: npm install @sap/hana-client');
  process.exit(1);
}

/* 3 — connection */
console.log('\n3. CONNECTION  (opens a real session and runs a real query)');
const v = await hana.verify();
line('result', v.ok ? 'CONNECTED' : `REFUSED (${v.reason})`);
if (v.version) line('HANA version', v.version);
if (v.user) line('signed in as', v.user);
if (!v.ok) {
  line('detail', String(v.detail || '').slice(0, 200));
  console.log('\n  WHAT THIS USUALLY MEANS');
  const d = String(v.detail || '');
  if (v.reason === 'TIMEOUT' || /allowed|denied|refused/i.test(d)) {
    console.log('    • HANA Cloud only accepts connections from addresses on its allowlist.');
    console.log('      HANA Cloud Central → your instance → Configuration → Allowed connections.');
    console.log('      Add your own address to test locally, and Render\'s outbound addresses');
    console.log('      (or 0.0.0.0/0 while demoing) for the deployed app.');
  } else if (/resolve host|ENOTFOUND/i.test(d)) {
    console.log('    • The hostname is wrong. Use "Copy SQL Endpoint" and drop the :443 suffix');
    console.log('      into SAP_HANA_PORT instead of leaving it in SAP_HANA_HOST.');
  } else if (/authentication|invalid user|password/i.test(d)) {
    console.log('    • The user or password is wrong. In HANA Cloud Central the instance shows');
    console.log('      "Sign in to the Instance" until valid credentials are supplied — the same');
    console.log('      credentials go here.');
  } else {
    console.log('    • Read the detail above; it comes straight from the HANA driver.');
  }
  console.log('\n  Nothing was written. PIE keeps using its own store as the system of record.\n');
  process.exit(1);
}
line('recorded', 'saved — the app will now show SAP HANA Cloud as CONNECTED');

/* 4 — schema */
console.log('\n4. SCHEMA');
if (wantCreate) {
  const s = await hana.ensureSchema();
  if (!s.ok) { line('result', `FAILED — ${s.detail || s.reason}`); process.exit(1); }
  if (s.created.length) line('created', s.created.join(', '));
  if (s.existing.length) line('already there', s.existing.join(', '));
} else {
  line('skipped', 'run with --create to create PIE_AUDIT_EVENT and PIE_MATCH_RESULT');
}

const c = await hana.counts();
if (c.ok) {
  line('PIE_AUDIT_EVENT', `${c.auditEvents} row(s)`);
  line('PIE_MATCH_RESULT', `${c.matchResults} row(s)`);
} else if (!wantCreate) {
  line('row counts', 'tables not created yet — run with --create');
}

rule();
console.log('  Connection is real and recorded.');
console.log('  Set SAP_HANA_MIRROR=1 to start writing the audit trail and match results.\n');
