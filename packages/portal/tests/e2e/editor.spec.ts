/**
 * Realistic editor flow:
 *   - Land on the default site dashboard
 *   - Open Pages list
 *   - Click into a page editor
 *   - Edit the title → autosaves to the working copy (unsaved-changes state)
 *   - Deliberately Save via the Publish menu → all-changes-saved state
 *   - Confirm the reloaded canvas is ready and shows the page
 *
 * Runs against the seeded "default" site + page from the bundled fixtures
 * (no auth needed; the dev session falls in automatically when Firebase is
 * unset).
 */
import { test, expect } from '@playwright/test';
import { waitForHydration } from './helpers/ready';

test('editor autosave → deliberate Save via Publish menu', async ({ page }) => {
  await page.goto('/app/sites/default');
  await expect(page).toHaveTitle(/Default|ACME|Site/i);

  // Walk to Pages list.
  await page.getByRole('link', { name: /pages/i }).first().click();
  await expect(page).toHaveURL(/\/pages/);

  // Open the seeded home page by URL — locating the row by its title is
  // brittle when a previous local run renamed it (the e2e server writes to
  // the bundled fixtures, so titles persist across runs).
  await page.goto('/app/sites/default/pages/home');
  await expect(page).toHaveURL(/\/pages\/[\w-]+/);

  // Wait for the React editor to hydrate — filling before hydration gets
  // silently reverted when React mounts with the server-rendered title.
  await expect(page.getByLabel('Page title', { exact: true })).toBeVisible();
  await waitForHydration(page);

  // Edit the title. The debounced autosave (~800ms) writes the working
  // copy, so the indicator lands in the unsaved-changes state — the
  // canonical page must be untouched until the deliberate Save.
  const newTitle = `E2E ${Date.now()}`;
  await page.getByLabel('Page title', { exact: true }).fill(newTitle);
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue(newTitle);
  await expect(page.locator('text=/Unsaved changes/i').first()).toBeVisible({ timeout: 10_000 });

  // Deliberate Save via the Publish ▾ menu.
  await page.getByRole('button', { name: /publish/i }).click();
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.locator('text=/All changes saved/i')).toBeVisible({ timeout: 10_000 });

  // The canvas shows the saved page. Save reloads it in a fresh frame, which
  // is still loading here: its `body` may be the new frame's empty initial
  // document, so wait for the canvas to report that it is ready (the editor
  // clears aria-busy on its ready message) and then for the page's blocks.
  const canvas = page.locator('iframe[title="Preview"]');
  await expect(canvas).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
  await expect(page.frameLocator('iframe[title="Preview"]').locator('[data-block-id]').first()).toBeVisible();

  // Restore the fixture title (best effort) so repeated local runs don't
  // drift the bundled fixtures further and further from the committed state.
  // Close the panel first — fill() focuses without a mousedown, so the
  // outside-click close never fires and a second Publish click would
  // toggle the panel shut instead of open.
  await page.keyboard.press('Escape');
  await page.getByLabel('Page title', { exact: true }).fill('Home');
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
