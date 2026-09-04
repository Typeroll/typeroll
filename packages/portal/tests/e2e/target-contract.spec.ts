import { expect, test } from '@playwright/test';

import { authenticatePersona, personaCredentials, type CorePersona } from './helpers/auth';

const SITE_ID = 'e2e-core-site';
const targetKind = process.env.TYPEROLL_E2E_TARGET ?? 'local';
const portalOrigin = process.env.TYPEROLL_E2E_PORTAL_URL ?? 'http://127.0.0.1:4322';
const formsUrl = process.env.TYPEROLL_E2E_FORMS_URL ?? 'http://127.0.0.1:4322';

function e2eApiHeaders(): Record<string, string> {
  const key = process.env.TYPEROLL_E2E_API_KEY;
  if (!key) throw new Error('TYPEROLL_E2E_API_KEY is required for the remote API contract');
  return { Authorization: `Bearer ${key}` };
}

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
  await page.waitForFunction(() => {
    const form = document.querySelector<HTMLFormElement>('form');
    const email = document.querySelector<HTMLInputElement>('input[type="email"]');
    return form?.dataset.loginReady === 'true' || Boolean(email && '_valueTracker' in email);
  });
  // Core 0.1.4 predates the explicit label association added after the first
  // permanent-target qualification. Attribute selectors exercise the same
  // login behavior across that pinned release and subsequent accessible markup.
  await page.locator('input[type="email"]').fill(credentials.email);
  await page.locator('input[type="password"]').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  const signOut = page.getByRole('button', { name: /sign out/i });
  const navigationToggle = page.getByRole('button', { name: 'Open navigation' });
  if ((page.viewportSize()?.width ?? 1024) < 1024) {
    await navigationToggle.click();
    await expect(signOut).toBeInViewport();
  }
  await signOut.click();
  await expect(page).not.toHaveURL(/\/app(?:\/|$)/);
});

test('seeded key reaches public API, Apps, and Extensions without leaking secrets', async ({ request }) => {
  test.skip(targetKind === 'local', 'The permanent API key belongs only to remote E2E targets');
  const headers = e2eApiHeaders();
  const [sitesResponse, pagesResponse, appsResponse, extensionsResponse] = await Promise.all([
    request.get('/api/v1/sites', { headers }),
    request.get(`/api/v1/sites/${SITE_ID}/pages?status=all`, { headers }),
    request.get(`/api/v1/sites/${SITE_ID}/apps`, { headers }),
    request.get(`/api/v1/sites/${SITE_ID}/extensions`, { headers }),
  ]);
  for (const response of [sitesResponse, pagesResponse, appsResponse, extensionsResponse]) {
    expect(response.status()).toBe(200);
  }
  const sites = await sitesResponse.json() as { sites?: Array<{ id?: string }> };
  const pages = await pagesResponse.json() as { pages?: Array<{ id?: string }> };
  const apps = await appsResponse.json() as { apps?: unknown[] };
  const extensions = await extensionsResponse.json() as { extensions?: unknown[] };
  expect(sites.sites?.map(({ id }) => id)).toEqual([SITE_ID]);
  expect(pages.pages?.some(({ id }) => id === 'home')).toBe(true);
  expect(Array.isArray(apps.apps)).toBe(true);
  expect(Array.isArray(extensions.extensions)).toBe(true);
  expect(JSON.stringify({ apps, extensions })).not.toMatch(/secret_config_enc|private_config/);
});

test('hosted MCP initializes with the seeded site key', async ({ request }) => {
  test.skip(targetKind === 'local', 'The permanent API key belongs only to remote E2E targets');
  const response = await request.post('/api/mcp', {
    headers: {
      ...e2eApiHeaders(),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'typeroll-remote-e2e', version: '1' },
      },
    },
  });
  expect(response.status()).toBe(200);
  expect(await response.text()).toMatch(/serverInfo|protocolVersion/);

  const tools = await request.post('/api/mcp', {
    headers: {
      ...e2eApiHeaders(),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  });
  expect(tools.status()).toBe(200);
  const toolList = await tools.json() as { result?: { tools?: Array<{ name?: string }> }; error?: unknown };
  expect(toolList.error).toBeUndefined();
  expect(toolList.result?.tools?.some(({ name }) => name === 'get_site_capabilities')).toBe(true);

  const call = await request.post('/api/mcp', {
    headers: {
      ...e2eApiHeaders(),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_site_capabilities', arguments: {} },
    },
  });
  expect(call.status()).toBe(200);
  const result = await call.json() as { result?: { content?: unknown[]; isError?: boolean }; error?: unknown };
  expect(result.error).toBeUndefined();
  expect(result.result?.isError).not.toBe(true);
  expect(Array.isArray(result.result?.content)).toBe(true);
});

test('Extension issuer discovery and JWKS match the target origin', async ({ request }) => {
  const [discoveryResponse, jwksResponse] = await Promise.all([
    request.get('/.well-known/typeroll-extension-issuer'),
    request.get('/.well-known/jwks.json'),
  ]);
  expect(discoveryResponse.status()).toBe(200);
  expect(jwksResponse.status()).toBe(200);
  const discovery = await discoveryResponse.json() as {
    issuer?: string;
    jwks_uri?: string;
    token_endpoint?: string;
    protocol_version?: number;
  };
  const jwks = await jwksResponse.json() as { keys?: Array<Record<string, unknown>> };
  expect(discovery).toMatchObject({
    issuer: portalOrigin,
    jwks_uri: `${portalOrigin}/.well-known/jwks.json`,
    token_endpoint: `${portalOrigin}/api/extensions/token`,
    protocol_version: 3,
  });
  expect(jwks.keys?.some((key) => key.kty === 'EC' && key.crv === 'P-256' && key.alg === 'ES256')).toBe(true);
  expect(jwks.keys?.every((key) => !('d' in key))).toBe(true);
});

test('authenticated Core shell fits the target viewport', async ({ page }, testInfo) => {
  await authenticatePersona(page, 'owner');
  await page.goto('/app');
  await expect(page).toHaveURL(/\/app(?:\/|$)/);
  await expect(page.locator('body')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
  }));
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);
  await testInfo.attach(`core-shell-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
