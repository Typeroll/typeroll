/**
 * Menu editor on the default site (dev session, bundled fixtures):
 *   - Menus list → create a menu
 *   - Add a page item and a custom link, refuse a script address
 *   - Indent the link under the page with the keyboard-operable buttons
 *   - Save, reload, and find the structure and the preview kept
 *   - Delete the menu with the in-page confirmation
 */
import { test, expect } from '@playwright/test';

test('build, save and delete a menu', async ({ page }) => {
  const name = `E2E menu ${Date.now()}`;
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  await page.goto('/app/sites/default/menus');
  await expect(page.getByRole('heading', { name: 'Menus', level: 1 })).toBeVisible();
  await page.getByLabel('Menu name').fill(name);
  await page.getByRole('button', { name: '+ New menu' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('No items yet.')).toBeVisible();

  // A page item from the page search.
  const add = page.locator('section', { has: page.getByRole('heading', { name: 'Add items' }) });
  const firstPage = add.getByRole('list', { name: 'Pages' }).getByRole('button').first();
  const pageTitle = (await firstPage.locator('strong').textContent())!.trim();
  await firstPage.click();
  const items = page.getByRole('list', { name: 'Menu items' });
  await expect(items.getByText(pageTitle, { exact: true })).toBeVisible();

  // A custom link: a script address is refused before it reaches the menu.
  await add.getByText('Custom link').click();
  await add.getByLabel('Address').fill('javascript:alert(1)');
  await add.getByLabel('Label').fill('Shop');
  await add.getByRole('button', { name: 'Add link' }).click();
  await expect(add.getByText('This kind of address is not allowed')).toBeVisible();
  await add.getByLabel('Address').fill('https://shop.example');
  await add.getByRole('button', { name: 'Add link' }).click();
  await expect(items.getByText('Shop', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Move Shop under the item above' }).click();
  await expect(page.getByRole('button', { name: 'Move Shop out one level' })).toBeEnabled();
  await expect(page.getByText('Unsaved changes')).toBeVisible();

  await page.getByRole('button', { name: 'Save menu' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Move Shop out one level' })).toBeEnabled();
  const preview = page.locator('.menu-editor__preview').first();
  await expect(preview.locator('ul li', { hasText: 'Shop' })).toBeVisible();

  await page.getByRole('button', { name: 'Delete this menu…' }).click();
  await page.getByRole('button', { name: 'Delete menu', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/sites\/default\/menus$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});
