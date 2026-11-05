import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_MAIN, e2eStore } from './helpers/store';

const pageDoc = `${DEFAULT_MAIN}/pages/css-page`;
const settingsDoc = `${DEFAULT_MAIN}/settings/default`;

test('site and page CSS are checked, saved and applied', async ({ page }, info) => {
  const originalSettings = await e2eStore.read(settingsDoc);
  await e2eStore.set(pageDoc, {
    id: 'css-page', title: 'CSS page', slug: 'css-page', status: 'draft', content_mode: 'blocks',
    blocks: [{ id: 'note', name: 'Note', type: 'core/heading', data: { text: 'Pricing note', level: 'h2' }, style_overrides: { custom_class: 'pricing-note' } }],
  });
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await gotoReady(page, '/app/sites/default/styles');
    const siteCss = page.getByLabel('CSS for every page');
    await siteCss.fill('.pricing-note { color: #b91c1c;\n');
    await expect(page.getByRole('alert').filter({ hasText: 'is not closed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save CSS' })).toBeDisabled();
    await siteCss.fill('[data-block="heading"] { letter-spacing: 0.02em }\n.pricing-note { color: rgb(185, 28, 28) }');
    await expect(page.getByText(/targets platform markup/)).toBeVisible();
    await page.getByRole('button', { name: 'Save CSS' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    expect((await e2eStore.read(settingsDoc)).custom_css).toContain('.pricing-note');
    await page.screenshot({ path: info.outputPath('site-css-1280.png'), fullPage: true });

    await gotoReady(page, '/app/sites/default/pages/css-page');
    const preview = page.frameLocator('iframe[title="Preview"]');
    const heading = preview.getByRole('heading', { name: 'Pricing note' });
    await expect(heading).toHaveCSS('color', 'rgb(185, 28, 28)');
    await page.getByText('Page CSS', { exact: true }).click();
    await expect(page.getByRole('button', { name: '.pricing-note' })).toBeVisible();
    await page.getByLabel('CSS for this page only').fill('.pricing-note { text-transform: uppercase }');
    await expect(heading).toHaveCSS('text-transform', 'uppercase', { timeout: 10_000 });
  } finally {
    await e2eStore.deleteTree(pageDoc);
    await e2eStore.set(settingsDoc, originalSettings);
  }
});
