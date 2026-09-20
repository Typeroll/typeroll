import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const links = Array.from({ length: 12 }, (_, index) => ({ label: `Moving guide ${index + 1}`, href: '#content' }));
const blocks: Block[] = [
  { id: 'gradient', type: 'core/container', data: { background_gradient: { from: '#f8fbff', to: '#e8f4fc', angle: 135 }, radius_px: 12, overflow: 'clip', padding_x_px: 16, padding_y_px: 16 }, children: [
    { id: 'nested', type: 'core/container', data: {}, children: [{ id: 'label', type: 'core/rich_heading', data: { html: '<a href="#content">Tips for moving</a>', level: 'h2' } }] },
    { id: 'card', type: 'core/post_card', data: { title: 'Packing electronics', href: '#content', whole_card_link: true, appearance: 'card', background: '#f8f9fa', hover_background: '#e8f4fc', hover_border_color: '#186ec0', show_image: false, show_date: false } },
  ] },
  { id: 'pdf', type: 'core/repeater', data: { item_block: 'core/post_card', items: [{ title: 'Moving checklist', url: '#content', pdf: '/checklist.pdf' }], item_overrides: { appearance: 'card', download_url_field: 'pdf', download_style: 'outline', download_color: '#00857d', download_hover_background: '#00857d', download_hover_color: '#ffffff', show_date: false } } },
  { id: 'footer', type: 'core/navigation_links', data: { links, density: 'compact-desktop', font_size_px: 14.4, line_height: 1.1 } },
  { id: 'menu', type: 'core/navigation_links', data: { links: links.slice(0, 1) } },
  { id: 'default-card', type: 'core/post_card', data: { title: 'Default theme card', href: '#content', appearance: 'card', whole_card_link: true, show_date: false } },
  { id: 'default-pdf', type: 'core/repeater', data: { item_block: 'core/post_card', items: [{ title: 'Default download', url: '#content', pdf: '/checklist.pdf' }], item_overrides: { download_url_field: 'pdf', download_style: 'outline', show_date: false } } },
];
const html = (primary: string) => `<!doctype html><meta name="viewport" content="width=device-width"><style>:root{--color-primary:${primary};--color-background:#fff;--color-on-primary:#fff}*{box-sizing:border-box}body{margin:20px;font:16px/1.5 system-ui;color:#18202c}main{max-width:900px;margin:auto}${collectBlockAssets(blocks,registry).css}</style><main id="content">${renderBlocks(blocks,{registry,annotate:true})}</main>`;

