// Temporary logo verification (deleted after the run).
// Drives the already-running PIE server at :5174 through Chrome DevTools
// Protocol: landing screen, then a demo sign-in to reach the app shell, and
// reports the rendered size/position of every brand mark it finds.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5174';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1600,900',
  '--remote-debugging-port=9333', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = async u => (await fetch(u)).json();

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params }));
});

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJSON('http://127.0.0.1:9333/json/list');
      const page = list.find(t => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

const url = await connect();
ws = new WebSocket(url);
await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};

await send('Page.enable');
await send('Runtime.enable');

const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(name, Buffer.from(r.data, 'base64'));
  return name;
};

/* Reports every brand mark on the page: its box, and whether the image inside
   it actually decoded (naturalWidth > 0 proves the asset resolved, not alt text). */
const PROBE = `(() => {
  const out = [];
  for (const sel of ['.nav__mark', '.entry__mark', '.examtop__mark']) {
    for (const el of document.querySelectorAll(sel)) {
      const b = el.getBoundingClientRect();
      const img = el.querySelector('img');
      const ib = img?.getBoundingClientRect();
      out.push({
        sel,
        box: [Math.round(b.width), Math.round(b.height)],
        at: [Math.round(b.x), Math.round(b.y)],
        radius: getComputedStyle(el).borderRadius,
        img: img ? { src: new URL(img.src).pathname, natural: [img.naturalWidth, img.naturalHeight],
                     rendered: [Math.round(ib.width), Math.round(ib.height)], complete: img.complete } : null,
        leftoverText: el.textContent.trim(),
      });
    }
  }
  return out;
})()`;

const clickByText = t => `(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(t)}));
  if (!el) return false; el.click(); return true;
})()`;

let failures = 0;
const report = (label, marks) => {
  if (!marks.length) { console.log(`  ! ${label}: no brand mark on this screen`); return; }
  for (const m of marks) {
    const ok = m.img && m.img.complete && m.img.natural[0] > 0
      && m.img.rendered[0] === m.box[0] && m.img.rendered[1] === m.box[1]
      && m.leftoverText === '';
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${label} ${m.sel} box ${m.box.join('×')} radius ${m.radius}` +
      (m.img ? ` — ${m.img.src} ${m.img.natural.join('×')} drawn ${m.img.rendered.join('×')}` : ' — NO IMG') +
      (m.leftoverText ? ` — leftover text "${m.leftoverText}"` : ''));
  }
};

await send('Page.navigate', { url: BASE });
await sleep(2500);
report('landing', await evaluate(PROBE));
await shot('.shot-logo-landing.png');

// Enter demo -> first persona, which lands in the authenticated shell (sidebar).
console.log(`  · Enter demo clicked: ${await evaluate(clickByText('Enter demo'))}`);
await sleep(1200);
const signedIn = await evaluate(`(() => {
  const b = document.querySelector('button.acct');
  if (!b) return null;
  b.click();
  return b.querySelector('.acct__n')?.textContent.trim() || 'persona';
})()`);
console.log(`  · persona: ${signedIn ?? 'none found'}`);
await sleep(3000);
report('app shell', await evaluate(PROBE));
await shot('.shot-logo-shell.png');

const consoleErrors = await evaluate(`window.__pieErrors ? window.__pieErrors.length : 0`);
console.log(`  · page still rendering: ${await evaluate(`!!document.querySelector('#root').firstChild`)}`);

ws.close();
chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still holds it */ }
console.log(failures ? `\n${failures} problem(s)` : '\nEvery brand mark renders the asset at its original box size.');
process.exit(failures ? 1 : 0);
