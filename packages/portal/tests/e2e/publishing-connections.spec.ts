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

// GitHub results are explained inside the GitHub card from the persisted
// diagnosis (GET /api/orgs/publishing → github_diagnosis), never by a page alert.
const githubSetup = { available: true, app_configured: true, encryption_available: true, app_slug: 'synthetic-publisher', install_url: 'https://github.com/apps/synthetic-publisher/installations/new' };
const githubUser = { id: '78', login: 'synthetic-owner' };
function diagnosis(outcome: string, extra: Record<string, unknown> = {}) {
  return { version: 1, checked_at: '2026-10-02T00:00:00.000Z', revision: 'synthetic-revision', attempted_by: 'e2e-owner', github_user: null, outcome,
    primary_action: null, blockers: [], installations: [], app: { slug: 'synthetic-publisher', install_url: githubSetup.install_url }, ...extra };
}
const notOwner = { code: 'not_org_owner', who: 'github_owner', message: '@synthetic-owner is not an owner of member-org. Only an organization owner can connect it to Typeroll.',
  action: { kind: 'link', label: 'See who owns member-org', url: 'https://github.com/orgs/member-org/people?query=role%3Aowner' } };
const install = { code: 'no_installation', who: 'you', message: 'The synthetic-publisher GitHub App is not installed on your personal account or on an organization you own. Install it with All repositories access.',
  action: { kind: 'install', label: 'Install the GitHub App', url: githubSetup.install_url } };
