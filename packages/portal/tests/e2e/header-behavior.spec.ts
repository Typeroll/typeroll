import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { buildCoreBlockRegistry, collectBlockAssets, renderBlocks, CONTENT_WELL_CSS, HEADER_BEHAVIOR_CSS, HEADER_BEHAVIOR_RUNTIME_JS, withHeaderBehaviorAttribute, type Block } from '@typeroll/shared';

const registry = buildCoreBlockRegistry();
const reset = fs.readFileSync(new URL('../../../site-template/src/styles/reset.css', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../../../site-template/src/styles/global.css', import.meta.url), 'utf8');
const menu: Block = { id: 'menu', type: 'core/navigation_menu', data: { collapse_below: '1024' }, children: [
  { id: 'links', type: 'core/navigation_links', data: { links: [{ label: 'Product', href: '#product' }, { label: 'Pricing', href: '#pricing' }], direction: 'row' } },
] };

function page_(behavior: string) {
  const assets = collectBlockAssets([menu], registry);
  const header = withHeaderBehaviorAttribute(`<header class="site-header" style="display:flex;justify-content:space-between;align-items:center;padding:16px;background:#fff"><span id="logo">Logo</span>${renderBlocks([menu], { registry })}</header>`, behavior);
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${reset}${css}${CONTENT_WELL_CSS}${assets.css}body{margin:0}${HEADER_BEHAVIOR_CSS}</style></head><body>${header}<main><div style="height:4000px">Long page</div></main></body></html>`;
}
const blockScript = `window.TyperollBlocks={register(id,init){document.querySelectorAll('[data-block-type="'+id+'"]').forEach(init)}};${registry.get('core/navigation_menu')!.script}`;

test('reveal_on_scroll_up hides the header on scroll down and returns it compact on scroll up', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setContent(page_('reveal_on_scroll_up'));
  await page.addScriptTag({ content: blockScript });
  await page.addScriptTag({ content: HEADER_BEHAVIOR_RUNTIME_JS });
  const header = page.locator('header');
  const toggle = page.getByRole('button', { name: 'Open menu' });
  // At the top: the full desktop menu, no toggle.
  await expect(toggle).toBeHidden();
  await expect(header).not.toHaveAttribute('data-header-compact', '');

  await page.mouse.wheel(0, 1500);
  await expect(header).toHaveAttribute('data-header-hidden', '');
  await expect.poll(() => header.evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(1);

  await page.mouse.wheel(0, -200);
  await expect(header).not.toHaveAttribute('data-header-hidden', '');
  await expect(header).toHaveAttribute('data-header-compact', '');
  await expect.poll(() => header.evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(0);
  // Compact: the menu opens from its toggle at desktop width too.
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('dialog.block-menu-dialog')).toHaveAttribute('open', '');
  await expect(page.locator('dialog.block-menu-dialog a')).toHaveCount(2);
});

test('a sticky header stays put and a static header gets no behaviour', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.setContent(page_('sticky'));
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.locator('header').evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(0);
  await page.setContent(page_('static'));
  expect(await page.locator('header').getAttribute('data-header-behavior')).toBeNull();
});
