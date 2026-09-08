import { test, expect } from '@playwright/test';
import { authenticatePersona } from './helpers/auth';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: { account_name: 'Example', zones: [] } }));
});

test('organization domain form saves the exact hostname and remains usable on mobile', async ({ page }) => {
  let domain = { revision: 'initial', sites_domain: null as string | null, media_host: null as string | null, dns_mode: 'automatic', verified_at: null };
  await page.route('**/api/orgs/publishing/domains', async route => {
    if (route.request().method() === 'PUT') {
      const submitted = route.request().postDataJSON();
      expect(submitted.revision).toBe(domain.revision);
      expect(submitted.media_host).toBe('Media.example.com');
      domain = { ...domain, revision: 'saved', media_host: 'media.example.com', sites_domain: submitted.sites_domain, dns_mode: submitted.dns_mode };
    }
    await route.fulfill({ json: domain });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  await page.getByText('Manual settings or external DNS', { exact: true }).click();
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Domains', exact: true }) });
  await expect(section.getByLabel('Shared media host')).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(section.getByRole('button', { name: 'Save domain settings' })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await section.getByLabel('Shared media host').fill('Media.example.com');
  await section.getByLabel('Site address base').fill('sites.example.com');
  await section.getByLabel('DNS management').selectOption('external');
  await section.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(section.getByRole('status')).toContainText('Organization domains saved');
  await expect(section.getByLabel('Shared media host')).toHaveValue('media.example.com');
  await expect(section.getByLabel('Site address base')).toHaveValue('sites.example.com');
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
  await page.getByText('Manual settings or external DNS', { exact: true }).click();
  await page.getByLabel('Shared media host').fill('https://media.example.com/path');
  await page.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(page.getByRole('alert')).toContainText('without https:// or a path');
  await expect(page.getByLabel('Shared media host')).toHaveValue('https://media.example.com/path');
});

test('organization domain settings reject a non-admin session', async ({ page }) => {
  await authenticatePersona(page, 'editor');
  expect((await page.request.get('/api/orgs/publishing/domains')).status()).toBe(403);
  expect((await page.request.put('/api/orgs/publishing/domains', {
    headers: { Origin: 'http://127.0.0.1:4322' }, data: { revision: 'initial', media_host: 'media.example.com', sites_domain: 'sites.example.com', dns_mode: 'automatic' },
  })).status()).toBe(403);
});

test('shows media status and external DNS instructions without discarding unsaved hostnames', async ({ page }) => {
  let active = false;
  await page.route('**/api/orgs/publishing/domains', async route => {
    await route.fulfill({ json: {
      revision: 'saved', sites_domain: 'sites.example.com', media_host: 'media.example.net', dns_mode: 'external', verified_at: null,
      domain_status: { hostname: 'media.example.net', state: active ? 'active' : 'pending', checked_at: '2026-09-08T08:00:00Z',
        message: active ? 'Cloudflare has activated this media domain and its HTTPS certificate.' : 'Waiting for Cloudflare to confirm domain ownership and HTTPS.',
        account_name: 'Example organization', account_id: 'synthetic-account', public_bucket: 'typeroll-public-0123456789abcdef',
        ownership: 'active', certificate: active ? 'active' : 'pending', zone_check: 'found', zone: { name: 'example.net', type: 'partial', status: 'active' },
        steps: [{ title: 'If DNS is hosted by another provider', description: 'Keep your current nameservers and other services. Use Cloudflare Business or Enterprise partial (CNAME) setup for only the selected hostnames.', url: 'https://developers.cloudflare.com/dns/zone-setups/partial-setup/setup/' },
          { title: 'Connect the media domain', description: 'In Cloudflare → R2 object storage → typeroll-public-0123456789abcdef → Settings → Custom Domains → Add, enter media.example.net.', url: 'https://dash.cloudflare.com/synthetic-account/r2/default/buckets/typeroll-public-0123456789abcdef/settings' }],
      },
    } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  await page.getByText('Manual settings or external DNS', { exact: true }).click();
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Domains', exact: true }) });
  await expect(section.getByText('Waiting for domain activation', { exact: true })).toBeVisible();
  await expect(section).toHaveAttribute('data-state', 'waiting');
  await expect(section.locator('details[open]')).toHaveCount(1);
  await section.getByText('Domain connection details', { exact: true }).click();
  await expect(section.getByText('External DNS with Cloudflare partial setup', { exact: false })).toBeVisible();
  await expect(section.getByText('If DNS is hosted by another provider', { exact: true })).not.toBeVisible();
  await section.getByText('Setup instructions', { exact: true }).click();
  await expect(section.getByText('If DNS is hosted by another provider', { exact: true })).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ fullPage: true, path: `test-results/organization-domains-${width}.png`, animations: 'disabled' });
  }
  await section.getByLabel('Site address base').fill('unsaved.example.com');
  active = true;
  await section.getByRole('button', { name: 'Check domain status' }).click();
  await expect(section.getByText('Media domain active in Cloudflare', { exact: true })).toBeVisible();
  await expect(section).toHaveAttribute('data-state', 'ready');
  await expect(section.getByLabel('Site address base')).toHaveValue('unsaved.example.com');
  await expect(section.getByLabel('Shared media host')).toHaveValue('media.example.net');
});

test('configures short subdomains in one action and automatically checks activation without losing edits', async ({ page }) => {
  const zone = { id: 'a'.repeat(32), name: 'example.com', status: 'active', type: 'full' };
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: { account_name: 'Example', zones: [zone] } }));
  let configured = false, active = false;
  await page.route('**/api/orgs/publishing/domains', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ revision: 'initial', zone_id: zone.id, media_subdomain: 'media', sites_subdomain: 'demos' });
      configured = true;
    }
    await route.fulfill({ json: { revision: configured ? 'saved' : 'initial', sites_domain: configured ? 'demos.example.com' : null, media_host: configured ? 'media.example.com' : null, dns_mode: 'automatic',
      domain_status: { state: configured ? active ? 'active' : 'pending' : 'not_configured', checked_at: new Date().toISOString(), hostname: configured ? 'media.example.com' : null,
        message: active ? 'Cloudflare has activated the domain.' : 'Waiting for Cloudflare.', account_name: 'Example', steps: [] } } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Domains', exact: true }) });
  await expect(section.getByLabel('Cloudflare domain')).toHaveValue(zone.id);
  await expect(section.getByLabel('Media subdomain')).toHaveValue('media');
  await section.getByLabel('Sites subdomain').fill('demos');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await section.screenshot({ path: `test-results/domain-setup-${width}.png`, animations: 'disabled' });
  }
  await section.getByRole('button', { name: 'Configure domains', exact: true }).click();
  await expect(section.getByText('Waiting for domain activation', { exact: true })).toBeVisible();
  await expect(section).toHaveAttribute('data-state', 'waiting');
  await section.getByLabel('Sites subdomain').fill('unsaved');
  active = true;
  await expect(section.getByText('Media domain active in Cloudflare', { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(section.getByLabel('Sites subdomain')).toHaveValue('unsaved');
  await section.getByRole('button', { name: 'Refresh domain list' }).click();
  await expect(section.getByLabel('Sites subdomain')).toHaveValue('unsaved');
});

test('rejects organization domain setup and discovery for a site editor and cross-origin writes', async ({ page }) => {
  await page.unroute('**/api/orgs/publishing/zones');
  await authenticatePersona(page, 'editor');
  expect((await page.request.get('/api/orgs/publishing/zones')).status()).toBe(403);
  expect((await page.request.post('/api/orgs/publishing/domains', { data: {} })).status()).toBe(403);
  await authenticatePersona(page, 'owner');
  expect((await page.request.post('/api/orgs/publishing/domains', { headers: { Origin: 'https://other.example.com' }, data: {} })).status()).toBe(403);
});

test('refreshes newly added domains without account authorization and only asks for missing permissions', async ({ page }) => {
  let available = false, approval = false, authorizations = 0;
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: {
    account_name: 'Example', domain_access: approval ? 'approval_required' : 'granted',
    zones: available ? [{ id: 'a'.repeat(32), name: 'example.com', status: 'active', type: 'full' }] : [],
  } }));
  await page.route('**/api/orgs/publishing/cloudflare', route => { authorizations++; return route.fulfill({ status: 503, json: { error: 'Synthetic approval service unavailable' } }); });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Domains', exact: true }) });
  await expect(section.getByText('No domains were returned', { exact: false })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Allow domain access' })).toHaveCount(0);
  await expect(section.getByText('reconnect', { exact: false })).toHaveCount(0);
  available = true;
  await section.getByRole('button', { name: 'Refresh domain list' }).click();
  await expect(section.getByRole('status')).toHaveText('Domain list updated.');
  await expect(section.getByLabel('Cloudflare domain')).toHaveValue('a'.repeat(32));
  expect(authorizations).toBe(0);
  approval = true;
  await section.getByRole('button', { name: 'Refresh domain list' }).click();
  await expect(section.getByRole('button', { name: 'Allow domain access' })).toBeVisible();
  await section.getByRole('button', { name: 'Allow domain access' }).click();
  await expect(section.getByRole('alert')).toHaveText('Synthetic approval service unavailable');
  expect(authorizations).toBe(1);
});

for (const allowed of [true, false]) test(`saved media hostname replacement is ${allowed ? 'available when unused' : 'blocked when used'}`, async ({ page }) => {
  const zone = { id: 'a'.repeat(32), name: 'example.com', status: 'active', type: 'full' };
  await page.route('**/api/orgs/publishing/zones', route => route.fulfill({ json: { account_name: 'Example', domain_access: 'granted', zones: [zone] } }));
  let submissions = 0;
  await page.route('**/api/orgs/publishing/domains', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ revision: 'saved', zone_id: zone.id, media_subdomain: 'media-staging', sites_subdomain: 'sites-staging' });
      submissions++;
      return route.fulfill({ status: 409, json: { error: 'Domain settings changed. Reload before configuring domains.' } });
    }
    await route.fulfill({ json: { revision: 'saved', sites_domain: 'media.example.com', media_host: 'media.example.com', dns_mode: 'external', media_host_change_allowed: allowed } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto('/app/settings/publishing');
  const section = page.getByRole('region', { name: 'Domains', exact: true });
  await expect(section.getByLabel('Media subdomain')).toHaveValue('media');
  await section.getByLabel('Media subdomain').fill('media-staging');
  await section.getByLabel('Sites subdomain').fill('sites-staging');
  const button = section.getByRole('button', { name: 'Configure domains', exact: true });
  if (allowed) {
    await expect(button).toBeEnabled();
    await expect(section.getByText('The saved media hostname has not been used.', { exact: false })).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await section.screenshot({ path: `test-results/unused-domain-${width}.png`, animations: 'disabled' });
    }
    await button.click();
    expect(submissions).toBe(1);
    await expect(section.getByRole('alert')).toContainText('Domain settings changed.');
    await expect(section.getByLabel('Media subdomain')).toHaveValue('media-staging');
  } else {
    await expect(button).toBeDisabled();
    await expect(section.getByText('Keep your existing media host, media.example.com', { exact: false })).toBeVisible();
    await section.getByLabel('Media subdomain').fill('media');
    await expect(button).toBeEnabled();
    expect(submissions).toBe(0);
  }
});
