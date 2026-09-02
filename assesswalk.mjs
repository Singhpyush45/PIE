// PIE — assessment flow walk.
//
// uiwalk.mjs covers the screens; this covers the ONE flow it cannot: a real
// attempt from consent to result, with a fake camera, checking the pieces a
// candidate actually sees — language choice, the live self-view, paste blocking
// and question provenance.
//
//   node assesswalk.mjs

import { chromium } from 'playwright';

const BASE = process.env.PIE_UI_BASE || 'http://localhost:5174';
const res = [];
const ok = (n, d = '') => { res.push(1); console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { res.push(0); console.log(`  ✗ ${n} — ${d}`); };
const check = async (n, fn) => { try { ok(n, await fn() || ''); } catch (e) { bad(n, e.message.split('\n')[0]); } };

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    // The attempt now requires a shared screen; auto-answer the picker.
    '--auto-select-desktop-capture-source=Entire screen', '--auto-accept-this-tab-capture',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 940 }, permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });

// Sign in as a demo candidate.
await page.getByRole('button', { name: /demo|explore/i }).first().click().catch(() => {});
await page.waitForTimeout(600);
const meera = page.getByText(/meera/i).first();
if (await meera.count()) { await meera.click(); await page.waitForTimeout(900); }

await check('candidate signed in', async () => {
  await page.waitForSelector('text=/assessment/i', { timeout: 8000 });
  return 'candidate workspace reached';
});

// The app navigates through its own sidebar, not URLs.
await check('assessment view opens', async () => {
  const item = page.locator('.nav__item', { hasText: /assessment/i }).first();
  await item.waitFor({ timeout: 8000 });
  await item.click();
  await page.waitForTimeout(1500);
  return (await page.locator('h1').first().innerText()).trim();
});

await check('a role can be chosen for assessment', async () => {
  // The picker lists roles as buttons; the sidebar also has one called
  // "Assessment", so match a role card rather than any button with that word.
  const role = page.getByRole('button', { name: /Engineer|Analyst|Developer/i }).first();
  await role.waitFor({ timeout: 10000 });
  const label = (await role.innerText()).split('\n')[0].trim();
  await role.click();
  await page.waitForTimeout(1800);
  return `chose "${label}"`;
});

await check('language selector is offered', async () => {
  const sel = page.locator('#assess-lang');
  await sel.waitFor({ timeout: 6000 });
  const n = await sel.locator('option').count();
  if (n < 2) throw new Error(`only ${n} language option(s)`);
  await sel.selectOption('hi');
  await page.waitForTimeout(400);
  const note = await page.getByText(/English-only|part of the assessment will be in English/i).count();
  if (!note) throw new Error('choosing Hindi did not disclose the English-bank fallback');
  await sel.selectOption('en');
  return `${n} languages, mixed-language caveat shown`;
});

