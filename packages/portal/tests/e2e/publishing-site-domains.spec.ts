import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { authenticatePersona } from './helpers/auth';

const org = 'e2e-core', site = 'e2e-domain-site';
const endpoint = `**/api/sites/${site}/publishing/domains`;

/** A separate customer publishing site, so the shared E2E site keeps its own publishing mode. */
async function customerPublishingSite() {
  if ((process.env.TYPEROLL_E2E_TARGET ?? 'local') !== 'local') test.skip(true, 'Synthetic fixture only supports local execution');
  const root = join(tmpdir(), 'typeroll-e2e-fixtures');
  const source = JSON.parse(await readFile(join(root, `organizations/${org}/sites/e2e-core-site.json`), 'utf8'));
  const file = join(root, `organizations/${org}/sites/${site}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...source, name: 'Synthetic domain site', slug: site, publishing_mode: 'customer_git' }));
}

const base = {
  revision: 'r1', dns_mode: 'automatic', state: 'declared', media_aliases: [],
  active: { website_host: 'old.sites.example.com', media_host: null, media_path_prefix: '' },
  desired: { website_host: 'example.com', media_host: null, media_path_prefix: '', redirect_hosts: ['www.example.com'] },
};

async function noHorizontalScroll(page: Page) {
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}

test('shows pending-zone blockers before preparation and saves redirect hosts', async ({ page }, info) => {
  await customerPublishingSite();
  let saved: Record<string, unknown> | null = null;
  const blockers = [
    { code: 'zone_not_active', severity: 'blocking', host: 'example.com', message: 'example.com is in the Cloudflare account, but its status is pending, not active.' },
    { code: 'zone_not_active', severity: 'blocking', host: 'www.example.com', message: 'www.example.com needs the same active zone.' },
  ];
  await page.route(endpoint, async route => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { ...base, revision: 'r2', desired: { ...base.desired, redirect_hosts: ['old.example.com', 'www.example.com'] }, host_checks: { blockers: [], warnings: [] } } });
    }
    await route.fulfill({ json: { ...base, host_checks: { blockers, warnings: [] } } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings`);
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Website and media addresses', exact: true }) });
  await expect(section.getByRole('alert')).toContainText('Resolve before preparing the domain change');
  await expect(section.getByRole('alert')).toContainText('status is pending');
  await expect(section.getByRole('button', { name: 'Prepare domain change from published content' })).toBeDisabled();
  await expect(section.getByLabel('Redirect hosts')).toHaveValue('www.example.com');
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('site-domain-blockers.png'), fullPage: true });
  await section.getByLabel('Redirect hosts').fill('www.example.com, old.example.com');
  await section.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(section.getByRole('status')).toContainText('Future addresses saved');
  expect(saved).toMatchObject({ revision: 'r1', website_host: 'example.com', redirect_hosts: 'www.example.com, old.example.com' });
  await expect(section.getByLabel('Redirect hosts')).toHaveValue('old.example.com, www.example.com');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Prepare domain change from published content' })).toBeEnabled();
});

test('requires explicit acceptance of the validation window and shows the redirect rule', async ({ page }, info) => {
  await customerPublishingSite();
  let approval: Record<string, unknown> | null = null;
  const prepared = { ...base, state: 'ready_to_switch', candidate: { id: 'candidate' },
    preparation: { hostname: 'example.com', certificate_ready: false, has_existing_traffic: true, requirements: [{ phase: 'traffic', type: 'CNAME', name: 'example.com', content: 'typeroll-synthetic.pages.dev', status: 'required' }],
      validation_blocker: { code: 'domain_prevalidation_unavailable', resolution: 'accept_validation_window', message: 'Cloudflare Pages validates example.com only after its record points at Pages. To roll back, restore A example.com 192.0.2.10 (DNS only).' } },
    redirect_preparations: [{ hostname: 'www.example.com', target_host: 'example.com', action: 'approve_cutover', zone_id: 'zone', certificate_ready: true, has_existing_traffic: true, blocker: null,
      requirements: [{ phase: 'traffic', type: 'A', name: 'www.example.com', content: '192.0.2.1', status: 'required' }],
      rule: { zone_name: 'example.com', expression: 'http.host eq "www.example.com"', target_url_expression: 'concat("https://example.com", http.request.uri.path)', status: 'configured', managed: true } }],
    host_checks: { blockers: [], warnings: [] } };
  await page.route(endpoint, route => route.fulfill({ json: prepared }));
  await page.route(`**/api/sites/${site}/publishing/cutover`, async route => {
    approval = route.request().postDataJSON();
    await route.fulfill({ json: { ...prepared, state: 'distributing' } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings`);
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Website and media addresses', exact: true }) });
  await expect(section.getByRole('alert')).toContainText('The switch has a short validation window');
  await expect(section).toContainText('Redirect from www.example.com to example.com is ready to switch with the website');
  await section.getByText('DNS records and instructions', { exact: true }).click();
  await expect(section.getByText('http.host eq "www.example.com"', { exact: true })).toBeVisible();
  const button = section.getByRole('button', { name: 'Switch website traffic' });
  await expect(button).toBeDisabled();
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('site-domain-validation-window.png'), fullPage: true });
  await section.getByLabel(/accept that example.com does not answer/).check();
  await button.click();
  await expect(section.getByRole('status')).toContainText('Traffic switch approved');
  expect(approval).toEqual({ revision: 'r1', candidate_id: 'candidate', accept_validation_window: true });
});
