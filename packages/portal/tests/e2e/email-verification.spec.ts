import { test, expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import { authenticatePersona } from './helpers/auth';

const origin = 'http://127.0.0.1:4322';

async function expectCheckEmail(page: Page, next: string | null) {
  await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toBe('/verify-email');
  expect(url.searchParams.get('next')).toBe(next);
}

test('an account without a confirmed email reaches only "Check your email"', async ({ page }, testInfo) => {
  // The owner persona is a member of e2e-core: the membership is kept but unusable.
  await authenticatePersona(page, 'owner', { emailVerified: false });

  for (const [path, next] of [
    ['/', null],
    ['/app', null],
    ['/login', null],
    ['/app/settings/api-keys', '/app/settings/api-keys'],
    ['/app/sites/e2e-core-site', '/app/sites/e2e-core-site'],
    ['/onboarding', '/onboarding'],
    ['/onboarding?invite=synthetic-invite', '/onboarding?invite=synthetic-invite'],
  ] as const) {
    await page.goto(path);
    await expectCheckEmail(page, next);
  }

  const registered = await page.request.post('/api/mcp/oauth/register', { data: { redirect_uris: ['https://client.example.test/callback'] } });
  const { client_id } = await registered.json();
  const challenge = crypto.createHash('sha256').update('synthetic-pkce-verifier-for-email-gate').digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client.example.test/callback', code_challenge: challenge, code_challenge_method: 'S256' });
  await page.goto(`/api/mcp/oauth/authorize?${query}`);
  await expectCheckEmail(page, `/mcp/consent?${query}`);

  const headers = { Origin: origin };
  expect((await page.request.get('/api/orgs')).status()).toBe(401);
  expect((await page.request.get('/api/sites/e2e-core-site/pages')).status()).toBe(401);
  expect((await page.request.post('/api/orgs/create', { headers, data: { name: 'Unconfirmed Org' } })).status()).toBe(401);
  expect((await page.request.post('/api/orgs/invite/join', { headers, data: { token: 'synthetic-invite' } })).status()).toBe(401);
  expect((await page.request.post('/api/orgs/api-keys', { headers, data: { name: 'unconfirmed' } })).status()).toBe(401);
  expect((await page.request.post('/api/mcp/oauth/complete', { headers, form: { decision: 'allow', ...Object.fromEntries(query) } })).status()).toBe(401);

  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/verify-email?next=%2Fapp%2Fsettings');
    await expect(page.locator('[data-verify-ready="true"]')).toBeVisible();
    await expect(page.getByText('Confirm your email address to continue:', { exact: false })).toBeVisible();
    await expect(page.getByText('owner@e2e.typeroll.local', { exact: true })).toBeVisible();
    await expect(page.getByText('Organizations you already belong to are kept.', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`verify-email-${width}.png`), fullPage: true });
  }

  // Only the server knows: there is no "I've confirmed" button, and an
  // unconfirmed account stays on the page without an error.
  await expect(page.getByRole('button', { name: "I've confirmed my email" })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send confirmation email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('We sent a confirmation link to owner@e2e.typeroll.local');
  await expect(page.getByRole('button', { name: 'Resend confirmation email', exact: true })).toBeEnabled();

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).not.toHaveURL(/\/verify-email/);
  const cookies = await page.context().cookies();
  expect(cookies.find(cookie => cookie.name === 'typeroll_session')).toBeUndefined();
});

test('onboarding stays blocked until the email is confirmed', async ({ page }) => {
  await authenticatePersona(page, 'pending', { emailVerified: false });
  await page.goto('/onboarding');
  await expectCheckEmail(page, '/onboarding');
  await expect(page.getByLabel('Organization name', { exact: true })).toHaveCount(0);
  expect((await page.request.post('/api/orgs/create', { headers: { Origin: origin }, data: { name: 'Pending Unconfirmed' } })).status()).toBe(401);

  // The same person after confirmation sees the normal onboarding form.
  await authenticatePersona(page, 'pending');
  await page.goto('/verify-email?next=%2Fonboarding');
  await expect(page).toHaveURL(`${origin}/onboarding`);
  await expect(page.getByLabel('Organization name', { exact: true })).toBeVisible();
});