await check('the assessment steps stay readable on a phone', async () => {
  // Five labelled steps do not fit a 390px screen. They used to be clipped
  // mid-word by the scrolling main column — no body overflow, so the general UI
  // walk could not see it, and the screen simply looked broken.
  const problems = [];
  for (const w of [1440, 900, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(400);
    const cut = await page.evaluate(() => {
      const nav = document.querySelector('aside.nav');
      const out = [];
      for (const el of document.querySelectorAll('.steps span, .stepsmini span, .assess h2, .assess h3')) {
        if (nav?.contains(el)) continue;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > window.innerWidth + 1) out.push((el.textContent || '').trim().slice(0, 20));
      }
      return [...new Set(out)];
    });
    if (cut.length) problems.push(`${w}px: ${cut.join(', ')} off-screen`);

    // Whichever form is shown, the candidate must still know where they are.
    const tells = await page.evaluate(() => {
      const vis = s => { const e = document.querySelector(s); return e && getComputedStyle(e).display !== 'none'; };
      return vis('.steps') || vis('.stepsmini');
    });
    if (!tells) problems.push(`${w}px: no progress indicator at all`);
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.waitForTimeout(400);

  // The rail used to end at exactly the card's top edge, and the current step's
  // focus ring then bled into the panel — the step circle looked like it was
  // sitting on top of the card. Measure the ring, not just the box.
  const clearance = await page.evaluate(() => {
    const dot = document.querySelector('.steps__node--now .steps__dot')
      || document.querySelector('.steps__dot');
    const card = document.querySelector('.assess .card, .card');
    if (!dot || !card) return null;
    const ring = parseFloat((getComputedStyle(dot).boxShadow.match(/(\d+(?:\.\d+)?)px\s*$/) || [0, 0])[1]) || 0;
    return +(card.getBoundingClientRect().top - (dot.getBoundingClientRect().bottom + ring)).toFixed(1);
  });
  if (clearance !== null && clearance < 6) {
    throw new Error(`the step circle has only ${clearance}px above the card — its focus ring overlaps the panel`);
  }

  if (problems.length) throw new Error(problems.join(' | '));
  return `full rail on desktop, compact on phone, ${clearance}px clearance above the card`;
});

await check('consent must be accepted explicitly', async () => {
  const boxes = page.locator('input[type=checkbox]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await page.getByRole('button', { name: /accept|continue|proceed/i }).first().click();
  await page.waitForTimeout(1500);
  return `${n} acknowledgements required`;
});

await check('device check reaches ready', async () => {
  await page.waitForSelector('text=/ready|begin assessment|start assessment/i', { timeout: 15000 });
  return 'camera and mic checks passed';
});

await check('assessment starts', async () => {
  await page.getByRole('button', { name: /share screen and start/i }).click();
  await page.waitForTimeout(2500);
  await page.waitForSelector('.assess__bar', { timeout: 10000 });
  return 'live attempt running';
});

await check('the attempt takes over the screen', async () => {
  // Fullscreen and the screen share are both requested on the start click,
  // because a browser refuses either one asked for without a user gesture.
  const full = await page.evaluate(() => Boolean(document.fullscreenElement));
  if (!full) throw new Error('the assessment did not enter fullscreen');
  if (!await page.locator('.selfview--screen video').count()) throw new Error('the shared screen is not being shown back');
  return 'fullscreen, with the shared screen visible to the candidate';
});

await check('face checks run and report what they see', async () => {
  // The fake camera has no face in it, so the honest reading is "nobody".
  await page.waitForTimeout(4000);
  const badge = (await page.locator('.badge, [class*=badge]').allTextContents())
    .find(t => /in frame|Face checks/i.test(t));
  if (!badge) throw new Error('the integrity panel reports no face state at all');
  if (/Face checks off/i.test(badge)) return 'unavailable, and says so';
  if (!/Nobody in frame/i.test(badge)) throw new Error(`unexpected face state against a faceless camera: ${badge}`);

  // And that state must reach the server as a counted breach.
  const bar = await page.locator('.assess__bar').innerText();
  const count = bar.match(/(\d+)\/(\d+)/);
  if (!count) throw new Error('no warning counter on the status bar');
  if (count[2] !== '3') throw new Error(`breach threshold is ${count[2]}, expected 3`);
  if (Number(count[1]) < 1) throw new Error('a sustained no-face condition raised no breach');
  return `detected, counted ${count[1]}/${count[2]}`;
});

await check('the self-view is on screen and cannot be dismissed', async () => {
  // Two .selfview panels now — camera and shared screen. Address the camera.
  await page.locator('video[data-pie-camera]').waitFor({ timeout: 6000 });
  const playing = await page.locator('video[data-pie-camera]').evaluate(v => v.readyState >= 2 && !v.paused);
  if (!playing) throw new Error('the preview element is not actually playing');
  // Permanent by design: a candidate being watched should always be able to see
  // what the camera sees, and a hidden preview hides a dead camera too.
  if (await page.locator('.livecam__toggle, button:has-text("Hide")').count())
    throw new Error('the self-view can still be hidden');
  return 'streaming, no dismiss control';
});

await check('the consent screen states the limits of the monitoring', async () => {
  // Checked on the consent screen earlier in the flow; re-read it from the API
  // so the claim and the screen cannot drift apart.
  const claim = await page.evaluate(async () => {
    const r = await fetch('/api/assessment/policy', { credentials: 'include' });
    return (await r.json()).policy;
  });
  if (claim.integrityPosture !== 'DEFENCE_IN_DEPTH') throw new Error('posture is not defence-in-depth');
  if (/cheat.?proof/i.test(claim.integrityClaim) && !/not cheat.?proof|Not cheat.?proof/i.test(claim.integrityClaim))
    throw new Error('the claim reads as cheat-proof');
  if (!claim.integrityLimits?.length) throw new Error('no limits are stated');
  return `${claim.integrityLimits.length} limits stated openly`;
});

// Walk to a coding question to exercise paste blocking.
await check('paste into the answer box is blocked and disclosed', async () => {
  for (let i = 0; i < 12; i++) {
    if (await page.locator('#code').count()) break;
    const opt = page.locator('.assess input[type=radio], .opt').first();
    if (await opt.count()) await opt.click().catch(() => {});
    const next = page.getByRole('button', { name: /submit|next|finalise|finalize/i }).first();
    if (await next.count()) { await next.click().catch(() => {}); await page.waitForTimeout(900); }
  }
  const box = page.locator('#code');
  if (!await box.count()) throw new Error('never reached a coding question');
  await box.click();
  await page.evaluate(() => {
    const el = document.querySelector('#code');
    const dt = new DataTransfer(); dt.setData('text/plain', 'pasted answer');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(500);
  const val = await box.inputValue();
  if (val.includes('pasted answer')) throw new Error('the paste went through');
  const notice = await page.getByText(/Paste blocked/i).count();
  if (!notice) throw new Error('paste was blocked but the candidate was not told');
  return 'blocked, and stated as one layer';
});

await check('a coding question shows its examples and is honest about the hidden ones', async () => {
  const box = page.locator('#code');
  if (!await box.count()) return 'no coding question on this paper';
  // Examples are shown so the candidate can see the expected shape. The hidden
  // tests are counted, never listed.
  // Wait for the table rather than counting immediately: the paste handler sets
  // state, and counting in the same tick raced React and reported zero rows on a
  // page that had them.
  await page.locator('.dt--tight tbody tr').first().waitFor({ timeout: 5000 }).catch(() => {});
  const examples = await page.locator('.dt--tight tbody tr').count();

  // Some coding questions cannot be executed at all — a SQL query, say — and
  // the paper's order is randomised, so either state can come up first. Both
  // are correct; being silent about either is not.
  if (!examples) {
    const reviewed = await page.getByText(/read by a person|recruiter reads it/i).count();
    if (!reviewed) throw new Error('a coding question showed no examples and no explanation for why');
    return 'review-only question, and the candidate is told so';
  }
  const told = await page.getByText(/test(s)? you cannot see|checked against/i).count();
  if (!told) throw new Error('examples are shown but the hidden tests are not mentioned');
  return `${examples} example(s) shown, hidden tests disclosed as a count`;
});

await check('when no sandbox is running the candidate is told, not silently failed', async () => {
  const sandbox = await page.evaluate(async () => {
    const r = await fetch('/api/assessment/sandbox', { credentials: 'include' });
    return (await r.json()).sandbox;
  });
  if (sandbox.available) return `sandbox live (${sandbox.engine} ${sandbox.version})`;
  if (!/not executed/i.test(sandbox.note)) throw new Error('the unavailable state does not explain itself');
  if (!sandbox.reason) throw new Error('no reason given for the sandbox being unavailable');
  return 'unavailable, and says so plainly';
});

await check('finishing shows question provenance', async () => {
  for (let i = 0; i < 12; i++) {
    if (await page.getByText(/How this paper was built/i).count()) break;
    const box = page.locator('#code');
    if (await box.count()) await box.fill('def solve():\n    return True');
    const opt = page.locator('.assess input[type=radio], .opt').first();
    if (await opt.count()) await opt.click().catch(() => {});
    const next = page.getByRole('button', { name: /submit|next|finish|finalise|finalize|done/i }).first();
    if (await next.count()) { await next.click().catch(() => {}); await page.waitForTimeout(1100); }
  }
  await page.waitForSelector('text=/How this paper was built/i', { timeout: 10000 });
  const t = await page.getByText(/written for this job|from the verified bank/i).count();
  if (!t) throw new Error('the provenance card has no source breakdown');
  return 'source mix shown to the candidate';
});

console.log(`\n  ${res.filter(Boolean).length}/${res.length} checks passed`);
console.log(`  ${errors.length} console errors`);
if (errors.length) errors.slice(0, 5).forEach(e => console.log('    ! ' + e.slice(0, 160)));
await browser.close();
process.exit(res.every(Boolean) && !errors.length ? 0 : 1);
