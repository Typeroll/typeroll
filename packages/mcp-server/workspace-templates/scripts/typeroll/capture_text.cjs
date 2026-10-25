// Explicit selector avoids silently excluding the wrong column/sidebar.
const qa = require('./browser.cjs');
const fs = require('node:fs/promises');
const [url, out, selector = 'main'] = process.argv.slice(2);
(async () => {
  const browser = await qa.chromium.launch();
  try {
    const page = await browser.newPage();
    await qa.open(page, url); await qa.settle(page);
    const target = page.locator(selector);
    if (await target.count() !== 1) throw Error('Select exactly one content region');
    const value = await target.evaluate(el => ({ text: el.innerText,
      images: [...el.querySelectorAll('img')].map(i => ({ alt: i.alt, path: new URL(i.currentSrc || i.src, location.href).pathname })) }));
    await fs.mkdir(require('node:path').dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(value, null, 2));
  } finally { await browser.close(); }
})().catch(qa.fail);
