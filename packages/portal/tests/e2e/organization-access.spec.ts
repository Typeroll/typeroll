import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';
const origin = 'http://127.0.0.1:4322';
test.afterEach(() => {
  const root = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');
  for (const relative of ['organizations/trial-browser', 'organizations/trial-browser.json', 'user_organizations/typeroll-e2e-owner/organizations/trial-browser.json'])
    rmSync(path.join(root, relative), { recursive: true, force: true });
});
test('trial onboarding, expiry, export access and recovery remain clear on mobile and desktop', async ({ page }, info) => {
  await authenticatePersona(page, 'owner');
  await page.goto('/onboarding?add=1');
  await expect(page.getByText(/30-day free trial/)).toBeVisible();
  await page.getByLabel('Organization name', { exact: true }).fill('Trial Browser');
  await page.getByRole('button', { name: 'Create organization', exact: true }).last().click();
  await expect(page).toHaveURL(`${origin}/app`);
  await expect(page.getByText('Your free trial', { exact: true })).toBeVisible();
  const response = await page.request.get('/api/orgs/access');
  expect(response.status()).toBe(200);
  const { access } = await response.json();
  expect(access.state).toBe('trial');
  expect(Date.parse(access.ends_at) - Date.parse(access.starts_at)).toBe(30 * 86400000);
  await page.getByRole('link', { name: 'View access', exact: true }).click();
  await expect(page.getByText(/No payment card is required/)).toBeVisible();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width <= 960) await expect.poll(() => page.locator('.app-sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath(`trial-${width}.png`), fullPage: true });
  }
  // Synthetic filesystem data only; no production account or clock changes.
  const file = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/trial-browser.json');
  const org = JSON.parse(readFileSync(file, 'utf8'));
  const now = Date.now();
  org.service_access.initial_period = { starts_at: new Date(now - 31 * 86400000).toISOString(), ends_at: new Date(now - 86400000).toISOString(), read_until: new Date(now + 89 * 86400000).toISOString() };
  writeFileSync(file, JSON.stringify(org));
  await page.reload();
  await expect(page.getByText('Read and export access only.', { exact: true })).toBeVisible();
  const denied = await page.request.post('/api/sites/create', { headers: { Origin: origin }, data: { name: 'Must not create' } });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toMatchObject({ code: 'organization_trial_ended' });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.locator('.app-sidebar').evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath('expired-mobile.png'), fullPage: true });
  expect((await page.request.get('/api/orgs')).status()).toBe(200);
  org.service_access.override = { state: 'active', ends_at: null, read_until: null };
  writeFileSync(file, JSON.stringify(org));
  await page.reload();
  await expect(page.getByText('Editing and publishing are available.', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/orgs/access')).status()).toBe(200);
});
