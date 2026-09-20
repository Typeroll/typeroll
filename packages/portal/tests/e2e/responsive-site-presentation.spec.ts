import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';
const registry = buildCoreBlockRegistry();
const widths = { tablet: 576, laptop: 769, desktop: 1024, wide: 1280 };
const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ceeaf5"/></svg>').toString('base64');
const card = (id: string, hasImage: boolean): Block => ({ id, type: 'core/post_card', data: {
  title: `Checklist ${id}`, href: `#${id}`, action_label: 'Read', download_url_field: 'pdf', download_style: 'outline',
  image: hasImage ? image : '', image_fit: 'cover', image_aspect: 'auto', show_excerpt: false, show_date: false, show_author: false,
  layout: { mobile: 'column', laptop: 'row' }, image_width_percent: 40,
  actions_direction: { mobile: 'column', laptop: 'row' }, actions_gap_px: 20, action_size_px: 14.4, action_weight: '500',
  body_padding_px: 15, body_gap_px: 20, title_size_px: 20, title_weight: '500', whole_card_link: true, appearance: 'card',
} });
function documentHtml(tree: Block[]) {
  const assets = collectBlockAssets(tree, registry);
  const html = sanitizeBody(renderBlocks(tree, { registry, context: { site: { responsive_breakpoints: widths }, item: { pdf: '/guide.pdf' } } }));
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;padding:16px;font-family:Arial}*{box-sizing:border-box}a{color:#075696}${assets.css}</style></head><body>${html}</body></html>`;
}

test('exact authored thresholds control typography, geometry and visibility without changing the menu contract', async ({ page }, info) => {
  const tree: Block[] = [
    { id: 'header-shape', type: 'core/container', data: { width: 'full', min_height_px: { mobile: 80, laptop: 103 }, padding_x_px: 0, padding_y_px: 0 }, children: [{ id: 'logo-text', type: 'core/prose', data: { html: '<p>Site name</p>', font_size_px: 24 } }] },
    { id: 'legal', type: 'core/prose', data: { html: '<p>Copyright and company information</p>', font_size_px: 14.4, line_height: 1.6, text_align: 'center', paragraph_spacing_px: 0 } },
    { id: 'tabletonly', type: 'core/prose', data: { html: '<p>Range marker</p>' }, hidden_on: ['mobile', 'laptop', 'desktop', 'wide'] },
    { id: 'columns', type: 'core/grid', data: { cols: { mobile: 1, tablet: 2, laptop: 3 }, gap_px: 20 }, children: [card('one', true), card('two', false)] },
  ];
  await page.setContent(documentHtml(tree));
  for (const width of [320,390,575,576,639,640,768,769,1023,1024,1280,1536]) {
    await page.setViewportSize({ width, height: 900 });
    const grid = page.locator('[data-block="grid"]');
    expect(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width < 576 ? 1 : width < 769 ? 2 : 3);
    const legal = page.locator('[data-block="prose"]').nth(1);
    expect(await legal.evaluate(el => ({ size: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight, align: getComputedStyle(el).textAlign }))).toEqual({ size: '14.4px', line: '23.04px', align: 'center' });
    const marker = page.getByText('Range marker');
    if (width >= 576 && width < 769) await expect(marker).toBeVisible(); else await expect(marker).toBeHidden();
    const header = page.locator('[data-block="container"]').first();
    expect((await header.boundingBox())!.height).toBe(width < 769 ? 80 : 103);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if ([390,769,1280].includes(width)) await page.screenshot({ path: info.outputPath(`presentation-${width}.png`), fullPage: true });
  }
});

