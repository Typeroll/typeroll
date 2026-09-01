import { expect, test } from '@playwright/test';

import { authenticatePersona, personaCredentials, type CorePersona } from './helpers/auth';

const SITE_ID = 'e2e-core-site';
const targetKind = process.env.TYPEROLL_E2E_TARGET ?? 'local';
const portalOrigin = process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322';
const formsUrl = process.env.TYPEROLL_E2E_FORMS_URL ?? 'http://127.0.0.1:4322';

test('target reports live, ready, and immutable release identity', async ({ request }) => {
  const [health, ready, version, formsReady] = await Promise.all([
    request.get('/api/healthz'),
    request.get('/api/readyz'),
    request.get('/api/version'),
    request.get(`${formsUrl}/api/readyz`),
  ]);
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe('ok');
  expect(ready.ok()).toBe(true);
  expect((await ready.json()).ready).toBe(true);
  expect(formsReady.ok()).toBe(true);
  expect((await formsReady.json()).ready).toBe(true);
  const release = await version.json() as { image_digest?: string };
  if (targetKind !== 'local') expect(release.image_digest).toBe(process.env.TYPEROLL_E2E_EXPECTED_DIGEST);
});

const accessCases: Array<{
  persona: CorePersona;
  read: number;
  writeGuard: number;
  adminGuard: number;
}> = [
  { persona: 'owner', read: 200, writeGuard: 400, adminGuard: 400 },
  { persona: 'editor', read: 200, writeGuard: 400, adminGuard: 403 },
  { persona: 'viewer', read: 200, writeGuard: 403, adminGuard: 403 },
  { persona: 'outsider', read: 404, writeGuard: 404, adminGuard: 404 },
  { persona: 'pending', read: 403, writeGuard: 403, adminGuard: 403 },
];

for (const scenario of accessCases) {
  test(`${scenario.persona} has the expected Core permission boundary`, async ({ page }) => {
    await authenticatePersona(page, scenario.persona);
    const read = await page.request.get(`/api/sites/${SITE_ID}/pages/home`);
    expect(read.status()).toBe(scenario.read);

    // Empty title reaches validation only when the persona passed the write
    // guard. It creates no page and therefore keeps the permanent fixture stable.
    const write = await page.request.post(`/api/sites/${SITE_ID}/pages/create`, {
      headers: { Origin: portalOrigin },
      form: { title: '' },
      maxRedirects: 0,
    });
    expect(write.status()).toBe(scenario.writeGuard);

    // Empty name likewise reaches validation only after the admin guard and
    // creates no API key, so this is safe to repeat against permanent targets.
    const admin = await page.request.post(`/api/sites/${SITE_ID}/api-keys`, {
      headers: { Origin: portalOrigin },
      data: {},
    });
    expect(admin.status()).toBe(scenario.adminGuard);
  });
}

test('remote password login and logout use the real browser flow', async ({ page }) => {
  test.skip(targetKind === 'local', 'Local runs exercise the signed isolated persona session');
  const credentials = personaCredentials('owner');
  await page.goto('/login');
  await page.getByLabel('Email').fill(credentials.email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page).not.toHaveURL(/\/app(?:\/|$)/);
});
