import { test, expect, type Page } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

// One Cloudflare permission update per account, then Analytics chosen per
// Site. Provider responses are synthetic; nothing reaches Cloudflare.
const ACCOUNT = { account_id: 'a'.repeat(32), account_name: 'Moveria AB' };
const capability = (id: string, status: string, missing: string[], enables: string) => ({ capability: id, status, enables, required_scopes: missing, missing_scopes: missing, next_step: null });
const permissions = {
  hosting_group_id: 'default', hosting_group_name: 'Default', connected: true, ...ACCOUNT, auth_method: 'oauth', requested_optional_scopes: [],
  capabilities: [capability('analytics_provisioning', 'approval_required', ['account-settings.write'], 'Create a Site’s Cloudflare Web Analytics site when Analytics is enabled for that Site'),
    capability('analytics_reports', 'approval_required', ['account-analytics.read'], 'Read Web Analytics reports for Insights'),
    capability('redirect_rules', 'available', [], 'Create the Single Redirect rule for redirect hosts such as www')],
  permission_update: { required: true, missing_scopes: ['account-settings.write', 'account-analytics.read'], hosting_group_ids: ['default', 'group-2'],
    action: { kind: 'approve_update', label: 'Approve update' }, next_step: 'Approve update', connect_url: '/app/settings/publishing#cloudflare' },
};

async function mockPublishing(page: Page, posts: unknown[]) {
  const empty = { status: 'disconnected', revision: 'synthetic-revision', credentials_saved: false, github: null, cloudflare: null };
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: { account_name: ACCOUNT.account_name, zones: [] } }));
  await page.route('**/api/orgs/publishing', route => route.fulfill({ json: {
    github: empty, github_setup: { available: false }, github_choices: [], encryption_available: true, cloudflare_setup: { available: true }, cloudflare_choices: [],
    cloudflare: { ...empty, status: 'connected', auth_method: 'oauth', credentials_saved: true, media_ready: true,
      cloudflare: { ...ACCOUNT, bucket: 'organization-media', public_bucket: 'organization-public-media', endpoint: '' } },
    cloudflare_permissions: permissions,
  } }));
  await page.route('**/api/orgs/publishing/cloudflare', route => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { authorization_url: '/app/settings/publishing?cloudflare=connected#cloudflare', hosting_group_ids: ['default', 'group-2'] } });
  });
}

test('Approve update explains that it grants permission only, before Cloudflare', async ({ page }) => {
  const posts: unknown[] = [];
  await authenticatePersona(page, 'owner');
  await mockPublishing(page, posts);
  await page.goto('/app/settings/publishing#cloudflare');
  const update = page.locator('[data-cloudflare-permission-update]');
  await expect(update.getByRole('heading', { name: 'Permission update available' })).toBeVisible();
  await expect(update).toContainText('Create Web Analytics sites');
  await update.getByRole('button', { name: 'Approve update' }).click();
  await expect(update).toContainText('This only gives Typeroll permission in Moveria AB.');
  await expect(update).toContainText('Analytics stays off for every Site until you enable it');
  await expect(update).toContainText('once for each of the 2 connections');
  expect(posts).toEqual([]);
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await update.getByRole('button', { name: 'Continue to Cloudflare' }).click();
  await expect(page).toHaveURL(/cloudflare=connected/);
  expect(posts).toEqual([{ action: 'approve_update' }]);
});

test('the Analytics tab changes only the Sites that were chosen', async ({ page }) => {
  const posts: Array<{ sites: Array<{ site_id: string; enabled: boolean }> }> = [];
  await authenticatePersona(page, 'owner');
  await mockPublishing(page, []);
  const site = (id: string, name: string, enabled: boolean) => ({ site_id: id, name, publishing_mode: 'customer_git', hosting_group_id: 'default', hosting_group_name: 'Default',
    enabled, setup: enabled ? { status: 'ready', checked_at: '2026-10-22T00:00:00.000Z' } : null, beacon_configured: enabled });
  let sites = [site('alpha', 'Moveria Göteborg', true), site('bravo', 'Moveria Stockholm', false), site('charlie', 'Moveria Malmö', false)];
  await page.route('**/api/orgs/analytics', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); posts.push(body);
      sites = sites.map(item => body.sites.find((change: { site_id: string }) => change.site_id === item.site_id) ? site(item.site_id, item.name, true) : item);
      return route.fulfill({ json: { results: body.sites.map((change: { site_id: string }) => ({ site_id: change.site_id, enabled: true, status: 'ready' })) } });
    }
    return route.fulfill({ json: { sites, cloudflare_permissions: [permissions] } });
  });
  await page.goto('/app/settings/publishing#analytics');
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Analytics', exact: true }) });
  await expect(card.locator('.publishing-card__status')).toContainText('1 of 3 Sites measured');
  await expect(card).toContainText('turns Analytics on for no Site');
  await expect(card.getByRole('link', { name: 'Approve update' })).toHaveAttribute('href', '/app/settings/publishing#cloudflare');
  await card.getByRole('checkbox', { name: /Moveria Malmö/ }).check();
  await card.getByRole('button', { name: 'Save changes for 1 Site' }).click();
  await expect(card.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  expect(posts).toEqual([{ sites: [{ site_id: 'charlie', enabled: true }] }]);
  await expect(card.getByRole('checkbox', { name: /Moveria Stockholm/ })).not.toBeChecked();
  await expect(card.locator('.publishing-card__status')).toContainText('2 of 3 Sites measured');
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
