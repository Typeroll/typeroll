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
