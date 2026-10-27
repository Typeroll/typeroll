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
  next_publication: { message: 'Normal publication continues at the current address. Choose Publish for the new domain shortly before changing DNS.' },
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

const guideBase = { title: 'Move site to example.com', revision: 'r1', state: 'declared', traffic_live: false, current_phase: 'declared', next_action: 'prepare', can_prepare: false, checks: [{ id: 'zone', status: 'action_required', message: 'example.com is pending. Review DNS and update nameservers at your registrar.' }], switch_summary: { interruption: 'Cloudflare must validate the host after the switch.', rollback: 'Previous DNS will be restored if verification fails.', validation_timeout_minutes: 15 } };
const guideEndpoint = `**/api/sites/${site}/publishing/domain-guide`;

test('shows blockers, saves redirect hosts without rebuilding and renders at desktop and mobile widths', async ({ page }, info) => {
  await customerPublishingSite();
  let saved: Record<string, unknown> | null = null;
  let current = { ...base };
  await page.route(endpoint, async route => {
    if (route.request().method() === 'PUT') {
      saved = route.request().postDataJSON();
      current = { ...base, revision: 'r2', desired: { ...base.desired, redirect_hosts: ['old.example.com', 'www.example.com'] } };
    }
    await route.fulfill({ json: current });
  });
  await page.route(guideEndpoint, route => route.fulfill({ json: route.request().method() === 'POST' ? { confirmation_required: false, candidate_preserved: true } : { ...guideBase, revision: current.revision, can_prepare: current.revision === 'r2' } }));
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  await expect(page.getByRole('button', { name: 'Publish for the new domain' })).toBeDisabled();
  await expect(page.getByText('example.com is pending.', { exact: false })).toBeVisible();
  await page.getByText('Edit website and media addresses', { exact: true }).click();
  await page.getByLabel('Redirect hosts', { exact: true }).fill('www.example.com, old.example.com');
  await page.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(page.getByText('Future addresses saved.', { exact: false })).toBeVisible();
  expect(saved).toMatchObject({ revision: 'r1', website_host: 'example.com', redirect_hosts: 'www.example.com, old.example.com' });
  await expect(page.getByLabel('Redirect hosts', { exact: true })).toHaveValue('old.example.com, www.example.com');
  await expect(page.getByRole('button', { name: 'Publish for the new domain' })).toBeEnabled();
  await page.getByText('Edit website and media addresses', { exact: true }).click();
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`domain-guide-${width}.png`), fullPage: true, animations: 'disabled' });
  }
});

test('requires explicit approval of the validation window and never describes queued switching as live', async ({ page }) => {
  await customerPublishingSite();
  let approval: Record<string, unknown> | null = null;
  let current = { ...guideBase, state: 'ready_to_switch', next_action: 'approve', current_phase: 'awaiting domain cutover approval', candidate: { id: 'candidate' }, preparation: { validation_blocker: { resolution: 'accept_validation_window' } }, checks: [{ id: 'candidate', status: 'ready', message: 'Candidate verified.' }] };
  await page.route(endpoint, route => route.fulfill({ json: base }));
  await page.route(guideEndpoint, async route => {
    if (route.request().method() === 'POST') {
      approval = route.request().postDataJSON();
      current = { ...current, state: 'distributing', next_action: 'wait', current_phase: 'verifying public traffic' };
    }
    await route.fulfill({ json: current });
  });
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  await page.getByRole('button', { name: 'Review traffic switch' }).click();
  const button = page.getByRole('button', { name: 'Approve and switch traffic' });
  await expect(button).toBeDisabled();
  await page.getByLabel('I accept that the website may be unavailable until Cloudflare validates it.').check();
  await button.click();
  await expect(page.getByText('Switch approved.', { exact: false })).toBeVisible();
  await expect(page.getByText('Live and verified', { exact: true })).toHaveCount(0);
  await expect(page.getByText('verifying public traffic', { exact: false })).toBeVisible();
  expect(approval).toEqual({ action: 'approve', revision: 'r1', candidate_id: 'candidate', accept_validation_window: true, validation_timeout_minutes: 15 });
});

test('cancelling a rebuild confirmation keeps the saved settings and candidate', async ({ page }) => {
  await customerPublishingSite();
  let saves = 0;
  await page.route(endpoint, route => { if (route.request().method() === 'PUT') saves++; return route.fulfill({ json: base }); });
  await page.route(guideEndpoint, route => route.fulfill({ json: route.request().method() === 'POST' ? { confirmation_required: true, message: 'These addresses require a new verified candidate.' } : guideBase }));
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  await page.getByText('Edit website and media addresses', { exact: true }).click();
  await page.getByLabel('Website host', { exact: true }).fill('new.example.com');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Save domain settings' }).click();
  await expect(page.getByRole('button', { name: 'Save domain settings' })).toBeEnabled();
  expect(saves).toBe(0);
  await expect(page.getByLabel('Website host', { exact: true })).toHaveValue('new.example.com');
});

