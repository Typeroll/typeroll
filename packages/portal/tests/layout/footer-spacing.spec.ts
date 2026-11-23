import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, contentWellCss, defaultSiteSettings, footerSpacingCss, renderBlocks, siteContext, siteThemeCss, composePageWithTemplate, PLATFORM_LAYER_ORDER_CSS, platformLayer, type Block, type Page, type SiteSettings } from '@typeroll/shared';
const registry = buildCoreBlockRegistry();
const text: Block = { id: 'text', type: 'core/prose', data: { html: '<p class="last-copy">The final paragraph.</p>' } };
const container = (data: Record<string, unknown> = {}): Block => ({ id: 'ending', type: 'core/container', data: { width: 'full', ...data }, children: [text] });
function html(blocks: Block[], settings: SiteSettings, page: Partial<Page> = {}) {
  const assets = collectBlockAssets(blocks, registry, { renderVersion: settings.render_version });
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${PLATFORM_LAYER_ORDER_CSS}</style><style>body{margin:0}p{margin:0}footer{padding:20px;background:#123;color:white}</style><style>${siteThemeCss(settings)}\n${platformLayer('content', contentWellCss(settings.render_version!), settings.render_version)}\n${assets.css}</style><style>${footerSpacingCss(settings, page)}</style></head><body><main class="page-content page-content--blocks">${renderBlocks(blocks, { registry, renderVersion: settings.render_version, context: { site: siteContext(settings as unknown as Record<string, unknown>) } })}</main><footer>Site footer</footer></body></html>`;
}
for (const width of [375, 768, 1280]) {
  test(`the theme minimum survives a zero-padded final container at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const settings = { ...defaultSiteSettings, render_version: 20, footer_min_spacing: { mobile: 32, laptop: 64 } } as SiteSettings;
    await page.setContent(html([container({ padding_bottom_px: 0 })], settings));
    expect(await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('.last-copy')!.getBoundingClientRect().bottom)).toBeCloseTo(width < 1024 ? 32 : 64, 0);
    await page.setContent(html([container({ padding_bottom_px: 0 })], settings, { footer_spacing: 'none' }));
    expect(await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('.last-copy')!.getBoundingClientRect().bottom)).toBeCloseTo(0, 0);
  });
  test(`footer spacing follows site scale at ${width}px without adding container defaults`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const settings = { ...defaultSiteSettings, render_version: 20, footer_spacing: { mobile: 32, laptop: 64 } } as SiteSettings;
    for (const ending of [[text], [container()], [{ id: 'section', type: 'core/section', data: {}, children: [text] }]]) {
      await page.setContent(html(ending, settings));
      const gap = await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('.last-copy')!.getBoundingClientRect().bottom);
      expect(gap).toBeCloseTo(width < 1024 ? 32 : 64, 0);
    }
    await page.screenshot({ path: test.info().outputPath(`footer-${width}.png`), fullPage: true });
  });
  test(`explicit spacing and edge-to-edge retain intent at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const settings = { ...defaultSiteSettings, render_version: 20, footer_spacing: 'xl' } as SiteSettings;
    for (const own of [0, 24, { mobile: 16, laptop: 40 }]) {
      await page.setContent(html([container({ padding_bottom_px: own })], settings));
      const gap = await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('.last-copy')!.getBoundingClientRect().bottom);
      expect(gap).toBeCloseTo(typeof own === 'number' ? own : width < 1024 ? 16 : 40, 0);
    }
    await page.setContent(html([container({ background: 'primary' })], settings, { footer_spacing: 'none' }));
    expect(await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('[data-block="container"]')!.getBoundingClientRect().bottom)).toBeCloseTo(0, 0);
  });
  test(`composed templates and hidden endings use the last visible block at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const settings = { ...defaultSiteSettings, render_version: 20, footer_spacing: 48 } as SiteSettings;
    const hidden: Block = { ...container({ padding_bottom_px: 0 }), id: 'hidden', hidden_on: ['mobile','tablet','laptop','desktop','wide'], children: [] };
    const blocks = composePageWithTemplate([{ id: 'slot', type: 'template_content_slot', data: {} }, hidden], [container()]);
    await page.setContent(html(blocks, settings));
    expect(await page.evaluate(() => document.querySelector('footer')!.getBoundingClientRect().top - document.querySelector('.last-copy')!.getBoundingClientRect().bottom)).toBeCloseTo(48, 0);
  });
}