const memberOrg = (usable: boolean, blockers: unknown[] = usable ? [] : [notOwner]) => ({ installation_id: '35', account: { login: 'member-org', type: 'Organization', id: '57' }, usable, blockers });
const incident = () => diagnosis('action_required', { github_user: githubUser, primary_action: install.action, blockers: [install], installations: [memberOrg(false)] });
const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
const noHorizontalScroll = (page: import('@playwright/test').Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const accountType of ['Organization', 'User'] as const) test(`GitHub starts with sign-in and connects a verified ${accountType} account without a text field`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let selecting = false;
  let connected = false;
  let submitted: Record<string, unknown> | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const selected = { installation_id: '35', account: { login: 'synthetic-selected', type: accountType, id: '79' }, usable: true, blockers: [] };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: {
    github: connected ? { ...empty, status: 'connected', github: { owner: 'synthetic-selected', account_type: accountType, repository_creation_state: 'ready' } } : empty,
    cloudflare: empty, encryption_available: true, github_setup: githubSetup,
    github_choices: selecting && !connected ? [{ owner: 'synthetic-company', installation_id: '34', account_type: 'Organization' }, { owner: 'synthetic-selected', installation_id: '35', account_type: accountType }] : [],
    github_diagnosis: connected ? diagnosis('connected', { github_user: githubUser, installations: [selected] })
      : selecting ? diagnosis('choose', { github_user: githubUser, installations: [{ ...selected, installation_id: '34', account: { login: 'synthetic-company', type: 'Organization', id: '56' } }, selected] })
      : diagnosis('sign_in_required', { primary_action: { kind: 'sign_in', label: 'Connect GitHub' } }),
  } }));
  await page.route('**/api/orgs/publishing/github', route => {
    submitted = route.request().postDataJSON();
    if (submitted?.installation_id) { connected = true; return route.fulfill({ json: { connected: true } }); }
    selecting = true;
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing?github=choose' } });
  });
  await page.route('**/api/orgs/publishing/github/permissions', route => route.fulfill({ json: { state: 'up_to_date', revision: 'synthetic-revision', message: 'GitHub permissions are up to date.', approval_url: null, missing_permissions: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/settings/publishing');
  await expect(page.getByLabel('GitHub organization name')).not.toBeVisible();
  await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub account' })).toBeVisible();
  await expect(page.locator('.github-connection__next')).toBeFocused();
  expect(submitted).not.toHaveProperty('owner');
  await page.screenshot({ path: testInfo.outputPath('github-account-choice-mobile.png') });
  await page.getByRole('combobox', { name: 'Choose a GitHub account' }).selectOption('35');
  await page.getByRole('button', { name: 'Connect selected account' }).click();
  await expect(page.locator('[data-github-announcement]')).toContainText('GitHub connected');
  await expect(page.getByRole('region', { name: 'GitHub account', exact: true })).toHaveAttribute('data-state', 'ready');
  expect(submitted).toMatchObject({ installation_id: '35' });
  if (accountType === 'User') await expect(page.getByText('Personal account authorization', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('github-account-connected-mobile.png') });
  await expect(page.getByRole('combobox', { name: 'Choose a GitHub account' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByText('Advanced: connect with existing API and R2 keys', { exact: true }).click();
  await page.getByLabel('Cloudflare Account ID').scrollIntoViewIfNeeded();
  await expect(page.locator('#cf-account-help')).toContainText('Search → Copy account ID');
  expect(await noHorizontalScroll(page)).toBe(true);
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
  const choice = page.getByRole('group', { name: 'Choose a Cloudflare account' });
  await choice.getByRole('radio', { name: /Selected agency with a longer account name/ }).check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('cloudflare-account-choice-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Connect Selected agency with a longer account name' }).click();
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

for (const width of [320, 390, 1440]) test(`GitHub explains a member-only organization inside the card and re-checks without signing in again at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  let phase: 'incident' | 'choose' | 'connected' = 'incident';
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: {
    github: phase === 'connected' ? { ...empty, status: 'connected', github: { owner: 'member-org', account_type: 'Organization', repository_creation_state: 'ready' } } : empty,
    cloudflare: empty, encryption_available: true, cloudflare_setup: { available: false }, github_setup: githubSetup,
    github_choices: phase === 'choose' ? [{ owner: 'member-org', installation_id: '35', account_type: 'Organization' }] : [],
    github_diagnosis: phase === 'incident' ? incident() : phase === 'choose' ? diagnosis('choose', { github_user: githubUser, installations: [memberOrg(true)] })
      : diagnosis('connected', { github_user: githubUser, installations: [memberOrg(true)] }),
  } }));
  await page.route('**/api/orgs/publishing/github/diagnosis', route => {
    posts.push({ path: 'diagnosis', body: route.request().postDataJSON() });
    phase = 'choose';
    return route.fulfill({ json: { diagnosis: diagnosis('choose', { github_user: githubUser, installations: [memberOrg(true)] }) } });
  });
  await page.route('**/api/orgs/publishing/github', route => {
    posts.push({ path: 'github', body: route.request().postDataJSON() });
    phase = 'connected';
    return route.fulfill({ json: { connected: true } });
  });
  await page.route('**/api/orgs/publishing/github/permissions', route => route.fulfill({ json: { state: 'up_to_date', revision: 'synthetic-revision', message: 'GitHub permissions are up to date.', approval_url: null, missing_permissions: [] } }));
  // The person returns from GitHub after approving sign-in.
  await page.goto('/app/settings/publishing?github=action_required');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  const next = card.locator('.github-connection__next');
  await expect(next).toBeFocused();
  await expect(page).toHaveURL(/\/app\/settings\/publishing$/);
  await expect(card).toHaveAttribute('data-state', 'error');
  await expect(card.getByText('Not connected · Action required', { exact: true })).toBeVisible();
  await expect(next.locator('[data-github-announcement]')).toContainText('GitHub is not connected yet.');
  await expect(card.locator('[data-github-step="sign-in"]')).toContainText('Signed in as @synthetic-owner');
  await expect(card.locator('[data-github-step="sign-in"]').getByRole('button', { name: 'Use a different GitHub account' })).toBeVisible();
  const row = card.getByRole('list', { name: 'Accounts with the GitHub App' }).getByRole('listitem').filter({ hasText: 'member-org' }).first();
  await expect(row.locator('.github-connection__who')).toHaveText('Who acts: GitHub organization owner');
  await expect(row).toContainText('is not an owner of member-org');
  await expect(row.getByRole('link', { name: /See who owns member-org/ })).toHaveAttribute('href', 'https://github.com/orgs/member-org/people?query=role%3Aowner');
  await expect(next.getByRole('button', { name: 'Install the GitHub App', exact: true })).toBeVisible();
  await expect(next.getByRole('button', { name: 'Check again', exact: true })).toBeVisible();
  // The old page-level banner and the old two-step "Waiting for sign-in" state are gone.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(card).not.toContainText('Waiting for sign-in');
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: testInfo.outputPath(`github-incident-${width}.png`) });
  // Keyboard: the primary action is reachable from the focused result.
  await page.keyboard.press('Tab');
  await expect(next.getByRole('button', { name: 'Install the GitHub App', exact: true })).toBeFocused();
  await next.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(next.locator('[data-github-announcement]')).toContainText('Checked again.');
  await expect(card.getByText('Setup incomplete · Choose an account', { exact: true })).toBeVisible();
  await expect(card.getByRole('combobox', { name: 'Choose a GitHub account' })).toHaveValue('35');
  await card.getByRole('button', { name: 'Connect selected account' }).click();
  await expect(card.getByText('Connected · member-org', { exact: true }).first()).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'ready');
  await expect(card.locator('[data-github-step="connected"]')).toHaveAttribute('data-state', 'ready');
  expect(posts).toEqual([{ path: 'diagnosis', body: { action: 'recheck' } }, { path: 'github', body: { installation_id: '35' } }]);
  expect(await noHorizontalScroll(page)).toBe(true);
  expect(errors).toEqual([]);
});

for (const width of [390, 1440]) test(`GitHub card re-checks by itself after returning from GitHub without a callback and offers Connect @login at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const person = { id: '78', login: 'bootingbots' };
  const moveria = { installation_id: '35', account: { login: 'Moveria-AB', type: 'Organization', id: '57' }, usable: false,
    blockers: [{ ...notOwner, message: '@bootingbots is not an owner of Moveria-AB. Only an organization owner can connect it to Typeroll.',
      action: { kind: 'link', label: 'See who owns Moveria-AB', url: 'https://github.com/orgs/Moveria-AB/people?query=role%3Aowner' } }] };
  const personal = { installation_id: '36', account: { login: 'bootingbots', type: 'User', id: '78' }, usable: true, blockers: [] };
  // The stored result from before the installation: nothing installed on an account the person owns.
  let current = diagnosis('action_required', { github_user: person, primary_action: install.action, blockers: [install], installations: [moveria] });
  const ready = diagnosis('action_required', { checked_at: '2026-10-02T00:05:00.000Z', github_user: person,
    primary_action: { kind: 'sign_in', label: 'Connect @bootingbots' }, blockers: [], installations: [moveria, personal] });
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: { github: empty, cloudflare: empty, encryption_available: true,
    cloudflare_setup: { available: false }, github_setup: githubSetup, github_choices: [], github_diagnosis: current,
    github_attempt: { recheck_available: true, installation_started_at: '2026-10-02T00:01:00.000Z' } } }));
  await page.route('**/api/orgs/publishing/github/diagnosis', route => {
    posts.push({ path: 'diagnosis', body: route.request().postDataJSON() });
    current = ready;
    return route.fulfill({ json: { diagnosis: ready } });
  });
  await page.route('**/api/orgs/publishing/github', route => {
    posts.push({ path: 'github', body: route.request().postDataJSON() });
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing?github=connected' } });
  });
  // GitHub left the person on its installation settings page; they open Publishing again (no ?github=).
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  const next = card.locator('.github-connection__next');
  await expect(next.locator('[data-github-announcement]')).toHaveText('Checked again. GitHub is not connected yet. Connect @bootingbots to finish.');
  expect(posts).toEqual([{ path: 'diagnosis', body: { action: 'recheck' } }]);
  await expect(next.locator('[data-github-summary]')).toHaveText('GitHub is not connected yet. Connect @bootingbots to finish.');
  await expect(next).not.toContainText('One step below');
  await expect(next).not.toContainText('Sign in to GitHub to connect');
  await expect(next.locator('[data-github-primary-hint]')).toHaveText('GitHub asks you to confirm once; you come straight back here.');
  await expect(card.locator('[data-github-step="sign-in"]')).toContainText('Signed in as @bootingbots');
  const own = card.getByRole('list', { name: 'Accounts with the GitHub App' }).getByRole('listitem').filter({ hasText: 'Personal account' }).first();
  await expect(own).toContainText('Can be connected');
  await expect(card.locator('[data-github-step="access"]')).toContainText('All repositories, Administration and Contents access granted');
  // Who acts is a label of its own, not the start of the reason.
  const other = card.locator('[data-installation="35"]');
  await expect(other.locator('.github-connection__who')).toHaveText('Who acts: GitHub organization owner');
  await expect(other).toContainText('@bootingbots is not an owner of Moveria-AB. Only an organization owner can connect it to Typeroll.');
  await expect(other).not.toContainText('GitHub organization owner @bootingbots');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: testInfo.outputPath(`github-return-connect-${width}.png`) });
  await next.getByRole('button', { name: 'Connect @bootingbots', exact: true }).click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toEqual({ path: 'github', body: {} });
  expect(errors).toEqual([]);
});

