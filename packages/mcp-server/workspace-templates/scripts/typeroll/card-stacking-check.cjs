// Check every whole-card target, including excerpt/media/meta, without navigating.
const qa = require('./browser.cjs');
const [url, width = '390'] = process.argv.slice(2);
(async () => {
  const browser = await qa.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: qa.widths([width])[0], height: 900 } });
    await qa.open(page, url);
    const cards = page.locator('[data-block="post_card"][data-whole="true"]');
    const report = [];
    for (let index = 0; index < await cards.count(); index++) {
      const card = cards.nth(index);
      await card.scrollIntoViewIfNeeded();
      report.push(await card.evaluate(card => {
        const link = card.querySelector('.block-postcard-title > a');
        const targets = [card, ...card.querySelectorAll('.block-postcard-excerpt,.block-postcard-meta,.block-postcard-media')];
        const hits = targets.filter(el => el.getBoundingClientRect().height > 0).map(el => {
          const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          return { part: el.className || 'card', inViewport: y >= 0 && y < innerHeight, linked: document.elementFromPoint(x, y)?.closest('a') === link };
        });
        return { block: card.dataset.blockId || card.dataset.bid || null, title: link?.textContent, hits };
      }));
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.length || report.some(r => r.hits.some(h => !h.inViewport || !h.linked))) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(qa.fail);
