// PIE — environment loading.
//
// Must be the FIRST import in index.js: some modules read process.env at load time
// (the store reads PIE_DATA_DIR), so the file has to be parsed before they are.
//
// Uses Node's built-in .env parser (Node 20.6+). No dependency, nothing to install.
// Precedence, highest first:
//   1. Real environment variables already exported in your shell
//   2. server/.env
//   3. <project root>/.env
//
// SECURITY: this file is read by the SERVER ONLY. No value here is ever sent to the
// browser. Values are never logged — only the NAMES of the keys that were found.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.resolve(__dirname, '../.env'),        // server/.env   (preferred)
  path.resolve(__dirname, '../../.env'),     // project root/.env
];

const loaded = [];
const before = new Set(Object.keys(process.env));

for (const file of CANDIDATES) {
  if (!fs.existsSync(file)) continue;
  try {
    // Node's parser does not overwrite variables already set in the real
    // environment, which gives us the precedence order documented above.
    process.loadEnvFile(file);
    loaded.push(file);
  } catch (e) {
    console.warn(`[env] could not read ${file}: ${e.message}`);
  }
}

/** Keys we care about, grouped for a readable startup banner. */
const GROUPS = {
  'AI provider': ['AI_PROVIDER', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OLLAMA_BASE_URL'],
  GitHub: ['GITHUB_TOKEN', 'GITHUB_CLIENT_ID', 'GITHUB_CALLBACK_URL'],
  // All four are required together: the SDK runs in-process, so it needs the
  // Hub credentials AND the key that encrypts stored authorisations AND a real
  // Postgres connection. Three out of four is not a working integration.
  Corsair: ['CORSAIR_API_KEY', 'CORSAIR_SIGNING_SECRET', 'CORSAIR_KEK', 'CORSAIR_DATABASE_URL'],
  // Gmail is a Corsair plugin, but its credentials are yours: it has no managed
  // auth type, so this is a Google Cloud OAuth client you registered.
  'Gmail (via Corsair)': ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URL'],
  // Mail and persistence were missing here, and their absence was the reason
  // "is my .env even being read?" was hard to answer: the banner listed AI and
  // GitHub and said nothing about the two things most likely to be wrong.
  Mail: ['SMTP_HOST', 'SMTP_USER', 'SMTP_FROM', 'MAIL_HTTP_PROVIDER', 'MAIL_FROM',
    'RESEND_API_KEY', 'BREVO_API_KEY', 'EMAIL_VERIFICATION'],
  Persistence: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_MIRROR', 'SUPABASE_HYDRATE'],
  App: ['APP_BASE_URL', 'ADMIN_PASSWORD', 'TOKEN_ENCRYPTION_KEY', 'NODE_ENV'],
};

const isSet = k => Boolean((process.env[k] || '').trim());

export function envReport() {
  return {
    filesLoaded: loaded,
    groups: Object.fromEntries(
      Object.entries(GROUPS).map(([g, keys]) => [g, keys.filter(isSet)]),
    ),
    // Names only. A value is never returned from here.
    configured: Object.values(GROUPS).flat().filter(isSet),
  };
}

export function printEnvBanner() {
  if (loaded.length) {
    for (const f of loaded) console.log(`  env: loaded ${path.relative(process.cwd(), f)}`);
  } else {
    // Where it looked, not just that it found nothing. "No .env file found" on
    // its own sends people to check the file they are staring at, rather than
    // the two paths that are actually consulted.
    console.log('  env: no .env file found — running on deterministic defaults (this is fine)');
    for (const f of CANDIDATES) console.log(`  env:   looked for ${f}`);
  }
  for (const [group, keys] of Object.entries(GROUPS)) {
    const set = keys.filter(isSet);
    if (set.length) console.log(`  env: ${group} → ${set.join(', ')} set`);
  }
  // A key that is present but obviously malformed is worth flagging early.
  const openai = (process.env.OPENAI_API_KEY || '').trim();
  if (openai && !openai.startsWith('sk-')) {
    console.warn('  env: OPENAI_API_KEY does not start with "sk-" — check it was pasted whole.');
  }
  const gh = (process.env.GITHUB_TOKEN || '').trim();
  if (gh && !/^(gh[pousr]_|github_pat_)/.test(gh)) {
    console.warn('  env: GITHUB_TOKEN does not look like a GitHub token — repository import will fall back to demo data.');
  }
}

/** True when a variable was inherited from the shell rather than a .env file. */
export const fromShell = k => before.has(k);