const blockerCases = [
  { name: 'SSO', diagnosis: diagnosis('action_required', { github_user: githubUser, primary_action: { kind: 'link', label: 'Authorize single sign-on for owned-org', url: 'https://github.com/orgs/owned-org/sso?authorization_request=synthetic' },
    installations: [{ installation_id: '34', account: { login: 'owned-org', type: 'Organization', id: '56' }, usable: false, blockers: [{ code: 'sso_authorization_required', who: 'you', message: 'owned-org requires SAML single sign-on. Authorize your GitHub session for owned-org, then select Check again.', action: { kind: 'link', label: 'Authorize single sign-on for owned-org', url: 'https://github.com/orgs/owned-org/sso?authorization_request=synthetic' } }] }] }),
    status: 'Not connected · Action required', text: 'requires SAML single sign-on', link: ['Authorize single sign-on for owned-org', 'https://github.com/orgs/owned-org/sso?authorization_request=synthetic'] },
  { name: 'repository selection', diagnosis: diagnosis('action_required', { github_user: githubUser, primary_action: { kind: 'link', label: 'Allow all repositories in owned-org', url: 'https://github.com/organizations/owned-org/settings/installations/34' },
    installations: [{ installation_id: '34', account: { login: 'owned-org', type: 'Organization', id: '56' }, usable: false, blockers: [{ code: 'repository_selection_limited', who: 'you', message: 'The App can only access selected repositories in owned-org.', action: { kind: 'link', label: 'Allow all repositories in owned-org', url: 'https://github.com/organizations/owned-org/settings/installations/34' } }] }] }),
    status: 'Not connected · Action required', text: 'only access selected repositories', link: ['Allow all repositories in owned-org', 'https://github.com/organizations/owned-org/settings/installations/34'] },
  { name: 'owner approval', diagnosis: diagnosis('waiting_on_owner', { github_user: githubUser, primary_action: { kind: 'retry', label: 'Check again' },
    blockers: [{ code: 'install_request_pending', who: 'github_owner', message: 'Your request to install the synthetic-publisher GitHub App was sent to the organization’s owners.', action: { kind: 'retry', label: 'Check again' } }] }),
    status: 'Not connected · Waiting for an owner', text: 'was sent to the organization’s owners', link: null },
  { name: 'rate limit', diagnosis: diagnosis('retryable_error', { github_user: githubUser, primary_action: { kind: 'sign_in', label: 'Try again' },
    blockers: [{ code: 'github_rate_limited', who: 'you', message: 'GitHub is limiting requests right now. Nothing was changed. Try again in 42 seconds.', retry_after: 42, action: { kind: 'sign_in', label: 'Try again' } }] }),
    status: 'Not connected · Try again', text: 'Try again in 42 seconds', link: null },
  { name: 'missing encryption', setup: { ...githubSetup, available: false, encryption_available: false, install_url: null },
    diagnosis: diagnosis('unavailable', { blockers: [{ code: 'encryption_unavailable', who: 'publisher', message: 'The publisher has not configured encrypted credential storage, so GitHub cannot be connected yet (App: synthetic-publisher).', action: { kind: 'contact_publisher', label: 'What the publisher must change', url: 'https://typeroll.com/docs/guides/github-troubleshooting/#encryption_unavailable' } }],
      primary_action: { kind: 'contact_publisher', label: 'What the publisher must change', url: 'https://typeroll.com/docs/guides/github-troubleshooting/#encryption_unavailable' } }),
    status: 'Unavailable · Publisher setup required', text: 'encrypted credential storage', link: ['What the publisher must change', 'https://typeroll.com/docs/guides/github-troubleshooting/#encryption_unavailable'] },
];
for (const item of blockerCases) test(`GitHub card names who fixes ${item.name} and links the fix`, async ({ page }) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: { github: empty, cloudflare: empty, encryption_available: true,
    github_setup: item.setup ?? githubSetup, github_choices: [], github_diagnosis: item.diagnosis } }));
  await page.goto(`/app/settings/publishing?github=${item.diagnosis.outcome}`);
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  await expect(card.getByText(item.status, { exact: true })).toBeVisible();
  await expect(card.locator('.github-connection__next')).toBeFocused();
  await expect(card).toContainText(item.text);
  if (item.link) await expect(card.getByRole('link', { name: new RegExp(item.link[0]) }).first()).toHaveAttribute('href', item.link[1]);
  if (item.name === 'missing encryption') {
    await expect(card.locator('[data-github-step="publisher"]')).toHaveAttribute('data-state', 'error');
    await expect(card.getByRole('button', { name: 'Check again' })).toHaveCount(0);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('GitHub card explains an expired Typeroll session after returning from sign-in', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let started = false;
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: { github: empty, cloudflare: empty, encryption_available: true,
    github_setup: githubSetup, github_choices: [], github_diagnosis: diagnosis('sign_in_required', { primary_action: { kind: 'sign_in', label: 'Connect GitHub' } }) } }));
  await page.route('**/api/orgs/publishing/github', route => { started = true; return route.fulfill({ json: { authorization_url: '/app/settings/publishing' } }); });
  await page.goto('/app/settings/publishing?github=session_expired');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  await expect(card).toContainText('Your Typeroll session ended while you were on GitHub');
  await card.getByRole('button', { name: 'Sign in to GitHub again' }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('every GitHub state keeps a working next step, also when Check again needs a new sign-in', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let phase: 'waiting' | 'expired_choice' = 'waiting';
  let started = 0;
  const waiting = diagnosis('waiting_on_owner', { primary_action: { kind: 'retry', label: 'Check again' },
    blockers: [{ code: 'install_request_pending', who: 'github_owner', message: 'Your request to install the synthetic-publisher GitHub App was sent to the organization’s owners.', action: { kind: 'retry', label: 'Check again' } }] });
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: { github: empty, cloudflare: empty, encryption_available: true, github_setup: githubSetup, github_choices: [],
    github_diagnosis: phase === 'waiting' ? waiting : diagnosis('choose', { github_user: githubUser, installations: [memberOrg(true)] }) } }));
  // The re-check could not use a proven identity; its answer is shown even though the stored diagnosis did not change.
  await page.route('**/api/orgs/publishing/github/diagnosis', route => route.fulfill({ json: { diagnosis: { ...waiting, checked_at: '2026-10-02T00:01:00.000Z',
    primary_action: { kind: 'sign_in', label: 'Sign in to GitHub to check again' } } } }));
  // The second sign-in returns without a sign-in that this browser started (state_expired).
  await page.route('**/api/orgs/publishing/github', route => { started++;
    return route.fulfill({ json: { authorization_url: started === 2 ? '/app/settings/publishing?github=state_expired' : '/app/settings/publishing' } }); });
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  const next = card.locator('.github-connection__next');
  await expect(card.getByText('Not connected · Waiting for an owner', { exact: true })).toBeVisible();
  await expect(next).toContainText('was sent to the organization’s owners');
  // Signing in is available without a previous sign-in on record.
  await expect(card.locator('[data-github-step="sign-in"]').getByRole('button', { name: 'Sign in to GitHub', exact: true })).toBeVisible();
  await next.getByRole('button', { name: 'Check again', exact: true }).click();
  await next.getByRole('button', { name: 'Sign in to GitHub to check again', exact: true }).click();
  await expect.poll(() => started).toBe(1);
  // A choice that is no longer offered still has a way forward.
  phase = 'expired_choice';
  await page.reload();
  await expect(card.getByRole('combobox', { name: 'Choose a GitHub account' })).toHaveCount(0);
  await next.getByRole('button', { name: 'Sign in to GitHub again', exact: true }).click();
  await expect.poll(() => started).toBe(2);
  // A return that matched no sign-in from this browser changed nothing and says so.
  await expect(next).toContainText('was not started in this browser or has expired, so nothing was changed');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('connecting a different GitHub account after a disconnect needs a confirmation naming the previous account', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let submitted: Record<string, unknown> | undefined;
  const locked = { code: 'locked_to_account', who: 'you', previous_account: { login: 'owned-org', id: '56', type: 'Organization' },
    message: 'This organization previously published with owned-org. You can connect second-org instead after confirming. Existing repositories stay in owned-org and are not moved.',
    action: { kind: 'confirm_account_change', label: 'Use second-org instead of owned-org', installation_id: '35' } };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: { github: empty, cloudflare: empty, encryption_available: true, github_setup: githubSetup,
    github_choices: [{ owner: 'second-org', installation_id: '35', account_type: 'Organization', account_change: { from_account_id: '56', from_owner: 'owned-org' } }],
    github_diagnosis: diagnosis('action_required', { github_user: githubUser, primary_action: locked.action,
      installations: [{ installation_id: '35', account: { login: 'second-org', type: 'Organization', id: '57' }, usable: false, blockers: [locked] }] }) } }));
  await page.route('**/api/orgs/publishing/github', route => { submitted = route.request().postDataJSON(); return route.fulfill({ json: { connected: true } }); });
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  await card.locator('.github-connection__next').getByRole('button', { name: 'Use second-org instead of owned-org' }).click();
  const confirm = card.getByRole('group', { name: 'Connect second-org instead of owned-org?' });
  await expect(confirm).toContainText('are not moved');
  expect(submitted).toBeUndefined();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  await card.locator('.github-connection__next').getByRole('button', { name: 'Use second-org instead of owned-org' }).click();
  await card.getByRole('group', { name: 'Connect second-org instead of owned-org?' }).getByRole('button', { name: 'Connect second-org' }).click();
  await expect.poll(() => submitted).toEqual({ installation_id: '35', confirm_account_change: '56' });
});

