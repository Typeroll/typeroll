import { expect, test, type Page } from '@playwright/test';
import { e2eStore } from './helpers/store';

// The AI chat is shown only where the owner organization added its own key
// and allowed the Site. Layout needs only that state, never a working key.
const aiSettings = 'organizations/default/ai_settings';
async function allowAiChatOnDefaultSite() {
  await e2eStore.set(`${aiSettings}/default`, {
    provider: 'anthropic', encrypted_api_key: 'synthetic-sealed-value-never-opened', key_last4: '0000',
    key_set_by: 'e2e', key_set_by_email: null, key_set_at: null, key_verified_at: null,
    site_access: { mode: 'selected', site_ids: ['default'] }, updated_at: '2026-10-22T00:00:00.000Z', updated_by: 'e2e',
  });
}
test.afterEach(async () => {
  for (const { id } of await e2eStore.list(`${aiSettings}`)) await e2eStore.deleteTree(`${aiSettings}/${id}`);
});

async function expectInsideViewport(page: Page, selector: string) {
  const metrics = await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      width: box.width,
      viewportWidth: document.documentElement.clientWidth,
    };
  });
  expect(metrics.width).toBeGreaterThan(0);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

test('key admin surfaces fit a 320px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });

  await page.goto('/app/sites/default/pages');
  await expect(page.getByRole('heading', { name: /Pages/ })).toBeVisible();
  await expectInsideViewport(page, '.app-header__create-form');
  await expect(page.locator('.pages-table thead')).toHaveCSS('display', 'none');
  await expect(page.locator('.page-row').first()).toHaveCSS('display', 'grid');

  await page.goto('/app/sites/default/partials');
  await expect(page.getByRole('heading', { name: 'Global blocks' })).toBeVisible();
  await expectInsideViewport(page, '.app-header__create-form');

  await page.goto('/app/sites/default/blocks');
  const blockManager = page.locator('.block-builder');
  await expect(blockManager).toBeVisible();
  expect((await blockManager.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).split(' ')).toHaveLength(1);
  await expectInsideViewport(page, '.block-builder');

  await allowAiChatOnDefaultSite();
  await page.goto('/app/sites/default/ai');
  await expect(page.getByRole('heading', { name: 'AI chat' })).toBeVisible();
  await expect(page.locator('.chat__input')).toBeVisible();
  await expectInsideViewport(page, '.chat__input-row');

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
