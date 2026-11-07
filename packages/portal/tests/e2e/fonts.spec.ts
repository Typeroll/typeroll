/**
 * Fonts on the default site (dev session, bundled fixtures):
 *   - Fonts library: the licence must be confirmed; a TTF upload is read,
 *     converted to WOFF2 and listed under its family
 *   - Settings → Design: pick the uploaded family for headings and a catalog
 *     family for body text, save, and find both in the settings
 *   - The library shows the role that uses the family; deleting it warns
 */
import { test, expect } from '@playwright/test';
import { gotoReady } from './helpers/ready';
import { DEFAULT_MAIN, e2eStore } from './helpers/store';
import { testTrueTypeFont } from '../../src/__tests__/helpers/font-fixtures';

const settingsDoc = `${DEFAULT_MAIN}/settings/default`;

test('upload a font, use it for headings beside a catalog family, then delete it', async ({ page }, info) => {
  const family = `E2E Brand ${Date.now() % 100000}`;
  const original = await e2eStore.read(settingsDoc);
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, '/app/sites/default/fonts');
    await expect(page.getByRole('heading', { name: 'Fonts', level: 1 })).toBeVisible();

    await page.getByLabel('Font file').setInputFiles({ name: 'brand.ttf', mimeType: 'font/ttf', buffer: Buffer.from(testTrueTypeFont({ family, weight: 700 })) });
    await expect(page.getByLabel('Family name')).toHaveValue(family);
    await expect(page.getByLabel('Weight')).toHaveValue('700');
    await page.getByRole('button', { name: 'Upload font' }).click();
    await expect(page.getByText(/licence/i).and(page.locator('.fl-error'))).toBeVisible();
    await page.getByLabel('I confirm the font’s licence allows using it on this website').check();
    await page.getByRole('button', { name: 'Upload font' }).click();
    const card = page.getByRole('region', { name: family });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/TTF/);

    await gotoReady(page, '/app/sites/default/settings?section=design');
    await page.getByRole('button', { name: 'Change heading font' }).click();
    await page.getByRole('combobox', { name: 'Search fonts' }).fill(family);
    await page.getByRole('option', { name: new RegExp(family) }).first().click();
    await page.getByRole('button', { name: 'Change body font' }).click();
    await page.getByRole('combobox', { name: 'Search fonts' }).fill('Lora');
    await page.getByRole('option', { name: /^Lora/ }).first().click();
    await page.getByRole('button', { name: 'Save Design', exact: true }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    const saved = await e2eStore.read(settingsDoc);
    expect(saved.fonts).toMatchObject({ heading: family, body: 'Lora' });
    await page.screenshot({ path: info.outputPath('fonts-settings.png'), fullPage: true });

    await gotoReady(page, '/app/sites/default/fonts');
    await expect(card).toContainText(/heading/i);
    await page.screenshot({ path: info.outputPath('fonts-library.png'), fullPage: true });
    await card.getByRole('button', { name: /^Delete / }).click();
    await card.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText(/^Deleted\./)).toBeVisible();
    await expect(page.getByRole('region', { name: family })).toHaveCount(0);
  } finally { await e2eStore.set(settingsDoc, original); }
});
