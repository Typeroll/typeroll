const qa = require('./browser.cjs');
const [out, url, ...args] = process.argv.slice(2);
(async () => {
  const browser = await qa.chromium.launch();
  try {
    for (const width of qa.widths(args)) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const hosts = new Set();
      page.on('request', r => { try { hosts.add(new URL(r.url()).hostname); } catch {} });
      await qa.open(page, url); await qa.settle(page);
      await qa.screenshot(page, `${out}-${width}.png`);
      console.log(JSON.stringify({ width, ...await qa.inspect(page), hosts: [...hosts] }));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(qa.fail);