for (const width of [320, 1440]) test(`GitHub connected state and personal reauthorization stay in the card across reload at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  let phase: 'connected' | 'renew' = 'connected';
  const actions: unknown[] = [];
  const example = { installation_id: '34', account: { login: 'Example', type: 'User', id: '78' }, usable: true, blockers: [] };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: {
    github: { ...empty, status: 'connected', github: { owner: 'Example', account_type: 'User', repository_creation_state: phase === 'renew' ? 'reconnect_required' : 'ready' } },
    cloudflare: empty, github_choices: [], github_setup: githubSetup, cloudflare_setup: { available: false }, encryption_available: true,
    github_diagnosis: diagnosis('connected', { installations: [example] }),
  } }));
  await page.route('**/api/orgs/publishing/github', async route => { actions.push(route.request().postDataJSON()); await route.fulfill({ json: { authorization_url: '/app/settings/publishing?github=connected' } }); });
  await page.route('**/api/orgs/publishing/github/permissions', route => route.fulfill({ json: { state: 'up_to_date', revision: 'synthetic-revision', message: 'GitHub permissions are up to date.', approval_url: null, missing_permissions: [] } }));
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'GitHub account', exact: true });
  const steps = card.getByRole('list', { name: 'GitHub connection steps', exact: true });
  await expect(steps.locator(':scope > li')).toHaveCount(5);
  for (const step of ['publisher', 'sign-in', 'installation', 'access', 'connected']) await expect(steps.locator(`[data-github-step="${step}"]`)).toHaveAttribute('data-state', 'ready');
  await expect(card.getByText('Connected · Example', { exact: true }).first()).toBeVisible();
  await expect(card.getByText('GitHub permissions are up to date.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`github-connected-${width}.png`), fullPage: true });
  phase = 'renew';
  await page.reload();
  const signIn = steps.locator('[data-github-step="sign-in"]');
  await expect(signIn).toHaveAttribute('data-state', 'error');
  await expect(signIn).toContainText('Renew authorization');
  await expect(card).toHaveAttribute('data-state', 'waiting');
  await signIn.getByRole('button', { name: 'Reconnect GitHub', exact: true }).click();
  await expect.poll(() => actions).toEqual([{}]);
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

// Cloudflare results are explained inside the Cloudflare card from the persisted
// diagnosis (GET /api/orgs/publishing → cloudflare_diagnosis), never by a page alert.
const staging = { id: 'a'.repeat(32), name: 'Staging Account' };
const autopilot = { id: 'b'.repeat(32), name: 'Autopilot' };
function cloudflareDiagnosis(outcome: string, extra: Record<string, unknown> = {}) {
  return { version: 1, checked_at: new Date().toISOString(), hosting_group_id: 'default', revision: 'synthetic-revision', attempted_by: 'e2e-owner', outcome,
    primary_action: null, blockers: [], accounts: [], selection_expires_at: null, sign_in_started_at: null, recheck_available: false, ...extra };
}
function cloudflareStatus(input: { connected?: typeof staging | null; diagnosis: unknown; choices?: unknown[] }) {
  return { github: { ...empty, status: 'connected', github: { owner: 'synthetic-agency' } }, github_setup: { available: false, install_url: null }, github_choices: [],
    encryption_available: true, cloudflare_setup: { available: true }, cloudflare_choices: input.choices ?? [], cloudflare_diagnosis: input.diagnosis,
    cloudflare: input.connected ? { ...empty, status: 'connected', credentials_saved: true, auth_method: 'oauth', media_ready: true,
      cloudflare: { account_id: input.connected.id, account_name: input.connected.name, bucket: 'agency-media', public_bucket: 'public-media' } } : empty };
}

for (const width of [320, 1440]) test(`Cloudflare offers two authorized accounts in the card and connects the chosen one at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  let phase: 'initial' | 'choose' | 'connected' = 'initial';
  const submitted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const offered = [{ ...autopilot, usable: true, blockers: [] }, { ...staging, usable: true, blockers: [] }];
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: cloudflareStatus({
    connected: phase === 'connected' ? staging : null, choices: phase === 'choose' ? [autopilot, staging] : [],
    diagnosis: phase === 'initial' ? cloudflareDiagnosis('sign_in_required', { primary_action: { kind: 'sign_in', label: 'Connect Cloudflare' } })
      : phase === 'choose' ? cloudflareDiagnosis('choose', { accounts: offered, recheck_available: true, selection_expires_at: new Date(Date.now() + 9 * 60_000).toISOString() })
      : cloudflareDiagnosis('connected', { revision: 'synthetic-revision', accounts: offered, recheck_available: true }) }) }));
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    const body = route.request().postDataJSON(); submitted.push(body);
    if (body.action === 'start') { phase = 'choose'; return route.fulfill({ json: { authorization_url: '/app/settings/publishing?cloudflare=choose#cloudflare' } }); }
    if (body.action === 'select') { phase = 'connected'; return route.fulfill({ json: { connected: true } }); }
    return route.fulfill({ json: {} });
  });
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'Cloudflare account', exact: true });
  await expect(card.locator('[data-cloudflare-summary]')).toContainText('Sign in to Cloudflare');
  await card.locator('.cloudflare-connection__next').getByRole('button', { name: 'Connect Cloudflare', exact: true }).click();
  // Back from Cloudflare: the chooser is in the card, focused, with why and until when.
  const next = card.locator('.cloudflare-connection__next');
  await expect(next).toBeFocused();
  await expect(page).toHaveURL(/\/app\/settings\/publishing#cloudflare$/);
  await expect(card).toHaveAttribute('data-state', 'waiting');
  await expect(card.locator('.publishing-card__status')).toHaveText('Setup incomplete · Choose an account');
  const choice = next.getByRole('group', { name: 'Choose a Cloudflare account' });
  await expect(choice).toContainText('You authorized 2 accounts on Cloudflare. Typeroll does not pick one for you');
  await expect(choice.locator('[data-cloudflare-expiry]')).toContainText('Choose by');
  await expect(next.getByRole('button', { name: 'Select an account to connect' })).toBeDisabled();
  await choice.getByRole('radio', { name: /Staging Account/ }).check();
  await expect(card.locator('[data-cloudflare-step="account"]')).toContainText('Choose one of 2 accounts');
  // No page-level Cloudflare banner (other cards, such as Builds, have their own alerts).
  await expect(page.getByRole('alert').filter({ hasText: /Cloudflare/ })).toHaveCount(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
  await card.screenshot({ path: testInfo.outputPath(`cloudflare-choice-${width}.png`) });
  await next.getByRole('button', { name: 'Connect Staging Account', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'ready');
  await expect(card.locator('.publishing-card__status')).toHaveText('Connected · Staging Account');
  await expect(next.locator('h3')).toHaveText('Cloudflare is ready');
  await expect(next.locator('[data-cloudflare-announcement]')).toContainText('Cloudflare connected');
  await expect(next.getByRole('group', { name: 'Choose a Cloudflare account' })).toHaveCount(0);
  expect(submitted.map(body => body.action)).toEqual(['start', 'select']);
  expect(submitted[1]).toEqual({ action: 'select', account_id: staging.id });
  expect(errors).toEqual([]);
});

test('Cloudflare explains a cancelled consent inside the card, also after a reload', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  let started = false;
  const cancelled = { code: 'oauth_cancelled', who: 'you', message: 'Cloudflare sign-in was cancelled, so nothing was connected. Connect Cloudflare again and select Authorize on Cloudflare’s consent page.',
    action: { kind: 'sign_in', label: 'Connect Cloudflare again' } };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: cloudflareStatus({
    diagnosis: cloudflareDiagnosis('sign_in_required', { blockers: [cancelled], primary_action: cancelled.action }) }) }));
  await page.route('**/api/orgs/publishing/cloudflare', route => { started = route.request().postDataJSON().action === 'start';
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing' } }); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/settings/publishing?cloudflare=sign_in_required#cloudflare');
  const card = page.getByRole('region', { name: 'Cloudflare account', exact: true });
  const next = card.locator('.cloudflare-connection__next');
  await expect(next).toBeFocused();
  await expect(page).toHaveURL(/\/app\/settings\/publishing#cloudflare$/);
  await expect(card).toHaveAttribute('data-state', 'error');
  await expect(next.locator('.cloudflare-connection__who')).toHaveText('Who acts: You');
  await expect(next).toContainText('Cloudflare sign-in was cancelled, so nothing was connected.');
  await expect(card.locator('[data-cloudflare-step="sign-in"]')).toContainText('Not completed');
  // No page-level Cloudflare banner (other cards, such as Builds, have their own alerts).
  await expect(page.getByRole('alert').filter({ hasText: /Cloudflare/ })).toHaveCount(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
  await card.screenshot({ path: testInfo.outputPath('cloudflare-cancelled-mobile.png') });
  // The explanation is stored, so a reload keeps it.
  await page.reload();
  await expect(next).toContainText('Cloudflare sign-in was cancelled');
  await next.getByRole('button', { name: 'Connect Cloudflare again', exact: true }).click();
  await expect.poll(() => started).toBe(true);
});

test('Cloudflare explains an expired account choice and starts again', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  const submitted: Record<string, unknown>[] = [];
  const offered = [{ ...autopilot, usable: true, blockers: [] }, { ...staging, usable: true, blockers: [] }];
  // The choice closes two seconds after the page loads, while the page stays open.
  const expires = new Date(Date.now() + 2_000).toISOString();
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: cloudflareStatus({ choices: [autopilot, staging],
    diagnosis: cloudflareDiagnosis('choose', { accounts: offered, selection_expires_at: expires }) }) }));
  await page.route('**/api/orgs/publishing/cloudflare', route => { submitted.push(route.request().postDataJSON());
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing' } }); });
  await page.goto('/app/settings/publishing');
  const card = page.getByRole('region', { name: 'Cloudflare account', exact: true });
  const next = card.locator('.cloudflare-connection__next');
  await expect(next.getByRole('group', { name: 'Choose a Cloudflare account' })).toBeVisible();
  await expect(next).toContainText('Your Cloudflare account choice expired after 10 minutes, so nothing was connected.', { timeout: 10_000 });
  await expect(next.getByRole('group', { name: 'Choose a Cloudflare account' })).toHaveCount(0);
  await expect(card.locator('[data-cloudflare-step="account"]')).toContainText('Choice expired');
  await expect(card).toHaveAttribute('data-state', 'error');
  await next.getByRole('button', { name: 'Connect Cloudflare again', exact: true }).click();
  await expect.poll(() => submitted).toEqual([{ action: 'start' }]);
  // No page-level Cloudflare banner (other cards, such as Builds, have their own alerts).
  await expect(page.getByRole('alert').filter({ hasText: /Cloudflare/ })).toHaveCount(0);
  await expect(card.getByRole('alert')).toHaveCount(0);
});

