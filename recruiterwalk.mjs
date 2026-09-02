// PIE — recruiter question authoring walk.
//
// Covers the decision PIE hands back to the recruiter: whose questions a
// candidate is asked. Writes a question, checks a bad one is refused with a
// reason the author can act on, and switches modes.
//
//   node recruiterwalk.mjs

import { chromium } from 'playwright';

const BASE = process.env.PIE_UI_BASE || 'http://localhost:5174';
const res = [];
const check = async (n, fn) => {
  try { const d = await fn(); res.push(1); console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); }
  catch (e) { res.push(0); console.log(`  ✗ ${n} — ${e.message.split('\n')[0]}`); }
};

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 } });
const page = await ctx.newPage();
// The walk deliberately submits an invalid question, so one 400 is the system
// working. Everything else is recorded.
let expecting400 = false;
const errors = [];
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (expecting400 && /400|Bad Request/i.test(m.text())) return;
  errors.push(m.text());
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /demo|explore/i }).first().click().catch(() => {});
await page.waitForTimeout(700);
const rec = page.getByText(/ananya/i).first();
if (await rec.count()) { await rec.click(); await page.waitForTimeout(1100); }

await check('recruiter signed in', async () => {
  await page.locator('.nav__item', { hasText: /requisition/i }).first().waitFor({ timeout: 8000 });
  return 'recruiter workspace reached';
});

await check('a requisition opens', async () => {
  await page.locator('.nav__item', { hasText: /requisitions/i }).first().click();
  await page.waitForTimeout(1400);
  // Exact match: /open/i also hits "Open requisition" and other labels.
  await page.getByRole('button', { name: /^open$/i }).first().click();
  await page.locator('.modegrid').waitFor({ timeout: 10000 });
  return (await page.locator('h2').first().innerText()).trim();
});

await check('the three assessment modes are offered with their trade-offs', async () => {
  await page.locator('.modegrid').waitFor({ timeout: 8000 });
  const n = await page.locator('.modecard').count();
  if (n !== 3) throw new Error(`${n} modes, expected 3`);
  const only = page.locator('.modecard', { hasText: /Only my questions/i }).first();
  // With no authored questions this mode must be blocked, not silently broken.
  if (!await only.isDisabled()) throw new Error('"Only my questions" was selectable with an empty question set');
  const text = await page.locator('.modegrid').innerText();
  if (!/Depends on a working AI provider/i.test(text)) throw new Error('the AI mode does not state its dependency');
  return '3 modes, recruiter-only correctly blocked while empty';
});

await check('a question with a broken answer key is refused with a usable reason', async () => {
  expecting400 = true;
  await page.getByRole('button', { name: /add a question/i }).first().click();
  await page.waitForTimeout(500);
  await page.locator('#q-skill').fill('sql');
  await page.locator('#q-prompt').fill('Which clause limits the rows a window function sees within its partition?');
  // Two identical options: more than one correct answer, or a dead distractor.
  const opts = page.locator('.card__body input.input[placeholder^="Option"]');
  await opts.nth(0).fill('ROWS BETWEEN');
  await opts.nth(1).fill('ROWS BETWEEN');
  await opts.nth(2).fill('GROUP BY');
  await opts.nth(3).fill('HAVING');
  await page.locator('#q-explain').fill('The frame clause limits the rows visible inside each partition.');
  await page.getByRole('button', { name: /^add question$/i }).click();
  await page.waitForTimeout(1200);
  const msg = await page.locator('.toast, [role=alert], .notice').allInnerTexts();
  const joined = msg.join(' ');
  if (!/same|duplicate|option/i.test(joined)) throw new Error(`no usable reason shown: ${joined.slice(0, 120)}`);
  expecting400 = false;
  return 'duplicate options rejected, reason shown to the author';
});

await check('a valid question is accepted and listed', async () => {
  const opts = page.locator('.card__body input.input[placeholder^="Option"]');
  await opts.nth(1).fill('RANGE BETWEEN');
  await page.getByRole('button', { name: /^add question$/i }).click();
  await page.waitForTimeout(1500);
  const rows = await page.locator('table.dt tbody tr').count();
  if (!rows) throw new Error('the question list is still empty');
  const listed = await page.getByText(/window function sees within its partition/i).count();
  if (!listed) throw new Error('the question was accepted but is not listed');
  return `${rows} question(s) in the set`;
});

await check('"Only my questions" unlocks once a question exists', async () => {
  const only = page.locator('.modecard', { hasText: /Only my questions/i }).first();
  if (await only.isDisabled()) throw new Error('still blocked after adding a question');
  await only.click();
  await page.waitForTimeout(1400);
  const on = await page.locator('.modecard--on').innerText();
  if (!/Only my questions/i.test(on)) throw new Error('the mode did not switch');
  const warned = await page.getByText(/smaller than a full paper|shorter/i).count();
  if (!warned) throw new Error('a one-question set was accepted without warning the recruiter');
  return 'switched, and the short-set trade-off is stated';
});

await check('the walk leaves the requisition as it found it', async () => {
  // A walk that reconfigures a shared demo server is a walk that breaks the next
  // one: leaving this requisition on "Only my questions" gave the candidate walk
  // a paper with no coding question, and it looked like a paste-blocking bug.
  const ai = page.locator('.modecard', { hasText: /AI-generated from the job description/i }).first();
  await ai.click();
  await page.waitForTimeout(1400);
  const on = await page.locator('.modecard--on').innerText();
  if (!/AI-generated/i.test(on)) throw new Error('the mode was not restored');
  return 'mode restored to AI-generated';
});

console.log(`\n  ${res.filter(Boolean).length}/${res.length} checks passed`);
console.log(`  ${errors.length} console errors`);
if (errors.length) errors.slice(0, 4).forEach(e => console.log('    ! ' + e.slice(0, 150)));
await browser.close();
process.exit(res.every(Boolean) ? 0 : 1);
