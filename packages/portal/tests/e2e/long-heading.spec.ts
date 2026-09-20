import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, renderBlocks, collectBlockAssets, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const titles = ['Är jag tvungen att vara med på städdag i bostadsrättsföreningen?', 'Hyresrättsöverlåtelsebestämmelser', 'Grundstücksverkehrsgenehmigungszuständigkeit', 'Short title'];

test('Heading and Page Title contain long words without shrinking authored type or shifting the body', async ({ page }, testInfo) => {
  for (const type of ['core/heading', 'template/page_title']) {
    for (const title of titles) {
      const blocks: Block[] = [{ id: 'frame', type: 'core/container', data: { width: 'full', direction: 'row', wrap: 'nowrap' }, children: [
        { id: 'article', type: 'core/container', data: { width: 'full', align_cross: 'center' }, children: [
          { id: 'title', type, data: { text: title, level: 'h1', font_size_px: 40 } },
          { id: 'body', type: 'core/prose', data: { html: '<p>Article body remains inside the content well.</p>' } },
        ] },
      ] }];
      await page.setContent(`<meta name="viewport" content="width=device-width"><style>*{box-sizing:border-box}body{margin:0;padding:20px;font-family:Arial}main{max-width:1120px;margin:auto}${collectBlockAssets(blocks, registry).css}</style><main>${renderBlocks(blocks, { registry, context: { page: { title } } })}</main>`);
      for (const width of [320,390,480,768,1280]) {
        await page.setViewportSize({width,height:900});
        await expect(page.getByRole('heading',{level:1})).toHaveCSS('font-size','40px');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const body = await page.locator('[data-block="prose"]').boundingBox();
        expect(body!.x).toBeGreaterThanOrEqual(20);
        expect(body!.x + body!.width).toBeLessThanOrEqual(width-19);
      }
      if (title === titles[0]) {
        await page.setViewportSize({width:390,height:900});
        await page.screenshot({path:testInfo.outputPath(`${type.replace('/','-')}-390.png`),fullPage:true});
      }
    }
  }
});
