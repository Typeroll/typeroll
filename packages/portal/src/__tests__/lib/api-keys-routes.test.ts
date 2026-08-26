// Smoke-tests for the management-API endpoints behind the API-keys UI.
// Cookie-auth via the dev-user fallback (the same session shape the existing
// site-access tests use), so we exercise the full route handler.

import { describe, it, expect, beforeEach } from 'vitest';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { paths } from '@typeroll/shared';
import type { APIRoute } from 'astro';

const DEV_ORG = 'default';
const SITE = 'mysite';

async function setup(): Promise<void> {
  makeTmpFixtures();
  await resetDatastore();
  const { getStore } = await import('../../lib/datastore');
  await getStore().setDoc(paths.site(DEV_ORG, SITE), {
    name: 'My Site',
    created_at: new Date().toISOString(),
  });
}

const fakeCookies = {
  get: () => undefined,
} as unknown as Parameters<APIRoute>[0]['cookies'];

const fakeLocals = {} as Parameters<APIRoute>[0]['locals'];

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

async function callRoute(
  routeImport: Promise<{ GET?: APIRoute; POST?: APIRoute; DELETE?: APIRoute }>,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  params: Record<string, string>,
  init?: RequestInit,
): Promise<Response> {
  const mod = await routeImport;
  const handler = mod[method];
  if (!handler) throw new Error(`No ${method} handler`);
  return handler({
    request: makeRequest(url, { method, ...init }),
    cookies: fakeCookies,
    params,
    locals: fakeLocals,
  } as unknown as Parameters<APIRoute>[0]) as Promise<Response>;
}

describe('POST /api/sites/{siteId}/api-keys', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('creates a key, returns the plaintext token once, and persists metadata', async () => {
    await setup();
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/api-keys/index'),
      'POST',
      `http://localhost/api/sites/${SITE}/api-keys`,
      { siteId: SITE },
      { body: JSON.stringify({ name: 'Acme agency' }), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: { id: string; name: string }; token: string };
    expect(body.token).toMatch(/^typeroll_live_[0-9a-f]{12}_[0-9a-f]{48}$/);
    expect(body.key.name).toBe('Acme agency');

    const { listApiKeys } = await import('../../lib/api-keys');
    const keys = await listApiKeys(DEV_ORG, SITE);
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe('Acme agency');
  });

  it('rejects an empty name', async () => {
    await setup();
    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/api-keys/index'),
      'POST',
      `http://localhost/api/sites/${SITE}/api-keys`,
      { siteId: SITE },
      { body: JSON.stringify({ name: '' }), headers: { 'content-type': 'application/json' } },
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sites/{siteId}/api-keys', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('returns the metadata list without exposing any hash or token', async () => {
    await setup();
    const { createApiKey } = await import('../../lib/api-keys');
    await createApiKey({ orgId: DEV_ORG, siteId: SITE, name: 'one', createdBy: 'admin' });
    await createApiKey({ orgId: DEV_ORG, siteId: SITE, name: 'two', createdBy: 'admin' });

    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/api-keys/index'),
      'GET',
      `http://localhost/api/sites/${SITE}/api-keys`,
      { siteId: SITE },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('key_hash');
    expect(text).not.toContain('typeroll_live_');
    const body = JSON.parse(text) as { keys: Array<{ name: string }> };
    expect(body.keys.length).toBe(2);
    expect(body.keys.map((k) => k.name).sort()).toEqual(['one', 'two']);
  });
});

describe('DELETE /api/sites/{siteId}/api-keys/{prefix}', () => {
  beforeEach(async () => {
    await resetDatastore();
  });

  it('revokes the key so subsequent verifications fail', async () => {
    await setup();
    const { createApiKey, verifyApiToken } = await import('../../lib/api-keys');
    const { token, key } = await createApiKey({
      orgId: DEV_ORG, siteId: SITE, name: 'one', createdBy: 'admin',
    });
    expect(await verifyApiToken(token)).not.toBeNull();

    const res = await callRoute(
      import('../../pages/api/sites/[siteId]/api-keys/[prefix]'),
      'DELETE',
      `http://localhost/api/sites/${SITE}/api-keys/${key.id}`,
      { siteId: SITE, prefix: key.id },
    );
    expect(res.status).toBe(200);
    expect(await verifyApiToken(token)).toBeNull();
  });
});
