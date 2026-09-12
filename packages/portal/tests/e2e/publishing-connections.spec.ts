import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';

const connections = path.join(os.tmpdir(), 'typeroll-e2e-fixtures/organizations/e2e-core/publishing_connections');

// These journeys exercise account connections against synthetic provider data.
// Domain discovery has its own API and browser coverage, so keep that boundary
// consistent with the synthetic account instead of calling Cloudflare here.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: { account_name: 'Example', zones: [] } }));
});


test('organization owner sees masked account metadata and can disconnect without deleting provider resources', async ({ page }) => {
  mkdirSync(connections, { recursive: true });
  const file = path.join(connections, 'cloudflare.json');
  writeFileSync(file, JSON.stringify({ revision: 'synthetic-connection-revision', status: 'connected',
    cloudflare: { account_id: 'a'.repeat(32), account_name: 'Synthetic agency', bucket: 'agency-media', public_bucket: 'public-media', endpoint: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com` },
    encrypted_credentials: 'synthetic-encrypted-secret-that-must-stay-on-server' }));
  try {
    await authenticatePersona(page, 'owner');
    const response = await page.goto('/app/settings/publishing');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Publishing' })).toBeVisible();
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
    await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cloudflare account', exact: true }) }).getByRole('status')).toContainText('Disconnected');
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
    await route.fulfill({ json: { github: empty, cloudflare: connected ? { ...empty, status: 'connected', credentials_saved: true, media_ready: true,
      cloudflare: { account_id: 'a'.repeat(32), account_name: 'Synthetic agency', bucket: 'agency-media', public_bucket: 'public-media' } } : empty,
      github_setup: { available: false, install_url: null }, encryption_available: true } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', async (route) => {
    submitted = route.request().postDataJSON(); connected = true;
    await route.fulfill({ json: { connected: true } });
  });
  await page.goto('/app/settings/publishing');
  await page.getByText('Advanced: connect with existing API and R2 keys', { exact: true }).click();
  await page.getByLabel('Cloudflare Account ID').fill('a'.repeat(32));
  await page.getByLabel('R2 bucket name').fill('agency-media');
  for (const [label, value] of [['Cloudflare API token', 'synthetic-token'], ['R2 Access Key ID', 'synthetic-access'], ['R2 Secret Access Key', 'synthetic-secret']]) {
    await expect(page.getByLabel(label)).toHaveAttribute('type', 'password');
    await page.getByLabel(label).fill(value);
  }
  await page.getByRole('button', { name: 'Verify and save Cloudflare' }).click();
  await expect(page.getByRole('status')).toContainText('Cloudflare connection updated');
  expect(submitted).toMatchObject({ api_token: 'synthetic-token', access_key_id: 'synthetic-access', secret_access_key: 'synthetic-secret', revision: 'synthetic-revision' });
  for (const label of ['Cloudflare API token', 'R2 Access Key ID', 'R2 Secret Access Key']) await expect(page.getByLabel(label)).toHaveValue('');
  await expect(page.getByLabel('Cloudflare Account ID')).toHaveValue('a'.repeat(32));
  await expect(page.getByLabel('R2 bucket name')).toHaveValue('agency-media');
});

for (const accountType of ['Organization', 'User'] as const) test(`GitHub starts with sign-in and connects a verified ${accountType} account without a text field`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let selecting = false;
  let connected = false;
  let submitted: Record<string, unknown> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: { github: connected ? { ...empty, status: 'connected', github: { owner: 'synthetic-selected', account_type: accountType, repository_creation_state: 'ready' } } : empty,
      cloudflare: empty, encryption_available: true,
      github_setup: { available: true, install_url: 'https://github.com/apps/synthetic-publisher/installations/new' },
      github_choices: selecting && !connected ? [{ owner: 'synthetic-company', installation_id: '34', account_type: 'Organization' }, { owner: 'synthetic-selected', installation_id: '35', account_type: accountType }] : [] } });
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
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub account' })).toBeVisible();
  expect(submitted).not.toHaveProperty('owner');
  await page.screenshot({ path: testInfo.outputPath('github-account-choice-mobile.png') });
  await page.getByRole('combobox', { name: 'Choose a GitHub account' }).selectOption('35');
  await page.getByRole('button', { name: 'Connect selected account' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'GitHub connected' })).toBeVisible();
  expect(submitted).toMatchObject({ installation_id: '35' });
  if (accountType === 'User') await expect(page.getByText('Personal account authorization', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('github-account-connected-mobile.png') });
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub account' })).toHaveCount(0);
  await page.goto('/app/settings/publishing?github=owner_required');
  await expect(page.getByRole('alert').filter({ hasText: 'Sign in to your personal GitHub account' })).toBeVisible();
  await page.getByText('Advanced: connect with existing API and R2 keys', { exact: true }).click();
  await page.getByLabel('Cloudflare Account ID').scrollIntoViewIfNeeded();
  await expect(page.locator('#cf-account-help')).toContainText('Search → Copy account ID');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloudflare-account-help-mobile.png') });
  expect(errors).toEqual([]);
});

test('Cloudflare sign-in discovers accounts and prepares reusable media access on mobile', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let phase: 'initial' | 'select' | 'connected' | 'bucket' | 'ready' = 'initial';
  let githubConnected = true;
  let activationRequired = true;
  let keysRejected = true;
  const submitted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    const connected = ['connected', 'bucket', 'ready'].includes(phase);
    return route.fulfill({ json: { github: githubConnected ? { ...empty, status: 'connected', github: { owner: 'synthetic-agency' } } : empty, github_setup: { available: false, install_url: null }, github_choices: [],
      encryption_available: true, cloudflare_setup: { available: true },
      cloudflare_choices: phase === 'select' ? [{ id: 'a'.repeat(32), name: 'First agency' }, { id: 'b'.repeat(32), name: 'Selected agency with a longer account name' }] : [],
      cloudflare: connected ? { ...empty, status: 'connected', credentials_saved: true, auth_method: 'oauth', media_ready: phase === 'ready',
        cloudflare: { account_id: 'b'.repeat(32), account_name: 'Selected agency with a longer account name', bucket: phase === 'connected' ? '' : 'agency-media', public_bucket: phase === 'connected' ? '' : 'public-media' } } : empty } });
  });
  await page.route('**/api/orgs/publishing/github', route => {
    githubConnected = false;
    return route.fulfill({ json: { disconnected: true } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    const body = route.request().postDataJSON(); submitted.push(body);
    if (body.action === 'start') { phase = 'select'; return route.fulfill({ json: { authorization_url: '/app/settings/publishing?cloudflare=select' } }); }
    if (body.action === 'select') phase = 'connected';
    if (body.action === 'prepare_media') {
      if (activationRequired) {
        return route.fulfill({ status: 409, json: { code: 'r2_activation_required', error: 'R2 subscription activation required.' } });
      }
      phase = 'bucket';
    }
    if (body.action === 'save_media') {
      if (keysRejected) {
        keysRejected = false;
        return route.fulfill({ status: 502, json: { code: 'r2_verification_failed', error: 'R2 verification failed: could not read the test file from bucket typeroll-public-09b4b053a9a4768f (account bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb). AccessDenied, HTTP 403. Cloudflare denied this operation. Check that the R2 token has Object Read & Write access to this bucket. These submitted keys have not been saved.' } });
      }
      phase = 'ready';
    }
    return route.fulfill({ json: { connected: true } });
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/app/settings/publishing');
  for (const name of ['GitHub account', 'Cloudflare account', 'Media storage', 'Domains']) await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
  await expect(page.locator('details[open]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'GitHub account', exact: true })).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('region', { name: 'Cloudflare account', exact: true })).toHaveAttribute('data-state', 'error');
  await expect(page.getByRole('region', { name: 'Media storage', exact: true })).toHaveAttribute('data-state', 'error');
  await expect(page.getByLabel('Cloudflare Account ID')).not.toBeVisible();
  await page.getByRole('button', { name: 'Connect Cloudflare', exact: true }).click();
  expect(submitted[0]).toMatchObject({ action: 'start' });
  expect(submitted[0]).not.toHaveProperty('account_id');
  const choice = page.getByRole('combobox', { name: 'Choose a Cloudflare account' });
  await choice.selectOption('b'.repeat(32));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloudflare-account-choice-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Connect selected account' }).click();
  const media = page.getByRole('region', { name: 'Media storage' });
  const alert = media.getByRole('alert');
  await expect(page.getByRole('region', { name: 'Cloudflare account', exact: true })).toHaveAttribute('data-state', 'ready');
  await expect(alert).toContainText('R2 is not activated for Selected agency');
  await expect(media).toHaveAttribute('data-state', 'error');
  await expect(alert).toBeFocused();
  await media.getByText('How to activate R2', { exact: true }).click();
  await expect(alert).toContainText('subscription checkout');
  await expect(alert).toContainText('billing details');
  await expect(alert.getByText('R2 is not activated', { exact: false })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('r2-activation-error-mobile.png'), animations: 'disabled' });
  expect(submitted.filter(body => body.action === 'prepare_media')).toHaveLength(1);
  await page.getByRole('button', { name: 'Disconnect GitHub' }).click();
  await expect(alert).toContainText('R2 is not activated');
  await expect(page.getByText('R2 storage prepared', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open R2 activation in Selected agency with a longer account name ↗' })).toHaveAttribute('href', `https://dash.cloudflare.com/${'b'.repeat(32)}/r2/overview`);
  await page.getByRole('button', { name: 'I’ve activated R2 — check again' }).click();
  await expect(alert).toContainText('R2 is not activated');
  await expect(page.getByText('R2 storage prepared', { exact: true })).toHaveCount(0);
  activationRequired = false;
  await page.getByRole('button', { name: 'I’ve activated R2 — check again' }).click();
  await expect(media.getByRole('status')).toContainText('R2 is activated and your storage is prepared');
  await expect(page.getByRole('button', { name: 'I’ve activated R2 — check again' })).toHaveCount(0);
  await expect(page.getByText('Create one R2 upload token', { exact: false })).not.toBeVisible();
  await media.getByText('How to create R2 upload keys', { exact: true }).click();
  await expect(page.getByText('Create one R2 upload token', { exact: false })).toBeVisible();
  await expect(page.getByText('R2 connected', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '1. Activate R2 in Cloudflare' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Finish R2 setup' })).toBeVisible();
  await expect(media).toContainText('Object Read & Write');
  await expect(media).toContainText('Manage API Tokens');
  await expect(page.locator('#oauth-r2-access')).toHaveAttribute('type', 'password');
  await page.locator('#oauth-r2-access').fill('synthetic-access');
  await page.locator('#oauth-r2-secret').fill('synthetic-secret');
  await page.getByRole('button', { name: 'Verify keys and finish setup' }).click();
  await expect(media.getByRole('alert')).toContainText('could not read the test file from bucket typeroll-public-09b4b053a9a4768f');
  await expect(media.getByRole('alert')).toBeFocused();
  await expect(media.getByRole('alert')).not.toContainText('R2 is not activated');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await media.getByRole('alert').evaluate(node => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    await media.getByRole('alert').screenshot({ path: testInfo.outputPath(`r2-verification-error-${width}.png`) });
  }
  await expect(page.locator('#oauth-r2-access')).toHaveValue('synthetic-access');
  await expect(media.getByText('R2 connected', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Verify keys and finish setup' }).click();
  await expect(page.getByRole('region', { name: 'Media storage' }).getByText('R2 connected', { exact: true })).toBeVisible();
  await expect(media).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: 'I’ve activated R2 — check again' })).toHaveCount(0);
  await expect(page.locator('#oauth-r2-access')).not.toBeVisible();
  await expect(page.locator('#oauth-r2-secret')).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Media storage' }).getByText('R2 connected', { exact: true })).toBeVisible();
  await expect(media).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#oauth-r2-access')).toHaveValue('');
  await expect(page.locator('#oauth-r2-secret')).toHaveValue('');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(async () => { window.scrollTo(0, 0); await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: testInfo.outputPath(`cloudflare-media-ready-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  expect(submitted.map(body => body.action)).toEqual(['start', 'select', 'prepare_media', 'prepare_media', 'prepare_media', 'save_media', 'save_media']);
  expect(errors).toEqual([]);
});

test('already active R2 is prepared automatically without activation instructions', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let prepared = false;
  let checks = 0;
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: { github: empty, github_setup: { available: false }, github_choices: [], encryption_available: true,
      cloudflare_setup: { available: true }, cloudflare: { ...empty, status: 'connected', auth_method: 'oauth', credentials_saved: true,
        cloudflare: { account_id: 'b'.repeat(32), account_name: 'Active organization', bucket: prepared ? 'organization-media' : '', public_bucket: prepared ? 'organization-public-media' : '' } } } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    expect(route.request().postDataJSON().action).toBe('prepare_media');
    checks++; prepared = true;
    return route.fulfill({ json: { bucket: 'organization-media', public_bucket: 'organization-public-media' } });
  });
  await page.goto('/app/settings/publishing');
  await expect(page.getByRole('heading', { name: 'Finish R2 setup' })).toBeVisible();
  expect(checks).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('subscription checkout', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'I’ve activated R2 — check again' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Finish R2 setup' })).toBeVisible();
  expect(checks).toBe(1);
});

test('owners can find GitHub and Cloudflare directly from navigation and site settings', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/app/sites/e2e-core-site/pages');
    if (width < 768) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const link = page.getByRole('link', { name: 'Publishing', exact: true });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`publishing-navigation-${width}.png`) });
    await link.click();
    await expect(page.getByRole('heading', { name: 'Publishing', exact: true })).toBeVisible();
    await expect(page.getByText('GitHub and Cloudflare connections for', { exact: false })).toContainText('Typeroll E2E Core');
  }
  for (const route of ['/app/settings', '/app/sites/e2e-core-site/settings']) {
    await page.goto(route);
    await page.getByRole('link', { name: 'Open Publishing', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/settings\/publishing$/);
  }
  await authenticatePersona(page, 'editor');
  await page.goto('/app/settings');
  await expect(page.getByRole('link', { name: 'Publishing', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Publishing', exact: true })).toHaveCount(0);
  await expect(page.getByText('Ask an organization owner or admin to connect these accounts.')).toBeVisible();
});

test('media migration progress updates automatically until completion', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let completed = false, emptyLibrary = false;
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: { github: empty, github_setup: { available: false }, github_choices: [], encryption_available: true,
      cloudflare: { ...empty, status: 'connected', media_ready: true, cloudflare: { account_id: 'b'.repeat(32), account_name: 'Test organization', bucket: 'private-media', public_bucket: 'public-media' } },
      media_migration: { state: completed ? 'complete' : 'running', copied_files: emptyLibrary ? 0 : completed ? 3 : 1, pending_files: completed ? 0 : 2, error: null } } });
  });
  await page.goto('/app/settings/publishing');
  await expect(page.getByText('Moving existing originals to R2: 1 file copied and verified.')).toBeVisible();
  await expect(page.getByText('The transfer continues automatically. You can close this page.', { exact: false })).toBeVisible();
  await expect(page.getByText('2 remaining.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Media storage' })).toHaveAttribute('data-state', 'waiting');
  completed = true;
  await expect(page.getByText('Originals moved to your R2 storage.', { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('region', { name: 'Media storage' })).toHaveAttribute('data-state', 'ready');
  emptyLibrary = true;
  await page.reload();
  await expect(page.getByText('No existing media to move. New uploads go directly to R2.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Media storage' })).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('button', { name: 'Refresh migration status' })).toHaveCount(0);
  await expect(page.getByText('Moving media to R2…', { exact: true })).toHaveCount(0);
});

test('disconnect uses fresh metadata after token rotation and reports success or failure beside the button', async ({ page }, testInfo) => {
  let revision = 'initial', connected = true, fail = true, connectedAt = '2026-09-08T00:00:00Z';
  const deletes: string[] = [];
  await page.route('**/api/orgs/publishing', route => {
    const empty = { revision: 'github', status: 'disconnected', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: { github: empty, github_setup: { available: false }, encryption_available: true,
      cloudflare: { ...empty, status: connected ? 'connected' : 'disconnected', revision, connected_at: connectedAt, credentials_saved: connected, media_ready: true,
        cloudflare: { account_id: 'a'.repeat(32), account_name: 'Example', bucket: 'private', public_bucket: 'public' } } } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    expect(route.request().method()).toBe('DELETE');
    deletes.push(route.request().postDataJSON().revision);
    if (fail) return route.fulfill({ status: 503, json: { error: 'Could not disconnect. Please try again.' } });
    connected = false;
    return route.fulfill({ json: { disconnected: true } });
  });
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/settings/publishing');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cloudflare account', exact: true }) });
  await expect(section.getByRole('button', { name: 'Disconnect Cloudflare' })).toBeVisible();
  revision = 'rotated';
  await section.getByRole('button', { name: 'Disconnect Cloudflare' }).click();
  await expect(section.getByRole('alert')).toHaveText('Could not disconnect. Please try again.');
  await expect(section.getByRole('alert')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('disconnect-error-mobile.png'), animations: 'disabled' });
  expect(deletes).toEqual(['rotated']);
  connectedAt = '2026-09-08T01:00:00Z';
  await section.getByRole('button', { name: 'Disconnect Cloudflare' }).click();
  await expect(section.getByRole('alert')).toContainText('changed in another session');
  expect(deletes).toEqual(['rotated']);
  fail = false;
  await section.getByRole('button', { name: 'Disconnect Cloudflare' }).click();
  await expect(section.getByRole('status')).toContainText('Disconnected.');
  await expect(section.getByRole('status')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('disconnect-success-mobile.png'), animations: 'disabled' });
  await expect(section.getByRole('button', { name: 'Disconnect Cloudflare' })).toHaveCount(0);
});

test('a delayed migration poll cannot restore a disconnected account in the browser', async ({ page }) => {
  let reads = 0, connected = true;
  let releasePoll: (() => Promise<void>) | undefined;
  await page.route('**/api/orgs/publishing', async route => {
    reads++;
    const empty = { revision: 'initial', status: 'disconnected', credentials_saved: false, github: null, cloudflare: null };
    const snapshot = { github: empty, github_setup: { available: false }, encryption_available: true,
      media_migration: { state: 'running', copied_files: 0, pending_files: 1, error: null },
      cloudflare: { ...empty, status: connected ? 'connected' : 'disconnected', media_ready: connected,
        cloudflare: { account_id: 'account', account_name: 'Example', bucket: 'private', public_bucket: 'public' } } };
    if (reads === 2) return new Promise<void>(resolve => { releasePoll = async () => { await route.fulfill({ json: snapshot }); resolve(); }; });
    await route.fulfill({ json: snapshot });
  });
  await page.route('**/api/orgs/publishing/cloudflare', route => { connected = false; return route.fulfill({ json: { disconnected: true } }); });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  await expect.poll(() => Boolean(releasePoll), { timeout: 10000 }).toBe(true);
  await page.getByRole('button', { name: 'Disconnect Cloudflare' }).click();
  await expect(page.getByText('Disconnected.', { exact: false })).toBeVisible();
  const response = page.waitForResponse(result => result.url().endsWith('/api/orgs/publishing'));
  await releasePoll!(); await response;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('button', { name: 'Disconnect Cloudflare' })).toHaveCount(0);
});

for (const width of [320, 390, 1440]) test(`GitHub sign-in and installation keep separate status across reload at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  let phase: 'sign-in' | 'install' | 'connected' | 'renew' = 'sign-in';
  const actions: unknown[] = [];
  await page.route('**/api/orgs/publishing', route => {
    const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
    return route.fulfill({ json: {
      github: phase === 'connected' || phase === 'renew' ? { ...empty, status: 'connected', github: { owner: 'Example', account_type: 'User', repository_creation_state: phase === 'renew' ? 'reconnect_required' : 'ready' } } : empty,
      cloudflare: empty, github_next_step: phase === 'install' ? 'install' : null, github_choices: [],
      github_setup: { available: true, install_url: 'https://github.com/apps/synthetic-publisher/installations/new' },
      cloudflare_setup: { available: false }, encryption_available: true,
    } });
  });
  await page.route('**/api/orgs/publishing/github', async route => {
    const body = route.request().postDataJSON(); actions.push(body.action ?? 'start');
    phase = body.action === 'install' ? 'connected' : 'install';
    await route.fulfill({ json: { authorization_url: `/app/settings/publishing?github=${phase === 'connected' ? 'connected' : 'install_required'}` } });
  });
  await page.route('**/api/orgs/publishing/github/permissions', route => route.fulfill({ json: { state: 'ready', revision: 'synthetic-revision', message: 'GitHub permissions are up to date.', approval_url: null, permissions: [] } }));
  await page.goto('/app/settings/publishing');
  const steps = page.getByRole('list', { name: 'GitHub connection steps', exact: true });
  const signIn = steps.locator('[data-github-step="sign-in"]');
  const installation = steps.locator('[data-github-step="installation"]');
  await expect(steps.getByRole('listitem')).toHaveCount(2);
  await expect(signIn).toHaveAttribute('data-state', 'error');
  await expect(installation).toHaveAttribute('data-state', 'waiting');
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  const required = page.getByRole('button', { name: 'Install and connect GitHub', exact: true });
  await expect(required).toBeVisible();
  await expect(signIn).toHaveAttribute('data-state', 'ready');
  await expect(installation).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByText('Setup incomplete · Install the GitHub App', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(required).toBeVisible();
  await expect(signIn).toContainText('Sign-in approved');
  await expect(installation).toContainText('Required · Install the App');
  await expect(page.getByLabel('GitHub installation required')).toContainText('All repositories');
  await expect(page.getByLabel('GitHub installation required')).toContainText('return here automatically');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`github-installation-${width}.png`), fullPage: true });
  await required.click();
  await expect(page.getByText('Connected · Example', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'GitHub connected. Setup is complete.' })).toBeVisible();
  await expect(required).toHaveCount(0);
  await expect(signIn).toHaveAttribute('data-state', 'ready');
  await expect(installation).toHaveAttribute('data-state', 'ready');
  await expect(installation).toContainText('Repository access verified for Example');
  await expect(page.getByText('GitHub permissions are up to date.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.reload();
  await expect(signIn).toHaveAttribute('data-state', 'ready');
  await expect(installation).toHaveAttribute('data-state', 'ready');
  await page.screenshot({ path: testInfo.outputPath(`github-connected-${width}.png`), fullPage: true });
  phase = 'renew';
  await page.reload();
  await expect(signIn).toHaveAttribute('data-state', 'error');
  await expect(signIn).toContainText('Renew authorization');
  await expect(signIn.getByRole('button', { name: 'Reconnect GitHub', exact: true })).toBeVisible();
  await expect(installation).toHaveAttribute('data-state', 'ready');
  expect(actions).toEqual(['start', 'install']);
});

for (const width of [320, 1440]) test(`build setup explains missing permissions and clears failed progress at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  const initial = { provider: 'cloudflare', state: 'not_configured', revision: 'initial', enabled: false, worker_name: 'builder', account_name: 'Build account' };
  const denied = { ...initial, revision: 'denied', state: 'approval_required', issue: { code: 'build_permission_required', message: 'Cloudflare denied access to Workers Scripts in Build account (HTTP 403, code 10000). Click Approve build permissions, approve access in Cloudflare, then return and finish build setup. Your hosting accounts and media stay connected.' } };
  let current = initial, fail = false;
  await page.route('**/api/orgs/publishing/builds', async route => {
    if (route.request().method() === 'POST') {
      if (fail) {
        current = { ...initial, state: 'error', revision: 'failed' };
        return route.fulfill({ status: 502, json: { error: 'Build storage could not be prepared. Check Media storage.' } });
      }
      current = denied;
    }
    await route.fulfill({ json: current });
  });
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'Builds', exact: true });
  await card.getByRole('button', { name: 'Finish build setup', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Approve build permissions', exact: true })).toBeEnabled();
  await expect(card.getByRole('status')).toContainText('Click Approve build permissions');
  await expect(card).not.toContainText('Preparing the shared build engine');
  await expect(card).toHaveAttribute('data-state', 'error');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await card.screenshot({ path: testInfo.outputPath(`build-permission-${width}.png`) });
  current = initial; fail = true;
  await page.reload();
  await card.getByRole('button', { name: 'Finish build setup', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Check Media storage');
  await expect(card.getByRole('status')).toHaveCount(0);
  await expect(card).not.toContainText('Preparing the shared build engine');
  await expect(card.getByRole('button', { name: 'Finish build setup', exact: true })).toBeEnabled();
  await card.screenshot({ path: testInfo.outputPath(`build-failure-${width}.png`) });
});

test('Cloudflare callback refreshes stale build permissions after connection UI cleans the URL', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let checks = 0;
  const stale = { provider: 'cloudflare', state: 'approval_required', revision: 'before-consent', enabled: false, worker_name: 'builder', issue: { message: 'Stale Cloudflare HTTP 403' } };
  await page.route('**/api/orgs/publishing/builds', async route => {
    if (route.request().method() === 'POST') {
      checks++;
      expect(route.request().postDataJSON()).toEqual({ revision: 'before-consent' });
      return route.fulfill({ json: { ...stale, revision: 'after-consent', state: 'qualification_required', issue: { message: 'Build permissions verified.' } } });
    }
    // Reproduce the actual race: connection UI clears the query while Builds awaits its GET.
    await page.waitForURL(url => !url.searchParams.has('cloudflare'));
    await route.fulfill({ json: stale });
  });
  await page.goto('/app/settings/publishing?cloudflare=connected');
  const card = page.getByRole('region', { name: 'Builds', exact: true });
  await expect(card.getByRole('status')).toHaveText('Build permissions verified.');
  await expect(card).not.toContainText('Stale Cloudflare HTTP 403');
  await expect(card.getByRole('button', { name: 'Approve build permissions', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Finish build setup', exact: true })).toBeEnabled();
  expect(checks).toBe(1);
  await card.screenshot({ path: testInfo.outputPath('cloudflare-return-build-status.png') });
});