for (const width of [320, 1440]) test(`joining a Cloudflare account another Organization uses names it and needs a confirmation at ${width}px`, async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.setViewportSize({ width, height: 900 });
  let connected = false;
  const submitted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // One authorized account that Company A, which this person also administers, already uses.
  const shared = { ...staging, shared_with: ['Company A'] };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: cloudflareStatus({
    connected: connected ? staging : null, choices: connected ? [] : [shared],
    diagnosis: connected ? cloudflareDiagnosis('connected', { accounts: [{ ...staging, usable: true, blockers: [] }], recheck_available: true })
      : cloudflareDiagnosis('choose', { accounts: [{ ...shared, usable: true, blockers: [] }], recheck_available: true, selection_expires_at: new Date(Date.now() + 9 * 60_000).toISOString() }) }) }));
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    const body = route.request().postDataJSON(); submitted.push(body);
    if (body.action === 'select' && body.confirm_shared_account === true) { connected = true; return route.fulfill({ json: { connected: true } }); }
    return route.fulfill({ status: 409, json: { code: 'shared_account_confirmation_required', error: 'Staging Account is also used by: Company A.', details: { shared_with: ['Company A'] } } });
  });
  await page.goto('/app/settings/publishing?cloudflare=choose#cloudflare');
  const card = page.getByRole('region', { name: 'Cloudflare account', exact: true });
  const next = card.locator('.cloudflare-connection__next');
  const choice = next.getByRole('group', { name: 'Choose a Cloudflare account' });
  await expect(choice).toContainText('You authorized 1 account on Cloudflare.');
  await expect(next.locator('[data-cloudflare-summary]')).toHaveText('Confirm that this organization shares the Cloudflare account you authorized.');
  await expect(card.locator('[data-cloudflare-step="account"]')).toContainText('Confirm Staging Account');
  await expect(choice.locator(`[data-account="${staging.id}"]`)).toContainText('Shared');
  const confirmation = next.locator('[data-cloudflare-shared]');
  await expect(confirmation).toContainText('This Cloudflare account is also used by: Company A.');
  await expect(confirmation).toContainText('Sites stay separate');
  const connect = next.getByRole('button', { name: 'Connect Staging Account', exact: true });
  await expect(connect).toBeDisabled();
  expect(await noHorizontalScroll(page)).toBe(true);
  await card.screenshot({ path: testInfo.outputPath(`cloudflare-shared-account-${width}.png`) });
  await confirmation.getByRole('checkbox', { name: 'Use Staging Account for this Organization as well' }).check();
  await connect.click();
  await expect(card.locator('.publishing-card__status')).toHaveText('Connected · Staging Account');
  expect(submitted).toEqual([{ action: 'select', account_id: staging.id, confirm_shared_account: true }]);
  expect(errors).toEqual([]);
});

