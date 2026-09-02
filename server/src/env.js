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
  'AI provider': ['SAP_AI_CORE_DEPLOYMENT_URL', 'SAP_AI_CORE_TOKEN', 'OPENAI_API_KEY'],
  GitHub: ['GITHUB_TOKEN'],
  'SAP enterprise': ['SAP_BTP_CAP_URL', 'SAP_HANA_HOST', 'SF_API_URL', 'SAC_TENANT_URL'],
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
    console.log('  env: no .env file found — running on deterministic defaults (this is fine)');
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
