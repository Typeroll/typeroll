import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady } from './helpers/ready';

const settingsFile = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/settings/default.json');

test('text on a theme colour shows both measures and saves a chosen colour', async ({ page }, info) => {
  const original = readFileSync(settingsFile, 'utf8');
  const settings = JSON.parse(original);
  // Render version 7 picks #111827 on teal by the WCAG 2 ratio.
  writeFileSync(settingsFile, JSON.stringify({ ...settings, render_version: 7, colors: { ...settings.colors, secondary: '#00a19c' } }));
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await gotoReady(page, '/app/sites/default/settings?section=design');
    const mode = page.getByLabel('Text on secondary', { exact: true });
    await expect(mode.locator('option:checked')).toHaveText('Automatic (#111827)');
    const field = page.locator('.field').filter({ has: mode });
    await expect(field).toContainText('APCA Lc 44.0, WCAG 2 5.56:1.');
    await expect(field).toContainText('Below Lc 60: hard to read as button text.');

    await mode.selectOption('custom');
    await page.getByLabel('Text on secondary colour').fill('#ffffff');
    await expect(field).toContainText('APCA Lc 63.9, WCAG 2 3.19:1. Readable as button text.');
    // The measure follows the palette picker above it.
    await page.locator('input[name="colors.secondary"]').fill('#1e293b');
    await expect(field).toContainText('APCA Lc 104.3');
    await page.locator('input[name="colors.secondary"]').fill('#00a19c');
    await page.locator('.card').filter({ has: mode }).screenshot({ path: info.outputPath('colors-card.png') });

    await page.getByRole('button', { name: 'Save Design' }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(saved.colors.on_secondary).toBe('#ffffff');
    expect(saved.colors.secondary).toBe('#00a19c');
    expect(saved.colors).not.toHaveProperty('on_primary');

    await gotoReady(page, '/app/sites/default/settings?section=design');
    await page.getByLabel('Text on secondary', { exact: true }).selectOption('auto');
    await page.getByRole('button', { name: 'Save Design' }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).colors).not.toHaveProperty('on_secondary');
  } finally {
    writeFileSync(settingsFile, original);
  }
});
