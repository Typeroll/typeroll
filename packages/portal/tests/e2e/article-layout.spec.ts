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

test('editorial headings, optional mobile outline and card defaults match their declared settings', async ({ page }, testInfo) => {
  const registry = buildCoreBlockRegistry();
  const blocks: Block[] = [
    { id: 'title', type: 'core/heading', data: { text: 'An editorial article title', level: 'h1', size: 'article', font_weight: '500' } },
    { id: 'heading', type: 'core/heading', data: { text: 'Packing electronics', level: 'h2', size: 'article', font_weight: '500' } },
    { id: 'outline', type: 'core/table_of_contents', data: { mobile_display: 'hidden', list_style: 'plain' } },
    { id: 'cards', type: 'core/repeater', data: { item_block: 'core/post_card', cols: { mobile: 1, tablet: 2, desktop: 3 },
      items: [1, 2, 3].map(id => ({ title: `Related ${id}`, image: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="${id * 300}"></svg>`, url: `/related-${id}` })),
      item_overrides: { show_date: false, show_excerpt: false },
    } },
  ];
  const html = prepareHeadingOutline(renderBlocks(blocks, { registry, context: { page: { content_mode: 'blocks', blocks: blocks.slice(0, 2) } } })).html;
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:16px;font:16px sans-serif}${collectBlockAssets(blocks, registry).css}</style><main>${html}</main>`);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator('h1').evaluate(el => getComputedStyle(el).fontWeight)).toBe('500');
    expect(await page.locator('h1').evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBe(width === 390 ? 28 : 40);
    expect(await page.locator('h2').evaluate(el => Number.parseFloat(getComputedStyle(el).fontSize))).toBe(width === 390 ? 24 : 32);
    const outline = page.locator('[data-block="table_of_contents"]');
    if (width === 390) await expect(outline).toBeHidden();
    else { await expect(outline).toBeVisible(); expect(await outline.locator('ol').evaluate(el => getComputedStyle(el).listStyleType)).toBe('none'); }
    const cards = await page.locator('[data-block="post_card"]').all();
    const boxes = await Promise.all(cards.map(card => card.boundingBox()));
    expect(boxes.every(Boolean)).toBe(true);
    if (width === 390) expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y);
    else expect(boxes[1]!.y).toBe(boxes[0]!.y);
    const heights = await page.locator('[data-block="post_card"] img').evaluateAll(images => images.map(image => image.getBoundingClientRect().height));
    expect(heights).toHaveLength(3);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`article-migration-settings-${width}.png`), fullPage: true });
  }
});

test('article rhythm separates media and headings in the body slot', async ({ page }) => {
  const registry = buildCoreBlockRegistry();
  const body: Block[] = [
    { id: 'video', type: 'core/html', data: { html: '<div class="video-placeholder" style="height:250px;background:#ddd">Video</div>' } },
    { id: 'h', type: 'core/heading', data: { text: 'After the video', level: 'h2', size: 'article' } },
    { id: 'p', type: 'core/prose', data: { html: '<p>First paragraph</p>' } },
  ];
  const blocks = composePageWithTemplate([{ id: 'body', type: 'template_content_slot', data: { rhythm: 'article' } }], body);
  const assets = collectBlockAssets(blocks, registry);
  await page.setContent(`<style>body{margin:16px;font:16px sans-serif}${assets.css}</style>${renderBlocks(blocks, { registry })}`);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    const video = await page.locator('.video-placeholder').boundingBox();
    const heading = await page.locator('h2').boundingBox();
    const paragraph = await page.locator('p').boundingBox();
    expect(heading!.y - video!.y - video!.height).toBeGreaterThanOrEqual(27);
    expect(heading!.y - video!.y - video!.height).toBeLessThanOrEqual(36);
    expect(paragraph!.y - heading!.y - heading!.height).toBeGreaterThanOrEqual(9);
  }
});

test('sticky outline and anchor targets clear a resizing sticky header', async ({ page }) => {
  const registry = buildCoreBlockRegistry();
  const html = article().replace('<main>', '<header style="position:sticky;top:0;height:103px;background:white;z-index:10">Menu</header><main>');
  await page.setContent(html);
  await page.addScriptTag({ content: `window.TyperollBlocks={register(name,init){document.querySelectorAll('[data-block="table_of_contents"]').forEach(init)}};${registry.get('core/table_of_contents')!.script}` });
  await page.locator('[data-block="table_of_contents"]').evaluate(el => { (el as HTMLElement).dataset.highlightActive = 'false'; });
  for (const height of [103, 150, 81]) {
    await page.locator('header').evaluate((el, h) => { el.style.height = `${h}px`; }, height);
    await page.evaluate(() => scrollTo(0, 700));
    await expect.poll(async () => (await page.locator('[data-block="table_of_contents"]').boundingBox())!.y).toBeGreaterThanOrEqual(height + 15);
    await page.locator('[data-block="table_of_contents"] a').first().click();
    const heading = await page.locator('#storage-prices').boundingBox();
    expect(heading!.y).toBeGreaterThanOrEqual(height + 15);
    expect(heading!.y).toBeLessThan(height + 40);
  }
});

test('boxed related cards provide a distinct surface and compact titles', async ({ page }) => {
  const registry = buildCoreBlockRegistry();
  const blocks: Block[] = [{ id: 'card', type: 'core/post_card', data: { title: 'Related article', href: '/related', appearance: 'card', show_excerpt: false, show_date: false } }];
  await page.setContent(`<style>body{font:16px sans-serif}${collectBlockAssets(blocks, registry).css}</style>${renderBlocks(blocks, { registry })}`);
  const card = page.locator('[data-block="post_card"]');
  expect(await card.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe('none');
  expect(await card.locator('h3').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBe(16);
  expect(await card.locator('.block-postcard-body').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft))).toBeGreaterThanOrEqual(16);
});


