import { expect, test, type Page } from '@playwright/test';

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

  await page.goto('/app/sites/default/pages/posts');
  await expect(page.getByRole('heading', { name: /Pages/ })).toBeVisible();
  await expectInsideViewport(page, '.app-header__create-form');
  await expect(page.locator('.pages-table thead')).toHaveCSS('display', 'none');
  await expect(page.locator('.page-row').first()).toHaveCSS('display', 'grid');

  await page.goto('/app/sites/default/partials');
  await expect(page.getByRole('heading', { name: 'Global blocks' })).toBeVisible();
  await expectInsideViewport(page, '.app-header__create-form');

  await page.goto('/app/sites/default/blocks');
  const blockManager = page.locator('.block-type-manager');
  await expect(blockManager).toBeVisible();
  expect((await blockManager.evaluate((element) => getComputedStyle(element).gridTemplateColumns)).split(' ')).toHaveLength(1);
  await expectInsideViewport(page, '.block-type-manager');

  await page.goto('/app/sites/default/ai');
  await expect(page.getByRole('heading', { name: 'AI chat' })).toBeVisible();
  await expect(page.locator('.chat__input')).toBeVisible();
  await expectInsideViewport(page, '.chat__input-row');

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
