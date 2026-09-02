// PIE — full UI regression walk.
// Drives the real built app in a real browser: landing → register → candidate
// journey → recruiter journey → admin → demo. Fails loudly on any console error.
//
//   node uiwalk.mjs

import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.PIE_UI_BASE || 'http://localhost:5174';
const SHOTS = new URL('./shots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });

const tag = Math.random().toString(36).slice(2, 7);
const results = [];
let stepNo = 0;

const ok = (name, detail = '') => { results.push({ ok: true, name, detail }); console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`); };
const fail = (name, detail) => { results.push({ ok: false, name, detail }); console.log(`  ✗ ${name} — ${detail}`); };

async function step(page, name, fn) {
  stepNo += 1;
  try { const d = await fn(); ok(`${String(stepNo).padStart(2, '0')} ${name}`, d || ''); }
  catch (e) { fail(`${String(stepNo).padStart(2, '0')} ${name}`, e.message.split('\n')[0]); await shot(page, `fail-${stepNo}`); }
}

const shot = (page, name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false }).catch(() => {});

const errors = [];
// A 401 that the walk deliberately provokes (the wrong-password check) is the
// system working, not a defect. Everything else is recorded.
let expecting401 = false;
const isExpected = t => expecting401 && /401|Unauthorized/i.test(t);

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !isExpected(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));

  /* ───────────────────────────────────────────────────────────── LANDING */
  console.log('\nLANDING');
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await step(page, 'four role cards, no demo personas on first paint', async () => {
    const cards = await page.locator('.rolecard').allTextContents();
    if (cards.length !== 4) throw new Error(`expected 4 cards, saw ${cards.length}`);
    const body = await page.locator('body').innerText();
    for (const persona of ['Meera', 'Farah', 'Arjun', 'Nikhil', 'Ananya']) {
      if (body.includes(persona)) throw new Error(`persona "${persona}" leaked onto the landing page`);
    }
    return cards.map(c => c.split('\n')[0]).join(' | ');
  });

  await step(page, 'theme toggles and persists across a reload', async () => {
    await page.locator('.entry__theme button, .entry__theme').first().click();
    await page.waitForTimeout(250);
    const dark = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.reload({ waitUntil: 'networkidle' });
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (dark !== after) throw new Error(`theme did not persist (${dark} → ${after})`);
    await shot(page, 'w-landing-dark');
    if (after === 'dark') await page.locator('.entry__theme button, .entry__theme').first().click();
    return `persisted as ${after}`;
  });

  /* ──────────────────────────────────────────────────────── REGISTRATION */
  console.log('\nCANDIDATE REGISTRATION');
  const cand = { user: `walk${tag}`, email: `walk${tag}@example.test`, pass: `Str0ng-${tag}` };

  await step(page, 'candidate card opens the register form', async () => {
    await page.getByRole('button', { name: /^Create account$/ }).first().click();
    await page.waitForTimeout(400);
    await page.waitForSelector('input[name="username"], input[placeholder*="sername" i]', { timeout: 4000 });
    return 'register form visible';
  });

  await step(page, 'registration creates a real account and signs in', async () => {
    const fill = async (sel, v) => { const l = page.locator(sel).first(); if (await l.count()) await l.fill(v); };
    await fill('input[name="name"]', `Walk Tester ${tag}`);
    await fill('input[name="username"]', cand.user);
    await fill('input[name="email"]', cand.email);
    await fill('input[name="password"]', cand.pass);
    await fill('input[name="confirmPassword"]', cand.pass);
    await page.getByRole('button', { name: /continue|create account|sign up/i }).last().click();
    await page.waitForTimeout(900);
    // Step 2 (career profile) is skippable.
    const skip = page.getByRole('button', { name: /skip|finish|go to dashboard|start/i }).first();
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(900); }
    await page.waitForSelector('.shell', { timeout: 8000 });
    return 'signed in to the app shell';
  });

  await step(page, 'a real account is badged as signed in, not as a demo persona', async () => {
    const nav = await page.locator('.nav').innerText();
    if (/Demo persona/i.test(nav)) throw new Error('a real account was badged as a demo persona');
    if (!/Signed in/i.test(nav)) throw new Error('the signed-in badge is missing');
    return nav.split('\n').slice(0, 3).join(' / ');
  });

  await step(page, 'a real account starts empty — no demo data bleeds in', async () => {
    const body = await page.locator('.content').innerText();
    for (const persona of ['Meera', 'Farah', 'Arjun']) {
      if (body.includes(persona)) throw new Error(`demo persona "${persona}" visible to a real account`);
    }
    await shot(page, 'w-candidate-empty');
    return 'empty state, no demo bleed';
  });

  /* ───────────────────────────────────────────────────── CANDIDATE PATHS */
  console.log('\nCANDIDATE JOURNEY');
  const navItems = await page.locator('.nav__item').allTextContents();
  ok(`   candidate navigation: ${navItems.map(t => t.trim()).join(' · ')}`);

  for (const label of navItems.map(t => t.trim().replace(/\d+$/, '').trim())) {
    await step(page, `candidate view "${label}" renders`, async () => {
      await page.locator('.nav__item', { hasText: label }).first().click();
      await page.waitForTimeout(600);
      const txt = await page.locator('.content').innerText();
      if (/^\s*$/.test(txt)) throw new Error('the view rendered empty');
      if (/undefined|NaN|\[object Object\]/.test(txt)) throw new Error('a raw value leaked into the UI');
      return `${txt.trim().split('\n')[0].slice(0, 48)}…`;
    });
  }

  await step(page, 'GitHub connect states its real mode and never fakes a login', async () => {
    const evidenceNav = page.locator('.nav__item', { hasText: /evidence/i }).first();
    if (await evidenceNav.count()) { await evidenceNav.click(); await page.waitForTimeout(600); }
    const body = await page.locator('.content').innerText();
    if (/password/i.test(body) && /github/i.test(body))
      throw new Error('the UI appears to ask for a GitHub password');
    await shot(page, 'w-github');
    return /demo/i.test(body) ? 'demo mode disclosed in the UI' : 'connect flow present';
  });

  await step(page, 'sign out returns to the landing page', async () => {
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForTimeout(700);
    const cards = await page.locator('.rolecard').count();
    if (cards !== 4) throw new Error('sign out did not return to the four-card entry');
    return 'back at the entry';
  });

  /* ───────────────────────────────────────────────────────── REAL LOGIN */
  console.log('\nSIGN IN');
  await step(page, 'sign in with the username', async () => {
    await page.getByRole('button', { name: /^Sign in$/ }).first().click();
    await page.waitForTimeout(400);
    await page.locator('input[name="identifier"]').first().fill(cand.user);
    await page.locator('input[name="password"]').first().fill(cand.pass);
    await page.getByRole('button', { name: /^sign in$/i }).last().click();
    await page.waitForSelector('.shell', { timeout: 8000 });
    return 'username sign-in works';
  });

  await step(page, 'a wrong password shows a message that reveals nothing', async () => {
    expecting401 = true;
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /^Sign in$/ }).first().click();
    await page.waitForTimeout(300);
    await page.locator('input[name="identifier"]').first().fill(cand.user);
    await page.locator('input[name="password"]').first().fill('definitely-wrong');
    await page.getByRole('button', { name: /^sign in$/i }).last().click();
    await page.waitForTimeout(900);
    const msg = await page.locator('.alert, [role="alert"]').first().innerText().catch(() => '');
    if (!msg) throw new Error('no error message was shown');
    if (/not found|no such user|unknown user|wrong password/i.test(msg))
      throw new Error(`the message discloses account existence: "${msg}"`);
    expecting401 = false;
    return `"${msg.trim().replace(/\n/g, ' ').slice(0, 60)}"`;
  });

  /* ──────────────────────────────────────────────────────────────── DEMO */
  console.log('\nDEMO WORLD');
  await step(page, 'the demo door lists curated personas', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /enter demo|explore|grand finale/i }).first().click();
    await page.waitForTimeout(800);
    const body = await page.locator('body').innerText();
    if (!/Meera|Farah|Arjun/.test(body)) throw new Error('no personas offered behind the demo door');
    await shot(page, 'w-demo-picker');
    return 'personas listed only here';
  });

  await step(page, 'entering as a demo persona loads the curated world', async () => {
    await page.locator('button, .rolecard, .personacard').filter({ hasText: /Meera/ }).first().click();
    await page.waitForSelector('.shell', { timeout: 8000 });
    const nav = await page.locator('.nav').innerText();
    if (!/Demo persona/i.test(nav)) throw new Error('a demo session must be badged as one');
    const body = await page.locator('.content').innerText();
    if (body.includes(cand.user)) throw new Error('a real account leaked into the demo world');
    await shot(page, 'w-demo-candidate');
    return 'badged, isolated';
  });

  await step(page, 'the full orchestrator run completes end to end', async () => {
    const run = page.locator('.nav__item', { hasText: /orchestrat|match|opportunit/i }).first();
    if (await run.count()) { await run.click(); await page.waitForTimeout(800); }
    const btn = page.getByRole('button', { name: /run|orchestrate|analyse|analyze/i }).first();
    if (!(await btn.count())) return 'no run control on this view (skipped)';
    await btn.click();
    await page.waitForTimeout(4000);
    const body = await page.locator('.content').innerText();
    if (/error|could not complete/i.test(body) && !/no error/i.test(body))
      throw new Error('the run surfaced an error');
    await shot(page, 'w-run');
    return 'run completed';
  });

  await step(page, 'demo sign out, then a recruiter persona', async () => {
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /enter demo|explore|grand finale/i }).first().click();
    await page.waitForTimeout(700);
    await page.locator('button, .rolecard, .personacard').filter({ hasText: /Ananya/ }).first().click();
    await page.waitForSelector('.shell', { timeout: 8000 });
    const items = await page.locator('.nav__item').allTextContents();
    await shot(page, 'w-demo-recruiter');
    return items.map(t => t.trim()).join(' · ');
  });

  const recruiterViews = await page.locator('.nav__item').allTextContents();
  for (const label of recruiterViews.map(t => t.trim().replace(/\d+$/, '').trim())) {
    await step(page, `recruiter view "${label}" renders`, async () => {
      await page.locator('.nav__item', { hasText: label }).first().click();
      await page.waitForTimeout(700);
      const txt = await page.locator('.content').innerText();
      if (/undefined|NaN|\[object Object\]/.test(txt)) throw new Error('a raw value leaked into the UI');
      return `${txt.trim().split('\n')[0].slice(0, 48)}…`;
    });
  }

  /* ──────────────────────────────────────────────── TABBED PANELS
     Nav items are not the whole app. Every tab inside the candidate profile is
     a separate component tree that only mounts when its tab is selected, and a
     walk that never clicks them cannot see them fail.

     This is not hypothetical: the Decision tab shipped white-screening because
     a component there used <Skeleton> without importing it. The build passed —
     an undefined identifier is only a ReferenceError at runtime — every nav
     view still rendered, and 38/38 checks were green. It was found by a person
     clicking the tab. */
  await step(page, 'a candidate profile opens from the pool', async () => {
    await page.locator('.nav__item', { hasText: /candidate pool/i }).first().click();
    await page.waitForTimeout(900);
    const open = page.locator('table.dt tbody tr button').first();
    await open.waitFor({ timeout: 8000 });
    await open.click();
    await page.waitForTimeout(2000);
    return (await page.locator('h2').first().innerText()).trim();
  });

  await step(page, 'every tab in the candidate profile mounts without crashing', async () => {
    // The tabs only exist once a run has produced a result.
    const run = page.getByRole('button', { name: /re-?run orchestrator|run orchestrator/i }).first();
    if (await run.count()) { await run.click(); await page.waitForTimeout(8000); }

    const labels = (await page.locator('.tabs [role=tab]').allTextContents()).map(t => t.trim());
    if (labels.length < 3) throw new Error(`only ${labels.length} tab(s) found — the run did not complete`);

    const broken = [];
    for (const label of labels) {
      const before = errors.length;
      await page.locator('.tabs [role=tab]', { hasText: label.split(/\s+/)[0] }).first().click();
      await page.waitForTimeout(1100);

      const txt = await page.locator('[role=tabpanel]').innerText().catch(() => '');
      // A crashed panel renders nothing; React unmounts the whole subtree.
      if (txt.trim().length < 40) broken.push(`${label}: rendered ${txt.trim().length} characters`);
      if (errors.length > before) broken.push(`${label}: ${errors[errors.length - 1].slice(0, 80)}`);
      if (/undefined|NaN|\[object Object\]/.test(txt)) broken.push(`${label}: a raw value leaked into the UI`);
    }
    if (broken.length) throw new Error(broken.join(' | '));
    return `${labels.length} tabs: ${labels.map(l => l.split(/\s+/)[0]).join(', ')}`;
  });

  /* ─────────────────────────────────────────────────────── RESPONSIVE */
  console.log('\nRESPONSIVE + ACCESSIBILITY');
  for (const [w, h, name] of [[1440, 900, 'desktop'], [1024, 800, 'laptop'], [768, 900, 'tablet'], [390, 844, 'phone']]) {
    await step(page, `layout holds at ${w}×${h} (${name})`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 4) throw new Error(`${overflow}px of horizontal overflow`);

      // Body overflow alone misses the more common failure: content pushed
      // past the right edge and clipped by an ancestor that scrolls vertically.
      // The assessment stepper was cut off mid-word on a phone for exactly this
      // reason, and a scrollWidth check on containers could not see it — the
      // clipping ancestor was the main scroll area.
      //
      // So: look at what the user can actually read. Any element with its own
      // visible text whose right edge is past the viewport is unreachable.
      const clipped = await page.evaluate(() => {
        const nav = document.querySelector('aside.nav');   // legitimately off-canvas on small screens
        const out = [];
        // Content inside a horizontal scroller is reachable, so it is not
        // clipped — it is scrolled. Without this the tab strip, which scrolls
        // by design, reported every tab past the fold as a layout fault.
        const inScroller = el => {
          for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
            const ox = getComputedStyle(n).overflowX;
            if (ox === 'auto' || ox === 'scroll') return true;
          }
          return false;
        };

        for (const el of document.querySelectorAll('span, b, td, th, h1, h2, h3, label, button, a, p')) {
          if (nav?.contains(el)) continue;
          if (el.closest('[aria-hidden="true"], [hidden]')) continue;
          if (inScroller(el)) continue;
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
          const text = (el.textContent || '').trim();
          if (!text) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right > window.innerWidth + 1) {
            out.push(`"${text.slice(0, 24)}" runs ${Math.round(r.right - window.innerWidth)}px past the right edge`);
          }
        }
        return [...new Set(out)].slice(0, 3);
      });
      if (clipped.length) throw new Error(`content clipped inside: ${clipped.join('; ')}`);

      await shot(page, `w-${name}`);
      return 'nothing clipped or overflowing';
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await step(page, 'every screen exposes exactly one h1 and no unlabelled control', async () => {
    const inApp = await page.locator('h1').count();
    if (inApp !== 1) throw new Error(`the app shell has ${inApp} h1 elements, expected 1`);
    await page.getByRole('button', { name: /sign out/i }).first().click();
    await page.waitForTimeout(700);
    const h1 = await page.locator('h1').count();
    if (h1 !== 1) throw new Error(`the entry page has ${h1} h1 elements, expected 1`);
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label')).length);
    if (unlabelled) throw new Error(`${unlabelled} button(s) with no accessible name`);
    return 'one h1 per screen, every button named';
  });

  /* ────────────────────────────────────────────────────────────── DONE */
  await browser.close();

  const passed = results.filter(r => r.ok).length;
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`  ${passed}/${results.length} checks passed`);
  if (errors.length) {
    console.log(`  ${errors.length} console error(s):`);
    [...new Set(errors)].slice(0, 8).forEach(e => console.log(`    · ${e.slice(0, 140)}`));
  } else {
    console.log('  0 console errors');
  }
  console.log(`${'─'.repeat(66)}\n`);
  process.exit(passed === results.length && errors.length === 0 ? 0 : 1);
})();