test('long desktop outlines remain usable within the viewport and expand on mobile', async ({ page }) => {
  const registry = buildCoreBlockRegistry();
  const block: Block = { id: 'toc', type: 'core/table_of_contents', data: {} };
  const headings = Array.from({ length: 40 }, (_, i) => `<h2 id="s${i}">Section ${i}</h2><p>Article text</p>`).join('');
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.setContent(`<style>body{margin:0;font:16px sans-serif}${collectBlockAssets([block], registry).css}</style><header style="position:sticky;top:0;height:100px">Menu</header><main>${renderBlocks([block], { registry, context: { page: { content_mode: 'html', body: headings } } })}${headings}</main>`);
  await page.addScriptTag({ content: `window.TyperollBlocks={register(name,init){document.querySelectorAll('[data-block="table_of_contents"]').forEach(init)}};${registry.get('core/table_of_contents')!.script}` });
  const toc = page.locator('[data-block="table_of_contents"]');
  await page.evaluate(() => scrollTo(0, 200));
  await expect.poll(async () => (await toc.boundingBox())!.y).toBe(116);
  const box = (await toc.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(584);
  await toc.getByRole('link', { name: 'Section 39', exact: true }).focus();
  expect(await toc.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 600 });
  expect(await toc.evaluate(el => getComputedStyle(el).maxHeight)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('listing grids use one mobile column unless explicitly overridden', async ({ page }, testInfo) => {
  const { CONTENT_WELL_CSS } = await import('@typeroll/shared');
  const registry = buildCoreBlockRegistry();
  const blocks: Block[] = [
    ...['core/repeater', 'core/page_list'].map((type, index) => ({
      id: `default-${index}`, type, data: { source_type: 'static', item_block: 'core/post_card', layout: 'grid', cols: 3,
        items: [{ title: 'First card' }, { title: 'A taller card with more text', excerpt: 'Different card heights must still share grid rows.' }, { title: 'Third card' }] },
    })),
    { id: 'explicit', type: 'core/repeater', data: { source_type: 'static', item_block: 'core/post_card', layout: 'grid', cols: 3, mobile_cols: 2, items: [{ title: 'One' }, { title: 'Two' }] } },
    { id: 'responsive', type: 'core/repeater', data: { source_type: 'static', item_block: 'core/post_card', layout: 'grid', cols: { tablet: 2, desktop: 3 }, items: [{ title: 'One' }, { title: 'Two' }] } },
  ];
  const html = renderBlocks(blocks, { registry });
  const assets = collectBlockAssets(blocks, registry);
  await page.setContent(`<style>body{margin:0;font:16px/1.6 sans-serif}*{box-sizing:border-box}:root{--container-medium:65rem;--spacing-md:1rem}${CONTENT_WELL_CSS}${assets.css}</style><main class="page-content page-content--blocks">${html}</main>`);
  for (const width of [320, 390, 767, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ['default-0', 'default-1', 'explicit', 'responsive']) {
      const cols = await page.locator(`div[data-bid="${id}"]`).evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      const expected = width < 768 ? (id === 'explicit' ? 2 : 1) : (id === 'responsive' && width < 1280 ? 2 : 3);
      expect(cols, `${id} at ${width}px`).toBe(expected);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-list-defaults.png'), fullPage: true });
  }
});

test('content gutters and field rows stay readable without overflow', async ({ page }, testInfo) => {
  const { CONTENT_WELL_CSS } = await import('@typeroll/shared');
  const registry = buildCoreBlockRegistry();
  const blocks: Block[] = [
    { id: 'facts', type: 'core/field_list', data: { title: 'At a glance', fields: [{ field: 'website' }, { field: 'hq' }, { field: 'empty' }] } },
    { id: 'section', type: 'core/section', data: { background: '#e5eef7', padding_y: 'sm' }, children: [
      { id: 'prose', type: 'core/prose', data: { html: '<p>Full-bleed background with padded content.</p>' } },
    ] },
  ];
  const context = { page: { fields: { website: `https://example.test/${'long-path-'.repeat(20)}`, hq: 'Stockholm', empty: '' } }, content_type: { fields: [{ name: 'website', label: 'Website', type: 'url' }, { name: 'hq', label: 'Head office', type: 'text' }, { name: 'empty', label: 'Hidden row', type: 'text' }] } };
  const html = renderBlocks(blocks, { registry, context });
  const assets = collectBlockAssets(blocks, registry);
  await page.setContent(`<style>body{margin:0;font:16px/1.6 sans-serif}*{box-sizing:border-box}:root{--container-medium:65rem;--spacing-md:1rem}${CONTENT_WELL_CSS}${assets.css}</style><main class="page-content page-content--blocks">${html}</main>`);
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const gutter = width < 768 ? '20px' : '28px';
    expect(await page.locator('[data-block="field_list"]').evaluate(el => getComputedStyle(el).paddingLeft)).toBe(gutter);
    expect(await page.locator('[data-block="section"]').evaluate(el => getComputedStyle(el).paddingLeft)).toBe(gutter);
    expect((await page.locator('[data-block="section"]').boundingBox())?.width).toBe(width);
    expect(await page.locator('dt').count()).toBe(2);
    expect(await page.locator('dt').first().evaluate(el => getComputedStyle(el).fontWeight)).toBe('600');
    expect(await page.locator('dd').first().evaluate(el => getComputedStyle(el).overflowWrap)).toBe('anywhere');
    expect(parseFloat(await page.locator('dl').evaluate(el => getComputedStyle(el).rowGap))).toBeCloseTo(11.2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-field-list-gutters.png'), fullPage: true });
  }
});
