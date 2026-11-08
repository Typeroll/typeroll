/**
 * Snippet editor on the default site (dev session, bundled fixtures):
 *   - Snippets list → create a "By day/date" snippet
 *   - Fill Monday and a specific date, see them in the week preview
 *   - Save, reload, and find both kept
 *   - Delete the snippet with the in-page confirmation
 */
import { test, expect } from '@playwright/test';

test('create, fill, save and delete a dated snippet', async ({ page }) => {
  const name = `E2E lunch ${Date.now()}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('/app/sites/default/snippets');
  await expect(page.getByRole('heading', { name: 'Snippets', level: 1 })).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('radio', { name: /By day\/date/ }).check();
  await page.getByRole('button', { name: 'New snippet' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  const monday = page.getByRole('textbox', { name: 'Monday', exact: true });
  await monday.click();
  await page.keyboard.type('Meatballs');
  await page.getByRole('button', { name: 'Add a date' }).click();
  await expect(page.locator(':focus')).toHaveAttribute('type', 'date');
  await page.locator(':focus').fill('2026-12-24');
  const date = page.getByRole('textbox', { name: 'Content for Thu 24 Dec' });
  await date.click();
  await page.keyboard.type('Christmas buffet');
  await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Save snippet' }).click();
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /Saved\. (Live on the site within a minute|.*next publication)/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Monday', exact: true })).toHaveText('Meatballs');
  await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-12-24');
  await expect(page.getByRole('textbox', { name: 'Content for Thu 24 Dec' })).toHaveText('Christmas buffet');

  await page.getByRole('button', { name: 'Delete this snippet…' }).click();
  await page.getByRole('button', { name: 'Delete snippet', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/sites\/default\/snippets$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});
