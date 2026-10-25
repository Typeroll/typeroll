const qa = require('./browser.cjs');
const [origin, out, paths, ...args] = process.argv.slice(2);
(async () => {
  const browser = await qa.chromium.launch();
  const report = [];
  try {
    for (const route of paths.split(',')) {
      const url = new URL(route, origin);
      if (url.origin !== new URL(origin).origin) throw Error('Paths must stay on the selected origin');
      for (const width of qa.widths(args)) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const failed = [];
        page.on('requestfailed', r => failed.push({ host: new URL(r.url()).hostname, kind: 'network' }));
        page.on('response', r => { if (r.status() >= 400) failed.push({ host: new URL(r.url()).hostname, status: r.status() }); });
        await qa.open(page, url.href); await qa.settle(page);
        const result = { path: route, width, ...await qa.inspect(page), failed };
        const name = require('node:crypto').createHash('sha256').update(route).digest('hex').slice(0, 12);
        await qa.screenshot(page, `${out}/${name}-${width}.png`);
        report.push(result);
        await page.close();
      }
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.some(r => r.overflow || r.incompleteImages.length || r.h1 !== 1 || r.failed.length || !r.scrollCoverageComplete)) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(qa.fail);