test('surface gradients, card feedback and desktop footer density remain usable at narrow widths', async ({ page }, testInfo) => {
  for (const primary of ['#186ec0', '#7c3aed']) {
    await page.setContent(html(primary));
    for (const width of [375, 768, 1023, 1024, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      const gradient = page.locator('[data-block-id="gradient"]');
      expect(await gradient.evaluate(el => getComputedStyle(el).backgroundImage)).toContain('135deg');
      expect(await gradient.evaluate(el => getComputedStyle(el).overflow)).toBe('clip');
      expect(await page.locator('[data-block-id="nested"]').evaluate(el => getComputedStyle(el).backgroundImage)).not.toContain('gradient(');
      const footerLink = page.locator('[data-block-id="footer"] a').first();
      expect((await footerLink.boundingBox())!.height).toBe(width < 1024 ? 44 : 24);
      expect((await page.locator('[data-block-id="menu"] a').boundingBox())!.height).toBe(44);
      const card = page.locator('[data-block-id="card"]');
      const before = await card.boundingBox();
      await card.hover();
      await expect(card).toHaveCSS('background-color', 'rgb(232, 244, 252)');
      expect(await card.boundingBox()).toEqual(before);
      await page.mouse.move(0,0);
      await card.locator('a').focus();
      await expect(card).toHaveCSS('outline-width', '2px');
      await expect(card).toHaveCSS('outline-offset', '-2px');
      const pdf = page.locator('[data-bid="pdf"] .block-postcard-download');
      await pdf.hover();
      await expect(pdf).toHaveCSS('background-color', 'rgb(0, 133, 125)');
      await expect(pdf).toHaveCSS('color', 'rgb(255, 255, 255)');
      await pdf.focus();
      await expect(pdf).toHaveCSS('outline-style', 'solid');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      if ([375,1280].includes(width)) await page.screenshot({ path:testInfo.outputPath(`surfaces-${primary.slice(1)}-${width}.png`), fullPage:true });
    }
    const defaults = page.locator('[data-block-id="default-card"]');
    await defaults.hover();
    await expect(defaults).toHaveCSS('outline-color',primary === '#186ec0' ? 'rgb(24, 110, 192)' : 'rgb(124, 58, 237)');
    await expect(defaults).not.toHaveCSS('background-color','rgb(255, 255, 255)');
    const defaultPdf = page.locator('[data-bid="default-pdf"] .block-postcard-download');
    await defaultPdf.hover();
    await expect(defaultPdf).toHaveCSS('background-color',primary === '#186ec0' ? 'rgb(24, 110, 192)' : 'rgb(124, 58, 237)');
    await expect(defaultPdf).toHaveCSS('color','rgb(255, 255, 255)');
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('[data-block-id="card"]')).toHaveCSS('transition-duration','0s');
});

test('compact footer keeps mobile and large touch targets', async ({ browser }) => {
  const context = await browser.newContext({ viewport:{width:1280,height:900},hasTouch:true,isMobile:true });
  const page = await context.newPage();
  try {
    await page.setContent(html('#186ec0'));
    expect((await page.locator('[data-block-id="footer"] a').first().boundingBox())!.height).toBe(44);
  } finally { await context.close(); }
});

test('template list and creation fields use readable portal colors on mobile and desktop', async ({ page }, testInfo) => {
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/app/sites/default/templates');
    await expect(page.getByRole('heading', {name:'Templates',exact:true})).toHaveCSS('color','rgb(28, 25, 23)');
    await page.getByRole('button',{name:'New template',exact:true}).click();
    const label = page.getByLabel('Label',{exact:true});
    await label.fill('Readable template label');
    await expect(label).toHaveCSS('color','rgb(28, 25, 23)');
    await expect(label).toHaveCSS('background-color','rgb(255, 255, 255)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:testInfo.outputPath(`template-list-${width}.png`),fullPage:true});
  }
});

test('native inspector edits and resets a gradient in the real page preview', async ({ page }) => {
  const file = path.join(os.tmpdir(),'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/pages/surface-editor.json');
  mkdirSync(path.dirname(file),{recursive:true});
  writeFileSync(file,JSON.stringify({id:'surface-editor',title:'Surface editor',slug:'surface-editor',status:'draft',content_mode:'blocks',blocks:[{
    id:'surface',name:'Surface',type:'core/container',data:{background_gradient:{from:'#f8fbff',to:'#e8f4fc',angle:135}},children:[{id:'heading',type:'core/heading',data:{text:'Surface preview',level:'h2'}}],
  }]}));
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('/app/sites/default/pages/surface-editor',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'Structure',exact:true}).click();
    await page.getByRole('button',{name:'Edit Surface',exact:true}).click();
    await page.getByText('Appearance',{exact:true}).click();
    await expect(page.getByLabel('Start color',{exact:true})).toHaveValue('#f8fbff');
    await page.getByLabel('Angle (degrees)',{exact:true}).fill('90');
    const surface = page.frameLocator('iframe[title="Preview"]').locator('[data-block-id="surface"]');
    await expect(surface).toHaveCSS('background-image',/90deg/);
    await page.getByRole('button',{name:'Reset linear gradient (optional)',exact:true}).click();
    await expect(surface).not.toHaveCSS('background-image',/gradient\(/);
  } finally { rmSync(file,{force:true}); }
});
