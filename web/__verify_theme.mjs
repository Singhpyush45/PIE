// Temporary logo verification (deleted after the run).
// Drives the running PIE server at :5174 over the DevTools protocol and checks
// the brand mark in both themes: the asset decodes, it still fills its original
// box, and the tile behind it takes the theme's surface colour.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:5174';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-cdp-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1600,900', '--remote-debugging-port=9334',
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject });
  ws.send(JSON.stringify({ id: n, method, params }));
});
async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
      const p = list.find(t => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}
ws = new WebSocket(await target());
await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
const logs = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text);
});

const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(name, Buffer.from(r.data, 'base64'));
};

const PROBE = `(() => {
  const css = getComputedStyle(document.documentElement);
  const out = { theme: document.documentElement.getAttribute('data-theme'),
    surface3: css.getPropertyValue('--surface-3').trim(), marks: [] };
  for (const sel of ['.nav__mark', '.entry__mark', '.examtop__mark'])
    for (const el of document.querySelectorAll(sel)) {
      const b = el.getBoundingClientRect(), s = getComputedStyle(el);
      const img = el.querySelector('img'), ib = img?.getBoundingClientRect();
      out.marks.push({ sel, box: [Math.round(b.width), Math.round(b.height)],
        at: [Math.round(b.x), Math.round(b.y)], radius: s.borderRadius, bg: s.backgroundColor,
        img: img ? { src: new URL(img.src).pathname, natural: [img.naturalWidth, img.naturalHeight],
          drawn: [Math.round(ib.width), Math.round(ib.height)], ok: img.complete && img.naturalWidth > 0 } : null,
        text: el.textContent.trim() });
    }
  return out;
})()`;
const clickText = t => `(() => { const el = [...document.querySelectorAll('button')]
  .find(b => b.textContent.trim().startsWith(${JSON.stringify(t)})); if (!el) return false; el.click(); return true; })()`;
const toggleTheme = `(() => { const b = [...document.querySelectorAll('button')]
  .find(b => (b.getAttribute('aria-label') || '').startsWith('Switch to')); if (!b) return false; b.click(); return true; })()`;

let bad = 0;
function report(where, p) {
  if (!p.marks.length) { console.log(`  ! ${where} [${p.theme}]: no brand mark found`); bad++; return; }
  for (const m of p.marks) {
    const fills = m.img && m.img.drawn[0] === m.box[0] && m.img.drawn[1] === m.box[1];
    const ok = m.img?.ok && fills && m.bg === p.surface3rgb && m.text === '';
    if (!ok) bad++;
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${where} [${p.theme}] ${m.sel} ${m.box.join('\u00d7')}`
      + ` at ${m.at.join(',')} r=${m.radius} bg=${m.bg} \u2190 --surface-3 ${p.surface3}`
      + ` | ${m.img?.src} ${m.img?.natural.join('\u00d7')} drawn ${m.img?.drawn.join('\u00d7')}`
      + (m.text ? ` | leftover text "${m.text}"` : ''));
  }
}
// --surface-3 is a hex token; compare against the computed rgb() the browser reports.
const asRgb = hex => { const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`; };
const probe = async () => { const p = await evaluate(PROBE); p.surface3rgb = asRgb(p.surface3); return p; };

await evaluate(`localStorage.setItem('pie-theme','light')`).catch(() => {});
await send('Page.navigate', { url: BASE });
await sleep(2500);
await evaluate(`localStorage.setItem('pie-theme','light')`);
await send('Page.reload'); await sleep(2200);

report('landing', await probe());
await shot('.shot-light-landing.png');
console.log(`  \u00b7 theme toggled: ${await evaluate(toggleTheme)}`);
await sleep(700);
report('landing', await probe());
await shot('.shot-dark-landing.png');

console.log(`  \u00b7 Enter demo: ${await evaluate(clickText('Enter demo'))}`);
await sleep(1200);
console.log(`  \u00b7 persona: ${await evaluate(`(() => { const b = document.querySelector('button.acct');
  if (!b) return null; b.click(); return b.querySelector('.acct__n')?.textContent.trim() || 'persona'; })()`)}`);
await sleep(3000);
report('app shell', await probe());
await shot('.shot-dark-shell.png');
console.log(`  \u00b7 theme toggled: ${await evaluate(toggleTheme)}`);
await sleep(700);
report('app shell', await probe());
await shot('.shot-light-shell.png');

console.log(`  \u00b7 root still mounted: ${await evaluate(`!!document.querySelector('#root').firstChild`)}`);
if (logs.length) { bad++; console.log('  \u2717 console errors:'); logs.forEach(l => console.log(`      ${l}`)); }
else console.log('  \u00b7 no console errors');

ws.close(); chrome.kill();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* chrome still holds it */ }
console.log(bad ? `\n${bad} problem(s)` : '\nBrand mark verified in both themes.');
process.exit(bad ? 1 : 0);
