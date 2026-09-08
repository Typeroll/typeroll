import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

test('organization domain form saves the exact hostname and remains usable on mobile', async ({ page }) => {
  let domain = { revision: 'initial', default_domain: null as string | null, dns_mode: 'automatic', verified_at: null };
  await page.route('**/api/orgs/publishing/domains', async route => {
    if (route.request().method() === 'PUT') {
      const submitted = route.request().postDataJSON();
      expect(submitted.revision).toBe(domain.revision);
      expect(submitted.default_domain).toBe('Media.example.com');
      domain = { ...domain, revision: 'saved', default_domain: 'media.example.com', dns_mode: submitted.dns_mode };
    }
    await route.fulfill({ json: domain });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Default domain', exact: true }) });
  await expect(section.getByLabel('Organization default domain')).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(section.getByRole('button', { name: 'Save domain settings' })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await section.getByLabel('Organization default domain').fill('Media.example.com');
  await section.getByLabel('DNS management').selectOption('external');
  await section.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(section.getByRole('status')).toContainText('Default domain saved');
  await expect(section.getByLabel('Organization default domain')).toHaveValue('media.example.com');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'test-results/publishing-domains-mobile.png', fullPage: true, animations: 'disabled' });
});

test('organization domain errors stay visible without losing the entered hostname', async ({ page }) => {
  await page.route('**/api/orgs/publishing/domains', async route => {
    await route.fulfill(route.request().method() === 'PUT'
      ? { status: 400, json: { error: 'Enter a hostname such as www.example.com, without https:// or a path.' } }
      : { json: { revision: 'initial', default_domain: null, dns_mode: 'automatic', verified_at: null } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  await page.getByLabel('Organization default domain').fill('https://media.example.com/path');
  await page.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(page.getByRole('alert')).toContainText('without https:// or a path');
  await expect(page.getByLabel('Organization default domain')).toHaveValue('https://media.example.com/path');
});

test('organization domain settings reject a non-admin session', async ({ page }) => {
  await authenticatePersona(page, 'editor');
  expect((await page.request.get('/api/orgs/publishing/domains')).status()).toBe(403);
  expect((await page.request.put('/api/orgs/publishing/domains', {
    headers: { Origin: 'http://127.0.0.1:4322' }, data: { revision: 'initial', default_domain: 'media.example.com', dns_mode: 'automatic' },
  })).status()).toBe(403);
});