test('explains future-host builds and warns about frozen noindex before cutover', async ({ page }, info) => {
  await customerPublishingSite();
  await page.route(endpoint, route => route.fulfill({json:{...base,state:'ready_to_switch',
    next_publication:{message:'Normal publication continues at the current test address. Publish for the new domain is a separate action.'},
    candidate:{id:'candidate',sitewide_noindex:true,robots_blocked:false},
    preparation:{hostname:'example.com',certificate_ready:true,has_existing_traffic:false,requirements:[]},
    host_checks:{blockers:[],warnings:[]}}}));
  await page.route(guideEndpoint, route => route.fulfill({json:{...guideBase,state:'ready_to_switch',next_action:'approve',can_prepare:true}}));
  await authenticatePersona(page,'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  await expect(page.getByText(/Normal publication continues at the current test address/)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('This publication has noindex enabled');
  await expect(page.getByRole('alert')).toContainText('The DNS approval will then refer to that latest publication');
  await noHorizontalScroll(page);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({width,height:900});
    await page.getByRole('heading', {name:'Website and media addresses',exact:true}).evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - 80));
    await page.screenshot({path:info.outputPath(`domain-candidate-indexing-${width}.png`), animations: 'disabled'});
  }
});


test('only replaces main after an explicit click and explains legacy preparations', async ({ page }, info) => {
  await customerPublishingSite();
  let calls = 0;
  let state = 'declared';
  await page.route(endpoint, route => route.fulfill({ json: { ...base, state,
    host_checks: { blockers: [], warnings: [] },
    ...(state === 'outdated' ? { candidate: { id: 'older' }, preparation: { hostname: 'example.com', certificate_ready: true, requirements: [] } } : {}),
  } }));
  await page.route(guideEndpoint, route => {
    if (route.request().method() === 'POST') {
      calls++;
      expect(route.request().postDataJSON()).toEqual({ action: 'prepare', revision: 'r1' });
      return route.fulfill({ json: { job_id: 'candidate', already_running: false } });
    }
    return route.fulfill({ json: { ...guideBase, state, can_prepare: true } });
  });
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Website and media addresses', exact: true }) });
  await expect(section.getByText(/Normal publication continues/)).toBeVisible();
  expect(calls).toBe(0);
  await expect(section.getByText(/replacing the site at its current address/)).toBeVisible();
  await section.getByRole('button', { name: 'Publish for the new domain' }).click();
  await expect(section.getByText(/Publishing for the new domain started/)).toBeVisible();
  expect(calls).toBe(1);
  state = 'outdated';
  await page.reload();
  await expect(section.getByRole('alert')).toContainText('This older preparation is not the current main publication');
  await expect(section.getByRole('button', { name: 'Review traffic switch' })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Publish for the new domain' })).toBeEnabled();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await section.evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - 80));
    await page.screenshot({ path: info.outputPath(`domain-preparation-outdated-${width}.png`), animations: 'disabled' });
  }
});

for (const width of [390, 1280]) test(`shows verified redirects and noindex warnings for previous addresses at ${width}px`, async ({ page }, info) => {
  await customerPublishingSite();
  await page.setViewportSize({ width, height: 900 });
  await page.route(endpoint, route => route.fulfill({ json: base }));
  await page.route(guideEndpoint, route => route.fulfill({ json: { ...guideBase, state: 'live', traffic_live: true, next_action: 'none', current_phase: 'live', checks: [], previous_hosts: [
    { host: 'site-782c37b7bd005ada.sites.example.com', target_host: 'example.com', mode: 'redirect', status: 'verified', message: '301 redirect preserves the path and query string.' },
    { host: 'old-demo.sites.example.com', target_host: 'example.com', mode: 'noindex', status: 'warning', message: 'The old address is blocked from indexing. Enable Single Redirect access to finish.' },
  ] } }));
  await authenticatePersona(page, 'owner');
  await page.goto(`/app/sites/${site}/settings?section=publishing`);
  const section = page.getByRole('region', { name: 'Previous website addresses' });
  await expect(section).toBeVisible();
  await expect(section.getByText('301 → example.com', { exact: true })).toBeVisible();
  await expect(section.getByText('Noindex protection · redirect needs attention')).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`previous-hosts-${width}.png`), animations: 'disabled' });
});
