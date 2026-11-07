/**
 * Site fields on the default site (dev session, an administrator):
 *   - Define a settings page with a checkbox and opening hours
 *   - Fill in the values, save, reload and find them kept
 *   - Delete the page again, confirming that its values go too
 */
import { test, expect } from '@playwright/test';
import { gotoReady, reloadReady } from './helpers/ready';

test('define a settings page, fill it in and keep the values', async ({ page }) => {
  const title = `E2E settings ${Date.now()}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await gotoReady(page, '/app/sites/default/site-fields');
  await expect(page.getByRole('heading', { name: 'Site fields', level: 1 })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create a settings page' });
  if (await create.isVisible()) await create.click();
  else {
    await page.getByRole('button', { name: 'Define fields' }).click();
    await page.getByRole('button', { name: 'New settings page' }).click();
  }
  await page.getByLabel('Title', { exact: true }).fill(title);

  // A checkbox field, named after its label.
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  await page.getByLabel('Label', { exact: true }).fill('Show booking');
  await page.getByLabel('Type', { exact: true }).selectOption('boolean');
  const name = await page.getByLabel('Name', { exact: true }).inputValue();
  expect(name).toMatch(/^show_booking(_\d+)?$/);
  await expect(page.getByText(`{{site.fields.${name}}}`)).toBeVisible();

  await page.getByRole('button', { name: 'Add opening hours' }).click();
  await expect(page.getByText(/opening_hours(_\d+)? · Opening hours/)).toBeVisible();
  await page.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('Saved the settings pages and their fields.')).toBeVisible();
  await expect(page.getByRole('tab', { name: title })).toHaveAttribute('aria-selected', 'true');

  // Values: the checkbox, a week and a holiday.
  const panel = page.getByRole('tabpanel');
  await panel.getByRole('checkbox', { name: 'Show booking' }).check();
  await panel.getByLabel('Monday opens').fill('09:00');
  await panel.getByLabel('Monday closes').fill('17:00');
  await panel.getByRole('button', { name: 'Copy Monday to Tuesday–Friday' }).click();
  await expect(panel.getByLabel('Friday closes')).toHaveValue('17:00');
  await panel.getByLabel('Sunday closed').check();
  await expect(panel.getByLabel('Sunday opens')).toBeDisabled();
  await panel.getByRole('button', { name: 'Add exception' }).click();
  await panel.getByLabel('Date of exception 1').fill('2026-12-24');
  await panel.getByLabel('Note for 2026-12-24').fill('Christmas Eve');
  await expect(page.getByText('Unsaved changes in 1 page')).toBeVisible();
  await panel.getByRole('button', { name: `Save ${title}` }).click();
  await expect(page.getByText(`Saved “${title}”.`)).toBeVisible();

  await reloadReady(page);
  await page.getByRole('tab', { name: title }).click();
  const saved = page.getByRole('tabpanel');
  await expect(saved.getByRole('checkbox', { name: 'Show booking' })).toBeChecked();
  await expect(saved.getByLabel('Monday opens')).toHaveValue('09:00');
  await expect(saved.getByLabel('Thursday closes')).toHaveValue('17:00');
  await expect(saved.getByLabel('Sunday closed')).toBeChecked();
  await expect(saved.getByLabel('Note for 2026-12-24')).toHaveValue('Christmas Eve');

  // Clean up: deleting the page deletes its values, which saving asks to confirm.
  await page.getByRole('button', { name: 'Define fields' }).click();
  await page.getByRole('tab', { name: title }).click();
  await page.getByRole('button', { name: 'Delete settings page…' }).click();
  await page.getByRole('button', { name: 'Delete settings page', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save fields' })).toBeDisabled();
  await page.getByLabel(/Delete these values when I save/).check();
  await page.getByRole('button', { name: 'Save fields' }).click();
  await expect(page.getByText('Saved the settings pages and their fields.')).toBeVisible();
  await expect(page.getByRole('tab', { name: title })).toHaveCount(0);
});