test('Cloudflare explains an account another Organization uses without naming it and links the shared-account guide', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  const blocker = { code: 'claimed_by_other_organization', who: 'organization_admin', account: staging,
    message: 'Staging Account is already used by another Typeroll Organization. Several Organizations may share one Cloudflare account, but only an owner or admin of an Organization that already uses it can connect it here, so that both are under common control. If you administer that Organization too, sign in to Typeroll as that person and connect it again. Otherwise ask an owner or admin of that Organization, or Typeroll support.',
    action: { kind: 'link', label: 'How shared Cloudflare accounts work', url: 'https://typeroll.com/docs/guides/cloudflare-troubleshooting/#claimed_by_other_organization' } };
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: cloudflareStatus({
    diagnosis: cloudflareDiagnosis('action_required', { primary_action: blocker.action, recheck_available: true, accounts: [{ ...staging, usable: false, blockers: [blocker] }] }) }) }));
  await page.goto('/app/settings/publishing#cloudflare');
  const card = page.getByRole('region', { name: 'Cloudflare account', exact: true });
  const reason = card.locator('[data-cloudflare-reason="claimed_by_other_organization"]').first();
  await expect(reason).toContainText('Who acts: Owner or admin of the Organization that uses the account');
  await expect(reason).toContainText('Typeroll support');
  await expect(card.getByRole('link', { name: /How shared Cloudflare accounts work/ }).first()).toHaveAttribute('href', blocker.action.url);
  await expect(card.locator('[data-cloudflare-step="access"]')).toContainText('Action required');
});

