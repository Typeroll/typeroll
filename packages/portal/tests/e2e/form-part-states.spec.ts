/**
 * A style chosen for a form input never hides the field's invalid state:
 * the red border wins over the style's border, and the style applies again
 * once the value is valid.
 */
import { expect, test } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, resolveBreakpointWidths, siteStylesCss, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const styles = [{ id: 'field', name: 'Field', targets: ['container'], parts: ['form/text.input'], base: { border: { width: '2px', style: 'solid', color: '#1d4ed8' } } }];

test('the invalid border wins over an input style', async ({ page }) => {
  const blocks: Block[] = [{ id: 'name', type: 'form/text', data: { name: 'name', label: 'Name', required: true } }];
  const breakpoints = resolveBreakpointWidths(undefined);
  const assets = collectBlockAssets(blocks, registry, { renderVersion: 8, siteStyles: { styles, breakpoints } });
  const site = siteStylesCss(styles, { breakpoints, colors: {}, renderVersion: 8 });
  await page.setContent(`<!doctype html><style>${assets.css}${site}</style>${renderBlocks(blocks, { registry, renderVersion: 8 })}`);
  const input = page.locator('.form-input');
  const border = () => input.evaluate(element => getComputedStyle(element).borderTopColor);
  expect(await border()).toBe('rgb(29, 78, 216)');
  await page.locator('.form-field').evaluate(field => field.setAttribute('data-invalid', ''));
  expect(await border()).toBe('rgb(179, 38, 30)');
});
