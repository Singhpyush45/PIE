// PIE — administrator (Trust & Integrity) UI walk.
// Usage: ADMIN_PASSWORD=... node adminwalk.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:5174';
const PW = process.env.ADMIN_PW;
if (!PW) { console.error('set ADMIN_PW'); process.exit(1); }

const errors = [];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
p.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

await p.goto(BASE, { waitUntil: 'networkidle' });

// Trust & Integrity offers sign-in only — never a "create account" button.
const adminCard = p.locator('.rolecard').filter({ hasText: /Trust & Integrity/ });
const actions = await adminCard.locator('button').allTextContents();
console.log('admin card actions:', actions.join(' | '));
if (actions.some(a => /create/i.test(a))) { console.log('FAIL: admin is self-registerable'); process.exit(1); }

await adminCard.locator('button').first().click();
await p.waitForTimeout(400);
const panel = await p.locator('.entry__panel, form').first().innerText();
console.log('provisioning notice shown:', /provisioned|server console/i.test(panel));

await p.locator('input[name="identifier"]').fill('admin');
await p.locator('input[name="password"]').fill(PW);
await p.getByRole('button', { name: /^sign in$/i }).last().click();
await p.waitForSelector('.shell', { timeout: 8000 });
console.log('admin signed in ✓');

const views = await p.locator('.nav__item').allTextContents();
console.log('admin navigation:', views.map(v => v.trim()).join(' · '));

for (const label of views.map(t => t.trim().replace(/\d+$/, '').trim())) {
  await p.locator('.nav__item', { hasText: label }).first().click();
  await p.waitForTimeout(700);
  const txt = await p.locator('.content').innerText();
  const bad = /undefined|NaN|\[object Object\]/.test(txt);
  console.log(`  ${bad ? '✗' : '✓'} ${label} — ${txt.trim().split('\n')[0].slice(0, 50)}`);
}
await p.screenshot({ path: new URL('./shots/w-admin.png', import.meta.url).pathname });

// The generated password must never be rendered anywhere in the app.
const whole = await p.locator('body').innerText();
console.log('password absent from the UI:', !whole.includes(PW));

console.log(errors.length ? `console errors: ${[...new Set(errors)].join(' | ')}` : 'console errors: 0');
await b.close();
