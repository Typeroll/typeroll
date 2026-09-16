import { test, expect } from '@playwright/test';
import {
  buildCoreBlockRegistry, collectBlockAssets, composePageWithTemplate,
  getPageTemplateStarter, prepareHeadingOutline, renderBlocks,
  type Block,
} from '@typeroll/shared';

function article(wideTable = false) {
  const body: Block[] = [
    { id: 'heading', type: 'core/heading', data: { text: 'Storage prices', level: 'h2' } },
    ...(wideTable ? [{ id: 'table', type: 'core/table', data: { rows: Array.from({ length: 8 }, (_, row) => ({
      cells: Array.from({ length: 12 }, (_, column) => ({ html: row === 0 ? `Monthly-price-${column}` : '1000 kr', header: row === 0 })),
    })) } }] : []),
    { id: 'long-body', type: 'core/prose', data: { html: '<p>Article content to scroll past.</p>'.repeat(60) } },
  ];
  const page = { title: 'Article', content_mode: 'blocks', blocks: body };
  const template = getPageTemplateStarter('article')!;
  template.find(block => block.type === 'core/columns')!.slots![1][0].data.sticky = true;
  const blocks = composePageWithTemplate(template, body);
  const registry = buildCoreBlockRegistry();
  const assets = collectBlockAssets(blocks, registry);
  const html = prepareHeadingOutline(renderBlocks(blocks, { registry, context: { page } })).html;
  return `<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:16px;font:16px/1.6 sans-serif}main{max-width:1100px;margin:auto}${assets.css}</style><main>${html}</main>`;
}

test('article outline stays in flow on mobile and sticky on desktop', async ({ page }) => {
  await page.setContent(article());
  const outline = page.locator('[data-block="table_of_contents"]');
  const column = outline.locator('..');
  for (const width of [390, 720, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => scrollTo(0, 0));
    expect(await outline.evaluate(el => getComputedStyle(el).position)).toBe(width <= 720 ? 'static' : 'sticky');
    expect(await column.evaluate(el => getComputedStyle(el).position)).toBe(width <= 720 ? 'static' : 'sticky');
    await page.evaluate(() => scrollTo(0, 700));
    const box = await outline.boundingBox();
    expect(box).not.toBeNull();
    if (width <= 720) expect(box!.y + box!.height).toBeLessThan(0);
    else expect(box!.y).toBeGreaterThanOrEqual(0);
  }
});

test('wide article tables scroll within their column without widening the page', async ({ page }) => {
  await page.setContent(article(true));
  for (const width of [320, 390, 720, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const scroller = page.locator('.block-table-scroll');
    expect(await scroller.evaluate(el => el.scrollWidth)).toBeGreaterThan(await scroller.evaluate(el => el.clientWidth));
    await scroller.evaluate(el => { el.scrollLeft = 150; });
    expect(await scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  }
});