test('checklist cards preserve optional media, horizontal actions and separate accessible destinations', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const tree: Block[] = [{ id: 'list', type: 'core/grid', data: { cols: { mobile: 1, laptop: 2 }, gap_px: 30 }, children: Array.from({length:18}, (_,i) => card(String(i+1), i % 3 !== 0)) }];
  await page.setContent(documentHtml(tree));
  const cards = page.locator('[data-block="post_card"]');
  await expect(cards).toHaveCount(18);
  for (let i = 0; i < 18; i++) {
    const entry = cards.nth(i);
    await expect(entry.locator('a a')).toHaveCount(0);
    const read = entry.getByRole('link', { name: 'Read', exact: true });
    const download = entry.getByRole('link', { name: 'Download PDF', exact: true });
    await expect(read).toHaveAttribute('href', `#${i+1}`);
    await expect(download).toHaveAttribute('href', '/guide.pdf');
    const a = (await read.boundingBox())!, b = (await download.boundingBox())!;
    expect(a.y).toBe(b.y); expect(b.x).toBeGreaterThan(a.x + a.width);
    if (i % 3 === 0) await expect(entry.locator('.block-postcard-media')).toHaveCount(0);
    else expect((await entry.locator('.block-postcard-media').boundingBox())!.width / (await entry.boundingBox())!.width).toBeCloseTo(0.4, 2);
  }
  await page.screenshot({path:info.outputPath('checklists-1280.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await cards.nth(0).locator('.block-postcard-actions').evaluate(el=>getComputedStyle(el).flexDirection)).toBe('column');
  await page.screenshot({path:info.outputPath('checklists-390.png'),fullPage:true});
});

test('native image-free link cards have one focusable target with the icon inside it', async ({page}) => {
  await page.setContent(documentHtml([{id:'advice',type:'core/post_card',data:{title:'Packing advice',href:'#packing',title_icon:'arrow-right',title_icon_color:'#075696',title_icon_size_px:24,title_icon_gap_px:12,whole_card_link:true,show_image:false,show_date:false,show_excerpt:false,appearance:'card'}}]));
  const link = page.getByRole('link',{name:'Packing advice'});
  await expect(page.locator('a')).toHaveCount(1);
  await expect(link.locator('.block-postcard-title-icon')).toBeVisible();
  expect(await link.evaluate(el=>getComputedStyle(el).display)).toBe('flex');
  await link.focus(); await expect(link).toBeFocused();
});

test('page lists honor exact site widths for both columns and item presentation', async ({ page }) => {
  await page.setContent(documentHtml([{id:'repeated',type:'core/page_list',data:{
    source_type:'static',item_block:'core/post_card',layout:'grid',
    cols:{mobile:1,tablet:2,laptop:3},items:[{title:'One'},{title:'Two'},{title:'Three'}],
    item_overrides:{title_size_px:{mobile:16,laptop:20}},
  }}]));
  for (const width of [575,576,768,769,1024]) {
    await page.setViewportSize({width,height:900});
    const grid = page.locator('[data-block="repeater"]');
    expect(await grid.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(width < 576 ? 1 : width < 769 ? 2 : 3);
    await expect(page.locator('.block-postcard-title').first()).toHaveCSS('font-size',width < 769 ? '16px' : '20px');
  }
});

test('site settings and page metadata expose the new native controls', async ({page}) => {
  await page.goto('/app/sites/default/settings');
  await page.getByText('Responsive block widths', {exact:true}).click();
  const input = page.getByLabel('tablet starts at (px)');
  await expect(input).toHaveValue('640');
  // The actual editor receives custom widths from the versioned settings, not a global client constant.
  const settingsFile = path.join(os.tmpdir(),'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/settings/default.json');
  const original = fs.readFileSync(settingsFile,'utf8');
  try {
    fs.writeFileSync(settingsFile,JSON.stringify({...JSON.parse(original),responsive_breakpoints:widths}));
    await page.goto('/app/sites/default/pages/home');
    await page.getByRole('button',{name:'Page settings',exact:true}).click();
    await expect(page.getByLabel('Breadcrumb label',{exact:true})).toBeVisible();
    await expect(page.locator('button[title*="laptop starts at 769px"]').first()).toBeVisible();
  } finally { fs.writeFileSync(settingsFile,original); }
});
