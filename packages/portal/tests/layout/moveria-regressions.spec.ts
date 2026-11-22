import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, FORM_BLOCKS_CSS, type Block } from '@typeroll/shared';
import { previewEmbedHelpScript } from '../../src/lib/preview-embed-help';
import { PREVIEW_SANDBOX } from '../../src/lib/preview-headers';
import { rewritePreviewFileLinks } from '../../src/lib/preview-media';

const registry = buildCoreBlockRegistry();
test('a date-only form fits a narrow phone without sideways scrolling', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 800 });
  const block: Block = { id: 'date', type: 'form/date', data: { name: 'moving_date', label: 'Flyttdatum', required: true } };
  await page.setContent(`<html><head><meta name="viewport" content="width=device-width"><style>body{margin:0;font:16px system-ui}.quote{padding:24px;box-sizing:border-box;width:100%}${FORM_BLOCKS_CSS}</style></head><body><form class="quote">${renderBlocks([block], { registry })}</form></body></html>`);
  await page.locator('input[type=date]').fill('2026-11-22');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  const input = await page.locator('input[type=date]').boundingBox();
  expect(input!.x + input!.width).toBeLessThanOrEqual(296);
  await page.screenshot({ path: info.outputPath('date-field-phone.png') });
});

test('legacy prose spacing remains em-based and canonical pixel fields take priority', async ({ page }) => {
  const blocks: Block[] = [
    { id: 'legacy', type: 'core/prose', data: { html: '<p>Legacy copy</p>', font_size: 20, paragraph_spacing: 1.5 } },
    { id: 'canonical', type: 'core/prose', data: { html: '<p>Canonical copy</p>', font_size: 20, font_size_px: 24, paragraph_spacing: 1.5, paragraph_spacing_px: 12 } },
  ];
  const assets = collectBlockAssets(blocks, registry);
  await page.setContent(`<style>${assets.css}</style>${renderBlocks(blocks, { registry })}`);
  const values = await page.locator('[data-block=prose]').evaluateAll(nodes => nodes.map(node => ({ size: getComputedStyle(node).fontSize, gap: getComputedStyle(node.querySelector('p')!).marginBottom })));
  expect(values).toEqual([{ size: '20px', gap: '30px' }, { size: '24px', gap: '12px' }]);
  const inherited: Block[] = [{ id: 'inherited', type: 'core/prose', data: { html: '<p>Template typography</p>' } }];
  const base = collectBlockAssets(inherited, registry);
  await page.setContent(`<style>${base.css}</style><div style="--paragraph_spacing:1.5;--page-body-paragraph-spacing:1.5em">${renderBlocks(inherited, { registry })}</div>`);
  const ratio = await page.locator('[data-block=prose] p').evaluate(node => parseFloat(getComputedStyle(node).marginBottom) / parseFloat(getComputedStyle(node).fontSize));
  expect(ratio).toBeCloseTo(1.5, 2);
});

test('a provider-blocked iframe has a visible explanation before the empty area', async ({ page }, info) => {
  await page.route('https://blocked.example.test/**', route => route.fulfill({ status: 200, headers: { 'Content-Security-Policy': "frame-ancestors 'none'" }, body: 'Restricted form' }));
  await page.setContent(`<iframe src="https://blocked.example.test/form" title="External form" style="width:300px;height:200px"></iframe><script>${previewEmbedHelpScript()}</script>`);
  const help = page.locator('[data-preview-embed-help]');
  await expect(help.getByText('This provider may only display its form on the published website.', { exact: false })).toBeVisible();
  expect(await help.locator('details').getAttribute('open')).not.toBeNull();
  await page.screenshot({ path: info.outputPath('preview-embed-explanation.png') });
});

test('a private file opens outside the preview sandbox with no opener', async ({ page, context }) => {
  const files = [{ id: 'pdf', mime_type: 'application/pdf', cdn_url: 'https://files.example.test/template.pdf', public_path: '/media/template.pdf' }] as any;
  const anchor = rewritePreviewFileLinks('<a href="/media/template.pdf">Open PDF</a>', files);
  await context.route('https://files.example.test/template.pdf', route => route.fulfill({ contentType: 'text/html', body: '<h1>File destination</h1>' }));
  await context.route('https://preview.example.test/frame', route => route.fulfill({ headers: { 'Content-Security-Policy': PREVIEW_SANDBOX }, contentType: 'text/html', body: anchor }));
  await page.setContent(`<iframe src="https://preview.example.test/frame" sandbox="${PREVIEW_SANDBOX.replace('sandbox ', '')}"></iframe>`);
  const popupPromise = context.waitForEvent('page');
  await page.frameLocator('iframe').getByRole('link', { name: 'Open PDF' }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading')).toHaveText('File destination');
  expect(await popup.evaluate(() => ({ origin: self.origin, opener: window.opener }))).toEqual({ origin: 'https://files.example.test', opener: null });
});
