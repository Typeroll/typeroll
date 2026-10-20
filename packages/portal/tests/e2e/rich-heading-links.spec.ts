/**
 * A formatted heading's link follows the site's Link style unless the block
 * says otherwise (link_decoration / link_hover_decoration), and keeps a
 * visible focus indicator either way.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import { BLOCKS_RUNTIME_CSS, buildCoreBlockRegistry, collectBlockAssets, renderBlocks, type Block } from '@typeroll/shared';
import { sanitizeBody } from '../../../site-template/src/lib/sanitize';

const registry = buildCoreBlockRegistry();
const reset = fs.readFileSync(new URL('../../../site-template/src/styles/reset.css', import.meta.url), 'utf8');
const heading = (id: string, data: Record<string, unknown> = {}): Block => ({
  id, type: 'core/rich_heading', data: { level: 'h2', html: `<a href="/avtal/">Avtal du behöver tänka på vid flytt</a>`, ...data },
});

async function open(page: Page, blocks: Block[], siteLinkDecoration = 'underline') {
  const assets = collectBlockAssets(blocks, registry, { renderVersion: 8 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${reset}${BLOCKS_RUNTIME_CSS}${assets.css}:root{--link-decoration:${siteLinkDecoration}}</style>`
    + sanitizeBody(renderBlocks(blocks, { registry, renderVersion: 8 })));
}
const decoration = (page: Page, id: string) => page.locator(`#${id} a`).evaluate(a => getComputedStyle(a).textDecorationLine);

for (const width of [390, 1280]) {
  test(`heading link underline follows the block setting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, [
      heading('site', { anchor_id: 'site' }),
      heading('none', { anchor_id: 'none', link_decoration: 'none' }),
      heading('hover', { anchor_id: 'hover', link_decoration: 'none', link_hover_decoration: 'underline' }),
    ]);
    expect(await decoration(page, 'site')).toBe('underline');
    expect(await decoration(page, 'none')).toBe('none');
    expect(await decoration(page, 'hover')).toBe('none');
    await page.locator('#hover a').hover();
    expect(await decoration(page, 'hover')).toBe('underline');
    // The focus indicator stays visible without an underline.
    // Keyboard first, so the focus counts as :focus-visible (Safari does not
    // move Tab focus to links by default).
    await page.keyboard.press('Shift');
    await page.locator('#none a').focus();
    const outline = await page.locator('#none a').evaluate(a => getComputedStyle(a).outlineStyle + ' ' + getComputedStyle(a).outlineWidth);
    expect(outline).toBe('solid 2px');
  });
}

test('without a block setting the heading link follows the site Link style', async ({ page }) => {
  await open(page, [heading('site', { anchor_id: 'site' })], 'none');
  expect(await decoration(page, 'site')).toBe('none');
});
