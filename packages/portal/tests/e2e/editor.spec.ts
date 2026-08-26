/**
 * Realistic editor flow:
 *   - Land on the default site dashboard
 *   - Open Pages → Posts list
 *   - Click into a page editor
 *   - Edit the title → autosaves to the working copy (unsaved-changes state)
 *   - Deliberately Save via the Publish menu → all-changes-saved state
 *   - Confirm the preview iframe is loadable
 *
 * Runs against the seeded "default" site + page from the bundled fixtures
 * (no auth needed; the dev session falls in automatically when Firebase is
 * unset).
 */
import { test, expect } from '@playwright/test';

test('editor autosave → deliberate Save via Publish menu', async ({ page }) => {
  await page.goto('/app/sites/default');
  await expect(page).toHaveTitle(/Default|ACME|Site/i);

  // Walk to Pages → Posts list.
  await page.getByRole('link', { name: /pages/i }).first().click();
  await expect(page).toHaveURL(/\/pages/);

  // Open the seeded home page by URL — locating the row by its title is
  // brittle when a previous local run renamed it (the e2e server writes to
  // the bundled fixtures, so titles persist across runs).
  await page.goto('/app/sites/default/pages/home');
  await expect(page).toHaveURL(/\/pages\/[\w-]+/);

  // Wait for the React editor to hydrate — filling before hydration gets
  // silently reverted when React mounts with the server-rendered title.
  await expect(page.locator('.editor__title-input')).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Edit the title. The debounced autosave (~800ms) writes the working
  // copy, so the indicator lands in the unsaved-changes state — the
  // canonical page must be untouched until the deliberate Save.
  const newTitle = `E2E ${Date.now()}`;
  await page.locator('.editor__title-input').fill(newTitle);
  await expect(page.locator('.editor__title-input')).toHaveValue(newTitle);
  await expect(page.locator('text=/Unsaved changes/i').first()).toBeVisible({ timeout: 10_000 });

  // Deliberate Save via the Publish ▾ menu.
  await page.getByRole('button', { name: /publish/i }).click();
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('text=/All changes saved/i')).toBeVisible({ timeout: 10_000 });

  // Preview iframe should be loadable.
  const iframe = page.frameLocator('iframe[title="Page preview"]');
  await expect(iframe.locator('body')).toBeVisible();

  // Restore the fixture title (best effort) so repeated local runs don't
  // drift the bundled fixtures further and further from the committed state.
  // Close the panel first — fill() focuses without a mousedown, so the
  // outside-click close never fires and a second Publish click would
  // toggle the panel shut instead of open.
  await page.keyboard.press('Escape');
  await page.locator('.editor__title-input').fill('Home');
  await expect(page.locator('text=/Unsaved changes/i').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: /publish/i }).click();
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('text=/All changes saved/i')).toBeVisible({ timeout: 10_000 });
});

test('sitemap.xml renders for the default site (via portal preview)', async ({ page }) => {
  const res = await page.goto('/api/sites/default/preview/browse/');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.locator('body')).toBeVisible();
});
