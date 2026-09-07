import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';

const connections = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/e2e-core/publishing_connections');

test('organization owner sees masked account metadata and can disconnect without deleting provider resources', async ({ page }) => {
  mkdirSync(connections, { recursive: true });
  const file = path.join(connections, 'cloudflare.json');
  writeFileSync(file, JSON.stringify({ revision: 'synthetic-connection-revision', status: 'connected',
    cloudflare: { account_id: 'a'.repeat(32), account_name: 'Synthetic agency', bucket: 'agency-media', endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com` },
    encrypted_credentials: 'synthetic-encrypted-secret-that-must-stay-on-server' }));
  try {
    await authenticatePersona(page, 'owner');
    const response = await page.goto('/app/settings/publishing');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Publishing accounts' })).toBeVisible();
    await expect(page.getByText('API and R2 credentials are saved and hidden.', { exact: false })).toBeVisible();
    expect(await page.content()).not.toContain('synthetic-encrypted-secret');
    const summary = await page.request.get('/api/orgs/publishing');
    expect(summary.headers()['cache-control']).toBe('no-store');
    expect(await summary.text()).not.toContain('encrypted_credentials');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.getByRole('button', { name: 'Disconnect Cloudflare' }).click();
    await expect(page.getByRole('status')).toContainText('Disconnected');
    await expect(page.getByRole('button', { name: 'Disconnect Cloudflare' })).toHaveCount(0);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.status).toBe('disconnected');
    expect(stored.encrypted_credentials).toBeNull();
    expect(stored.cloudflare.bucket).toBe('agency-media');
  } finally { rmSync(file, { force: true }); }
});

test('editor cannot view or mutate organization publishing credentials', async ({ page }) => {
  await authenticatePersona(page, 'editor');
  expect((await page.goto('/app/settings/publishing'))?.status()).toBe(403);
  expect((await page.request.get('/api/orgs/publishing')).status()).toBe(403);
  expect((await page.request.post('/api/orgs/publishing/github', {
    headers: { Origin: 'http://127.0.0.1:4322' }, data: { owner: 'synthetic-agency' },
  })).status()).toBe(403);
});

test('Cloudflare connection form clears credentials after success and retains the reusable account identity', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let connected = false;
  let submitted: Record<string, unknown> | undefined;
  // Exercise the browser form against its API boundary; provider authorization
  // and persistence are covered by the real route tests, not by this UI fixture.
  await page.route('**/api/orgs/publishing', async (route) => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    await route.fulfill({ json: { github: empty, cloudflare: connected ? { ...empty, status: 'connected', credentials_saved: true,
      cloudflare: { account_id: 'a'.repeat(32), account_name: 'Synthetic agency', bucket: 'agency-media' } } : empty,
      github_setup: { available: false, install_url: null }, encryption_available: true } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', async (route) => {
    submitted = route.request().postDataJSON(); connected = true;
    await route.fulfill({ json: { connected: true } });
  });
  await page.goto('/app/settings/publishing');
  await page.getByLabel('Cloudflare Account ID').fill('a'.repeat(32));
  await page.getByLabel('R2 bucket name').fill('agency-media');
  for (const [label, value] of [['Cloudflare API token', 'synthetic-token'], ['R2 Access Key ID', 'synthetic-access'], ['R2 Secret Access Key', 'synthetic-secret']]) {
    await expect(page.getByLabel(label)).toHaveAttribute('type', 'password');
    await page.getByLabel(label).fill(value);
  }
  await page.getByRole('button', { name: 'Verify and save Cloudflare' }).click();
  await expect(page.getByRole('status')).toContainText('Cloudflare and R2 connected');
  expect(submitted).toMatchObject({ api_token: 'synthetic-token', access_key_id: 'synthetic-access', secret_access_key: 'synthetic-secret', revision: 'synthetic-revision' });
  for (const label of ['Cloudflare API token', 'R2 Access Key ID', 'R2 Secret Access Key']) await expect(page.getByLabel(label)).toHaveValue('');
  await expect(page.getByLabel('Cloudflare Account ID')).toHaveValue('a'.repeat(32));
  await expect(page.getByLabel('R2 bucket name')).toHaveValue('agency-media');
});

test('GitHub starts with sign-in and offers verified organizations instead of a text field', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let selecting = false;
  let connected = false;
  let submitted: Record<string, unknown> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: { github: connected ? { ...empty, status: 'connected', github: { owner: 'second-agency' } } : empty,
      cloudflare: empty, encryption_available: true,
      github_setup: { available: true, install_url: 'https://github.com/apps/synthetic-publisher/installations/new' },
      github_choices: selecting && !connected ? [{ owner: 'first-agency', installation_id: '34' }, { owner: 'second-agency', installation_id: '35' }] : [] } });
  });
  await page.route('**/api/orgs/publishing/github', route => {
    submitted = route.request().postDataJSON();
    if (submitted?.installation_id) { connected = true; return route.fulfill({ json: { connected: true } }); }
    selecting = true;
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing?github=select' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/settings/publishing');
  await expect(page.getByLabel('GitHub organization name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub organization' })).toBeVisible();
  expect(submitted).not.toHaveProperty('owner');
  await page.screenshot({ path: testInfo.outputPath('github-organization-choice-mobile.png') });
  await page.getByRole('combobox', { name: 'Choose a GitHub organization' }).selectOption('35');
  await page.getByRole('button', { name: 'Connect selected organization' }).click();
  await expect(page.getByRole('status')).toContainText('GitHub connected');
  expect(submitted).toMatchObject({ installation_id: '35' });
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub organization' })).toHaveCount(0);
  await page.goto('/app/settings/publishing?github=owner_required');
  await expect(page.getByRole('alert')).toContainText('Sign in to GitHub as an owner');
  await page.getByLabel('Cloudflare Account ID').scrollIntoViewIfNeeded();
  await expect(page.locator('#cf-account-help')).toContainText('Search → Copy account ID');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloudflare-account-help-mobile.png') });
  expect(errors).toEqual([]);
});
