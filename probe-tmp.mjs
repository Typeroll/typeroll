import { chromium } from 'playwright';
const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage();
const reqs = [];
p.on('requestfinished', async r => {
  const u = r.url();
  if (u.includes('autopilot.se') || u.includes('hubs')) {
    const res = await r.response();
    reqs.push(`${r.method()} ${u.slice(0,110)} -> ${res ? res.status() : '?'}`);
  }
});
p.on('console', m => { if (m.type()==='error') reqs.push('CONSOLE ERROR: '+m.text().slice(0,160)); });
await p.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
await p.waitForTimeout(4000);
const frame = p.frames().find(f => f !== p.mainFrame());
const out = frame ? await frame.evaluate(() => {
  const m = document.querySelector('.tr-extension-mount');
  if (!m) return { found: false };
  return {
    found: true,
    text: (m.innerText || '').replace(/\s+/g,' ').slice(0, 700),
    inputs: [...m.querySelectorAll('input,select,textarea')].map(e => e.name || e.id || e.type),
    buttons: [...m.querySelectorAll('button')].map(e => (e.textContent||'').trim()).slice(0,6),
    labels: [...m.querySelectorAll('label')].map(e => (e.textContent||'').trim()).slice(0,20),
  };
}) : { found: false, note: 'no child frame' };
console.log(JSON.stringify({ network: reqs, mount: out }, null, 1));
await b.close();
