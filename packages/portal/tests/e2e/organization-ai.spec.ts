import { test, expect, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authenticatePersona } from './helpers/auth';

// The Organization's own AI key. Anthropic's key check is the only external
// call: playwright.config.ts points ANTHROPIC_BASE_URL at the stub below,
// which accepts one synthetic key and rejects everything else, the way
// Anthropic answers an unknown key. No real key is used anywhere.

const origin = 'http://127.0.0.1:4322';
const fixtures = path.join(os.tmpdir(), 'typeroll-e2e-fixtures', 'organizations', 'e2e-core');
const CORE_SITE = 'e2e-core-site';
const SECOND_SITE = 'e2e-ai-second-site';
const ACCEPTED_KEY = 'sk-ant-e2e-synthetic-accepted-key-0000ABCD';
const REJECTED_KEY = 'sk-ant-e2e-synthetic-rejected-key-0000WXYZ';

let anthropic: Server;
const keyChecks: string[] = [];

test.beforeAll(async () => {
  anthropic = createServer((request, response) => {
    const key = String(request.headers['x-api-key'] ?? '');
    keyChecks.push(request.url ?? '');
    const accepted = request.method === 'GET' && request.url?.startsWith('/v1/models') && key === ACCEPTED_KEY;
    response.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(accepted ? { data: [], has_more: false } : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  await new Promise<void>((resolve) => anthropic.listen(4329, '127.0.0.1', resolve));
  mkdirSync(path.join(fixtures, 'sites'), { recursive: true });
  writeFileSync(path.join(fixtures, 'sites', `${SECOND_SITE}.json`), JSON.stringify({ name: 'E2E AI second site', created_at: '2026-10-01T00:00:00.000Z', hosting_adapter: 'cloudflare' }));
});

test.afterEach(() => {
  rmSync(path.join(fixtures, 'ai_settings'), { recursive: true, force: true });
});

test.afterAll(async () => {
  rmSync(path.join(fixtures, 'sites', `${SECOND_SITE}.json`), { force: true });
  rmSync(path.join(fixtures, 'sites', SECOND_SITE), { recursive: true, force: true });
  await new Promise<void>((resolve) => anthropic.close(() => resolve()));
});

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const chatLink = (page: Page, siteId: string) => page.locator(`a[href="/app/sites/${siteId}/ai"]`);

async function enableForCoreSite(page: Page) {
  await authenticatePersona(page, 'owner');
  const headers = { Origin: origin };
  expect((await page.request.put('/api/orgs/ai/key', { headers, data: { api_key: ACCEPTED_KEY } })).status()).toBe(200);
  expect((await page.request.put('/api/orgs/ai/site-access', { headers, data: { mode: 'selected', site_ids: [CORE_SITE] } })).status()).toBe(200);
}

test('an owner adds a verified key, selects one site, and the chat appears only there', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  // Without a key the chat is nowhere.
  await page.goto(`/app/sites/${CORE_SITE}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(chatLink(page, CORE_SITE)).toHaveCount(0);

  const response = await page.goto('/app/settings/ai-assistant');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toBe('no-store');
  await expect(page.getByRole('heading', { name: 'AI assistant', level: 1 })).toBeVisible();
  await expect(page.getByText('No key.', { exact: false })).toBeVisible();
  await expect(page.getByText('Add a key above to choose sites.')).toBeVisible();

  const keyField = page.getByLabel('API key', { exact: true });
  await expect(keyField).toHaveAttribute('type', 'password');
  await expect(keyField).toHaveValue('');

  // A key Anthropic rejects is not stored, and the message never echoes it.
  await keyField.fill(REJECTED_KEY);
  await page.getByRole('button', { name: 'Verify and save key' }).click();
  const rejected = page.getByRole('alert');
  await expect(rejected).toContainText('Anthropic rejected this API key');
  await expect(rejected).toBeFocused();
  expect(await page.content()).not.toContain(REJECTED_KEY);

  await keyField.fill(ACCEPTED_KEY);
  await page.getByRole('button', { name: 'Verify and save key' }).click();
  const saved = page.getByRole('status').filter({ hasText: 'verified with Anthropic and saved' });
  await expect(saved).toContainText('No sites use it yet');
  await expect(saved).toBeFocused();
  await expect(page.getByText('Verified key ending in ABCD')).toBeVisible();
  await expect(page.getByLabel('Replace with a new key')).toHaveValue('');
  expect(keyChecks.some((url) => url.startsWith('/v1/models'))).toBe(true);

  // A new key has no sites: "Only selected sites" with nothing checked.
  await expect(page.getByLabel('Only selected sites')).toBeChecked();
  await expect(page.getByLabel('Typeroll E2E Core Site')).not.toBeChecked();
  await expect(page.getByLabel('E2E AI second site')).not.toBeChecked();
  await page.getByLabel('Typeroll E2E Core Site').check();
  await page.getByRole('button', { name: 'Save site access' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Site access saved' })).toContainText('1 site has the AI assistant');

  // The key never reaches the browser, after reloads either.
  await page.reload();
  expect(await page.content()).not.toContain(ACCEPTED_KEY);
  const summary = await page.request.get('/api/orgs/ai');
  expect(summary.headers()['cache-control']).toBe('no-store');
  expect(await summary.text()).not.toContain(ACCEPTED_KEY);

  for (const width of [390, 1440]) {
    // Tall enough to show the whole page without stitching the sticky bars.
    await page.setViewportSize({ width, height: width < 768 ? 1500 : 1100 });
    await page.reload();
    await expect(page.getByText('Verified key ending in ABCD')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`ai-assistant-settings-${width}.png`), animations: 'disabled' });
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/sites/${CORE_SITE}`);
  await expect(chatLink(page, CORE_SITE).first()).toBeVisible();
  await page.goto(`/app/sites/${SECOND_SITE}`);
  await expect(page.getByRole('heading', { name: 'E2E AI second site', level: 1 })).toBeVisible();
  await expect(chatLink(page, SECOND_SITE)).toHaveCount(0);
});

test('an editor on a site without access sees no chat and can still edit the site', async ({ page }) => {
  await enableForCoreSite(page);
  await authenticatePersona(page, 'editor');

  // Not an owner or admin: no settings page, no settings API.
  expect((await page.goto('/app/settings/ai-assistant'))?.status()).toBe(403);
  expect((await page.request.get('/api/orgs/ai')).status()).toBe(403);
  expect((await page.request.put('/api/orgs/ai/site-access', { headers: { Origin: origin }, data: { mode: 'all' } })).status()).toBe(403);

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/sites/${SECOND_SITE}`);
    await expect(page.getByRole('heading', { name: 'E2E AI second site', level: 1 })).toBeVisible();
    await expect(chatLink(page, SECOND_SITE)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'AI assistant' })).toHaveCount(0);
    expect(await noHorizontalScroll(page)).toBe(true);
  }
  await page.goto(`/app/sites/${SECOND_SITE}/ai`);
  await expect(page).toHaveURL(`${origin}/app/sites/${SECOND_SITE}`);
  const refused = await page.request.post(`/api/sites/${SECOND_SITE}/chat`, { headers: { Origin: origin }, data: { message: 'Hello' } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('ai_not_enabled');

  // The allowed site shows the chat to the same editor.
  await page.goto(`/app/sites/${CORE_SITE}`);
  await expect(chatLink(page, CORE_SITE).first()).toBeVisible();

  // Content work is not gated: the editor can still create a page on the
  // second site (MCP and the public API are covered by unit tests).
  const created = await page.request.post(`/api/sites/${SECOND_SITE}/pages/create`, {
    headers: { Origin: origin }, form: { title: 'Edited without the AI chat', content_mode: 'html' }, maxRedirects: 0,
  });
  expect(created.status()).toBe(302);
  expect(created.headers().location).toContain(`/app/sites/${SECOND_SITE}/pages/`);
});

test('a read-only viewer never gets the chat, even on an allowed site', async ({ page }) => {
  await enableForCoreSite(page);
  await authenticatePersona(page, 'viewer');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/sites/${CORE_SITE}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(chatLink(page, CORE_SITE)).toHaveCount(0);
  await page.goto(`/app/sites/${CORE_SITE}/ai`);
  await expect(page).toHaveURL(`${origin}/app/sites/${CORE_SITE}`);
});
