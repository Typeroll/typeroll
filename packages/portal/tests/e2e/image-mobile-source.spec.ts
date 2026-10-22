import { test, expect, type Page } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';

/** core/image swaps to `mobile_src` below 640px unless a breakpoint or exact width is chosen. */
const registry = buildCoreBlockRegistry();
const svg = (fill: string) => 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="${fill}"/></svg>`).toString('base64');
const DESKTOP = svg('#163e52');
const MOBILE = svg('#fbb86b');

async function shown(page: Page, data: Record<string, unknown>, width: number): Promise<'desktop' | 'mobile'> {
  const tree: Block[] = [{ id: 'banner', type: 'core/image', data: { src: DESKTOP, mobile_src: MOBILE, alt: 'Banner', ...data } }];
  await page.setViewportSize({ width, height: 600 });
  await page.setContent(`<!doctype html><style>${collectBlockAssets(tree, registry).css}</style>${renderBlocks(tree, { registry })}`);
  const img = page.locator('[data-block="image"] img');
  await expect(img).toHaveJSProperty('complete', true);
  const current = await img.evaluate(el => (el as HTMLImageElement).currentSrc);
  return current === MOBILE ? 'mobile' : 'desktop';
}

test('the mobile image switches at 640px by default and below the chosen breakpoint', async ({ page }) => {
  // Unset: the original 640px switch, whatever widths the block has.
  const moveria = { responsive_breakpoints: { tablet: 577, laptop: 768, desktop: 1280, wide: 1536 } };
  expect(await shown(page, moveria, 640)).toBe('mobile');
  expect(await shown(page, moveria, 700)).toBe('desktop');

  // Below the block's laptop width (768px), as legacy sites switch.
  const belowLaptop = { ...moveria, mobile_src_below: 'laptop' };
  expect(await shown(page, belowLaptop, 700)).toBe('mobile');
  expect(await shown(page, belowLaptop, 767)).toBe('mobile');
  expect(await shown(page, belowLaptop, 768)).toBe('desktop');

  // An exact width overrides the breakpoint.
  expect(await shown(page, { ...belowLaptop, mobile_src_below_px: 900 }, 850)).toBe('mobile');
  expect(await shown(page, { ...belowLaptop, mobile_src_below_px: 900 }, 900)).toBe('desktop');
});
