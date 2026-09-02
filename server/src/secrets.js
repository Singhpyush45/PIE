// PIE — encryption for third-party access tokens at rest.
//
// GitHub access tokens are secrets that belong to the candidate, not to PIE. They
// are AES-256-GCM encrypted before they touch the store, are never logged, never
// placed in a URL, and never serialised to any API response.
//
// The key comes from TOKEN_ENCRYPTION_KEY (32+ chars). If that is absent, a random
// key is generated once and written to data/.token-key with 0600 permissions, so a
// developer install works without ceremony while still never hard-coding a secret.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PIE_DATA_DIR
  ? path.resolve(process.cwd(), process.env.PIE_DATA_DIR)
  : path.resolve(__dirname, '../data');
const KEY_FILE = path.join(DATA_DIR, '.token-key');

let KEY = null;

function loadKey() {
  if (KEY) return KEY;
  const fromEnv = (process.env.TOKEN_ENCRYPTION_KEY || '').trim();
  if (fromEnv.length >= 32) {
    KEY = crypto.createHash('sha256').update(fromEnv).digest();
    return KEY;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(KEY_FILE)) {
      KEY = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
      if (KEY.length === 32) return KEY;
    }
    const generated = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, generated.toString('base64'), { mode: 0o600 });
    KEY = generated;
  } catch {
    // Last resort: an ephemeral key. Tokens then do not survive a restart, which
    // is safe — the candidate simply reconnects GitHub.
    KEY = crypto.randomBytes(32);
  }
  return KEY;
}

/** Returns an opaque string safe to persist. Never returns the plaintext. */
export function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/** Returns null rather than throwing, so a rotated key degrades to "reconnect". */
export function decryptSecret(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('v1.')) return null;
  try {
    const [, ivB, tagB, dataB] = payload.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** For logs and audit entries: proves a token existed without revealing it. */
export const fingerprint = v =>
  (v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 8) : null);
