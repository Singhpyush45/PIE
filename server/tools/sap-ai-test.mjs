#!/usr/bin/env node
// PIE — SAP Generative AI Hub (AI Core) connection test.
//
//   node tools/sap-ai-test.mjs            authenticate and list deployments
//   node tools/sap-ai-test.mjs --infer    also send one real prompt
//
// Proves the whole path rather than assuming it from environment variables, and
// records the result so the running app shows CONNECTED without a restart.
// No secret is ever printed.

import '../src/env.js';
import * as sap from '../src/integrations/sapGenAiHub.js';

const wantInfer = process.argv.slice(2).includes('--infer');
const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
const rule = () => console.log('  ' + '─'.repeat(66));

console.log('\nPIE — SAP GENERATIVE AI HUB TEST');
rule();

/* 1 — configuration */
console.log('\n1. CONFIGURATION  (no secret is printed)');
const mode = sap.authMode();
line('auth mode', mode);
line('DEPLOYMENT_URL', (process.env.SAP_AI_CORE_DEPLOYMENT_URL || '').trim() || '(not set)');
line('AUTH_URL', (process.env.SAP_AI_CORE_AUTH_URL || '').trim() || '(not set)');
line('CLIENT_ID', (process.env.SAP_AI_CORE_CLIENT_ID || '').trim() || '(not set)');
line('CLIENT_SECRET', process.env.SAP_AI_CORE_CLIENT_SECRET ? 'set' : '(not set)');
line('API_URL', (process.env.SAP_AI_CORE_API_URL || '').trim() || '(not set — deployment list will be skipped)');
line('RESOURCE_GROUP', (process.env.SAP_AI_RESOURCE_GROUP || 'default').trim());

if (mode === 'STATIC_TOKEN') {
  console.log('\n  NOTE: a static token is being used. AI Core tokens expire after a few hours,');
  console.log('  so this will stop working mid-session. Use the service key instead:');
  console.log('    SAP_AI_CORE_AUTH_URL      ← service key "url"');
  console.log('    SAP_AI_CORE_CLIENT_ID     ← service key "clientid"');
  console.log('    SAP_AI_CORE_CLIENT_SECRET ← service key "clientsecret"');
  console.log('    SAP_AI_CORE_API_URL       ← service key "serviceurls.AI_API_URL"');
}

if (!sap.isConfigured()) {
  console.log('\n  Nothing to test yet.');
  console.log('  In SAP AI Launchpad / BTP cockpit, create a service key for the AI Core');
  console.log('  instance and copy its values into server/.env.\n');
  process.exit(1);
}

/* 2 — authenticate + reach the API */
console.log('\n2. AUTHENTICATION AND API');
const v = await sap.verify();
line('result', v.ok ? 'CONNECTED' : `FAILED (${v.reason})`);
if (v.detail) line('detail', String(v.detail).slice(0, 180));
if (v.deployments != null) line('deployments', `${v.running} running of ${v.deployments}`);

if (!v.ok) {
  console.log('\n  WHAT THIS USUALLY MEANS');
  const d = String(v.detail || '');
  if (v.reason === 'AUTH_REJECTED') {
    console.log('    • The client id or secret is wrong, or they belong to a different');
    console.log('      service instance than the deployment URL.');
  } else if (v.reason === 'AUTH_UNREACHABLE') {
    console.log('    • The auth URL is wrong or unreachable. It is the service key "url",');
    console.log('      an authentication host — not the AI API host.');
  } else if (v.reason === 'API_REJECTED') {
    console.log('    • The token was issued but the AI API refused it. Check that');
    console.log('      SAP_AI_RESOURCE_GROUP matches the resource group your deployment is in.');
  } else {
    console.log('    • Read the detail above; it comes straight from SAP AI Core.');
  }
  console.log('\n  PIE falls back to the next configured provider. No score changes.\n');
  process.exit(1);
}
line('recorded', 'saved — the app will now show SAP Generative AI Hub as CONNECTED');

/* 3 — one real prompt */
if (wantInfer) {
  console.log('\n3. INFERENCE  (sends one short prompt)');
  try {
    const out = await sap.chat(
      [{ role: 'user', content: 'Reply with exactly: PIE is talking to SAP AI Core.' }],
      { maxTokens: 40, temperature: 0 });
    line('model replied', JSON.stringify(String(out).slice(0, 120)));
  } catch (e) {
    line('inference', `FAILED — ${String(e.message).slice(0, 160)}`);
    console.log('\n  Authentication works but the deployment did not answer. Check that the');
    console.log('  deployment URL points at a RUNNING deployment and that its model supports');
    console.log('  the chat-completions shape.\n');
    process.exit(1);
  }
} else {
  console.log('\n3. INFERENCE');
  line('skipped', 'run with --infer to send one real prompt');
}

rule();
console.log('  SAP Generative AI Hub is now first in PIE\'s provider chain.');
console.log('  Every score stays deterministic — this changes the wording, not one number.\n');
