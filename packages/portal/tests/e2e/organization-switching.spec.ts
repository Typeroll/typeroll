import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';

const origin = 'http://127.0.0.1:4322';
const fixtureRoot = path.join(os.tmpdir(), 'typeroll-e2e-fixtures');

test('creates another organization, switches back on desktop and mobile, and rejects cross-organization access', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.goto('/app');
  expect((await page.request.get('/api/sites/e2e-core-site/pages')).status()).toBe(200);
  await page.getByRole('link', { name: 'Create or join organization' }).click();
  await page.getByLabel('Organization name', { exact: true }).fill('Browser Customer');
  await page.getByRole('button', { name: 'Create organization', exact: true }).last().click();
  await expect(page).toHaveURL(`${origin}/app`);
  await expect(page.getByLabel('Organization', { exact: true })).toHaveValue('browser-customer');
  const listing = await page.request.get('/api/orgs');
  expect(listing.headers()['cache-control']).toBe('no-store');
  expect((await listing.json()).organizations.map((org: { id: string }) => org.id)).toEqual(['browser-customer', 'e2e-core']);
  expect((await page.request.get('/api/sites/e2e-core-site/pages')).status()).toBe(404);
  expect((await page.request.post('/api/orgs/switch', { headers: { Origin: origin }, data: { orgId: 'e2e-outsider' } })).status()).toBe(404);
  expect((await page.request.post('/api/orgs/switch', { headers: { Origin: 'https://attacker.invalid' }, data: { orgId: 'e2e-core' } })).status()).toBe(403);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    if (width < 768) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByLabel('Organization', { exact: true }).selectOption('e2e-core');
    await expect(page.getByLabel('Organization', { exact: true })).toHaveValue('e2e-core');
    expect((await page.request.get('/api/orgs/publishing')).status()).toBe(200);
    if (width < 768) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`organization-switcher-${width}.png`), animations: 'disabled' });
    await page.getByLabel('Organization', { exact: true }).selectOption('browser-customer');
    await expect(page.getByLabel('Organization', { exact: true })).toHaveValue('browser-customer');
  }
});

test('an existing owner joins as editor, keeps their first membership, and loses revoked access', async ({ page, browser }) => {
  const customer = await browser.newPage();
  await authenticatePersona(customer, 'outsider');
  const invite = await customer.request.post('/api/orgs/invite/generate', { headers: { Origin: origin }, data: {} });
  expect(invite.status()).toBe(200);
  const { inviteUrl } = await invite.json();
  await authenticatePersona(page, 'owner');
  await page.goto(inviteUrl);
  await page.getByRole('button', { name: 'Join organization', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/app`);
  expect((await page.request.get('/api/orgs/publishing')).status()).toBe(403);
  expect((await page.request.get('/api/orgs')).status()).toBe(200);
  const membership = path.join(fixtureRoot, 'organizations/e2e-outsider/members/typeroll-e2e-owner.json');
  rmSync(membership);
  expect((await page.request.get('/api/orgs/publishing')).status()).toBe(403);
  await page.goto('/app');
  await expect(page).toHaveURL(`${origin}/onboarding`);
  await page.getByLabel('Organization', { exact: true }).selectOption('e2e-core');
  await expect(page).toHaveURL(`${origin}/app`);
  await customer.close();
});

test('a new account recovers its organization after logout and a fresh login without organization claims', async ({ page }) => {
  try {
    await authenticatePersona(page, 'pending');
    await page.goto('/app');
    await expect(page).toHaveURL(`${origin}/onboarding`);
    await page.getByLabel('Organization name', { exact: true }).fill('First Organization');
    await page.getByRole('button', { name: 'Create organization', exact: true }).last().click();
    await expect(page).toHaveURL(`${origin}/app`);
    await expect(page.getByLabel('Organization', { exact: true })).toHaveValue('first-organization');
    await page.request.post('/api/auth/logout', { headers: { Origin: origin } });
    expect((await page.context().cookies()).some(cookie => cookie.name === 'typeroll_organization')).toBe(false);
    await authenticatePersona(page, 'pending');
    await page.goto('/app');
    await expect(page).toHaveURL(`${origin}/app`);
    await expect(page.getByLabel('Organization', { exact: true })).toHaveValue('first-organization');
    expect((await page.request.get('/api/orgs/publishing')).status()).toBe(200);
  } finally {
    for (const relative of ['organizations/first-organization', 'user_organizations/typeroll-e2e-pending']) {
      rmSync(path.join(fixtureRoot, relative), { recursive: true, force: true });
      rmSync(path.join(fixtureRoot, `${relative}.json`), { force: true });
    }
  }
});
