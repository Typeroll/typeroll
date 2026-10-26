import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gotoReady } from './helpers/ready';
const settingsFile = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/default/sites/default/versions/main/settings/default.json');

test('sections retain edits and save only the selected section', async ({ page }, info) => {
  const original = readFileSync(settingsFile, 'utf8');
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoReady(page, '/app/sites/default/settings');
    await expect(page.locator('#site-settings-form')).toHaveAttribute('novalidate', '');
    await expect(page.getByRole('heading', { name: 'Identity' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Colors', exact: true })).toBeHidden();
    await page.getByLabel('Site name', { exact: true }).fill('Unsaved identity');
    await page.getByRole('link', { name: 'SEO', exact: true }).click();
    await page.getByLabel('Default meta description').fill('Saved separately');
    await page.getByRole('button', { name: 'Save SEO', exact: true }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).site_name).toBe(JSON.parse(original).site_name);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).default_meta_description).toBe('Saved separately');
    await page.getByRole('link', { name: /^General/ }).click();
    await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('Unsaved identity');
    await expect(page.locator('#settings-save-status')).toContainText('Unsaved changes');
    await page.getByRole('button', { name: 'Save General', exact: true }).click();
    await expect(page.locator('#settings-save-status')).toContainText('Saved.');
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).site_name).toBe('Unsaved identity');
    await page.screenshot({ path: info.outputPath('settings-desktop.png'), fullPage: true });
    await page.reload();
    await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('Unsaved identity');
  } finally { writeFileSync(settingsFile, original); }
});

for (const width of [375, 767, 768]) test(`settings navigation at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await gotoReady(page, '/app/sites/default/settings?section=design');
  await expect(page.getByRole('heading', { name: 'Colors', exact: true })).toBeVisible();
  if (width < 768) {
    await expect(page.getByLabel('Settings section', { exact: true })).toHaveValue('design');
    await page.getByLabel('Settings section', { exact: true }).selectOption('access');
  } else await page.getByRole('link', { name: 'Access & AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI agent instructions' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Colors', exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath(`settings-access-${width}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Colors', exact: true })).toBeVisible();
});

test('save failure keeps edits and shows an actionable inline error', async ({ page }) => {
  await gotoReady(page, '/app/sites/default/settings');
  await page.getByLabel('Site name', { exact: true }).fill('Keep my edits');
  await page.route('**/api/sites/default/settings', route => route.fulfill({ status: 409, body: 'Settings changed. Reload before saving.' }));
  await page.getByRole('button', { name: 'Save General' }).click();
  await expect(page.locator('#settings-save-status')).toHaveText('Settings changed. Reload before saving.');
  await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('Keep my edits');
});


test('edits during saving remain unsaved and label clicks affect the right control', async ({ page }) => {
  await gotoReady(page, '/app/sites/default/settings?section=integrations');
  const consent = page.getByRole('checkbox', { name: 'Enable cookie consent on this site' });
  const checked = await consent.isChecked();
  await page.getByText('Enable cookie consent on this site', { exact: true }).click();
  await expect(consent).toBeChecked({ checked: !checked });
  await page.getByRole('link', { name: /^General/ }).click();
  await page.getByLabel('Site name', { exact: true }).fill('First edit');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sites/default/settings', async route => {
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ saved: true, section: 'general' }) });
  });
  try {
    await page.getByRole('button', { name: 'Save General' }).click();
    await expect(page.locator('#settings-save-status')).toHaveText('Saving…');
    await page.getByLabel('Site name', { exact: true }).fill('Newer edit');
  } finally { release(); }
  await expect(page.locator('#settings-save-status')).toContainText('newer unsaved changes');
  await expect(page.getByLabel('Site name', { exact: true })).toHaveValue('Newer edit');
});
