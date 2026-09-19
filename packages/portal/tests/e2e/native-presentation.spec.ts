import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, CONTENT_WELL_CSS, fontFamilyCss, prepareHeadingOutline, renderBlocks, type Block } from '@typeroll/shared';
const registry = buildCoreBlockRegistry();
const css = fs.readFileSync(new URL('../../../site-template/src/styles/global.css', import.meta.url), 'utf8');
const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="250"><rect width="800" height="250" fill="#d5ede9"/><rect x="2" y="2" width="796" height="246" fill="none" stroke="#007e78" stroke-width="4"/><circle cx="400" cy="125" r="100" fill="#ffe8a1"/></svg>').toString('base64');
const heading = (id: string, text: string): Block => ({ id, type: 'core/heading', data: { level: 'h2', text, font_size_px: { mobile: 26, laptop: 32 }, line_height: 1.2 } });
const blocks: Block[] = [
  { id: 'edge', type: 'core/container', data: { width: 'full', padding_x_px: 0, padding_y_px: 0, gap_px: 0 }, children: [
    { id: 'picture', type: 'core/image', data: { src: image, alt: 'Complete landscape illustration', radius: 'none', width: 'full' } },
    { id: 'band', type: 'core/section', data: { width: 'full', padding_x: 'none', padding_y: 'none', background: '#00a19c', content_gap_px: 0 }, children: [
      { id: 'hero-title', type: 'core/heading', data: { level: 'h1', text: 'A carefully composed home page', align: 'center', font_size_px: { mobile: 30, laptop: 48 }, line_height: 1.2, color: '#ffffff', font_weight: '700' } },
    ] },
  ] },
  { id: 'cards-section', type: 'core/section', data: { max_width_px: 1140 }, children: [
    { id: 'cards', type: 'core/grid', data: { cols: { mobile: 1, tablet: 2, laptop: 4 }, gap: 'md' }, children: Array.from({ length: 4 }, (_, i) => ({ id: `card${i}`, type: 'core/icon_box', data: { icon: '📦', heading: `Category ${i + 1}`, link: `/category-${i + 1}/`, whole_card_link: true, align: 'center', icon_size_px: 48, heading_size_px: 18.4, min_height_px: 180, padding_px: 24, radius_px: 8, background: '#ffffff', shadow: 'subtle' } })) },
  ] },
  { id: 'article-section', type: 'core/section', data: { max_width_px: 1140, padding_y: 'none', content_gap_px: 0 }, children: [
    { id: 'article-columns', type: 'core/columns', data: { ratio: '3-1', gap_px: { mobile: 24, laptop: 60 }, right_width_px: 280 }, slots: [[
      { id: 'crumbs', type: 'template/page_breadcrumbs', data: { padding_before_px: 0, padding_after_px: 12, divider: true } },
      heading('packing', 'Packing with a deliberate rhythm'),
      { id: 'intro', type: 'core/prose', data: { html: '<p>Clear instructions keep the content readable.</p>'.repeat(24) } },
      heading('checklist', 'A useful checklist'),
      { id: 'list', type: 'core/list', data: { items: [{ html: '<a href="/checklist.pdf">Download the checklist PDF</a>' }, { html: 'Protect and label each item.' }] } },
      heading('related', 'Related articles'),
    ], [{ id: 'toc', type: 'core/table_of_contents', data: { list_style: 'chevron', padding_px: 24, radius_px: 0, link_color: 'neutral', border: true, shadow: 'subtle' } }]] },
  ] },
];
function documentHtml(tree = blocks) {
  const assets = collectBlockAssets(tree, registry);
  return `<!doctype html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0}${css}${CONTENT_WELL_CSS}${assets.css}:root{--font-body:${fontFamilyCss('system')};--font-heading:${fontFamilyCss('system')}}</style><header><img alt="Example" src="${image}" style="display:none"></header><main class="page-content page-content--blocks">${prepareHeadingOutline(renderBlocks(tree, { registry, context: { page: { title: 'Example', content_mode: 'blocks', blocks: blocks[2].children![0].slots![0], breadcrumbs: [{ label: 'Packing', href: '/packing/' }] } } })).html}</main>`;
}
test('native controls preserve edge geometry, type and article proportions at every breakpoint', async ({ page }, info) => {
  await page.setContent(documentHtml());
  for (const width of [320, 390, 639, 640, 720, 721, 767, 768, 1023, 1024, 1279, 1280, 1535, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    const img = page.locator('[data-block="image"] img');
    const rect = await img.boundingBox();
    expect(rect!.x).toBe(0); expect(rect!.width).toBe(width);
    expect(await img.evaluate(el => [getComputedStyle(el).borderRadius, getComputedStyle(el).marginTop, getComputedStyle(el).marginBottom])).toEqual(['0px', '0px', '0px']);
    expect(rect!.width / rect!.height).toBeCloseTo(3.2, 1);
    expect(await page.locator('h1').evaluate(el => ({ font: parseFloat(getComputedStyle(el).fontSize), leading: parseFloat(getComputedStyle(el).lineHeight), color: getComputedStyle(el).color }))).toEqual({ font: width >= 1024 ? 48 : 30, leading: width >= 1024 ? 57.6 : 36, color: 'rgb(255, 255, 255)' });
    const columns = await page.locator('[data-block="columns"]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').map(parseFloat));
    if (width >= 1280) expect(columns).toEqual([800, 280]);
    if (width <= 720) expect(columns).toHaveLength(1);
    expect(await page.locator('[data-block="grid"]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width >= 1024 ? 4 : width >= 640 ? 2 : 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if ([320, 390, 768, 1024, 1280, 1536].includes(width)) await page.screenshot({ path: info.outputPath(`native-${width}.png`), fullPage: true });
  }
  const toc = page.locator('[data-block="table_of_contents"]');
  await page.evaluate(() => scrollTo(0, document.querySelector('[data-block="columns"]')!.getBoundingClientRect().top + scrollY + 200));
  await expect(toc).toBeVisible();
  await toc.locator('a').first().focus();
  expect(await toc.locator('a').first().evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.screenshot({ path: info.outputPath('native-scrolled.png') });
});
test('nested containers do not inherit dimensions and template titles honor exact sizes', async ({ page }) => {
  await page.setContent(documentHtml([{ id: 'outer', type: 'core/container', data: { width: 'full', padding_x_px: 40, padding_y_px: 0 }, children: [{ id: 'inner', type: 'core/container', data: { width: 'full', padding_x: 'none', padding_y: 'none' }, children: [{ id: 'title', type: 'template/page_title', data: { font_size_px: 40, line_height: 1.2 } }] }] }]));
  expect(await page.locator('[data-block="container"] [data-block="container"]').evaluate(el => getComputedStyle(el).paddingLeft)).toBe('0px');
  expect(await page.locator('h1').evaluate(el => getComputedStyle(el).fontSize)).toBe('40px');
});

test('logo dimensions and card hit target work without changing prose image defaults', async ({ page }) => {
  const tree: Block[] = [
    { id: 'logo', type: 'template/site_logo', data: { height_px: { mobile: 40, laptop: 50 } } },
    { id: 'card', type: 'core/icon_box', data: { icon: 'box', heading: 'Packing', link: '/packing/', whole_card_link: true, min_height_px: 180, padding_px: 24 } },
    { id: 'prose', type: 'core/prose', data: { html: `<img src="${image}" alt="Prose illustration">` } },
  ];
  const assets = collectBlockAssets(tree, registry);
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box}${css}${CONTENT_WELL_CSS}${assets.css}</style><main class="page-content page-content--blocks">${renderBlocks(tree, { registry, context: { site: { logo: image, name: 'Example' } } })}</main>`);
  for (const width of [390, 1024, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    const logo = await page.locator('[data-block="site-logo"] img').boundingBox();
    expect(logo!.height, JSON.stringify(await page.locator('[data-block="site-logo"]').evaluate(el => ({ html:el.outerHTML, value:getComputedStyle(el).getPropertyValue('--height_px'), child:getComputedStyle(el.querySelector('img')!).getPropertyValue('--height_px'), next:el.nextElementSibling?.outerHTML, width:innerWidth })))).toBe(width >= 1024 ? 50 : 40);
    expect(logo!.width / logo!.height).toBeCloseTo(3.2, 1);
  }
  const card = page.locator('[data-block="icon_box"]');
  const box = await card.boundingBox();
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), { x: box!.x + box!.width - 10, y: box!.y + box!.height - 10 })).toBe('/packing/');
  await card.locator('a').focus();
  expect(await card.locator('a').evaluate(el => getComputedStyle(el, '::after').outlineStyle)).toBe('solid');
  expect(await page.locator('[data-block="prose"] img').evaluate(el => getComputedStyle(el).borderRadius)).toBe('8px');
});

test('nested sections keep their own gutter without replacing the parent sibling gap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const tree: Block[] = [{ id: 'outer-section', type: 'core/section', data: { content_gap_px: 32, padding_x: 'none' }, children: [
    heading('first', 'First'),
    { id: 'inner-section', type: 'core/section', data: { content_gap_px: 0, padding_y: 'none' }, children: [heading('second', 'Second')] },
  ] }];
  await page.setContent(documentHtml(tree));
  const nested = page.locator('[data-block="section"] [data-block="section"]');
  expect(await nested.evaluate(el => getComputedStyle(el).paddingLeft)).toBe('20px');
  expect(await nested.evaluate(el => getComputedStyle(el).marginTop)).toBe('32px');
});

test('configured column stacking releases the outline track and preserves desktop geometry', async ({ page }, info) => {
  const tree = structuredClone(blocks);
  const columns = tree[2].children![0];
  columns.data.stack_below = '721';
  const outline = columns.slots![1][0];
  outline.data.mobile_display = 'hidden';
  // Responsive outline styles must not count as visible sidebar content.
  outline.data.padding_px = { mobile: 16, laptop: 24 };
  await page.setContent(documentHtml(tree));
  await page.setViewportSize({ width: 768, height: 850 });
  // Negative control: the legacy threshold really reserves a sidebar here.
  expect(await page.locator('[data-block="columns"]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
  columns.data.stack_below = '1024';
  await page.setContent(documentHtml(tree));
  for (const width of [720, 721, 767, 768, 1023, 1024, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    const container = page.locator('[data-block="columns"]');
    const slots = container.locator(':scope > .block-columns-col');
    const toc = container.locator('[data-block="table_of_contents"]');
    if (width < 1024) {
      await expect(toc).toBeHidden(); await expect(slots.nth(1)).toBeHidden();
      expect((await slots.first().boundingBox())!.width).toBe((await container.boundingBox())!.width);
      expect(await container.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1);
    } else {
      await expect(toc).toBeVisible(); await expect(slots.nth(1)).toBeVisible();
      expect(await toc.evaluate(el => getComputedStyle(el).position)).toBe('sticky');
      if (width === 1280) expect(await container.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').map(parseFloat))).toEqual([800, 280]);
      await toc.locator('a').first().focus(); await expect(toc.locator('a').first()).toBeFocused();
      expect(await toc.locator('a').first().getAttribute('href')).toBe('#packing-with-a-deliberate-rhythm');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: info.outputPath(`stack-${width}.png`), fullPage: true });
  }
  // Visible outlines remain in normal flow while columns are stacked.
  outline.data.mobile_display = 'visible';
  await page.setContent(documentHtml(tree));
  await page.setViewportSize({ width: 768, height: 850 });
  await expect(page.locator('[data-block="table_of_contents"]')).toBeVisible();
  expect(await page.locator('[data-block="table_of_contents"]').evaluate(el => getComputedStyle(el).position)).toBe('static');
  expect(await page.locator('[data-block="table_of_contents"]').locator('..').evaluate(el => getComputedStyle(el).position)).toBe('static');
  // A genuinely empty outline must not reserve a track or an empty grid row.
  await page.setContent(documentHtml(tree).replace(/data-empty="false"/g, 'data-empty="true"'));
  await page.setViewportSize({ width: 1280, height: 850 });
  await expect(page.locator('[data-block="columns"] > .block-columns-col').nth(1)).toBeHidden();
  expect(await page.locator('[data-block="columns"]').evaluate(el => getComputedStyle(el).gridTemplateColumns)).toBe('1140px');
  await page.locator('[data-block="columns"] > .block-columns-col').nth(1).evaluate(el => el.insertAdjacentHTML('beforeend', '<p>Other sidebar content</p>'));
  await expect(page.getByText('Other sidebar content')).toBeVisible();
  expect(await page.locator('[data-block="columns"]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(2);
});

test('asymmetric padding and precise grid gaps follow viewport settings without leaking', async ({ page }, info) => {
  const padding = { padding_top_px: { mobile: 12, tablet: 20, laptop: 25 }, padding_bottom_px: { mobile: 35, tablet: 50, laptop: 60 } };
  const gap = { mobile: 15, tablet: 20, laptop: 25 };
  const tree: Block[] = [
    { id: 'panel', type: 'core/container', data: { ...padding, padding_y_px: 99, width: 'full' }, children: [heading('hero-label', 'Hero title')] },
    { id: 'flow-panel', type: 'core/container', data: { ...padding, layout: 'flow', padding_y_px: 99 }, children: [heading('flow-label', 'Flow title')] },
    { id: 'fallback', type: 'core/container', data: { padding_y_px: 7, padding_top_px: 0 }, children: [{ id: 'nested-padding', type: 'core/container', data: { padding_y: 'none' }, children: [] }] },
    { id: 'grid', type: 'core/grid', data: { cols: 4, gap_px: gap }, children: [1,2,3,4].map(i => heading(`g${i}`, 'Card')) },
    { id: 'repeater', type: 'core/repeater', data: { cols: 4, mobile_cols: 2, gap_px: gap, item_block: 'core/icon_box', items: [1,2,3,4].map(i => ({ heading: `Card ${i}` })) } },
    { id: 'alias', type: 'core/feature_grid', data: { cols: 4, gap_px: gap, items: [{ heading: 'Alias card' }] } },
    { id: 'outer-grid', type: 'core/grid', data: { gap_px: 55 }, children: [{ id: 'inner-grid', type: 'core/grid', data: { gap: 'sm' }, children: [heading('nested-h', 'Nested')] }, { id: 'inner-repeater', type: 'core/repeater', data: { gap: 'sm', item_block: 'core/icon_box', items: [{ heading: 'Nested card' }] } }] },
  ];
  await page.setContent(documentHtml(tree).replace('class="page-content page-content--blocks"', ''));
  // The measurement well matches the source without any corrective block CSS.
  await page.addStyleTag({ content: 'main{max-width:1160px;margin:auto}' });
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    for (const title of ['Hero title', 'Flow title']) {
      expect(await page.getByText(title, { exact: true }).locator('../..').evaluate(el => [getComputedStyle(el).paddingTop, getComputedStyle(el).paddingBottom])).toEqual(width === 390 ? ['12px','35px'] : width === 768 ? ['20px','50px'] : ['25px','60px']);
    }
    for (const id of ['grid', 'repeater', 'alias']) expect(await page.locator(`[data-block][data-bid="${id}"]`).evaluate(el => getComputedStyle(el).gap)).toBe(`${width === 390 ? 15 : width === 768 ? 20 : 25}px`);
    expect(await page.locator('[data-block="grid"][data-bid="grid"]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width === 390 ? 1 : 4);
    if (width === 1280) expect((await page.locator('[data-bid="repeater"] > [data-block="icon_box"]').first().boundingBox())!.width).toBe(271.25);
    expect(await page.locator('[data-block="grid"] [data-block="grid"]').evaluate(el => getComputedStyle(el).gap)).toBe('8px');
    expect(await page.locator('[data-block="grid"] [data-block="repeater"]').evaluate(el => getComputedStyle(el).gap)).toBe('8px');
    expect(await page.locator('[data-block="container"] [data-block="container"]').evaluate(el => getComputedStyle(el).paddingTop)).toBe('0px');
    await page.screenshot({ path: info.outputPath(`precise-spacing-${width}.png`), fullPage: true });
  }
});

test('native sticky headers preserve navigation and outline anchor feedback with scroll padding', async ({ page }, info) => {
  const body: Block[] = [heading('first', 'First section'), { id: 'spacer', type: 'core/prose', data: { html: '<p>Read the full article.</p>'.repeat(20) } }, heading('second', 'Pack electronics'), { id: 'tail', type: 'core/prose', data: { html: '<p>More article text.</p>'.repeat(50) } }];
  const header: Block = { id: 'sticky-header', type: 'core/container', data: { tag: 'header', sticky: true, width: 'full', padding_y_px: 26.5, padding_x_px: 25, background: '#ffffff', direction: 'row', align_main: 'space-between', align_cross: 'center' }, children: [
    { id: 'header-logo', type: 'template/site_logo', data: { height_px: 50 } },
    { id: 'menu', type: 'core/navigation', data: { links: [{ label: 'Home', href: '/' }, { label: 'Sections', href: '#first-section' }] } },
  ] };
  const article: Block = { id: 'columns', type: 'core/columns', data: { right_width_px: 280, stack_below: '1024' }, slots: [body, [{ id: 'outline', type: 'core/table_of_contents', data: {} }]] };
  const assets = collectBlockAssets([header, article], registry);
  const render = (tree: Block[]) => prepareHeadingOutline(renderBlocks(tree, { registry, context: { site: { logo: image, name: 'Example' }, page: { content_mode: 'blocks', blocks: body } } })).html;
  const fixture = (sticky: boolean, padding: number) => {
    header.data.sticky = sticky;
    return `<!doctype html><meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0}${css}${assets.css}html{scroll-padding-top:${padding}px}main{max-width:1140px;margin:auto}</style>${render([header])}<main>${render([article])}</main>`;
  };
  for (const sticky of [false, true]) for (const padding of [0, 120]) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setContent(fixture(sticky, padding));
    await page.addScriptTag({ content: `window.TyperollBlocks={register(name,init){document.querySelectorAll(name==='core/navigation'?'[data-block="navigation"]':'[data-block="table_of_contents"]').forEach(init)}};${registry.get('core/navigation')!.script}\n${registry.get('core/table_of_contents')!.script}` });
    const link = page.locator('[data-block="table_of_contents"]').getByRole('link', { name: 'Pack electronics' });
    await link.click();
    await expect(link).toHaveAttribute('aria-current', 'location');
    expect(await page.locator('[aria-current="location"]').count()).toBe(1);
    const target = page.locator('#pack-electronics');
    await expect.poll(async () => (await target.boundingBox())!.y).toBeCloseTo((sticky ? 103 : 0) + 16 + padding, 0);
    if (sticky) {
      expect((await page.locator('header').boundingBox())!.y).toBe(0);
      expect((await page.locator('header').boundingBox())!.height).toBe(103);
      const menuLink = page.getByRole('link', { name: 'Sections', exact: true });
      await menuLink.hover();
      const point = (await menuLink.boundingBox())!;
      expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('a')?.textContent, { x: point.x + 5, y: point.y + 5 })).toBe('Sections');
    } else expect((await page.locator('header').boundingBox())!.y).toBeLessThan(0);
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator('[data-block="table_of_contents"] a').first()).toHaveAttribute('aria-current', 'location');
    await link.focus(); await page.keyboard.press('Enter');
    await expect(link).toHaveAttribute('aria-current', 'location');
    if (sticky && padding === 0) {
      await page.screenshot({ path: info.outputPath('native-sticky-anchor.png') });
      await page.setViewportSize({ width: 390, height: 800 });
      const toggle = page.locator('.block-navigation-toggle');
      await toggle.click(); await expect(page.locator('.block-navigation-list')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(toggle).toBeFocused();
      await expect(page.locator('.block-navigation-list')).toBeHidden();
    }
  }
});
