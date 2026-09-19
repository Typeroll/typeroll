import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
test.use({ javaScriptEnabled: false });

test('CTA links wrap and preserve browsing context and destination without JavaScript', async ({ page, context }, info) => {
  const registry = buildCoreBlockRegistry();
  const href = '/offers/?partner=example&market=se#start';
  const blocks: Block[] = [
    { id: 'new-tab', type: 'core/button', data: { label: 'Compare moving offers in a new tab', href, new_tab: true } },
    { id: 'same-tab', type: 'core/button', data: { label: 'Continue here', href, new_tab: false } },
    { id: 'long-label', type: 'core/button', data: { label: 'A very long descriptive button label ' + 'LongDestination'.repeat(10), href } },
  ];
  const html = `<!doctype html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;padding:20px;font:16px/1.5 sans-serif}${collectBlockAssets(blocks, registry).css}</style><main>${renderBlocks(blocks, { registry })}</main>`;
  await context.route('https://cta.example.test/**', route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/' ? html : '<h1>Local destination fixture</h1>' }));
  await page.goto('https://cta.example.test/');
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    expect(await page.locator('html').evaluate(el => el.scrollWidth)).toBe(width);
    for (const link of await page.locator('a').all()) {
      const box = (await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(20);
      expect(box.x + box.width).toBeLessThanOrEqual(width - 20);
    }
    if (width === 390) await page.screenshot({ path: info.outputPath('cta-mobile.png'), fullPage: true });
  }
  const [popup] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Compare moving offers in a new tab' }).click()]);
  await popup.waitForURL('https://cta.example.test/offers/?partner=example&market=se#start');
  expect(page.url()).toBe('https://cta.example.test/');
  expect(await page.getByRole('link', { name: 'Compare moving offers in a new tab' }).getAttribute('rel')).toBe('noopener noreferrer');
  await popup.close();
  await page.getByRole('link', { name: 'Continue here' }).click();
  await expect(page).toHaveURL('https://cta.example.test/offers/?partner=example&market=se#start');
  expect(context.pages()).toHaveLength(1);
});