test('connecting with API keys asks to confirm an account another Organization uses before saving', async ({ page }) => {
  await authenticatePersona(page, 'owner');
  let connected = false;
  const submitted: Record<string, unknown>[] = [];
  await page.route('**/api/orgs/publishing', async route => {
    await route.fulfill({ json: { github: empty, cloudflare: connected ? { ...empty, status: 'connected', credentials_saved: true, media_ready: true,
      cloudflare: { account_id: staging.id, account_name: staging.name, bucket: 'company-b-media', public_bucket: 'company-b-public' } } : empty,
      github_setup: { available: false, install_url: null }, encryption_available: true } });
  });
  await page.route('**/api/orgs/publishing/cloudflare', async route => {
    const body = route.request().postDataJSON(); submitted.push(body);
    if (body.confirm_shared_account !== true) return route.fulfill({ status: 409, json: { code: 'shared_account_confirmation_required',
      error: 'Staging Account is also used by: Company A. Sites stay separate.', details: { shared_with: ['Company A'] } } });
    connected = true;
    return route.fulfill({ json: { connected: true } });
  });
  await page.goto('/app/settings/publishing');
  await page.getByText('Advanced: connect with existing API and R2 keys', { exact: true }).click();
  await page.getByLabel('Cloudflare Account ID').fill(staging.id);
  await page.getByLabel('R2 bucket name').fill('company-b-media');
  for (const [label, value] of [['Cloudflare API token', 'synthetic-token'], ['R2 Access Key ID', 'synthetic-access'], ['R2 Secret Access Key', 'synthetic-secret']]) await page.getByLabel(label).fill(value);
  await page.getByRole('button', { name: 'Verify and save Cloudflare' }).click();
  const confirmation = page.locator('[data-cloudflare-shared]');
  await expect(confirmation).toContainText('This Cloudflare account is also used by: Company A.');
  // The credentials stay in the form; nothing is saved until the person confirms.
  await expect(page.getByLabel('Cloudflare API token')).toHaveValue('synthetic-token');
  await confirmation.getByRole('checkbox', { name: 'Use this account for this Organization as well' }).check();
  await page.getByRole('button', { name: 'Verify and save Cloudflare' }).click();
  await expect(page.getByRole('status')).toContainText('Cloudflare connection updated');
  expect(submitted).toHaveLength(2);
  expect(submitted[0]).not.toHaveProperty('confirm_shared_account');
  expect(submitted[1]).toMatchObject({ account_id: staging.id, bucket: 'company-b-media', confirm_shared_account: true });
});
