import { test, expect, type Page } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';

/**
 * Render version 9 raises a container with a shadow above the blocks after
 * it, so the next block's background no longer paints over the shadow, and
 * content that opens from it (a dropdown menu) lands above the next block.
 */
const registry = buildCoreBlockRegistry();
const HERO_BG = [234, 243, 248];

function header(data: Record<string, unknown> = {}): Block {
  return {
    id: 'header', type: 'core/container',
    data: { tag: 'header', width: 'full', shadow: 'header', background: '#00a19c', padding_y_px: 24, ...data },
    children: [{ id: 'menu', type: 'core/prose', data: { html: '<p class="dropdown">Dropdown</p>' } }],
  };
}
const hero: Block = { id: 'hero', type: 'core/hero', data: { heading: 'Hero', layout: 'centered', background: 'rgb(234 243 248)' } };

async function render(page: Page, tree: Block[], renderVersion: number) {
  const css = collectBlockAssets(tree, registry, { renderVersion }).css;
  // The dropdown stands in for a submenu that opens below the header, over the hero's content.
  const dropdown = '.dropdown{position:absolute;left:0;top:calc(100% - 4px);width:220px;height:120px;background:#fff;margin:0}';
  await page.setContent(`<!doctype html><style>*{box-sizing:border-box;margin:0}body{font:16px Arial}${css}${dropdown}</style><main>${renderBlocks(tree, { registry, renderVersion })}</main>`);
  await page.setViewportSize({ width: 1024, height: 700 });
}

/** The rendered colour of one viewport pixel. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async src => {
    const image = new Image();
    image.src = `data:image/png;base64,${src}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  }, png.toString('base64'));
}

async function headerBottom(page: Page) {
  const box = await page.locator('[data-block="semantic-container"], [data-block="container"]').first().boundingBox();
  return box!.y + box!.height;
}

test('a shadowed container paints its shadow and dropdowns above the next block from render version 9', async ({ page }) => {
  await render(page, [header(), hero], 9);
  const bottom = await headerBottom(page);
  const shadow = await pixel(page, 600, bottom + 1);
  // 0 2px 6px rgb(0 0 0 / 20%) darkens the hero's light background just below the header.
  expect(shadow[0]).toBeLessThan(HERO_BG[0] - 10);
  expect(await pixel(page, 600, bottom + 40)).toEqual(HERO_BG);
  expect(await page.locator('header').evaluate(el => getComputedStyle(el).boxShadow)).toBe('rgba(0, 0, 0, 0.2) 0px 2px 6px 0px');

  const inner = await page.locator('.block-hero-inner').boundingBox();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [100, inner!.y + 10]);
  expect(hit).toBe('dropdown');
});

test('render version 8 keeps the shadow under the next block', async ({ page }) => {
  await render(page, [header(), hero], 8);
  const bottom = await headerBottom(page);
  expect(await pixel(page, 600, bottom + 1)).toEqual(HERO_BG);
  expect(await page.locator('header').evaluate(el => getComputedStyle(el).position)).toBe('static');
});

test('a sticky shadowed container keeps z-index 100, and a container without a shadow stays unpositioned', async ({ page }) => {
  await render(page, [header({ sticky: true }), hero], 9);
  expect(await page.locator('header').evaluate(el => [getComputedStyle(el).position, getComputedStyle(el).zIndex])).toEqual(['sticky', '100']);
  await render(page, [header({ shadow: 'none' }), hero], 9);
  expect(await page.locator('header').evaluate(el => [getComputedStyle(el).position, getComputedStyle(el).zIndex])).toEqual(['static', 'auto']);
  await render(page, [header({ shadow: 'subtle', tag: 'div' }), hero], 9);
  expect(await page.locator('[data-block="container"]').first().evaluate(el => [getComputedStyle(el).position, getComputedStyle(el).zIndex])).toEqual(['relative', '10']);
});
